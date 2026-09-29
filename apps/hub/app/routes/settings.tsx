import type {
  AppDefinition,
  AppSubscriptionSummary,
  HubIntegrationSummary,
  MemberApplicationAssignmentSummary,
  MemberSummary,
  Permission,
  ResolvedEntitlements,
  StoreTemplateSummary,
  StoreSummary
} from "@aevocado/contracts";
import { ApiClientError, isApplicationCode } from "@aevocado/contracts";
import type { ApiClient } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import type { AccessDecisionResponse, ApplicationCode } from "@aevocado/api-contract";
import type { HubApplicationLaunchResponse } from "@aevocado/contracts";
import { Breadcrumbs, Button, DataTable, Input, PermissionDeniedState, Select, StatusBadge } from "@aevocado/design-system";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, ClientLoaderFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createHubApiClient,
  requireHubAccess,
  requestCsrfHeaders,
  invalidateHubAccessCache
} from "../lib/auth.server";
import { invalidateClientCache } from "../lib/client-cache";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";
import { logHubEvent } from "../lib/server-log.server";

interface OrganizationProfile {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  legalName: string;
  businessType: string;
  currency: string;
  timezone: string;
  country: string;
  contactEmail?: string;
  contactPhone?: string;
  onboardingStatus: string;
  createdAt: string;
  updatedAt: string;
}

type LaunchApplication = Extract<ApplicationCode, "PLAY" | "POS" | "KIOSK" | "QUEUE">;
const assignableApplicationCodes = ["PLAY", "POS", "KIOSK", "QUEUE"] as const satisfies readonly LaunchApplication[];

interface ApplicationAccessView {
  application: LaunchApplication;
  decision: AccessDecisionResponse;
}

export interface SettingsLoaderData {
  hub: HubLoaderData;
  organization: OrganizationProfile | null;
  stores: StoreSummary[];
  templates: StoreTemplateSummary[];
  members: MemberSummary[];
  memberApplications: Record<string, MemberApplicationAssignmentSummary[]>;
  apps: AppDefinition[];
  subscriptions: AppSubscriptionSummary[];
  entitlements: ResolvedEntitlements | null;
  applicationAccess: ApplicationAccessView[];
  integrations: HubIntegrationSummary[];
  auditLogs: HubAuditLog[];
  permissionDenied?: Permission;
}

interface HubAuditLog {
  id: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SettingsActionResult {
  ok: false;
  message: string;
}

interface OrganizationUpdateBody {
  name: string;
  legalName?: string;
  slug?: string;
  businessType?: string;
  currency?: string;
  timezone?: string;
  country?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

interface StoreCreateBody {
  organizationId: string;
  name: string;
  code: string;
  timezone?: string;
  currency?: string;
  storeMode?: "POS" | "KIOSK" | "BOOKING" | "POS_BOOKING" | "CUSTOM";
}

// Keep this list aligned with the gateway's member mutation contract. The
// broader role model also contains app-specific roles, but the current Hub
// member endpoint only accepts these organization roles.
const memberRoles = ["ADMIN", "BRANCH_MANAGER", "CASHIER", "KITCHEN", "STAFF", "VIEWER"] as const;
const storeModes = ["POS", "KIOSK", "BOOKING", "POS_BOOKING", "CUSTOM"] as const;
const nonAssignableApplicationCodes = new Set<ApplicationCode>(["HUB", "ADMIN", "GO", "DIGITAL_SIGN"]);

function applicationCodeForDefinition(app: AppDefinition): LaunchApplication | undefined {
  const candidate = app.code ?? (app.id === "booking" ? "PLAY" : app.id.toUpperCase());
  return isLaunchApplication(candidate) ? candidate : undefined;
}

function assignableApplications(apps: AppDefinition[]): Array<{ code: LaunchApplication; definition: AppDefinition }> {
  const seen = new Set<LaunchApplication>();
  return apps.flatMap((definition) => {
    const code = applicationCodeForDefinition(definition);
    if (!code || definition.storeScoped !== true || definition.status !== "ACTIVE" || definition.lifecycleStatus === "DEPRECATED" || definition.lifecycleStatus === "RETIRED" || seen.has(code)) return [];
    seen.add(code);
    return [{ code, definition }];
  });
}

function organizationIdFor(hub: HubLoaderData): string | undefined {
  return hub.access.organizationId ?? hub.me.principal?.organizationId;
}

function emptySettings(hub: HubLoaderData, permissionDenied?: Permission): SettingsLoaderData {
  return {
    hub,
    organization: null,
    stores: [],
    templates: [],
    members: [],
    memberApplications: {},
    apps: [],
    subscriptions: [],
    entitlements: null,
    applicationAccess: [],
    integrations: [],
    auditLogs: [],
    ...(permissionDenied ? { permissionDenied } : {})
  };
}

function textValue(form: FormData, name: string, maximum: number, required = false): string {
  const value = String(form.get(name) ?? "").trim();
  if (required && !value) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} is too long`);
  return value;
}

function optionalTextValue(form: FormData, name: string, maximum: number): string | undefined {
  const value = textValue(form, name, maximum);
  return value || undefined;
}

function defaultPublicSlug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63);
  return normalized || "store";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 320;
}

function isLaunchApplication(value: string): value is LaunchApplication {
  return isApplicationCode(value) && !nonAssignableApplicationCodes.has(value);
}

function isMemberRole(value: string): value is (typeof memberRoles)[number] {
  return memberRoles.includes(value as (typeof memberRoles)[number]);
}

function isStoreMode(value: string): value is (typeof storeModes)[number] {
  return storeModes.includes(value as (typeof storeModes)[number]);
}

function selectedApplications(form: FormData): LaunchApplication[] {
  const values = form.getAll("applicationCodes").map(String);
  if (values.some((value) => !isLaunchApplication(value))) throw new Error("Choose valid application assignments");
  return [...new Set(values)] as LaunchApplication[];
}

function settingsReturnPath(request: Request, query: string): string {
  const pathname = logicalPathname(request).replace(/\/+$/u, "");
  const destination = pathname.endsWith("/stores") ? "/stores" : "/settings";
  return `${destination}?${query}`;
}

function logicalPathname(request: Request): string {
  return new URL(request.url).pathname.replace(/\.data$/u, "");
}

async function loadMemberAssignments(api: ApiClient): Promise<MemberApplicationAssignmentSummary[]> {
  return (await api.request<{ assignments: MemberApplicationAssignmentSummary[] }>("/api/v1/hub/members/applications")).assignments;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<SettingsLoaderData> {
  const requestPath = logicalPathname(request);
  const loaderStartedAt = performance.now();
  const isStoresRoute = requestPath.endsWith("/stores");
  const hub = await requireHubAccess(request, requestPath.endsWith("/stores") ? "/modern/stores" : "/modern");
  if (!isAccessAllowed(hub.access)) return emptySettings(hub);

  const organizationId = organizationIdFor(hub);
  if (!organizationId) return emptySettings(hub, "organization.read");
  if (!hasHubPermission(hub, "organization.read")) return emptySettings(hub, "organization.read");

  const api = createHubApiClient(request);
  const canReadStores = hasHubPermission(hub, "store.read");
  const canManageMembers = hasHubPermission(hub, "member.manage");

  // Stores is a first-class workspace. Do not make branch navigation wait for
  // team assignments, subscriptions, entitlements, or every member's app
  // assignments. Those belong to the organization settings route only.
  if (isStoresRoute) {
    const scopedStores = canReadStores
      ? (hub.stores.length > 0
          ? hub.stores.filter((store) => !organizationId || store.organizationId === organizationId)
          : (await api.request<{ stores: StoreSummary[] }>(`/api/v1/hub/stores?organizationId=${encodeURIComponent(organizationId)}`)).stores)
      : [];
    const [organizationResult, templatesResult] = await Promise.all([
      api.request<{ organization: OrganizationProfile }>(`/api/v1/hub/organizations/${encodeURIComponent(organizationId)}`),
      canReadStores
        ? api.request<{ templates: StoreTemplateSummary[] }>("/api/v1/hub/store-templates")
        : Promise.resolve({ templates: [] as StoreTemplateSummary[] })
    ]);
    logHubEvent("info", "settings.loader.complete", {
      route: requestPath,
      mode: "stores",
      duration_ms: Math.round(performance.now() - loaderStartedAt),
      store_count: scopedStores.length,
    });
    return {
      ...emptySettings(hub),
      organization: organizationResult.organization,
      stores: scopedStores,
      templates: templatesResult.templates,
      auditLogs: []
    };
  }

  const applicationAccessPromise = Promise.all(assignableApplicationCodes.map(async (code): Promise<ApplicationAccessView> => ({
    application: code,
    decision: await api.request<AccessDecisionResponse>(`/api/v1/access?application=${code}`)
  })));
  const scopedStores = canReadStores
    ? (hub.stores.length > 0
        ? hub.stores.filter((store) => !organizationId || store.organizationId === organizationId)
        : (await api.request<{ stores: StoreSummary[] }>(`/api/v1/hub/stores?organizationId=${encodeURIComponent(organizationId)}`)).stores)
    : [];
  const [organizationResult, membersResult, appsResult, subscriptionsResult, entitlementsResult, integrationsResult, auditResult, earlyApplicationAccess] = await Promise.all([
    api.request<{ organization: OrganizationProfile }>(`/api/v1/hub/organizations/${encodeURIComponent(organizationId)}`),
    canManageMembers
      ? api.request<{ members: MemberSummary[] }>("/api/v1/hub/members")
      : Promise.resolve({ members: [] as MemberSummary[] }),
    api.request<{ apps: AppDefinition[] }>("/api/v1/hub/apps"),
    api.request<{ subscriptions: AppSubscriptionSummary[] }>("/api/v1/hub/subscriptions"),
    api.request<{ success: true; entitlements: ResolvedEntitlements }>("/api/v1/me/entitlements"),
    api.request<{ success: true; integrations: HubIntegrationSummary[] }>("/api/v1/hub/integrations"),
    hasHubPermission(hub, "audit.read")
      ? api.request<{ logs: HubAuditLog[] }>("/api/v1/hub/audit-logs")
      : Promise.resolve({ logs: [] as HubAuditLog[] }),
    applicationAccessPromise
  ]);
  logHubEvent("info", "settings.loader.base", {
    route: requestPath,
    duration_ms: Math.round(performance.now() - loaderStartedAt),
    store_count: scopedStores.length,
    member_count: membersResult.members.length,
    app_count: appsResult.apps.length,
    access_count: earlyApplicationAccess.length
  });
  const applicationAccess = earlyApplicationAccess.filter(({ application }) => assignableApplications(appsResult.apps).some(({ code }) => code === application));
  // These reads are independent. Keep the settings page's tail latency equal
  // to the slower group instead of adding profile and assignment latency.
  const assignmentsResult = await (
    canManageMembers
      ? loadMemberAssignments(api)
      : Promise.resolve([] as MemberApplicationAssignmentSummary[])
  );
  const memberApplications = assignmentsResult.reduce<Record<string, MemberApplicationAssignmentSummary[]>>((grouped, assignment) => {
    (grouped[assignment.membershipId] ??= []).push(assignment);
    return grouped;
  }, {});
  logHubEvent("info", "settings.loader.complete", {
    route: requestPath,
    duration_ms: Math.round(performance.now() - loaderStartedAt),
    store_count: scopedStores.length,
    member_count: membersResult.members.length,
    assignment_count: assignmentsResult.length,
    audit_count: auditResult.logs.length
  });

  return {
    hub,
    organization: organizationResult.organization,
    stores: scopedStores,
    templates: [],
    members: membersResult.members,
    memberApplications,
    apps: appsResult.apps,
    subscriptions: subscriptionsResult.subscriptions,
    entitlements: entitlementsResult.entitlements,
    applicationAccess,
    integrations: integrationsResult.integrations,
    auditLogs: auditResult.logs
  };
}

export async function clientLoader({
  serverLoader
}: ClientLoaderFunctionArgs): Promise<SettingsLoaderData> {
  // Settings contains memberships, assignments, entitlements and Hub
  // permissions. Re-authorize the complete payload on the server for every
  // route load; it is not eligible for browser-side caching.
  return await serverLoader() as SettingsLoaderData;
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | SettingsActionResult> {
  invalidateHubAccessCache(request.headers.get("cookie") ?? undefined);
  // Clear any legacy in-memory entries left by an older client bundle. New
  // route loaders never read these entries, but cleanup prevents stale data
  // from surviving a mutation during a rolling local/deployment update.
  invalidateClientCache();
  const hub = await requireHubAccess(request);
  if (!isAccessAllowed(hub.access)) return { ok: false, message: "Hub access is required." };

  const organizationId = organizationIdFor(hub);
  if (!organizationId) return { ok: false, message: "No organization context is available." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const api = createHubApiClient(request);

  try {
    if (intent === "update-organization") {
      if (!hasHubPermission(hub, "organization.manage")) {
        return { ok: false, message: "You do not have organization management permission." };
      }
      const legalName = optionalTextValue(form, "legalName", 200);
      const slug = optionalTextValue(form, "slug", 64);
      const businessType = optionalTextValue(form, "businessType", 100);
      const timezone = optionalTextValue(form, "timezone", 64);
      const currency = optionalTextValue(form, "currency", 8);
      const country = optionalTextValue(form, "country", 2);
      const contactEmail = optionalTextValue(form, "contactEmail", 320);
      if (contactEmail && !isEmail(contactEmail)) return { ok: false, message: "Enter a valid contact email." };
      const body: OrganizationUpdateBody = {
        name: textValue(form, "name", 160, true),
        ...(legalName ? { legalName } : {}),
        ...(slug ? { slug } : {}),
        ...(businessType ? { businessType } : {}),
        ...(timezone ? { timezone } : {}),
        ...(currency ? { currency: currency.toUpperCase() } : {}),
        ...(country ? { country: country.toUpperCase() } : {}),
        contactEmail: contactEmail || null,
        contactPhone: optionalTextValue(form, "contactPhone", 50) || null
      };
      await api.requestJson<{ success: true }, OrganizationUpdateBody>(`/api/v1/hub/organizations/${encodeURIComponent(organizationId)}`, {
        method: "PATCH",
        headers: requestCsrfHeaders(request),
        body
      });
      return redirect(settingsReturnPath(request, "updated=organization"));
    }

    if (intent === "create-store") {
      if (!hasHubPermission(hub, "store.create") && !hasHubPermission(hub, "organization.manage")) {
        return { ok: false, message: "You do not have store creation permission." };
      }
      const storeModeValue = textValue(form, "storeMode", 20, true);
      if (!isStoreMode(storeModeValue)) return { ok: false, message: "Choose a valid store mode." };
      const timezone = optionalTextValue(form, "storeTimezone", 64);
      const currency = optionalTextValue(form, "storeCurrency", 8);
      const body: StoreCreateBody = {
        organizationId,
        name: textValue(form, "storeName", 160, true),
        code: textValue(form, "storeCode", 32, true).toUpperCase(),
        storeMode: storeModeValue,
        ...(timezone ? { timezone } : {}),
        ...(currency ? { currency: currency.toUpperCase() } : {})
      };
      const created = await api.requestJson<{ success: true; store: StoreSummary }, StoreCreateBody>("/api/v1/hub/stores", {
        method: "POST",
        headers: requestCsrfHeaders(request),
        body
      });
      if (logicalPathname(request).endsWith("/stores")) {
        return redirect(`/stores/${encodeURIComponent(created.store.id)}?created=store`);
      }
      return redirect(settingsReturnPath(request, "updated=store"));
    }

    if (intent === "connect-integration" || intent === "rotate-integration") {
      if (!hasHubPermission(hub, "integration.manage")) return { ok: false, message: "Integration management permission is required." };
      const providerCode = textValue(form, "providerCode", 80, true).toUpperCase();
      const secretRef = textValue(form, "secretRef", 256, true);
      if (!/^(secret|gcp-secret|vault|env):\/\/[A-Za-z0-9._~:/-]{1,240}$/u.test(secretRef)) {
        return { ok: false, message: "Use a deployment secret reference such as secret://aevo/line/production. Do not paste a credential value." };
      }
      const storeId = optionalTextValue(form, "storeId", 64);
      const consent = form.get("consent") === "true";
      if (!consent) return { ok: false, message: "Confirm the integration consent before continuing." };
      const path = intent === "connect-integration" ? "connect" : "rotate";
      await api.requestJson(`/api/v1/hub/integrations/${encodeURIComponent(providerCode)}/${path}`, {
        method: "POST",
        headers: requestCsrfHeaders(request),
        body: { secretRef, consent, ...(storeId ? { storeId } : {}) }
      });
      return redirect(settingsReturnPath(request, "updated=integration"));
    }

    if (intent === "disconnect-integration") {
      if (!hasHubPermission(hub, "integration.manage")) return { ok: false, message: "Integration management permission is required." };
      const providerCode = textValue(form, "providerCode", 80, true).toUpperCase();
      const storeId = optionalTextValue(form, "storeId", 64);
      await api.requestJson(`/api/v1/hub/integrations/${encodeURIComponent(providerCode)}/disconnect`, {
        method: "POST",
        headers: requestCsrfHeaders(request),
        body: storeId ? { storeId } : {}
      });
      return redirect(settingsReturnPath(request, "updated=integration"));
    }

    if (intent === "create-store-from-template") {
      if (!hasHubPermission(hub, "store.create") && !hasHubPermission(hub, "organization.manage")) {
        return { ok: false, message: "You do not have store creation permission." };
      }
      const templateId = textValue(form, "templateId", 64, true);
      const publicSlug = optionalTextValue(form, "templatePublicSlug", 63);
      const templateStoreCode = textValue(form, "templateStoreCode", 32, true).toUpperCase();
      const created = await api.requestJson<{ success: true; store: StoreSummary }>(
        `/api/v1/hub/store-templates/${encodeURIComponent(templateId)}/instantiate`,
        {
          method: "POST",
          headers: requestCsrfHeaders(request),
          body: {
            name: textValue(form, "templateStoreName", 160, true),
            code: templateStoreCode,
            publicSlug: (publicSlug ?? defaultPublicSlug(templateStoreCode)).toLowerCase()
          }
        }
      );
      return redirect(`/stores/${encodeURIComponent(created.store.id)}?created=template`);
    }

    if (intent === "invite-member") {
      if (!hasHubPermission(hub, "member.manage")) {
        return { ok: false, message: "You do not have member management permission." };
      }
      const email = textValue(form, "memberEmail", 320, true).toLowerCase();
      if (!isEmail(email)) return { ok: false, message: "Enter a valid member email." };
      const role = textValue(form, "memberRole", 40, true);
      if (!isMemberRole(role)) return { ok: false, message: "Choose a valid organization role." };
      const displayName = optionalTextValue(form, "memberName", 120);
      const storeId = optionalTextValue(form, "memberStoreId", 64);
      const applicationCodes = selectedApplications(form);
      await api.requestJson("/api/v1/hub/members", {
        method: "POST",
        headers: requestCsrfHeaders(request),
        body: {
          email,
          ...(displayName ? { displayName } : {}),
          role,
          storeIds: storeId ? [storeId] : [],
          applicationCodes
        }
      });
      return redirect(settingsReturnPath(request, "updated=member"));
    }

    if (intent === "update-member-applications") {
      if (!hasHubPermission(hub, "member.manage")) {
        return { ok: false, message: "You do not have member management permission." };
      }
      const membershipId = textValue(form, "membershipId", 64, true);
      const selected = new Set(selectedApplications(form));
      const storeId = optionalTextValue(form, "applicationStoreId", 64);
      const catalog = await api.request<{ apps: AppDefinition[] }>("/api/v1/hub/apps");
      await Promise.all(assignableApplications(catalog.apps).map(({ code: applicationCode }) => api.requestJson(
        `/api/v1/hub/members/${encodeURIComponent(membershipId)}/applications/${applicationCode}`,
        {
          method: "PATCH",
          headers: requestCsrfHeaders(request),
          body: {
            status: selected.has(applicationCode) ? "ACTIVE" : "REVOKED",
            storeIds: storeId ? [storeId] : []
          }
        }
      )));
      return redirect(settingsReturnPath(request, "updated=application-access"));
    }

    if (intent === "launch") {
      const application = textValue(form, "application", 16, true);
      if (!isLaunchApplication(application)) return { ok: false, message: "Unknown application." };
      try {
        const result = await api.requestJson<HubApplicationLaunchResponse, { storeId?: string }>(
          `/api/v1/hub/applications/${encodeURIComponent(application)}/launch`,
          {
            method: "POST",
            headers: requestCsrfHeaders(request),
            body: {}
          }
        );
        return redirect(result.launch.url);
      } catch (error) {
        if (error instanceof ApiClientError) {
          if (["APP_ASSIGNMENT_REQUIRED", "APP_ASSIGNMENT_SUSPENDED"].includes(error.code)) {
            return redirect("/settings#team-heading");
          }
          if (["ENTITLEMENT_REQUIRED", "ENTITLEMENT_INACTIVE", "ENTITLEMENT_EXPIRED"].includes(error.code)) {
            return redirect("/settings#apps-heading");
          }
        }
        throw error;
      }
    }

    return { ok: false, message: "Unknown settings action." };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, message: error.message };
    if (error instanceof Error) return { ok: false, message: error.message };
    return { ok: false, message: "The settings action could not be completed." };
  }
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(timestamp);
}

function subscriptionFor(subscriptions: AppSubscriptionSummary[], appId: string): AppSubscriptionSummary | undefined {
  return subscriptions.find((subscription) => subscription.appId === appId);
}

function runtimeApplicationForCatalogId(app: AppDefinition): LaunchApplication | undefined {
  if (app.code) return isLaunchApplication(app.code) ? app.code : undefined;
  if (app.id === "booking") return "PLAY";
  const application = app.id.toUpperCase();
  return isLaunchApplication(application) ? application : undefined;
}

function statusClass(status: string): string {
  if (["ACTIVE", "TRIAL", "TRIALING", "ALLOWED"].includes(status)) return "aevo-status aevo-status--success";
  if (["BETA", "PAST_DUE", "GRACE_PERIOD", "SUSPENDED"].includes(status)) return "aevo-status aevo-status--warning";
  if (["CATALOG", "UNKNOWN", "UNAVAILABLE"].includes(status)) return "aevo-status aevo-status--neutral";
  return "aevo-status aevo-status--danger";
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (["ACTIVE", "TRIAL", "TRIALING", "ALLOWED"].includes(status)) return "success";
  if (["PAST_DUE", "GRACE_PERIOD", "SUSPENDED"].includes(status)) return "warning";
  if (["UNKNOWN", "UNAVAILABLE"].includes(status)) return "neutral";
  return "danger";
}

export function SettingsPermissionDenied({ permission }: { permission?: Permission }) {
  return (
    <PermissionDeniedState
      title="Organization settings are restricted"
      description={`The server resolved this Hub session, but this route requires ${permission ?? "organization.read"}. Ask an organization owner or manager to update your assignment.`}
      action={<Link className="aevo-button aevo-button--secondary" to="/">Back to overview</Link>}
    />
  );
}

function OrganizationForm({ organization, canManage, busy }: { organization: OrganizationProfile; canManage: boolean; busy: boolean }) {
  return (
    <Form method="post" className="aevo-settings-form">
      <input type="hidden" name="intent" value="update-organization" />
      <div className="aevo-form-grid">
        <label>Organization name<Input name="name" defaultValue={organization.name} maxLength={160} required disabled={!canManage} /></label>
        <label>Legal name<Input name="legalName" defaultValue={organization.legalName} maxLength={200} disabled={!canManage} /></label>
        <label>Slug<Input name="slug" defaultValue={organization.slug} maxLength={64} disabled={!canManage} /></label>
        <label>Business type<Input name="businessType" defaultValue={organization.businessType} maxLength={100} disabled={!canManage} /></label>
        <label>Country<Input name="country" defaultValue={organization.country} maxLength={2} disabled={!canManage} /></label>
        <label>Currency<Input name="currency" defaultValue={organization.currency} maxLength={8} disabled={!canManage} /></label>
        <label>Timezone<Input name="timezone" defaultValue={organization.timezone} maxLength={64} disabled={!canManage} /></label>
        <label>Contact email<Input type="email" name="contactEmail" defaultValue={organization.contactEmail ?? ""} maxLength={320} disabled={!canManage} /></label>
        <label>Contact phone<Input name="contactPhone" defaultValue={organization.contactPhone ?? ""} maxLength={50} disabled={!canManage} /></label>
      </div>
      <div className="aevo-form-actions">
        <StatusBadge tone={statusTone(organization.status)}>{organization.status}</StatusBadge>
        {canManage ? <Button variant="primary" type="submit" busy={busy} busyLabel="Saving organization…">Save organization</Button> : <span className="aevo-form-hint">Read-only for this role</span>}
      </div>
    </Form>
  );
}

export function StoreSection({ data, canManage, busy }: { data: SettingsLoaderData; canManage: boolean; busy: boolean }) {
  const activeStores = data.stores.filter((store) => (store.status ?? "ACTIVE") === "ACTIVE");
  return (
    <section className="aevo-settings-section" aria-labelledby="stores-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Tenant structure</span><h2 id="stores-heading">Stores & branches</h2><p>Use this directory to enter a store workspace. Customer App / Aevo Go profile, catalog, and app settings stay inside the selected store.</p></div><span className="aevo-count-badge">{activeStores.length} active</span></div>
      <DataTable className="aevo-table-wrap">
        <table className="aevo-data-table"><thead><tr><th>Name</th><th>Code</th><th>Mode</th><th>Timezone</th><th>Status</th><th>Open</th></tr></thead><tbody>
          {data.stores.length > 0 ? data.stores.map((store) => <tr key={store.id}><td><Link className="aevo-table-link" to={`/stores/${encodeURIComponent(store.id)}`} prefetch="intent">{store.name}</Link><small>{store.address || "No address"}</small></td><td><code>{store.code}</code></td><td>{store.storeMode ?? "—"}</td><td>{store.timezone}</td><td><span className={statusClass(store.status ?? "ACTIVE")}>{store.status ?? "ACTIVE"}</span></td><td><Link className="aevo-button aevo-button--secondary aevo-button--small" to={`/stores/${encodeURIComponent(store.id)}`} prefetch="intent">Open store</Link></td></tr>) : <tr><td colSpan={6}><span className="aevo-empty-state">No accessible stores were returned.</span></td></tr>}
        </tbody></table>
      </DataTable>
      <p className="aevo-form-hint">Customer App / Aevo Go profile and discovery settings are managed inside each store workspace.</p>
      {canManage ? <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-store" /><h3>Add a store</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Store name<Input name="storeName" maxLength={160} required /></label><label>Code<Input name="storeCode" maxLength={32} required /></label><label>Mode<Select name="storeMode" defaultValue="POS">{storeModes.map((mode) => <option key={mode}>{mode}</option>)}</Select></label><label>Timezone<Input name="storeTimezone" defaultValue={data.organization?.timezone ?? "Asia/Bangkok"} maxLength={64} /></label><label>Currency<Input name="storeCurrency" defaultValue={data.organization?.currency ?? "THB"} maxLength={8} /></label></div><Button variant="secondary" type="submit" busy={busy} busyLabel="Creating store…">Create store</Button></Form> : <p className="aevo-form-hint">Store creation is restricted to organization managers.</p>}
      {canManage && data.templates.length > 0 ? <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-store-from-template" /><h3>Create from template</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Template<Select name="templateId" required defaultValue=""><option value="" disabled>Select a saved template</option>{data.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</Select></label><label>Store name<Input name="templateStoreName" maxLength={160} required /></label><label>Code<Input name="templateStoreCode" maxLength={32} required /></label><label>Public slug<Input name="templatePublicSlug" maxLength={63} /></label></div><Button variant="primary" type="submit" busy={busy} busyLabel="Creating from template…">Create store from template</Button></Form> : null}
    </section>
  );
}

function TeamSection({ data, canManage, busy }: { data: SettingsLoaderData; canManage: boolean; busy: boolean }) {
  const availableApplications = assignableApplications(data.apps);
  return (
    <section id="team-heading" className="aevo-settings-section" aria-labelledby="team-section-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Access boundary</span><h2 id="team-section-heading">Team & access</h2><p>Membership, application assignment, and store scope are separate authorization layers.</p></div><span className="aevo-count-badge">{data.members.length} members</span></div>
      <DataTable className="aevo-table-wrap"><table className="aevo-data-table"><thead><tr><th>Member</th><th>Role</th><th>Store scope</th><th>Applications</th><th>Status</th></tr></thead><tbody>
        {data.members.length > 0 ? data.members.map((member) => {
          const assignments = data.memberApplications[member.membershipId] ?? [];
          const activeAssignments = assignments.filter((assignment) => assignment.status === "ACTIVE" && isLaunchApplication(assignment.applicationCode));
          return <tr key={member.membershipId}><td><strong>{member.displayName || member.email}</strong><small>{member.email}</small></td><td>{member.role}</td><td>{member.storeIds.length > 0 ? `${member.storeIds.length} scoped store${member.storeIds.length === 1 ? "" : "s"}` : "Organization"}</td><td><div className="aevo-chip-list">{activeAssignments.map((assignment) => <span className="aevo-assignment-chip" key={assignment.applicationCode}>{assignment.applicationCode}</span>)}{activeAssignments.length === 0 ? <small>No app assignment</small> : null}</div></td><td><span className={statusClass(member.status)}>{member.status}</span></td></tr>;
        }) : <tr><td colSpan={5}><span className="aevo-empty-state">Member list is restricted or empty.</span></td></tr>}
      </tbody></table></DataTable>
      {canManage ? <>
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="update-member-applications" /><h3>Assign applications to a member</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Member<Select name="membershipId" required defaultValue=""><option value="" disabled>Select a member</option>{data.members.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName || member.email}</option>)}</Select></label><label>Application store scope<Select name="applicationStoreId" defaultValue=""><option value="">Organization scope</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</Select></label></div><fieldset className="aevo-choice-fieldset"><legend>Active applications</legend><div className="aevo-choice-grid">{availableApplications.map(({ code, definition }) => <label className="aevo-choice" key={code}><input type="checkbox" name="applicationCodes" value={code} />{definition.name}</label>)}</div></fieldset><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving access…">Save application access</Button></Form>
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="invite-member" /><h3>Invite or restore a member</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Email<Input type="email" name="memberEmail" maxLength={320} required /></label><label>Name<Input name="memberName" maxLength={120} /></label><label>Role<Select name="memberRole" defaultValue="STAFF">{memberRoles.map((role) => <option key={role}>{role}</option>)}</Select></label><label>Store scope<Select name="memberStoreId" defaultValue=""><option value="">Organization scope</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</Select></label></div><fieldset className="aevo-choice-fieldset"><legend>Initial application assignments</legend><div className="aevo-choice-grid">{availableApplications.map(({ code, definition }) => <label className="aevo-choice" key={code}><input type="checkbox" name="applicationCodes" value={code} />{definition.name}</label>)}</div></fieldset><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving member…">Save member access</Button></Form>
      </> : <p className="aevo-form-hint">Member changes require <code>member.manage</code>.</p>}
    </section>
  );
}

function ApplicationSection({ data, busy }: { data: SettingsLoaderData; busy: boolean }) {
  const accessMap = new Map(data.applicationAccess.map((item) => [item.application, item]));
  const bindingLimit = data.entitlements?.limits?.store_application_bindings;
  const bindingUsage = data.entitlements?.usage?.store_application_bindings ?? 0;
  const isFreeTier = data.entitlements?.planId === "starter";
  const bindingLimitLabel = typeof bindingLimit === "number" ? String(bindingLimit) : "∞";

  const appState = data.apps.map((app) => {
    const application = runtimeApplicationForCatalogId(app);
    const access = application ? accessMap.get(application) : undefined;
    const subscription = subscriptionFor(data.subscriptions, app.id);
    const entitled = subscription?.isEntitled === true;
    return { app, application, access, subscription, entitled };
  });
  const installedApps = appState.filter(({ access, entitled }) => access?.decision.allowed === true || entitled);
  const catalogApps = appState.filter(({ access, entitled }) => access?.decision.allowed !== true && !entitled);

  function appCard(
    state: (typeof appState)[number],
    variant: "installed" | "catalog"
  ) {
    const { app, application, access, subscription, entitled } = state;
    const accessLabel = access?.decision.reason ?? (variant === "catalog" ? "Activation is managed by Core" : "No runtime access decision");
    const lifecycle = app.lifecycleStatus ?? app.status;
    const scope = app.installScope ?? (app.storeScoped === true ? "STORE" : "ORGANIZATION");
    const catalogAvailable = ["ACTIVE", "BETA"].includes(app.status) && !["DEPRECATED", "RETIRED"].includes(lifecycle);
    const catalogStatus = lifecycle === "BETA" ? "BETA" : catalogAvailable ? "CATALOG" : "UNAVAILABLE";
    const cardClass = variant === "catalog" ? "aevo-app-card aevo-app-card--catalog" : "aevo-app-card";

    return (
      <article className={cardClass} key={app.id}>
        <div className="aevo-app-card-top">
          <span className="aevo-app-icon" aria-hidden="true">{app.name.slice(0, 2).toUpperCase()}</span>
          <span className={statusClass(access?.decision.allowed ? "ALLOWED" : entitled ? "TRIAL" : variant === "catalog" ? catalogStatus : lifecycle)}>
            {access?.decision.allowed ? "Assigned" : entitled ? "Entitled" : variant === "catalog" ? lifecycle === "BETA" ? "Beta" : catalogAvailable ? "Available" : lifecycle : "Not active"}
          </span>
        </div>
        <h3>{app.name}</h3>
        <p>{app.description}</p>
        <dl className="aevo-app-facts">
          <div><dt>Scope</dt><dd>{scope}</dd></div>
          <div><dt>Lifecycle</dt><dd>{lifecycle}</dd></div>
          <div><dt>Contract</dt><dd>{app.contractVersion ?? app.manifestVersion ?? "—"}</dd></div>
        </dl>
        {variant === "installed" ? (
          <>
            <dl className="aevo-app-facts">
              <div><dt>Plan</dt><dd>{subscription?.planCode ?? "—"}</dd></div>
              <div><dt>Access</dt><dd>{accessLabel}</dd></div>
              <div><dt>Renewal</dt><dd>{formatDate(subscription?.currentPeriodEndsAt)}</dd></div>
            </dl>
            {access?.decision.allowed && (application === "PLAY" || application === "POS") ? <Form method="post"><input type="hidden" name="intent" value="launch" /><input type="hidden" name="application" value={application} /><Button variant="secondary" type="submit" busy={busy} busyLabel="Checking app…">Open {app.name}</Button></Form> : access?.decision.allowed && (application === "KIOSK" || application === "QUEUE") ? <span className="aevo-form-hint">Callback is not available for this application yet.</span> : <span className="aevo-form-hint">{entitled ? "Organization entitlement is active; member assignment controls direct entry." : access?.decision.allowed ? "Open this app from its store workspace." : "Assignment required for direct entry"}</span>}
          </>
        ) : (
          <>
            <div className="aevo-app-card__tags" aria-label={`${app.name} catalog metadata`}>
              <span>{app.origin ?? "Aevo registry"}</span>
              {app.ownerRepository ? <span>{app.ownerRepository}</span> : null}
              {app.storeScoped === true ? <span>Store workspace</span> : null}
            </div>
            <span className="aevo-form-hint">{!catalogAvailable ? "This catalog entry is not currently available for activation." : app.storeScoped === true ? "Enable this application from a store workspace after organization activation." : "Activation and assignment are managed by the Core control plane."}</span>
            {catalogAvailable && app.storeScoped === true ? <Link className="aevo-button aevo-button--secondary" to="/stores">Open store workspace</Link> : null}
          </>
        )}
      </article>
    );
  }

  return (
    <section id="applications" className="aevo-settings-section" aria-labelledby="apps-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Application control plane</span><h2 id="apps-heading">Applications & entitlements</h2><p>Subscription entitlement and runtime assignment are displayed independently. The browser never decides either one.</p></div></div>
      <div className="aevo-app-catalog">
        <section className="aevo-app-catalog__section" aria-labelledby="installed-apps-heading">
          <div className="aevo-app-catalog__heading"><div><span className="aevo-eyebrow">Organization inventory</span><h3 id="installed-apps-heading">Installed apps</h3><p>Entitled applications and server-resolved assignments available to this organization.</p></div><span className="aevo-count-badge">{installedApps.length} installed</span></div>
          {installedApps.length > 0 ? <div className="aevo-app-grid">{installedApps.map((state) => appCard(state, "installed"))}</div> : <p className="aevo-empty-state">No applications are installed or entitled for this organization yet.</p>}
        </section>
        <section className="aevo-app-catalog__section" aria-labelledby="app-catalog-heading">
          <div className="aevo-app-catalog__heading"><div><span className="aevo-eyebrow">Discover applications</span><h3 id="app-catalog-heading">App catalog</h3><p>Catalog entries are read from the Core registry. Activation, subscription, and assignment stay server-owned.</p></div><span className="aevo-count-badge">{catalogApps.length} available</span></div>
          {catalogApps.length > 0 ? <div className="aevo-app-grid">{catalogApps.map((state) => appCard(state, "catalog"))}</div> : <p className="aevo-empty-state">All registered applications are already installed or entitled.</p>}
        </section>
        {data.integrations.length > 0 ? <p className="aevo-app-catalog__note">Official plugins and tenant-wide adapters are managed in <a href="#integrations-heading">Integrations</a>. No credential is collected in the application catalog.</p> : null}
      </div>
      <div id="billing-heading" className="aevo-entitlement-summary">
        <div>
          <span className="aevo-eyebrow">Resolved entitlement state</span>
          <strong>{isFreeTier ? "Free tier" : data.entitlements?.planId ?? "—"}</strong>
          <span className={statusClass(data.entitlements?.status ?? "UNKNOWN")}>{data.entitlements?.status ?? "Unavailable"}</span>
          <small>{isFreeTier ? "One enabled application on one store" : "Features and quotas are enforced by Core."}</small>
        </div>
        <dl className="aevo-entitlement-metrics" aria-label="Billing usage">
          <div><dt>Store app usage</dt><dd>{bindingUsage} / {bindingLimitLabel}</dd></div>
          <div><dt>Store app quota</dt><dd>{isFreeTier ? "1 app · 1 store" : bindingLimitLabel === "∞" ? "Unlimited" : `${bindingLimitLabel} active bindings`}</dd></div>
        </dl>
        <ul className="aevo-permission-list">{Object.entries(data.entitlements?.features ?? {}).slice(0, 8).map(([feature, enabled]) => <li key={feature} className={enabled ? "aevo-feature-enabled" : "aevo-feature-disabled"}>{feature}: {enabled ? "on" : "off"}</li>)}</ul>
      </div>
    </section>
  );
}

function IntegrationSection({ data, canManage, busy }: { data: SettingsLoaderData; canManage: boolean; busy: boolean }) {
  return (
    <section id="integrations-heading" className="aevo-settings-section" aria-labelledby="integrations-title">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Core integration control plane</span><h2 id="integrations-title">Integrations</h2><p>Connect a supported adapter by reference. Hub never receives or stores the provider credential itself, and revocation is recorded instead of deleting the lifecycle record.</p></div><span className="aevo-count-badge">{data.integrations.length} available</span></div>
      <div className="aevo-app-grid">
        {data.integrations.map((integration) => {
          const connection = integration.connection;
          const connected = connection?.status === "ACTIVE" && connection.secretConfigured;
          return <article className="aevo-app-card" key={integration.providerCode}>
            <div className="aevo-app-card-top"><span className="aevo-app-icon" aria-hidden="true">LI</span><StatusBadge tone={statusTone(connection?.status ?? "UNAVAILABLE")}>{connected ? "Connected" : connection?.status ?? "Not connected"}</StatusBadge></div>
            <h3>{integration.name}</h3>
            <p>{integration.description}</p>
            <dl className="aevo-app-facts"><div><dt>Manifest</dt><dd>{integration.manifestVersion}</dd></div><div><dt>Owner adapter</dt><dd>{integration.ownerRepository}</dd></div><div><dt>Scopes</dt><dd>{integration.scopes.join(", ") || "—"}</dd></div></dl>
            {canManage ? <>
              <Form method="post" className="aevo-inline-form">
                <input type="hidden" name="intent" value={connected ? "rotate-integration" : "connect-integration"} />
                <input type="hidden" name="providerCode" value={integration.providerCode} />
                <label>Secret reference<Input name="secretRef" placeholder="secret://aevo/line/production" maxLength={256} required /></label>
                <label className="aevo-choice"><input type="checkbox" name="consent" value="true" required />I approve this tenant connection and requested scopes.</label>
                <Button variant={connected ? "secondary" : "primary"} type="submit" busy={busy} busyLabel={connected ? "Rotating…" : "Connecting…"}>{connected ? "Rotate secret reference" : "Connect integration"}</Button>
              </Form>
              {connected ? <Form method="post" className="aevo-form-actions"><input type="hidden" name="intent" value="disconnect-integration" /><input type="hidden" name="providerCode" value={integration.providerCode} /><Button variant="ghost" type="submit" busy={busy} busyLabel="Revoking…">Revoke connection</Button></Form> : null}
            </> : <span className="aevo-form-hint">Integration management permission is required to change this connection.</span>}
          </article>;
        })}
      </div>
    </section>
  );
}

function auditActionLabel(action: string): string {
  return action
    .replace(/^HUB_/u, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/gu, (character) => character.toUpperCase());
}

function formatAuditDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function SettingsOverview({ data }: { data: SettingsLoaderData }) {
  const activeApps = data.applicationAccess.filter(({ decision }) => decision.allowed).length;
  const activeStores = data.stores.filter((store) => (store.status ?? "ACTIVE") === "ACTIVE");
  const recentLogs = data.auditLogs.slice(0, 4);
  return (
    <section className="aevo-settings-overview" aria-label="Organization settings overview">
      <div className="aevo-settings-metric-grid">
        <article className="aevo-settings-metric"><span>Active stores</span><strong>{activeStores.length.toString().padStart(2, "0")}</strong><small>Store settings are isolated per workspace</small></article>
        <article className="aevo-settings-metric"><span>Connected apps</span><strong>{activeApps.toString().padStart(2, "0")}</strong><small>Server-checked application access</small></article>
        <article className="aevo-settings-metric"><span>Team members</span><strong>{data.members.length.toString().padStart(2, "0")}</strong><small>Organization membership and scope</small></article>
      </div>
      <div className="aevo-settings-overview-grid">
        <section className="aevo-settings-mini-card" aria-labelledby="recent-activity-heading">
          <div className="aevo-mini-card-heading"><div><span className="aevo-eyebrow">Audit trail</span><h2 id="recent-activity-heading">Recent account activity</h2></div><Link to="/settings#applications">View settings</Link></div>
          {recentLogs.length > 0 ? <ul className="aevo-activity-list">{recentLogs.map((log) => <li key={log.id}><span>{auditActionLabel(log.action)}</span><time dateTime={log.createdAt}>{formatAuditDate(log.createdAt)}</time></li>)}</ul> : <p className="aevo-empty-state">No recent activity is available for this organization.</p>}
        </section>
        <section className="aevo-settings-mini-card" aria-labelledby="security-summary-heading">
          <div className="aevo-mini-card-heading"><div><span className="aevo-eyebrow">Account protection</span><h2 id="security-summary-heading">Security &amp; access</h2></div><StatusBadge tone="success">Protected</StatusBadge></div>
          <p>Your workspace uses server-checked sessions, role permissions, and an immutable audit trail for sensitive changes.</p>
          <Link className="aevo-button aevo-button--secondary aevo-button--small" to="/security">Review security</Link>
        </section>
      </div>
    </section>
  );
}

export default function Settings() {
  const data = useLoaderData() as SettingsLoaderData;
  const actionData = useActionData() as SettingsActionResult | undefined;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  if (data.permissionDenied || !data.organization) return <SettingsPermissionDenied permission={data.permissionDenied} />;

  const canManageOrganization = hasHubPermission(data.hub, "organization.manage");
  const canManageMembers = hasHubPermission(data.hub, "member.manage");
  const updated = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("updated");

  return (
    <>
      <Breadcrumbs className="aevo-page-breadcrumb" items={[{ label: "Hub", href: "/" }, { label: "Organization settings" }]} />
      <section className="aevo-page-heading">
        <div><StatusBadge tone="success">Server-checked settings</StatusBadge><h1>{data.organization.name}</h1><p>Organization, team, and application state now loads through the modern Hub route. Store and branch operations are available from the dedicated Stores &amp; branches area.</p></div>
        <Link className="aevo-button aevo-button--secondary" to="/">Back to overview</Link>
      </section>
      <section className="aevo-scope-banner" aria-label="Organization scope">
        <div><span className="aevo-eyebrow">Organization workspace</span><strong>{data.organization.name}</strong><p>Changes on this page apply to the organization. Select a store from the context picker before changing store-specific settings.</p></div>
        <StatusBadge tone="info">Organization scope</StatusBadge>
      </section>
      {actionData?.ok === false ? <div className="aevo-inline-alert aevo-inline-alert--error" role="alert">{actionData.message}</div> : updated ? <div className="aevo-inline-alert" role="status">Saved {updated} successfully.</div> : null}
      {isSubmitting ? <div className="aevo-loading-strip" role="status">Saving securely…</div> : null}
      <div className="aevo-settings-stack">
        <SettingsOverview data={data} />
        <section className="aevo-settings-section" aria-labelledby="profile-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Organization layer</span><h2 id="profile-heading">Profile & defaults</h2><p>These defaults apply to the organization and are enforced again by the API.</p></div></div><OrganizationForm organization={data.organization} canManage={canManageOrganization} busy={isSubmitting} /></section>
        <TeamSection data={data} canManage={canManageMembers} busy={isSubmitting} />
        <IntegrationSection data={data} canManage={hasHubPermission(data.hub, "integration.manage")} busy={isSubmitting} />
        <ApplicationSection data={data} busy={isSubmitting} />
      </div>
    </>
  );
}
