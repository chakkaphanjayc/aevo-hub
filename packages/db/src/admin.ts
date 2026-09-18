import { createHash, randomBytes } from "node:crypto";
import type { AdminAuditEntry, PlatformRole } from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

export interface PlatformOverview {
  totalOrganizations: number;
  totalStores: number;
  totalUsers: number;
  totalDevices: number;
  totalSubscriptions: number;
  operatingMode: {
    mode: string;
    unlimited: boolean;
  };
}

export interface AdminOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  businessType?: string | null;
  status: string;
  maxUsers: number;
  maxStores: number;
  featureFlags: Record<string, boolean>;
  storesCount: number;
  membersCount: number;
  createdAt: string;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: string;
  memberships: Array<{
    organizationId: string;
    organizationName: string;
    role: string;
    storeIds: string[];
  }>;
}

export async function getPlatformOverview(database: Database): Promise<PlatformOverview> {
  try {
    const [orgsRes, storesRes, usersRes, devicesRes, subsRes, modeRes] = await Promise.all([
      database.client.from("organizations").select("id", { count: "exact", head: true }),
      database.client.from("stores").select("id", { count: "exact", head: true }),
      database.client.from("user_profiles").select("id", { count: "exact", head: true }),
      database.client.from("devices").select("id", { count: "exact", head: true }),
      database.client.from("subscriptions").select("id", { count: "exact", head: true }),
      database.client.from("system_settings").select("value").eq("key", "operating_mode").maybeSingle()
    ]);

    let operatingMode = { mode: "production", unlimited: false };
    if (modeRes.data?.value) {
      const val = typeof modeRes.data.value === "string" ? JSON.parse(modeRes.data.value) : modeRes.data.value;
      operatingMode = {
        mode: val.mode || "production",
        unlimited: Boolean(val.unlimited)
      };
    }

    return {
      totalOrganizations: orgsRes.count ?? 0,
      totalStores: storesRes.count ?? 0,
      totalUsers: usersRes.count ?? 0,
      totalDevices: devicesRes.count ?? 0,
      totalSubscriptions: subsRes.count ?? 0,
      operatingMode
    };
  } catch (error) {
    return throwDatabaseError(error, "Failed to load platform overview");
  }
}

export async function listAdminOrganizations(database: Database): Promise<AdminOrganizationSummary[]> {
  try {
    const orgsResult = await database.client
      .from("organizations")
      .select(`
        id,
        name,
        slug,
        legal_name,
        business_type,
        status,
        max_users,
        max_stores,
        feature_flags,
        created_at
      `)
      .order("created_at", { ascending: false });

    if (orgsResult.error) {
      return throwDatabaseError(orgsResult.error, "Failed to list organizations");
    }

    const rows = orgsResult.data || [];
    const summaries: AdminOrganizationSummary[] = [];

    // For each org, fetch store count and member count
    for (const org of rows) {
      const [storesCountRes, membersCountRes] = await Promise.all([
        database.client.from("stores").select("id", { count: "exact", head: true }).eq("organization_id", org.id),
        database.client.from("memberships").select("id", { count: "exact", head: true }).eq("organization_id", org.id)
      ]);

      summaries.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        legalName: org.legal_name,
        businessType: org.business_type,
        status: org.status || "ACTIVE",
        maxUsers: Number(org.max_users ?? 10),
        maxStores: Number(org.max_stores ?? 5),
        featureFlags: (org.feature_flags as Record<string, boolean>) || {
          pos: true,
          kiosk: true,
          booking: true,
          crm: true,
          inventory: true,
          odoo: false
        },
        storesCount: storesCountRes.count ?? 0,
        membersCount: membersCountRes.count ?? 0,
        createdAt: org.created_at
      });
    }

    return summaries;
  } catch (error) {
    return throwDatabaseError(error, "Failed to list admin organizations");
  }
}

export async function updateAdminOrganization(
  database: Database,
  orgId: string,
  updates: {
    status?: string;
    maxUsers?: number;
    maxStores?: number;
    featureFlags?: Record<string, boolean>;
  }
): Promise<{ organization: AdminOrganizationSummary }> {
  try {
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (updates.status !== undefined) updatePayload.status = updates.status;
    if (updates.maxUsers !== undefined) updatePayload.max_users = updates.maxUsers;
    if (updates.maxStores !== undefined) updatePayload.max_stores = updates.maxStores;
    if (updates.featureFlags !== undefined) updatePayload.feature_flags = updates.featureFlags;

    const result = await database.client
      .from("organizations")
      .update(updatePayload)
      .eq("id", orgId)
      .select()
      .single();

    if (result.error) {
      return throwDatabaseError(result.error, "Failed to update organization");
    }

    const org = result.data;
    const [storesCountRes, membersCountRes] = await Promise.all([
      database.client.from("stores").select("id", { count: "exact", head: true }).eq("organization_id", org.id),
      database.client.from("memberships").select("id", { count: "exact", head: true }).eq("organization_id", org.id)
    ]);

    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        legalName: org.legal_name,
        businessType: org.business_type,
        status: org.status || "ACTIVE",
        maxUsers: Number(org.max_users ?? 10),
        maxStores: Number(org.max_stores ?? 5),
        featureFlags: (org.feature_flags as Record<string, boolean>) || {},
        storesCount: storesCountRes.count ?? 0,
        membersCount: membersCountRes.count ?? 0,
        createdAt: org.created_at
      }
    };
  } catch (error) {
    return throwDatabaseError(error, "Failed to update admin organization");
  }
}

export async function listAdminUsers(database: Database): Promise<AdminUserSummary[]> {
  try {
    const usersResult = await database.client
      .from("user_profiles")
      .select(`
        id,
        email,
        display_name,
        status,
        created_at
      `)
      .order("created_at", { ascending: false });

    if (usersResult.error) {
      return throwDatabaseError(usersResult.error, "Failed to list users");
    }

    const users = usersResult.data || [];
    const results: AdminUserSummary[] = [];

    for (const u of users) {
      const membershipsResult = await database.client
        .from("memberships")
        .select(`
          organization_id,
          role_id,
          roles:role_id ( code ),
          organizations:organization_id ( name ),
          membership_stores ( store_id )
        `)
        .eq("user_id", u.id);

      const memList = (membershipsResult.data || []).map((m: any) => ({
        organizationId: m.organization_id,
        organizationName: m.organizations?.name || m.organization_id,
        role: m.roles?.code || "MEMBER",
        storeIds: (m.membership_stores || []).map((s: any) => s.store_id)
      }));

      results.push({
        id: u.id,
        email: u.email,
        displayName: u.display_name || "",
        status: u.status || "ACTIVE",
        createdAt: u.created_at,
        memberships: memList
      });
    }

    return results;
  } catch (error) {
    return throwDatabaseError(error, "Failed to list admin users");
  }
}

export async function updateAdminUserStatus(
  database: Database,
  userId: string,
  status: "ACTIVE" | "DISABLED"
): Promise<{ success: boolean; userId: string; status: string }> {
  try {
    const result = await database.client
      .from("user_profiles")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (result.error) {
      return throwDatabaseError(result.error, "Failed to update user status");
    }

    return { success: true, userId, status };
  } catch (error) {
    return throwDatabaseError(error, "Failed to update admin user status");
  }
}

export async function setOperatingMode(
  database: Database,
  mode: "production" | "testing",
  unlimited = false
): Promise<{ success: boolean; mode: string; unlimited: boolean }> {
  try {
    const payload = {
      mode,
      unlimited: mode === "testing" ? unlimited : false,
      updated_at: new Date().toISOString()
    };

    const result = await database.client
      .from("system_settings")
      .upsert({
        key: "operating_mode",
        value: payload,
        updated_at: new Date().toISOString()
      }, { onConflict: "key" });

    if (result.error) {
      return throwDatabaseError(result.error, "Failed to set operating mode");
    }

    return { success: true, mode, unlimited: payload.unlimited };
  } catch (error) {
    return throwDatabaseError(error, "Failed to set operating mode");
  }
}

export async function getPlatformUserRole(
  database: Database,
  userId: string
): Promise<PlatformRole | null> {
  const res = await database.client
    .from("platform_users")
    .select("role,is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (!res.data) return null;
  return (res.data as any).role as PlatformRole;
}

export async function writeStructuredAuditLog(
  database: Database,
  entry: AdminAuditEntry
): Promise<void> {
  await database.client.from("audit_logs").insert({
    organization_id: entry.organizationId ?? null,
    admin_user_id: entry.adminUserId ?? null,
    platform_role: entry.platformRole ?? null,
    action: entry.action,
    resource_type: entry.targetType,
    resource_id: entry.targetId ? entry.targetId : null,
    before_state: entry.beforeState ?? {},
    after_state: entry.afterState ?? {},
    reason: entry.reason ?? "System/Admin action",
    ip_address: entry.ipAddress ?? null,
    metadata: {
      timestamp: entry.createdAt || new Date().toISOString()
    }
  });
}

export async function createImpersonationSession(
  database: Database,
  input: {
    adminUserId: string;
    targetUserId: string;
    organizationId: string;
    reason: string;
    ttlMinutes?: number;
  }
): Promise<{ token: string; expiresAt: string }> {
  const ttl = input.ttlMinutes ?? 30; // 15-30 minutes max
  const rawToken = `imp_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashImpersonationToken(rawToken);
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();

  const insertRes = await database.client.from("impersonation_sessions").insert({
    admin_user_id: input.adminUserId,
    impersonated_user_id: input.targetUserId,
    organization_id: input.organizationId,
    token_hash: tokenHash,
    reason: input.reason,
    expires_at: expiresAt
  });

  if (insertRes.error) {
    throw new Error(`Failed to create impersonation session: ${insertRes.error.message}`);
  }

  return { token: rawToken, expiresAt };
}

export async function verifyImpersonationToken(
  database: Database,
  token: string
): Promise<{ adminUserId: string; targetUserId: string; organizationId: string; expiresAt: string } | null> {
  const res = await database.client
    .from("impersonation_sessions")
    .select("admin_user_id,impersonated_user_id,organization_id,expires_at,revoked_at")
    .eq("token_hash", hashImpersonationToken(token))
    .is("revoked_at", null)
    .maybeSingle();

  if (!res.data) return null;
  const row = res.data as Record<string, unknown>;
  const expiresAt = new Date(String(row.expires_at)).getTime();
  if (Date.now() > expiresAt) return null;

  return {
    adminUserId: String(row.admin_user_id),
    targetUserId: String(row.impersonated_user_id),
    organizationId: String(row.organization_id),
    expiresAt: new Date(expiresAt).toISOString()
  };
}

export async function revokeImpersonationSession(
  database: Database,
  token: string
): Promise<void> {
  await database.client
    .from("impersonation_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hashImpersonationToken(token));
}

function hashImpersonationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function listAdminSubscriptions(
  database: Database
): Promise<Array<Record<string, unknown>>> {
  const res = await database.client
    .from("subscriptions")
    .select("id,organization_id,plan_id,provider,status,current_period_start,current_period_end,trial_start,trial_end,created_at");

  if (!res.data || !Array.isArray(res.data)) return [];

  // Fetch organization names
  const orgIds = res.data.map((r: any) => r.organization_id);
  const orgsRes = await database.client
    .from("organizations")
    .select("id,name,slug")
    .in("id", orgIds);

  const orgMap = new Map<string, { name: string; slug: string }>();
  if (orgsRes.data && Array.isArray(orgsRes.data)) {
    for (const org of orgsRes.data as any[]) {
      orgMap.set(String(org.id), { name: String(org.name), slug: String(org.slug) });
    }
  }

  return res.data.map((row: any) => {
    const org = orgMap.get(row.organization_id);
    return {
      id: row.id,
      organizationId: row.organization_id,
      organizationName: org?.name ?? "Unknown",
      organizationSlug: org?.slug ?? "",
      planId: row.plan_id,
      provider: row.provider,
      status: row.status,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      trialStart: row.trial_start,
      trialEnd: row.trial_end,
      createdAt: row.created_at
    };
  });
}
