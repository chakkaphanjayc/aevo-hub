import type { AppDefinition, MemberSummary, Permission, StoreSummary } from "@aevocado/contracts";
import { ApiClientError } from "@aevocado/contracts";
import { Button, StatusBadge } from "@aevocado/design-system";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { isAccessAllowed } from "@aevocado/app-access";
import { CapabilityNotice, PlatformPage, StructuredRecordsToolbar } from "../components/platform-settings";
import { createHubApiClient, invalidateHubAccessCache, requestCsrfHeaders, requireHubAccess } from "../lib/auth.server";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";
import { paginate, parseStructuredListQuery, queryWithPage, type StructuredListQuery } from "../lib/structured-list";
import "../platform-settings.css";

const organizationRoles = ["ADMIN", "BRANCH_MANAGER", "CASHIER", "KITCHEN", "STAFF", "VIEWER"] as const;
const supportedApplications = ["PLAY", "POS", "KIOSK", "QUEUE"] as const;
const listOptions = {
  columns: ["member", "role", "status", "scope", "applications"],
  defaultColumns: ["member", "role", "status", "scope", "applications"],
  sorts: ["name", "email", "role", "status", "createdAt"],
  pageSizes: [10, 25, 50],
} as const;

interface CoreAssignmentScope {
  scopeType: string;
  scopeRef: string;
}

interface CoreMemberApplicationAssignment {
  id: string;
  membershipId: string;
  applicationCode: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  startsAt: string;
  expiresAt?: string | null;
  scopes: CoreAssignmentScope[];
}

export interface AccessLoaderData {
  hub: HubLoaderData;
  members: MemberSummary[];
  assignments: CoreMemberApplicationAssignment[];
  apps: AppDefinition[];
  stores: StoreSummary[];
  query: StructuredListQuery;
  filteredMembers: MemberSummary[];
  page: ReturnType<typeof paginate<MemberSummary>>;
  totalMembers: number;
  permissionDenied?: Permission;
  loadError?: string;
  scopeNamesUnavailable?: boolean;
  search: string;
}

export interface AccessActionResult {
  ok: boolean;
  message: string;
}

export function meta() {
  return [{ title: "Team & access | Aevo Hub" }];
}

function listParams(url: URL): StructuredListQuery {
  return parseStructuredListQuery(url.searchParams, listOptions);
}

function filterMembers(
  members: MemberSummary[],
  assignments: CoreMemberApplicationAssignment[],
  query: StructuredListQuery,
): MemberSummary[] {
  const needle = query.q.toLocaleLowerCase();
  const assignmentsByMember = new Map<string, CoreMemberApplicationAssignment[]>();
  for (const assignment of assignments) {
    const group = assignmentsByMember.get(assignment.membershipId) ?? [];
    group.push(assignment);
    assignmentsByMember.set(assignment.membershipId, group);
  }
  return members
    .filter((member) => {
      if (needle && !`${member.displayName} ${member.email} ${member.role}`.toLocaleLowerCase().includes(needle)) return false;
      if (query.role && member.role !== query.role) return false;
      if (query.status && member.status !== query.status) return false;
      if (query.scope) {
        const hasStoreScope = (assignmentsByMember.get(member.membershipId) ?? []).some((assignment) => assignment.scopes.length > 0);
        if (query.scope === "Store" && !hasStoreScope) return false;
        if (query.scope === "Organization" && hasStoreScope) return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftValue = query.sort === "email" ? left.email : query.sort === "role" ? left.role : query.sort === "status" ? left.status : query.sort === "createdAt" ? left.createdAt : left.displayName;
      const rightValue = query.sort === "email" ? right.email : query.sort === "role" ? right.role : query.sort === "status" ? right.status : query.sort === "createdAt" ? right.createdAt : right.displayName;
      const compared = leftValue.localeCompare(rightValue, undefined, { sensitivity: "base" });
      return query.direction === "desc" ? -compared : compared;
    });
}

export async function loader({ request }: LoaderFunctionArgs): Promise<AccessLoaderData> {
  const hub = await requireHubAccess(request, "/access");
  const url = new URL(request.url);
  const query = listParams(url);
  const deniedBase = { hub, members: [], assignments: [], apps: [], stores: [], query, filteredMembers: [], page: paginate<MemberSummary>([], query.page, query.pageSize), totalMembers: 0, search: url.search };
  if (!isAccessAllowed(hub.access)) return { ...deniedBase, permissionDenied: "member.manage" };
  if (!hasHubPermission(hub, "member.manage")) return { ...deniedBase, permissionDenied: "member.manage" };

  const api = createHubApiClient(request);
  try {
    const [membersResult, assignmentsResult, appsResult] = await Promise.all([
      api.request<{ success: true; members: MemberSummary[] }>("/api/v1/hub/members"),
      api.request<{ success: true; assignments: CoreMemberApplicationAssignment[] }>("/api/v1/hub/members/applications"),
      api.request<{ apps: AppDefinition[] }>("/api/v1/hub/apps"),
    ]);
    const canReadStores = hasHubPermission(hub, "store.read");
    const stores = canReadStores
      ? hub.stores.filter((store) => !hub.access.organizationId || store.organizationId === hub.access.organizationId)
      : [];
    const filteredMembers = filterMembers(membersResult.members, assignmentsResult.assignments, query);
    return {
      ...deniedBase,
      members: membersResult.members,
      assignments: assignmentsResult.assignments,
      apps: appsResult.apps,
      stores,
      query,
      filteredMembers,
      page: paginate(filteredMembers, query.page, query.pageSize),
      totalMembers: membersResult.members.length,
      scopeNamesUnavailable: !canReadStores,
      search: url.search,
    };
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
      return { ...deniedBase, permissionDenied: "member.manage" };
    }
    return { ...deniedBase, loadError: error instanceof Error ? error.message : "Core could not load organization access." };
  }
}

function formText(form: FormData, name: string, maximum: number): string {
  const value = String(form.get(name) ?? "").trim();
  if (!value || value.length > maximum) throw new Error(`Choose a valid ${name}.`);
  return value;
}

export async function action({ request }: ActionFunctionArgs): Promise<AccessActionResult> {
  invalidateHubAccessCache(request.headers.get("cookie") ?? undefined);
  const hub = await requireHubAccess(request, "/access");
  if (!isAccessAllowed(hub.access) || !hasHubPermission(hub, "member.manage")) {
    return { ok: false, message: "Core requires member.manage permission for this change." };
  }
  const form = await request.formData();
  const api = createHubApiClient(request);
  try {
    if (form.get("confirmed") !== "true") return { ok: false, message: "Confirm the impact before saving this access change." };
    const membershipId = formText(form, "membershipId", 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(membershipId)) {
      return { ok: false, message: "The membership identifier is invalid." };
    }
    if (form.get("intent") === "change-role") {
      const role = formText(form, "role", 40);
      if (!organizationRoles.some((candidate) => candidate === role)) return { ok: false, message: "Choose a supported organization role." };
      const result = await api.requestJson<{ success: true; member: MemberSummary }, { role: string }>(
        `/api/v1/hub/members/${encodeURIComponent(membershipId)}`,
        { method: "PATCH", headers: requestCsrfHeaders(request), body: { role } },
      );
      return { ok: true, message: `Core saved ${result.member.displayName || result.member.email} as ${result.member.role}.` };
    }
    if (form.get("intent") === "save-assignment") {
      const applicationCode = formText(form, "applicationCode", 24);
      if (!supportedApplications.some((candidate) => candidate === applicationCode)) return { ok: false, message: "Choose a supported application." };
      const statusValue = formText(form, "status", 16);
      if (statusValue !== "ACTIVE" && statusValue !== "REVOKED") return { ok: false, message: "Choose Active or Revoked." };
      const scopeMode = formText(form, "scopeMode", 16);
      const requestedStoreIds = form.getAll("storeIds").map(String);
      const storeIds = scopeMode === "ORGANIZATION" ? [] : scopeMode === "STORES" ? requestedStoreIds : undefined;
      if (!storeIds) return { ok: false, message: "Choose an organization or store scope." };
      if (scopeMode === "STORES" && storeIds.length === 0) return { ok: false, message: "Select at least one store for store-scoped access." };
      const allowedStoreIds = new Set(hub.stores.map((store) => store.id));
      if (storeIds.some((storeId) => !allowedStoreIds.has(storeId))) return { ok: false, message: "A selected store is outside the Core-resolved organization scope." };
      const result = await api.requestJson<{ success: true; assignment: CoreMemberApplicationAssignment }, { status: "ACTIVE" | "REVOKED"; storeIds: string[] }>(
        `/api/v1/hub/members/${encodeURIComponent(membershipId)}/applications/${encodeURIComponent(applicationCode)}`,
        { method: "PATCH", headers: requestCsrfHeaders(request), body: { status: statusValue, storeIds } },
      );
      return { ok: true, message: `Core saved ${result.assignment.applicationCode} as ${result.assignment.status} with ${result.assignment.scopes.length ? "store" : "organization"} scope.` };
    }
    return { ok: false, message: "Unknown access action." };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : "Core could not save this access change." };
  }
}

function scopeLabel(assignment: CoreMemberApplicationAssignment, storeNames: Map<string, string>): string {
  if (assignment.scopes.length === 0) return "Organization scope";
  return assignment.scopes.map((scope) => storeNames.get(scope.scopeRef) ?? scope.scopeRef).join(", ");
}

function ManagementControls({ data, member }: { data: AccessLoaderData; member: MemberSummary }) {
  const memberAssignments = data.assignments.filter((assignment) => assignment.membershipId === member.membershipId);
  const storeNames = new Map(data.stores.map((store) => [store.id, store.name]));
  const assignableApps = data.apps.filter((app) => {
    const code = app.code ?? app.id.toUpperCase();
    return supportedApplications.some((candidate) => candidate === code)
      && app.status === "ACTIVE"
      && app.storeScoped === true
      && app.lifecycleStatus !== "DEPRECATED"
      && app.lifecycleStatus !== "RETIRED";
  });
  return (
    <details className="aevo-platform-member-controls">
      <summary>Manage access for {member.displayName || member.email}</summary>
      <div className="aevo-platform-member-controls__body">
        <section aria-label={`Organization role for ${member.email}`}>
          <h3>Organization role</h3>
          <Form method="post" className="aevo-platform-mutation-form">
            <input type="hidden" name="intent" value="change-role" /><input type="hidden" name="membershipId" value={member.membershipId} />
            <label><span>Core role</span><select name="role" defaultValue={member.role}>{organizationRoles.map((role) => <option value={role} key={role}>{role.replaceAll("_", " ")}</option>)}</select></label>
            <label className="aevo-platform-confirm"><input type="checkbox" name="confirmed" value="true" required /><span>I confirm that Core will apply this role and re-evaluate the member’s permissions.</span></label>
            <Button type="submit" variant="secondary">Save role</Button>
          </Form>
        </section>
        <section aria-label={`Application access for ${member.email}`}>
          <h3>Application assignments and store scopes</h3>
          {assignableApps.length === 0 ? <p>No assignable store apps were returned by Core.</p> : <div className="aevo-platform-assignment-list">{assignableApps.map((app) => {
            const code = app.code ?? app.id.toUpperCase();
            const assignment = memberAssignments.find((item) => item.applicationCode === code);
            const selectedStores = assignment?.scopes.filter((scope) => scope.scopeType === "STORE").map((scope) => scope.scopeRef) ?? [];
            const isStoreScoped = selectedStores.length > 0;
            return <article className="aevo-platform-assignment" key={code}>
              <div className="aevo-platform-assignment__heading"><div><strong>{app.name}</strong><small>{assignment ? `${assignment.status} · ${scopeLabel(assignment, storeNames)}` : "No assignment returned"}</small></div>{assignment ? <StatusBadge tone={assignment.status === "ACTIVE" ? "success" : "neutral"}>{assignment.status}</StatusBadge> : null}</div>
              {data.scopeNamesUnavailable ? <p className="aevo-platform-inline-note">Store names are unavailable because Core did not grant store.read. Existing store scope IDs remain visible above.</p> : null}
              <Form method="post" className="aevo-platform-mutation-form">
                <input type="hidden" name="intent" value="save-assignment" /><input type="hidden" name="membershipId" value={member.membershipId} /><input type="hidden" name="applicationCode" value={code} />
                <div className="aevo-platform-mutation-form__row">
                  <label><span>Assignment</span><select name="status" defaultValue={assignment?.status === "ACTIVE" ? "ACTIVE" : "REVOKED"}><option value="ACTIVE">Active</option><option value="REVOKED">Revoked</option></select></label>
                  <label><span>Scope</span><select name="scopeMode" defaultValue={isStoreScoped ? "STORES" : "ORGANIZATION"}><option value="ORGANIZATION">Organization</option><option value="STORES" disabled={data.stores.length === 0}>Selected stores</option></select></label>
                </div>
                {data.stores.length > 0 ? <fieldset><legend>Stores included in this assignment</legend><div className="aevo-platform-store-options">{data.stores.map((store) => <label key={store.id}><input type="checkbox" name="storeIds" value={store.id} defaultChecked={selectedStores.includes(store.id)} /><span>{store.name}</span></label>)}</div><p>Store selections are used only when Scope is “Selected stores”.</p></fieldset> : null}
                <label className="aevo-platform-confirm"><input type="checkbox" name="confirmed" value="true" required /><span>I confirm this application assignment and scope change.</span></label>
                <Button type="submit" variant="secondary">Save assignment</Button>
              </Form>
            </article>;
          })}</div>}
        </section>
        {memberAssignments.length > 0 ? <section aria-label={`Application role status for ${member.email}`}><h3>Application roles</h3><p>Core assignment responses currently expose application and scope state. They do not expose a role catalog or role mutation contract.</p>{memberAssignments.map((assignment) => <p className="aevo-platform-inline-note" key={assignment.id}>{assignment.applicationCode}: app role unavailable</p>)}</section> : null}
      </div>
    </details>
  );
}

export default function AccessRoute() {
  const data = useLoaderData() as AccessLoaderData;
  const actionData = useActionData() as AccessActionResult | undefined;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  if (data.permissionDenied) {
    return <PlatformPage eyebrow="Organization settings" title="Team & access" description="Organization roles, permissions, application assignments, and store scopes are resolved by Core."><CapabilityNotice state="denied" title="Member access is restricted" description="Core requires member.manage to read or change organization memberships and application assignments." code="member.manage" /></PlatformPage>;
  }
  if (data.loadError) {
    return <PlatformPage eyebrow="Organization settings" title="Team & access" description="Organization roles, permissions, application assignments, and store scopes are resolved by Core."><CapabilityNotice state="error" title="Access data could not be loaded" description={data.loadError} /></PlatformPage>;
  }
  const storeNames = new Map(data.stores.map((store) => [store.id, store.name]));
  const appNames = new Map(data.apps.map((app) => [app.code ?? app.id.toUpperCase(), app.name]));
  const params = new URLSearchParams(data.search);
  const visible = new Set(data.query.columns);
  const page = data.page;
  return (
    <PlatformPage eyebrow="Organization settings" title="Team & access" description="Review Core-resolved roles, permissions, application assignments, and store scopes. Each change is submitted to Core and shown from its authoritative response.">
      {actionData ? <p className={`aevo-platform-action-result ${actionData.ok ? "is-success" : "is-error"}`} role={actionData.ok ? "status" : "alert"} aria-live="polite">{actionData.message}</p> : null}
      {busy ? <p className="aevo-platform-pending" role="status" aria-live="polite" aria-busy="true">Saving access change in Core…</p> : null}
      <section className="aevo-platform-section" aria-labelledby="access-permissions-heading">
        <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Current server decision</span><h2 id="access-permissions-heading">Your Hub permissions</h2><p>These permissions belong to the signed-in principal in the current organization context.</p></div><StatusBadge tone="info">Core-resolved</StatusBadge></div>
        {data.hub.access.permissions.length > 0 ? <ul className="aevo-platform-permission-list">{data.hub.access.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul> : <CapabilityNotice state="empty" title="No permission codes returned" description="Core returned an empty permission list for the current Hub principal." />}
        <CapabilityNotice state="unavailable" title="Role permission catalog is unavailable" description="Core applies role permissions during authorization, but it does not expose the role-to-permission catalog or other members’ resolved permission lists to this Hub route." code="CORE_ROLE_PERMISSION_CATALOG_NOT_EXPOSED" />
      </section>
      <section className="aevo-platform-section" aria-labelledby="access-members-heading">
        <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Organization directory</span><h2 id="access-members-heading">Members and assignments</h2><p>Search, filters, sorting, page size, and visible columns are stored in the URL for the Core-returned member list.</p></div><span className="aevo-platform-count">{page.total} of {data.totalMembers} members</span></div>
        <StructuredRecordsToolbar query={data.query} roleOptions={organizationRoles} statusOptions={["ACTIVE", "INVITED", "SUSPENDED"]} scopeOptions={["Organization", "Store"]} sortOptions={[{ value: "name", label: "Name" }, { value: "email", label: "Email" }, { value: "role", label: "Role" }, { value: "status", label: "Status" }, { value: "createdAt", label: "Date added" }]} columnOptions={[{ value: "member", label: "Member" }, { value: "role", label: "Role" }, { value: "status", label: "Status" }, { value: "scope", label: "Store scope" }, { value: "applications", label: "Applications" }]} resetTo="/access" />
        <p className="aevo-platform-list-meta">Showing {page.firstItem}–{page.lastItem} of {page.total}. Search and filters apply to the member records returned by Core.</p>
        {page.total === 0 ? <CapabilityNotice state="empty" title="No matching members" description="Change the search or filters, or clear the URL query to see all Core-returned members." /> : <div className="aevo-platform-table-wrap"><table className="aevo-platform-table"><caption>Core organization members</caption><thead><tr>{visible.has("member") ? <th scope="col">Member</th> : null}{visible.has("role") ? <th scope="col">Organization role</th> : null}{visible.has("scope") ? <th scope="col">Store scope</th> : null}{visible.has("applications") ? <th scope="col">Applications</th> : null}{visible.has("status") ? <th scope="col">Status</th> : null}<th scope="col">Manage</th></tr></thead><tbody>{page.items.map((member) => {
          const assignments = data.assignments.filter((assignment) => assignment.membershipId === member.membershipId);
          const activeAssignments = assignments.filter((assignment) => assignment.status === "ACTIVE");
          const memberStoreNames = member.storeIds.map((storeId) => storeNames.get(storeId) ?? storeId);
          return <tr key={member.membershipId}>{visible.has("member") ? <td><strong>{member.displayName || member.email}</strong><small>{member.email}</small></td> : null}{visible.has("role") ? <td>{member.role}</td> : null}{visible.has("scope") ? <td>{memberStoreNames.length ? memberStoreNames.join(", ") : "Organization"}</td> : null}{visible.has("applications") ? <td>{activeAssignments.length ? activeAssignments.map((assignment) => <span className="aevo-platform-inline-chip" key={assignment.applicationCode}>{appNames.get(assignment.applicationCode) ?? assignment.applicationCode}{assignment.scopes.length ? ` · ${scopeLabel(assignment, storeNames)}` : ""}</span>) : "No active app assignments"}</td> : null}{visible.has("status") ? <td><StatusBadge tone={member.status === "ACTIVE" ? "success" : member.status === "INVITED" ? "info" : "warning"}>{member.status}</StatusBadge></td> : null}<td><ManagementControls data={data} member={member} /></td></tr>;
        })}</tbody></table></div>}
        <nav className="aevo-platform-pagination" aria-label="Member pages"><span aria-live="polite">Page {page.page} of {page.pageCount}</span>{page.page <= 1 ? <span className="aevo-button aevo-button--ghost" aria-disabled="true">Previous</span> : <Link className="aevo-button aevo-button--ghost" to={queryWithPage(params, page.page - 1)}>Previous</Link>}{page.page >= page.pageCount ? <span className="aevo-button aevo-button--ghost" aria-disabled="true">Next</span> : <Link className="aevo-button aevo-button--ghost" to={queryWithPage(params, page.page + 1)}>Next</Link>}</nav>
        <CapabilityNotice state="unavailable" title="Scoped member export is unavailable" description="Core does not expose a server export job for the filtered member result. Hub does not present the visible page as a full-result export." code="CORE_EXPORT_CAPABILITY_NOT_EXPOSED" />
      </section>
      <section className="aevo-platform-section" aria-labelledby="app-roles-heading"><div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Application-level authorization</span><h2 id="app-roles-heading">Application roles</h2><p>Organization roles and app assignments are independently represented by Core.</p></div></div><CapabilityNotice state="unavailable" title="Application role management is unavailable" description="The current Core assignment API supports application status and store scopes, but it does not expose an application role catalog or an app-role mutation contract." code="CORE_APPLICATION_ROLE_CONTRACT_NOT_EXPOSED" /></section>
    </PlatformPage>
  );
}
