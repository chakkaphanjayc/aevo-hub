import { roles, type ApplicationCode, type AuditLogSummary, type MemberSummary, type Role, type SessionPrincipal } from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";
import { updateMemberApplicationAssignment } from "./application-assignments";

type Row = Record<string, unknown>;

function isRole(value: string): value is Role { return roles.includes(value as Role); }

export async function listMembers(database: Database, principal: SessionPrincipal): Promise<MemberSummary[]> {
  const membershipsResult = await database.client
    .from("memberships")
    .select("id,user_id,role_id,status,created_at")
    .eq("organization_id", principal.organizationId)
    .order("created_at", { ascending: true });
  throwDatabaseError(membershipsResult.error, "member list");
  if (!membershipsResult.data) return [];
  const memberships = membershipsResult.data as Row[];
  const userIds = memberships.map((row) => String(row.user_id));
  const roleIds = memberships.map((row) => String(row.role_id));
  const [profilesResult, rolesResult, accessResult] = await Promise.all([
    userIds.length ? database.client.from("user_profiles").select("id,email,display_name").in("id", userIds) : Promise.resolve({ data: [], error: null }),
    roleIds.length ? database.client.from("roles").select("id,code").in("id", roleIds) : Promise.resolve({ data: [], error: null }),
    memberships.length ? database.client.from("membership_stores").select("membership_id,store_id").in("membership_id", memberships.map((row) => String(row.id))) : Promise.resolve({ data: [], error: null })
  ]);
  throwDatabaseError(profilesResult.error, "member profile lookup");
  throwDatabaseError(rolesResult.error, "member role lookup");
  throwDatabaseError(accessResult.error, "member store access lookup");
  const profiles = new Map((profilesResult.data ?? []).map((row) => [String((row as Row).id), row as Row]));
  const roleMap = new Map((rolesResult.data ?? []).map((row) => [String((row as Row).id), String((row as Row).code)]));
  const stores = new Map<string, string[]>();
  for (const row of (accessResult.data ?? []) as Row[]) {
    const values = stores.get(String(row.membership_id)) ?? [];
    values.push(String(row.store_id));
    stores.set(String(row.membership_id), values);
  }
  return memberships.flatMap((row) => {
    const role = roleMap.get(String(row.role_id));
    const profile = profiles.get(String(row.user_id));
    if (!role || !isRole(role) || !profile) return [];
    return [{
      membershipId: String(row.id), userId: String(row.user_id), email: String(profile.email),
      displayName: String(profile.display_name ?? ""), role,
      status: (row.status === "INVITED" || row.status === "SUSPENDED" ? row.status : "ACTIVE") as MemberSummary["status"],
      storeIds: stores.get(String(row.id)) ?? [], createdAt: String(row.created_at)
    }];
  });
}

export async function updateMember(
  database: Database,
  principal: SessionPrincipal,
  membershipId: string,
  input: { role: Role; status?: "ACTIVE" | "SUSPENDED"; storeIds: string[] }
): Promise<MemberSummary | null> {
  const roleResult = await database.client.from("roles").select("id").eq("code", input.role).maybeSingle();
  throwDatabaseError(roleResult.error, "member role lookup");
  if (!roleResult.data) throw new Error("Role not found");
  const accessResult = await database.client.from("stores").select("id").eq("organization_id", principal.organizationId).in("id", input.storeIds);
  throwDatabaseError(accessResult.error, "member store access lookup");
  const allowedStoreIds = new Set((accessResult.data ?? []).map((row) => String((row as Row).id)));
  const storeIds = input.storeIds.filter((id) => allowedStoreIds.has(id));
  const updated = await database.client.from("memberships").update({ role_id: String((roleResult.data as Row).id), ...(input.status ? { status: input.status } : {}) }).eq("organization_id", principal.organizationId).eq("id", membershipId).select("id").maybeSingle();
  throwDatabaseError(updated.error, "member update");
  if (!updated.data) return null;
  const deleted = await database.client.from("membership_stores").delete().eq("membership_id", membershipId);
  throwDatabaseError(deleted.error, "member store access delete");
  if (storeIds.length) {
    const inserted = await database.client.from("membership_stores").insert(storeIds.map((storeId) => ({ membership_id: membershipId, store_id: storeId })));
    throwDatabaseError(inserted.error, "member store access create");
  }
  return (await listMembers(database, principal)).find((member) => member.membershipId === membershipId) ?? null;
}

export async function createMember(
  database: Database,
  principal: SessionPrincipal,
  input: { email: string; displayName?: string; role: Role; storeIds?: string[]; applicationCodes?: ApplicationCode[] }
): Promise<MemberSummary> {
  const roleResult = await database.client.from("roles").select("id").eq("code", input.role).maybeSingle();
  throwDatabaseError(roleResult.error, "member role lookup");
  if (!roleResult.data) throw new Error("Role not found");
  const roleId = String((roleResult.data as Row).id);

  const cleanEmail = input.email.trim().toLowerCase();
  const userProfile = await database.client
    .from("user_profiles")
    .select("id, email, display_name")
    .eq("email", cleanEmail)
    .maybeSingle();

  let userId: string;
  if (userProfile.data) {
    userId = String((userProfile.data as Row).id);
  } else {
    // User does not exist in user_profiles, create in auth.users first
    const createdUser = await database.client.auth.admin.createUser({
      email: cleanEmail,
      email_confirm: true,
      user_metadata: { display_name: input.displayName || cleanEmail.split("@")[0] }
    });

    if (createdUser.data?.user) {
      userId = createdUser.data.user.id;
    } else {
      // User might already exist in auth.users
      const { data: userList } = await database.client.auth.admin.listUsers();
      const matched = userList?.users?.find((u) => u.email?.toLowerCase() === cleanEmail);
      if (matched) {
        userId = matched.id;
      } else {
        throw new Error(createdUser.error?.message || "Failed to create Supabase auth user");
      }
    }

    const newProfile = await database.client.from("user_profiles").upsert({
      id: userId,
      email: cleanEmail,
      display_name: input.displayName || cleanEmail.split("@")[0],
      status: "ACTIVE"
    }).select("id").single();
    throwDatabaseError(newProfile.error, "create user profile");
  }

  const existing = await database.client
    .from("memberships")
    .select("id")
    .eq("organization_id", principal.organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  let membershipId: string;
  if (existing.data) {
    membershipId = String((existing.data as Row).id);
    await database.client.from("memberships").update({
      role_id: roleId,
      status: "ACTIVE"
    }).eq("id", membershipId);
  } else {
    const newMembership = await database.client.from("memberships").insert({
      organization_id: principal.organizationId,
      user_id: userId,
      role_id: roleId,
      status: "ACTIVE"
    }).select("id").single();
    throwDatabaseError(newMembership.error, "create membership");
    membershipId = String((newMembership.data as Row).id);
  }

  if (input.storeIds && input.storeIds.length > 0) {
    await database.client.from("membership_stores").delete().eq("membership_id", membershipId);
    await database.client.from("membership_stores").insert(
      input.storeIds.map((storeId) => ({ membership_id: membershipId, store_id: storeId }))
    );
  }

  const members = await listMembers(database, principal);
  const found = members.find((m) => m.membershipId === membershipId);
  if (!found) throw new Error("Failed to find created member");
  for (const applicationCode of input.applicationCodes ?? []) {
    if (applicationCode === "HUB" || applicationCode === "ADMIN" || applicationCode === "GO") continue;
    await updateMemberApplicationAssignment(database, principal, membershipId, {
      applicationCode,
      status: "ACTIVE",
      storeIds: input.storeIds ?? []
    });
  }
  return found;
}

export async function deleteMember(
  database: Database,
  principal: SessionPrincipal,
  membershipId: string
): Promise<boolean> {
  const deletedStores = await database.client.from("membership_stores").delete().eq("membership_id", membershipId);
  throwDatabaseError(deletedStores.error, "delete member stores");

  const deletedMembership = await database.client
    .from("memberships")
    .update({ status: "SUSPENDED" })
    .eq("organization_id", principal.organizationId)
    .eq("id", membershipId);
  throwDatabaseError(deletedMembership.error, "suspend membership");

  return true;
}

export async function listAuditLogs(database: Database, principal: SessionPrincipal, limit = 100): Promise<AuditLogSummary[]> {
  const result = await database.client.from("audit_logs").select("id,organization_id,user_id,action,resource_type,resource_id,metadata,created_at").eq("organization_id", principal.organizationId).order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 200));
  throwDatabaseError(result.error, "audit log list");
  if (!result.data) return [];
  return (result.data as Row[]).map((row) => ({
    id: String(row.id), organizationId: String(row.organization_id),
    ...(row.user_id ? { userId: String(row.user_id) } : {}), action: String(row.action), resourceType: String(row.resource_type),
    ...(row.resource_id ? { resourceId: String(row.resource_id) } : {}), metadata: (row.metadata as Record<string, unknown>) ?? {}, createdAt: String(row.created_at)
  }));
}

export async function writeAuditLog(database: Database, input: { organizationId: string; userId?: string; action: string; resourceType: string; resourceId?: string; metadata?: Record<string, unknown> }): Promise<void> {
  const result = await database.client.from("audit_logs").insert({ organization_id: input.organizationId, user_id: input.userId || null, action: input.action, resource_type: input.resourceType, resource_id: input.resourceId || null, metadata: input.metadata ?? {} });
  throwDatabaseError(result.error, "audit log create");
}
