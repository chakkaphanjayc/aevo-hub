import type {
  AppAccessDecision,
  ApplicationCode,
  Role,
  SessionPrincipal
} from "@aevo/contracts";
import { roles } from "@aevo/contracts";
import type { Database } from "./client";
import { isMissingDatabaseObject, throwDatabaseError } from "./errors";
import { canAccessStore, resolvePrincipal, type PrincipalIdentity } from "./repository";
import { isStoreApplicationEnabled } from "./store-application-access";

interface AssignmentRow {
  id: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  starts_at: string;
  expires_at: string | null;
}

interface ScopeRow {
  scope_type: "ORGANIZATION" | "STORE" | "RESOURCE" | "DEVICE_GROUP";
  scope_ref: string;
}

interface RoleRow {
  code: string;
}

function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

function denied(
  application: ApplicationCode,
  reason: AppAccessDecision["reason"],
  checkedAt: string,
  userId?: string
): AppAccessDecision {
  return {
    allowed: false,
    application,
    reason,
    permissions: [],
    checkedAt,
    ...(userId ? { userId } : {})
  };
}

function allowed(
  application: ApplicationCode,
  principal: SessionPrincipal,
  checkedAt: string,
  storeId?: string
): AppAccessDecision {
  return {
    allowed: true,
    application,
    reason: "ALLOWED",
    userId: principal.userId,
    organizationId: principal.organizationId,
    ...(storeId ? { storeId } : {}),
    role: principal.role,
    permissions: [...principal.permissions],
    checkedAt
  };
}

function isCurrentAssignment(row: AssignmentRow, now: number): boolean {
  const startsAt = Date.parse(row.starts_at);
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY;
  return row.status === "ACTIVE"
    && Number.isFinite(startsAt)
    && startsAt <= now
    && expiresAt > now;
}

export async function isApplicationActive(
  database: Database,
  application: ApplicationCode
): Promise<boolean> {
  const result = await database.client
    .from("application_registry")
    .select("status")
    .eq("code", application)
    .maybeSingle();

  if (result.error) {
    // Hub remains compatible during the additive migration; every other
    // application fails closed until its registry row is available.
    if (isMissingDatabaseObject(result.error)) return application === "HUB";
    throwDatabaseError(result.error, "application registry status lookup");
  }
  return result.data?.status === "ACTIVE";
}

/**
 * Resolve organization application access on the trusted API side. Client
 * context is only a lookup hint; membership, assignment, scope, and role data
 * are resolved again from the server database.
 */
export async function resolveApplicationAccess(
  database: Database,
  input: {
    userId: string;
    application: ApplicationCode;
    organizationId?: string;
    storeId?: string;
    identity?: PrincipalIdentity;
  }
): Promise<AppAccessDecision> {
  const checkedAt = new Date().toISOString();
  if (!await isApplicationActive(database, input.application)) {
    return denied(input.application, "APPLICATION_DISABLED", checkedAt, input.userId);
  }
  const principal = await resolvePrincipal(
    database,
    input.userId,
    input.organizationId,
    input.identity
  );
  if (!principal) return denied(input.application, "MEMBERSHIP_REQUIRED", checkedAt, input.userId);

  const assignmentResult = await database.client
    .from("member_app_assignments")
    .select("id,status,starts_at,expires_at")
    .eq("membership_id", principal.membershipId)
    .eq("application_code", input.application)
    .order("created_at", { ascending: false });
  if (assignmentResult.error) {
    // Keep the existing Hub usable during a rolling deployment where the
    // additive assignment migration has not landed yet. Non-Hub applications
    // fail closed until their assignment schema is available.
    if (input.application === "HUB" && isMissingDatabaseObject(assignmentResult.error)) {
      if (input.storeId && !await canAccessStore(database, principal, input.storeId)) {
        return denied(input.application, "SCOPE_REQUIRED", checkedAt, input.userId);
      }
      return allowed(input.application, principal, checkedAt, input.storeId);
    }
    throwDatabaseError(assignmentResult.error, "application assignment lookup");
  }

  const assignments = (assignmentResult.data ?? []) as AssignmentRow[];
  const assignment = assignments[0];
  if (!assignment) return denied(input.application, "APP_ASSIGNMENT_REQUIRED", checkedAt, input.userId);
  if (assignment.status === "SUSPENDED") {
    return denied(input.application, "APP_ASSIGNMENT_SUSPENDED", checkedAt, input.userId);
  }
  if (!isCurrentAssignment(assignment, Date.now())) {
    return denied(input.application, "APP_ASSIGNMENT_REQUIRED", checkedAt, input.userId);
  }

  const [scopeResult, roleResult] = await Promise.all([
    database.client
      .from("member_app_scopes")
      .select("scope_type,scope_ref")
      .eq("assignment_id", assignment.id),
    database.client
      .from("member_app_roles")
      .select("role_id")
      .eq("assignment_id", assignment.id)
  ]);
  if (scopeResult.error) throwDatabaseError(scopeResult.error, "application scope lookup");
  if (roleResult.error) throwDatabaseError(roleResult.error, "application role lookup");

  const scopes = (scopeResult.data ?? []) as ScopeRow[];
  if (input.storeId && !await canAccessStore(database, principal, input.storeId)) {
    return denied(input.application, "SCOPE_REQUIRED", checkedAt, input.userId);
  }
  if (input.storeId && !await isStoreApplicationEnabled(database, principal, input.storeId, input.application)) {
    return denied(input.application, "STORE_APPLICATION_DISABLED", checkedAt, input.userId);
  }
  if (scopes.length > 0) {
    const hasOrganizationScope = scopes.some(
      (scope) => scope.scope_type === "ORGANIZATION" && scope.scope_ref === principal.organizationId
    );
    const hasStoreScope = input.storeId
      ? scopes.some((scope) => scope.scope_type === "STORE" && scope.scope_ref === input.storeId)
      : false;
    if (!hasOrganizationScope && !hasStoreScope) {
      return denied(input.application, "SCOPE_REQUIRED", checkedAt, input.userId);
    }
  }

  const roleIds = (roleResult.data ?? [])
    .map((row) => (row as { role_id?: unknown }).role_id)
    .filter((value): value is string => typeof value === "string");
  if (roleIds.length > 0) {
    const assignedRolesResult = await database.client
      .from("roles")
      .select("code")
      .in("id", roleIds);
    if (assignedRolesResult.error) throwDatabaseError(assignedRolesResult.error, "application role resolution");
    const assignedRoles = ((assignedRolesResult.data ?? []) as RoleRow[])
      .map((row) => row.code)
      .filter(isRole);
    if (!assignedRoles.includes(principal.role)) {
      return denied(input.application, "PERMISSION_REQUIRED", checkedAt, input.userId);
    }
  }

  return allowed(input.application, principal, checkedAt, input.storeId);
}
