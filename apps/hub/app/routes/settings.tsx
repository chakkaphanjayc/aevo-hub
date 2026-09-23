import type {
  AppDefinition,
  AppSubscriptionSummary,
  CustomerStoreProfile,
  MemberApplicationAssignmentSummary,
  MemberSummary,
  Permission,
  ResolvedEntitlements,
  StoreTemplateSummary,
  StoreSummary
} from "@aevo/contracts";
import { ApiClientError } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import type { AccessDecisionResponse, ApplicationCode } from "@aevocado/api-contract";
import { Breadcrumbs, Button, DataTable, Input, PermissionDeniedState, Select, StatusBadge } from "@aevocado/design-system";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createHubApiClient,
  requireHubAccess,
  requestCsrfHeaders
} from "../lib/auth.server";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";

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

interface ApplicationAccessView {
  application: LaunchApplication;
  decision: AccessDecisionResponse;
  url?: string;
}

export interface SettingsLoaderData {
  hub: HubLoaderData;
  organization: OrganizationProfile | null;
  stores: StoreSummary[];
  templates: StoreTemplateSummary[];
  customerProfiles: Record<string, CustomerStoreProfile | null>;
  members: MemberSummary[];
  memberApplications: Record<string, MemberApplicationAssignmentSummary[]>;
  apps: AppDefinition[];
  subscriptions: AppSubscriptionSummary[];
  entitlements: ResolvedEntitlements | null;
  applicationAccess: ApplicationAccessView[];
  permissionDenied?: Permission;
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

interface CustomerProfileUpdateBody {
  publicSlug: string;
  publicEnabled: boolean;
  area: string;
  category: string;
  priceRange: string;
  availabilityLabel?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  mediaUrls?: string[];
  facilities?: string[];
  policySummary?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rating?: number | null;
  reviewCount?: number;
}

const launchApplications = ["PLAY", "POS", "KIOSK", "QUEUE"] as const satisfies readonly LaunchApplication[];
// Keep this list aligned with the gateway's member mutation contract. The
// broader role model also contains app-specific roles, but the current Hub
// member endpoint only accepts these organization roles.
const memberRoles = ["ADMIN", "BRANCH_MANAGER", "CASHIER", "KITCHEN", "STAFF", "VIEWER"] as const;
const storeModes = ["POS", "KIOSK", "BOOKING", "POS_BOOKING", "CUSTOM"] as const;
const applicationLabels: Record<LaunchApplication, string> = {
  PLAY: "Play booking",
  POS: "POS operations",
  KIOSK: "Kiosk",
  QUEUE: "Queue display"
};

function applicationUrl(application: LaunchApplication): string | undefined {
  const configured = application === "PLAY"
    ? process.env.AEVO_PLAY_URL
    : application === "POS"
      ? process.env.AEVO_POS_URL
      : undefined;
  if (!configured?.trim()) return undefined;
  try {
    const parsed = new URL(configured.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
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
    customerProfiles: {},
    members: [],
    memberApplications: {},
    apps: [],
    subscriptions: [],
    entitlements: null,
    applicationAccess: [],
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

function optionalLineList(form: FormData, name: string, maximumItemLength: number, maximumItems: number): string[] {
  const value = String(form.get(name) ?? "");
  const items = value.split(/\r?\n|,/u).map((item) => item.trim()).filter(Boolean);
  if (items.length > maximumItems || items.some((item) => item.length > maximumItemLength)) {
    throw new Error(`${name} contains too many or too-long values`);
  }
  return [...new Set(items)];
}

function optionalNumberValue(form: FormData, name: string, minimum: number, maximum: number): number | null {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function optionalIntegerValue(form: FormData, name: string, minimum: number, maximum: number): number | null {
  const value = optionalNumberValue(form, name, minimum, maximum);
  if (value !== null && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function optionalHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
    return parsed.toString();
  } catch {
    throw new Error("imageUrl must be an http(s) URL");
  }
}

function defaultPublicSlug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63);
  return normalized || "store";
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 320;
}

function isLaunchApplication(value: string): value is LaunchApplication {
  return launchApplications.includes(value as LaunchApplication);
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

export async function loader({ request }: LoaderFunctionArgs): Promise<SettingsLoaderData> {
  const requestPath = logicalPathname(request);
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
    const [organizationResult, storesResult, templatesResult] = await Promise.all([
      api.request<{ organization: OrganizationProfile }>(`/api/v1/hub/organizations/${encodeURIComponent(organizationId)}`),
      canReadStores
        ? api.request<{ stores: StoreSummary[] }>(`/api/v1/hub/stores?organizationId=${encodeURIComponent(organizationId)}`)
        : Promise.resolve({ stores: [] as StoreSummary[] }),
      canReadStores
        ? api.request<{ templates: StoreTemplateSummary[] }>("/api/v1/hub/store-templates").catch((error: unknown) => {
            // Templates are additive. During a rolling dev restart an older
            // gateway may not expose this optional endpoint yet; keep the
            // Stores workspace usable and hide the template controls instead
            // of failing the entire route.
            if (error instanceof ApiClientError && error.status === 404) return { templates: [] };
            throw error;
          })
        : Promise.resolve({ templates: [] as StoreTemplateSummary[] })
    ]);
    const customerProfileEntries = canReadStores
      ? await Promise.all(storesResult.stores.map(async (store) => {
          const response = await api.request<{ profile: CustomerStoreProfile | null }>(
            `/api/v1/hub/stores/${encodeURIComponent(store.id)}/customer-profile`
          );
          return [store.id, response.profile] as const;
        }))
      : [];
    return {
      ...emptySettings(hub),
      organization: organizationResult.organization,
      stores: storesResult.stores,
      templates: templatesResult.templates,
      customerProfiles: Object.fromEntries(customerProfileEntries)
    };
  }

  const [organizationResult, storesResult, membersResult, appsResult, subscriptionsResult, entitlementsResult, applicationAccess] = await Promise.all([
    api.request<{ organization: OrganizationProfile }>(`/api/v1/hub/organizations/${encodeURIComponent(organizationId)}`),
    canReadStores
      ? api.request<{ stores: StoreSummary[] }>(`/api/v1/hub/stores?organizationId=${encodeURIComponent(organizationId)}`)
      : Promise.resolve({ stores: [] as StoreSummary[] }),
    canManageMembers
      ? api.request<{ members: MemberSummary[] }>("/api/v1/hub/members")
      : Promise.resolve({ members: [] as MemberSummary[] }),
    api.request<{ apps: AppDefinition[] }>("/api/v1/hub/apps"),
    api.request<{ subscriptions: AppSubscriptionSummary[] }>("/api/v1/hub/subscriptions"),
    api.request<{ success: true; entitlements: ResolvedEntitlements }>("/api/v1/me/entitlements"),
    Promise.all(launchApplications.map(async (application): Promise<ApplicationAccessView> => ({
      application,
      decision: await api.request<AccessDecisionResponse>(`/api/v1/access?application=${application}`),
      ...(applicationUrl(application) ? { url: applicationUrl(application) } : {})
    })))
  ]);
  // These reads are independent. Keep the settings page's tail latency equal
  // to the slower group instead of adding profile and assignment latency.
  const [customerProfileEntries, memberApplicationEntries] = await Promise.all([
    canReadStores
      ? Promise.all(storesResult.stores.map(async (store) => {
          const response = await api.request<{ profile: CustomerStoreProfile | null }>(
            `/api/v1/hub/stores/${encodeURIComponent(store.id)}/customer-profile`
          );
          return [store.id, response.profile] as const;
        }))
      : Promise.resolve([] as Array<readonly [string, CustomerStoreProfile | null]>),
    canManageMembers
      ? Promise.all(membersResult.members.map(async (member) => {
          const response = await api.request<{ assignments: MemberApplicationAssignmentSummary[] }>(
            `/api/v1/hub/members/${encodeURIComponent(member.membershipId)}/applications`
          );
          return [member.membershipId, response.assignments] as const;
        }))
      : Promise.resolve([] as Array<readonly [string, MemberApplicationAssignmentSummary[]]>)
  ]);

  return {
    hub,
    organization: organizationResult.organization,
    stores: storesResult.stores,
    templates: [],
    customerProfiles: Object.fromEntries(customerProfileEntries),
    members: membersResult.members,
    memberApplications: Object.fromEntries(memberApplicationEntries),
    apps: appsResult.apps,
    subscriptions: subscriptionsResult.subscriptions,
    entitlements: entitlementsResult.entitlements,
    applicationAccess
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | SettingsActionResult> {
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

    if (intent === "update-customer-profile") {
      if (!hasHubPermission(hub, "store.manage") && !hasHubPermission(hub, "organization.manage")) {
        return { ok: false, message: "You do not have store management permission." };
      }
      const storeId = textValue(form, "customerProfileStoreId", 64, true);
      const publicSlug = textValue(form, "publicSlug", 63, true).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(publicSlug)) return { ok: false, message: "Use lowercase letters, numbers, and hyphens for the public slug." };
      const imageUrl = optionalHttpUrl(optionalTextValue(form, "imageUrl", 2000));
      const mediaUrls = optionalLineList(form, "mediaUrls", 2000, 24).map((value) => optionalHttpUrl(value)).filter((value): value is string => value !== null);
      const body: CustomerProfileUpdateBody = {
        publicSlug,
        publicEnabled: form.get("publicEnabled") === "true",
        area: textValue(form, "area", 120, true),
        category: textValue(form, "category", 80, true),
        priceRange: textValue(form, "priceRange", 16, true),
        availabilityLabel: optionalTextValue(form, "availabilityLabel", 120) || null,
        description: optionalTextValue(form, "description", 1000) || null,
        imageUrl,
        mediaUrls,
        facilities: optionalLineList(form, "facilities", 120, 24),
        policySummary: optionalTextValue(form, "policySummary", 2000) || null,
        latitude: optionalNumberValue(form, "latitude", -90, 90),
        longitude: optionalNumberValue(form, "longitude", -180, 180),
        rating: optionalNumberValue(form, "rating", 0, 5),
        reviewCount: optionalIntegerValue(form, "reviewCount", 0, 2_000_000) ?? 0
      };
      await api.requestJson<{ success: true }, CustomerProfileUpdateBody>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/customer-profile`, {
        method: "PUT",
        headers: requestCsrfHeaders(request),
        body
      });
      return redirect(settingsReturnPath(request, "updated=customer-profile"));
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
      await Promise.all(launchApplications.map((applicationCode) => api.requestJson(
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
      const decision = await api.request<AccessDecisionResponse>(`/api/v1/access?application=${application}`);
      if (!isAccessAllowed(decision)) return { ok: false, message: `Application access denied: ${decision.reason}.` };
      return { ok: false, message: "This application is assigned, but no launch URL is configured for this environment." };
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

function runtimeApplicationForCatalogId(appId: string): LaunchApplication | undefined {
  if (appId === "booking") return "PLAY";
  const application = appId.toUpperCase();
  return isLaunchApplication(application) ? application : undefined;
}

function statusClass(status: string): string {
  if (["ACTIVE", "TRIAL", "TRIALING", "ALLOWED"].includes(status)) return "aevo-status aevo-status--success";
  if (["PAST_DUE", "GRACE_PERIOD", "SUSPENDED"].includes(status)) return "aevo-status aevo-status--warning";
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

function CustomerProfileForm({ store, profile, canManage, busy }: { store: StoreSummary; profile: CustomerStoreProfile | null; canManage: boolean; busy: boolean }) {
  return (
    <Form method="post" className="aevo-inline-form aevo-customer-profile-form">
      <input type="hidden" name="intent" value="update-customer-profile" />
      <input type="hidden" name="customerProfileStoreId" value={store.id} />
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Aevo Go public projection</span><h3>{store.name}</h3><p>ข้อมูลชุดนี้เท่านั้นที่จะถูกเผยแพร่ให้ Customer App เห็นเมื่อเปิดใช้งาน</p></div><label className="aevo-choice"><input type="checkbox" name="publicEnabled" value="true" defaultChecked={profile?.publicEnabled === true} disabled={!canManage} />เปิด public profile</label></div>
      <div className="aevo-form-grid aevo-form-grid--compact">
        <label>Public slug<Input name="publicSlug" defaultValue={profile?.publicSlug ?? ""} maxLength={63} placeholder="north-star-coffee" required disabled={!canManage} /></label>
        <label>Area<Input name="area" defaultValue={profile?.area ?? ""} maxLength={120} placeholder="Ari" required disabled={!canManage} /></label>
        <label>Category<Input name="category" defaultValue={profile?.category ?? ""} maxLength={80} placeholder="Cafe" required disabled={!canManage} /></label>
        <label>Price range<Input name="priceRange" defaultValue={profile?.priceRange ?? "฿฿"} maxLength={16} required disabled={!canManage} /></label>
        <label>Availability label<Input name="availabilityLabel" defaultValue={profile?.availabilityLabel ?? ""} maxLength={120} disabled={!canManage} /></label>
        <label>Hero image URL<Input name="imageUrl" type="url" defaultValue={profile?.imageUrl ?? ""} maxLength={2000} disabled={!canManage} /></label>
        <label>Latitude<Input name="latitude" type="number" step="any" min={-90} max={90} defaultValue={profile?.latitude ?? ""} disabled={!canManage} /></label>
        <label>Longitude<Input name="longitude" type="number" step="any" min={-180} max={180} defaultValue={profile?.longitude ?? ""} disabled={!canManage} /></label>
        <label>Rating<Input name="rating" type="number" step="0.01" min={0} max={5} defaultValue={profile?.rating ?? ""} disabled={!canManage} /></label>
        <label>Review count<Input name="reviewCount" type="number" min={0} defaultValue={profile?.reviewCount ?? 0} disabled={!canManage} /></label>
        <label className="aevo-field--wide">Description<textarea name="description" maxLength={1000} defaultValue={profile?.description ?? ""} disabled={!canManage} /></label>
        <label className="aevo-field--wide">Gallery URLs<textarea name="mediaUrls" maxLength={24 * 2000} placeholder="หนึ่ง URL ต่อบรรทัด" defaultValue={profile?.mediaUrls.join("\n") ?? ""} disabled={!canManage} /></label>
        <label className="aevo-field--wide">Facilities<textarea name="facilities" maxLength={24 * 120} placeholder="Wi-Fi, Parking" defaultValue={profile?.facilities.join(", ") ?? ""} disabled={!canManage} /></label>
        <label className="aevo-field--wide">Policy summary<textarea name="policySummary" maxLength={2000} defaultValue={profile?.policySummary ?? ""} disabled={!canManage} /></label>
      </div>
      {canManage ? <Button variant="secondary" type="submit" busy={busy} busyLabel="Saving public profile…">Save Customer App profile</Button> : <p className="aevo-form-hint">Public profile changes require <code>store.manage</code>.</p>}
    </Form>
  );
}

export function StoreSection({ data, canManage, busy }: { data: SettingsLoaderData; canManage: boolean; busy: boolean }) {
  return (
    <section className="aevo-settings-section" aria-labelledby="stores-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Tenant structure</span><h2 id="stores-heading">Stores & branches</h2><p>Store scope is resolved by the gateway and remains separate from Hub access.</p></div><span className="aevo-count-badge">{data.stores.length} active</span></div>
      <DataTable className="aevo-table-wrap">
        <table className="aevo-data-table"><thead><tr><th>Name</th><th>Code</th><th>Mode</th><th>Timezone</th><th>Status</th><th>Open</th></tr></thead><tbody>
          {data.stores.length > 0 ? data.stores.map((store) => <tr key={store.id}><td><Link className="aevo-table-link" to={`/stores/${encodeURIComponent(store.id)}`}>{store.name}</Link><small>{store.address || "No address"}</small></td><td><code>{store.code}</code></td><td>{store.storeMode ?? "—"}</td><td>{store.timezone}</td><td><span className={statusClass(store.status ?? "ACTIVE")}>{store.status ?? "ACTIVE"}</span></td><td><Link className="aevo-button aevo-button--secondary aevo-button--small" to={`/stores/${encodeURIComponent(store.id)}`}>Open store</Link></td></tr>) : <tr><td colSpan={6}><span className="aevo-empty-state">No accessible stores were returned.</span></td></tr>}
        </tbody></table>
      </DataTable>
      {data.stores.map((store) => <CustomerProfileForm key={store.id} store={store} profile={data.customerProfiles[store.id] ?? null} canManage={canManage} busy={busy} />)}
      {canManage ? <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-store" /><h3>Add a store</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Store name<Input name="storeName" maxLength={160} required /></label><label>Code<Input name="storeCode" maxLength={32} required /></label><label>Mode<Select name="storeMode" defaultValue="POS">{storeModes.map((mode) => <option key={mode}>{mode}</option>)}</Select></label><label>Timezone<Input name="storeTimezone" defaultValue={data.organization?.timezone ?? "Asia/Bangkok"} maxLength={64} /></label><label>Currency<Input name="storeCurrency" defaultValue={data.organization?.currency ?? "THB"} maxLength={8} /></label></div><Button variant="secondary" type="submit" busy={busy} busyLabel="Creating store…">Create store</Button></Form> : <p className="aevo-form-hint">Store creation is restricted to organization managers.</p>}
      {canManage && data.templates.length > 0 ? <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-store-from-template" /><h3>Create from template</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Template<Select name="templateId" required defaultValue=""><option value="" disabled>Select a saved template</option>{data.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</Select></label><label>Store name<Input name="templateStoreName" maxLength={160} required /></label><label>Code<Input name="templateStoreCode" maxLength={32} required /></label><label>Public slug<Input name="templatePublicSlug" maxLength={63} /></label></div><Button variant="primary" type="submit" busy={busy} busyLabel="Creating from template…">Create store from template</Button></Form> : null}
    </section>
  );
}

function TeamSection({ data, canManage, busy }: { data: SettingsLoaderData; canManage: boolean; busy: boolean }) {
  return (
    <section className="aevo-settings-section" aria-labelledby="team-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Access boundary</span><h2 id="team-heading">Team & access</h2><p>Membership, application assignment, and store scope are separate authorization layers.</p></div><span className="aevo-count-badge">{data.members.length} members</span></div>
      <DataTable className="aevo-table-wrap"><table className="aevo-data-table"><thead><tr><th>Member</th><th>Role</th><th>Store scope</th><th>Applications</th><th>Status</th></tr></thead><tbody>
        {data.members.length > 0 ? data.members.map((member) => {
          const assignments = data.memberApplications[member.membershipId] ?? [];
          const activeAssignments = assignments.filter((assignment) => assignment.status === "ACTIVE" && isLaunchApplication(assignment.applicationCode));
          return <tr key={member.membershipId}><td><strong>{member.displayName || member.email}</strong><small>{member.email}</small></td><td>{member.role}</td><td>{member.storeIds.length > 0 ? `${member.storeIds.length} scoped store${member.storeIds.length === 1 ? "" : "s"}` : "Organization"}</td><td><div className="aevo-chip-list">{activeAssignments.map((assignment) => <span className="aevo-assignment-chip" key={assignment.applicationCode}>{assignment.applicationCode}</span>)}{activeAssignments.length === 0 ? <small>No app assignment</small> : null}</div></td><td><span className={statusClass(member.status)}>{member.status}</span></td></tr>;
        }) : <tr><td colSpan={5}><span className="aevo-empty-state">Member list is restricted or empty.</span></td></tr>}
      </tbody></table></DataTable>
      {canManage ? <>
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="update-member-applications" /><h3>Assign applications to a member</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Member<Select name="membershipId" required defaultValue=""><option value="" disabled>Select a member</option>{data.members.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName || member.email}</option>)}</Select></label><label>Application store scope<Select name="applicationStoreId" defaultValue=""><option value="">Organization scope</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</Select></label></div><fieldset className="aevo-choice-fieldset"><legend>Active applications</legend><div className="aevo-choice-grid">{launchApplications.map((application) => <label className="aevo-choice" key={application}><input type="checkbox" name="applicationCodes" value={application} />{applicationLabels[application]}</label>)}</div></fieldset><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving access…">Save application access</Button></Form>
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="invite-member" /><h3>Invite or restore a member</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>Email<Input type="email" name="memberEmail" maxLength={320} required /></label><label>Name<Input name="memberName" maxLength={120} /></label><label>Role<Select name="memberRole" defaultValue="STAFF">{memberRoles.map((role) => <option key={role}>{role}</option>)}</Select></label><label>Store scope<Select name="memberStoreId" defaultValue=""><option value="">Organization scope</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</Select></label></div><fieldset className="aevo-choice-fieldset"><legend>Initial application assignments</legend><div className="aevo-choice-grid">{launchApplications.map((application) => <label className="aevo-choice" key={application}><input type="checkbox" name="applicationCodes" value={application} />{applicationLabels[application]}</label>)}</div></fieldset><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving member…">Save member access</Button></Form>
      </> : <p className="aevo-form-hint">Member changes require <code>member.manage</code>.</p>}
    </section>
  );
}

function ApplicationSection({ data }: { data: SettingsLoaderData }) {
  const accessMap = new Map(data.applicationAccess.map((item) => [item.application, item]));
  return (
    <section className="aevo-settings-section" aria-labelledby="apps-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Application control plane</span><h2 id="apps-heading">Applications & entitlements</h2><p>Subscription entitlement and runtime assignment are displayed independently. The browser never decides either one.</p></div></div>
      <div className="aevo-app-grid">{data.apps.map((app) => {
        const application = runtimeApplicationForCatalogId(app.id);
        const access = application ? accessMap.get(application) : undefined;
        const subscription = subscriptionFor(data.subscriptions, app.id);
        const entitled = subscription?.isEntitled === true;
        return <article className="aevo-app-card" key={app.id}><div className="aevo-app-card-top"><span className="aevo-app-icon" aria-hidden="true">{app.name.slice(0, 2).toUpperCase()}</span><span className={statusClass(access?.decision.allowed ? "ALLOWED" : entitled ? "TRIAL" : "UNAVAILABLE")}>{access?.decision.allowed ? "Assigned" : entitled ? "Entitled" : "Not active"}</span></div><h3>{app.name}</h3><p>{app.description}</p><dl className="aevo-app-facts"><div><dt>Plan</dt><dd>{subscription?.planCode ?? "—"}</dd></div><div><dt>Access</dt><dd>{access?.decision.reason ?? "Not a first-party runtime"}</dd></div><div><dt>Renewal</dt><dd>{formatDate(subscription?.currentPeriodEndsAt)}</dd></div></dl>{access?.decision.allowed && access.url ? <a className="aevo-button aevo-button--secondary" href={access.url} target="_blank" rel="noreferrer">Open {app.name}</a> : <span className="aevo-form-hint">{access?.decision.allowed ? "Launch URL is not configured locally" : "Assignment required for direct entry"}</span>}</article>;
      })}</div>
      <div className="aevo-entitlement-summary"><div><span className="aevo-eyebrow">Resolved entitlement state</span><strong>{data.entitlements?.planId ?? "—"}</strong><span className={statusClass(data.entitlements?.status ?? "UNKNOWN")}>{data.entitlements?.status ?? "Unavailable"}</span></div><ul className="aevo-permission-list">{Object.entries(data.entitlements?.features ?? {}).slice(0, 8).map(([feature, enabled]) => <li key={feature} className={enabled ? "aevo-feature-enabled" : "aevo-feature-disabled"}>{feature}: {enabled ? "on" : "off"}</li>)}</ul></div>
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
      {actionData?.ok === false ? <div className="aevo-inline-alert aevo-inline-alert--error" role="alert">{actionData.message}</div> : updated ? <div className="aevo-inline-alert" role="status">Saved {updated} successfully.</div> : null}
      {isSubmitting ? <div className="aevo-loading-strip" role="status">Saving securely…</div> : null}
      <div className="aevo-settings-stack">
        <section className="aevo-settings-section" aria-labelledby="profile-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Organization layer</span><h2 id="profile-heading">Profile & defaults</h2><p>These defaults apply to the organization and are enforced again by the API.</p></div></div><OrganizationForm organization={data.organization} canManage={canManageOrganization} busy={isSubmitting} /></section>
        <TeamSection data={data} canManage={canManageMembers} busy={isSubmitting} />
        <ApplicationSection data={data} />
      </div>
    </>
  );
}
