import type {
  CreateInvitationInput,
  InvitationSummary,
  Role,
  ScopeType,
  SessionPrincipal
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

export class InvitationError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "InvitationError";
  }
}

export async function createInvitation(
  database: Database,
  principal: SessionPrincipal,
  input: CreateInvitationInput
): Promise<InvitationSummary> {
  const cleanEmail = input.email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new InvitationError("A valid email address is required");
  }

  // Enforce delegation rules
  if (input.role === "OWNER") {
    throw new InvitationError("Organization ownership cannot be assigned via invitation. Use ownership transfer.");
  }

  const roleResult = await database.client
    .from("roles")
    .select("id, code, scope_type")
    .eq("code", input.role)
    .maybeSingle();

  throwDatabaseError(roleResult.error, "lookup role");
  if (!roleResult.data) {
    throw new InvitationError(`Role '${input.role}' does not exist`, 404);
  }

  const roleRow = roleResult.data as Row;
  const roleId = String(roleRow.id);
  const roleScope = String(roleRow.scope_type) as ScopeType;

  // Verify inviter authority
  if (principal.role === "STORE_MANAGER") {
    if (input.scopeType !== "STORE" || !input.storeId) {
      throw new InvitationError("Store Managers can only invite staff to their assigned store", 403);
    }
    if (["ADMIN", "ORGANIZATION_MANAGER", "STORE_MANAGER"].includes(input.role)) {
      throw new InvitationError("Store Managers cannot invite managerial roles", 403);
    }
  } else if (principal.role === "ORGANIZATION_MANAGER") {
    if (input.role === "ADMIN") {
      throw new InvitationError("Organization Managers cannot invite Administrators", 403);
    }
  } else if (principal.role !== "OWNER" && principal.role !== "ADMIN") {
    throw new InvitationError("Insufficient permissions to send invitations", 403);
  }

  let scopeId = principal.organizationId;
  let storeId: string | null = null;

  if (input.scopeType === "STORE") {
    if (!input.storeId) {
      throw new InvitationError("Store ID is required for store-scoped invitations");
    }
    // Verify store exists and belongs to this org
    const storeCheck = await database.client
      .from("stores")
      .select("id")
      .eq("organization_id", principal.organizationId)
      .eq("id", input.storeId)
      .maybeSingle();

    if (storeCheck.error || !storeCheck.data) {
      throw new InvitationError("Specified store not found in this organization", 404);
    }

    storeId = input.storeId;
    scopeId = input.storeId;
  }

  // Insert invitation record
  const insertResult = await database.client
    .from("invitations")
    .insert({
      organization_id: principal.organizationId,
      store_id: storeId,
      email: cleanEmail,
      role_id: roleId,
      scope_type: input.scopeType,
      scope_id: scopeId,
      invited_by: principal.userId,
      status: "PENDING"
    })
    .select("id, organization_id, store_id, email, role_id, scope_type, scope_id, invited_by, status, expires_at, accepted_at, created_at")
    .single();

  throwDatabaseError(insertResult.error, "create invitation");
  const row = insertResult.data as Row;

  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    storeId: row.store_id ? String(row.store_id) : null,
    email: String(row.email),
    roleId: String(row.role_id),
    roleCode: input.role,
    scopeType: String(row.scope_type) as ScopeType,
    scopeId: String(row.scope_id),
    invitedBy: String(row.invited_by),
    status: String(row.status) as InvitationSummary["status"],
    expiresAt: String(row.expires_at),
    acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    createdAt: String(row.created_at)
  };
}

export async function listInvitations(
  database: Database,
  principal: SessionPrincipal,
  storeId?: string
): Promise<InvitationSummary[]> {
  let query = database.client
    .from("invitations")
    .select("id, organization_id, store_id, email, role_id, scope_type, scope_id, invited_by, status, expires_at, accepted_at, created_at, roles(code)")
    .eq("organization_id", principal.organizationId)
    .order("created_at", { ascending: false });

  if (storeId) {
    query = query.eq("store_id", storeId);
  }

  const result = await query;
  throwDatabaseError(result.error, "list invitations");

  return (result.data ?? []).map((row: Row) => {
    const roleCode = (row.roles as Row)?.code ? String((row.roles as Row).code) : "STAFF";
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      storeId: row.store_id ? String(row.store_id) : null,
      email: String(row.email),
      roleId: String(row.role_id),
      roleCode: roleCode as Role,
      scopeType: String(row.scope_type) as ScopeType,
      scopeId: String(row.scope_id),
      invitedBy: String(row.invited_by),
      status: String(row.status) as InvitationSummary["status"],
      expiresAt: String(row.expires_at),
      acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
      createdAt: String(row.created_at)
    };
  });
}

export async function revokeInvitation(
  database: Database,
  principal: SessionPrincipal,
  invitationId: string
): Promise<boolean> {
  const result = await database.client
    .from("invitations")
    .update({ status: "REVOKED" })
    .eq("organization_id", principal.organizationId)
    .eq("id", invitationId)
    .eq("status", "PENDING");

  throwDatabaseError(result.error, "revoke invitation");
  return true;
}

export async function acceptInvitation(
  database: Database,
  userId: string,
  invitationId: string
): Promise<boolean> {
  const inviteRes = await database.client
    .from("invitations")
    .select("id, organization_id, store_id, email, role_id, scope_type, scope_id, status, expires_at")
    .eq("id", invitationId)
    .maybeSingle();

  throwDatabaseError(inviteRes.error, "find invitation");
  if (!inviteRes.data) throw new InvitationError("Invitation not found", 404);
  const inv = inviteRes.data as Row;

  if (inv.status !== "PENDING") {
    throw new InvitationError(`Invitation is no longer pending (${inv.status})`);
  }

  if (new Date(String(inv.expires_at)) < new Date()) {
    await database.client.from("invitations").update({ status: "EXPIRED" }).eq("id", invitationId);
    throw new InvitationError("Invitation has expired");
  }

  const orgId = String(inv.organization_id);
  const roleId = String(inv.role_id);
  const scopeType = String(inv.scope_type);
  const storeId = inv.store_id ? String(inv.store_id) : null;

  // Add to organization memberships
  await database.client.from("memberships").upsert({
    organization_id: orgId,
    user_id: userId,
    role_id: roleId,
    status: "ACTIVE"
  }, { onConflict: "organization_id,user_id" });

  // If store scope, also add to store_members
  if (scopeType === "STORE" && storeId) {
    await database.client.from("store_members").upsert({
      store_id: storeId,
      user_id: userId,
      role_id: roleId,
      status: "ACTIVE"
    }, { onConflict: "store_id,user_id,role_id" });
  }

  // Mark invitation accepted
  await database.client
    .from("invitations")
    .update({
      status: "ACCEPTED",
      accepted_at: new Date().toISOString()
    })
    .eq("id", invitationId);

  return true;
}
