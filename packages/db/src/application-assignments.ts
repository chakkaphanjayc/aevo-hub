import {
  applicationAssignmentStatuses,
  applicationCodes,
  roles,
  type ApplicationAssignmentStatus,
  type ApplicationCode,
  type MemberApplicationAssignmentSummary,
  type Role,
  type SessionPrincipal
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

const assignableApplicationCodes = ["PLAY", "POS", "KIOSK", "QUEUE"] as const satisfies readonly ApplicationCode[];

function isAssignableApplication(value: string): value is (typeof assignableApplicationCodes)[number] {
  return assignableApplicationCodes.includes(value as (typeof assignableApplicationCodes)[number]);
}

function isAssignmentStatus(value: string): value is ApplicationAssignmentStatus {
  return applicationAssignmentStatuses.includes(value as ApplicationAssignmentStatus);
}

function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

async function getOrganizationMembership(
  database: Database,
  principal: SessionPrincipal,
  membershipId: string
): Promise<boolean> {
  const result = await database.client
    .from("memberships")
    .select("id")
    .eq("id", membershipId)
    .eq("organization_id", principal.organizationId)
    .maybeSingle();
  throwDatabaseError(result.error, "application assignment membership lookup");
  return Boolean(result.data);
}

export async function listMemberApplicationAssignments(
  database: Database,
  principal: SessionPrincipal,
  membershipId: string
): Promise<MemberApplicationAssignmentSummary[] | null> {
  if (!await getOrganizationMembership(database, principal, membershipId)) return null;

  const assignmentsResult = await database.client
    .from("member_app_assignments")
    .select("id,membership_id,application_code,status,starts_at,expires_at")
    .eq("membership_id", membershipId)
    .order("application_code", { ascending: true });
  throwDatabaseError(assignmentsResult.error, "application assignment list");

  const assignments = (assignmentsResult.data ?? []) as Row[];
  if (assignments.length === 0) return [];
  const assignmentIds = assignments.map((row) => String(row.id));
  const [scopesResult, rolesResult] = await Promise.all([
    database.client
      .from("member_app_scopes")
      .select("assignment_id,scope_type,scope_ref")
      .in("assignment_id", assignmentIds),
    database.client
      .from("member_app_roles")
      .select("assignment_id,role_id")
      .in("assignment_id", assignmentIds)
  ]);
  throwDatabaseError(scopesResult.error, "application assignment scope list");
  throwDatabaseError(rolesResult.error, "application assignment role list");

  const roleIds = (rolesResult.data ?? [])
    .map((row) => String((row as Row).role_id))
    .filter(Boolean);
  const roleRowsResult = roleIds.length
    ? await database.client.from("roles").select("id,code").in("id", roleIds)
    : { data: [], error: null };
  throwDatabaseError(roleRowsResult.error, "application assignment role lookup");
  const roleMap = new Map(
    (roleRowsResult.data ?? []).map((row) => [String((row as Row).id), String((row as Row).code)])
  );
  const scopes = new Map<string, MemberApplicationAssignmentSummary["scopes"]>();
  for (const row of (scopesResult.data ?? []) as Row[]) {
    const assignmentId = String(row.assignment_id);
    const values = scopes.get(assignmentId) ?? [];
    const scopeType = String(row.scope_type);
    if (scopeType === "ORGANIZATION" || scopeType === "STORE" || scopeType === "RESOURCE" || scopeType === "DEVICE_GROUP") {
      values.push({ scopeType, scopeRef: String(row.scope_ref) });
    }
    scopes.set(assignmentId, values);
  }
  const assignedRoles = new Map<string, Role[]>();
  for (const row of (rolesResult.data ?? []) as Row[]) {
    const code = roleMap.get(String(row.role_id));
    if (!code || !isRole(code)) continue;
    const assignmentId = String(row.assignment_id);
    const values = assignedRoles.get(assignmentId) ?? [];
    values.push(code);
    assignedRoles.set(assignmentId, values);
  }

  return assignments.flatMap((row) => {
    const applicationCode = String(row.application_code);
    const status = String(row.status);
    if (!applicationCodes.includes(applicationCode as ApplicationCode) || !isAssignmentStatus(status)) return [];
    return [{
      id: String(row.id),
      membershipId: String(row.membership_id),
      applicationCode: applicationCode as ApplicationCode,
      status,
      startsAt: String(row.starts_at),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      scopes: scopes.get(String(row.id)) ?? [],
      roleCodes: assignedRoles.get(String(row.id)) ?? []
    } satisfies MemberApplicationAssignmentSummary];
  });
}

export interface UpdateMemberApplicationAssignmentInput {
  applicationCode: ApplicationCode;
  status: ApplicationAssignmentStatus;
  storeIds?: string[];
  roleCodes?: string[];
}

export async function updateMemberApplicationAssignment(
  database: Database,
  principal: SessionPrincipal,
  membershipId: string,
  input: UpdateMemberApplicationAssignmentInput
): Promise<MemberApplicationAssignmentSummary | null> {
  if (!await getOrganizationMembership(database, principal, membershipId)) return null;
  if (!isAssignableApplication(input.applicationCode)) {
    throw new Error("Only workforce application assignments can be managed from Hub");
  }

  const storeIds = [...new Set((input.storeIds ?? []).filter((value) => typeof value === "string" && value.length > 0))];
  if (storeIds.length > 0) {
    const storesResult = await database.client
      .from("stores")
      .select("id")
      .eq("organization_id", principal.organizationId)
      .eq("status", "ACTIVE")
      .in("id", storeIds);
    throwDatabaseError(storesResult.error, "application assignment store scope lookup");
    const allowedStoreIds = new Set((storesResult.data ?? []).map((row) => String((row as Row).id)));
    if (allowedStoreIds.size !== storeIds.length) throw new Error("One or more store scopes are not available in this organization");
  }

  const requestedRoleCodes = [...new Set(input.roleCodes ?? [])];
  if (requestedRoleCodes.some((code) => !isRole(code))) throw new Error("One or more application roles are invalid");
  const roleCodes = requestedRoleCodes as Role[];
  let roleIds: string[] = [];
  if (roleCodes.length > 0) {
    const rolesResult = await database.client.from("roles").select("id,code").in("code", roleCodes);
    throwDatabaseError(rolesResult.error, "application assignment role lookup");
    const roleMap = new Map((rolesResult.data ?? []).map((row) => [String((row as Row).code), String((row as Row).id)]));
    roleIds = roleCodes.map((code) => roleMap.get(code)).filter((value): value is string => Boolean(value));
    if (roleIds.length !== roleCodes.length) throw new Error("One or more application roles are not available");
  }

  const assignmentResult = await database.client
    .from("member_app_assignments")
    .upsert({
      membership_id: membershipId,
      application_code: input.applicationCode,
      status: input.status,
      updated_at: new Date().toISOString()
    }, { onConflict: "membership_id,application_code" })
    .select("id")
    .single();
  throwDatabaseError(assignmentResult.error, "application assignment update");
  const assignmentId = String((assignmentResult.data as Row).id);

  const deletedScopes = await database.client.from("member_app_scopes").delete().eq("assignment_id", assignmentId);
  throwDatabaseError(deletedScopes.error, "application assignment scope reset");
  const scopeRows = storeIds.length > 0
    ? storeIds.map((storeId) => ({ assignment_id: assignmentId, scope_type: "STORE", scope_ref: storeId }))
    : [{ assignment_id: assignmentId, scope_type: "ORGANIZATION", scope_ref: principal.organizationId }];
  const insertedScopes = await database.client.from("member_app_scopes").insert(scopeRows);
  throwDatabaseError(insertedScopes.error, "application assignment scope update");

  const deletedRoles = await database.client.from("member_app_roles").delete().eq("assignment_id", assignmentId);
  throwDatabaseError(deletedRoles.error, "application assignment role reset");
  if (roleIds.length > 0) {
    const insertedRoles = await database.client.from("member_app_roles").insert(
      roleIds.map((roleId) => ({ assignment_id: assignmentId, role_id: roleId }))
    );
    throwDatabaseError(insertedRoles.error, "application assignment role update");
  }

  const assignments = await listMemberApplicationAssignments(database, principal, membershipId);
  return assignments?.find((assignment) => assignment.applicationCode === input.applicationCode) ?? null;
}
