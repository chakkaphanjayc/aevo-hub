import type {
  CreateOrganizationInput,
  CreateStoreInput,
  OrganizationOverviewStats,
  OrganizationSummary,
  Role,
  StoreOverviewStats,
  StorePerformanceMetric,
  StoreSummary
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

export interface OrganizationProfile {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  legalName: string;
  businessType: string;
  currency: string;
  timezone: string;
  country: string;
  logoUrl?: string;
  contactEmail?: string;
  contactPhone?: string;
  onboardingStatus: string;
  createdAt: string;
  updatedAt: string;
}

function mapOrganizationProfile(row: Row): OrganizationProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    status: (String(row.status) === "SUSPENDED" ? "SUSPENDED" : "ACTIVE"),
    legalName: String(row.legal_name ?? row.name),
    businessType: String(row.business_type ?? "GENERAL"),
    currency: String(row.currency ?? "THB"),
    timezone: String(row.timezone ?? "Asia/Bangkok"),
    country: String(row.country ?? "TH"),
    ...(row.logo_url ? { logoUrl: String(row.logo_url) } : {}),
    ...(row.contact_email ? { contactEmail: String(row.contact_email) } : {}),
    ...(row.contact_phone ? { contactPhone: String(row.contact_phone) } : {}),
    onboardingStatus: String(row.onboarding_status ?? "COMPLETED"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "org";
}

export async function listUserOrganizations(
  database: Database,
  userId: string
): Promise<OrganizationSummary[]> {
  // Query active memberships for this user
  const membershipsResult = await database.client
    .from("memberships")
    .select("id, organization_id, role_id, status, created_at")
    .eq("user_id", userId)
    .eq("status", "ACTIVE");

  if (membershipsResult.error) {
    throwDatabaseError(membershipsResult.error, "list user organizations");
  }

  const memberships = (membershipsResult.data ?? []) as Row[];
  if (memberships.length === 0) return [];

  const orgIds = memberships.map((m) => String(m.organization_id));
  const roleIds = memberships.map((m) => String(m.role_id));

  const [orgsResult, rolesResult] = await Promise.all([
    database.client
      .from("organizations")
      .select("id, name, slug, status, created_at")
      .in("id", orgIds),
    database.client.from("roles").select("id, code").in("id", roleIds)
  ]);

  if (orgsResult.error) throwDatabaseError(orgsResult.error, "lookup organizations");
  if (rolesResult.error) throwDatabaseError(rolesResult.error, "lookup roles");

  const rolesMap = new Map((rolesResult.data ?? []).map((r: Row) => [String(r.id), String(r.code) as Role]));
  const orgMap = new Map((orgsResult.data ?? []).map((o: Row) => [String(o.id), o]));

  return memberships.flatMap((m) => {
    const org = orgMap.get(String(m.organization_id));
    if (!org) return [];
    return [{
      id: String(org.id),
      name: String(org.name),
      slug: String(org.slug),
      role: rolesMap.get(String(m.role_id)),
      status: (String(org.status) === "ACTIVE" ? "ACTIVE" : "INACTIVE") as OrganizationSummary["status"],
      createdAt: String(org.created_at)
    }];
  });
}

export async function createOrganization(
  database: Database,
  userId: string,
  input: CreateOrganizationInput
): Promise<OrganizationSummary> {
  const slug = input.slug ? slugify(input.slug) : `${slugify(input.name)}-${Date.now().toString(36)}`;

  // 1. Insert organization
  const orgResult = await database.client
    .from("organizations")
    .insert({
      name: input.name,
      slug,
      status: "ACTIVE"
    })
    .select("id, name, slug, status, created_at")
    .single();

  if (orgResult.error) {
    throwDatabaseError(orgResult.error, "create organization");
  }
  const org = orgResult.data as Row;
  const orgId = String(org.id);

  // 2. Find OWNER role
  const roleResult = await database.client
    .from("roles")
    .select("id")
    .eq("code", "OWNER")
    .single();

  if (roleResult.error || !roleResult.data) {
    throwDatabaseError(roleResult.error, "lookup owner role");
    throw new Error("Owner role not found");
  }
  const ownerRoleId = String(roleResult.data.id);

  // 3. Create membership for creator as OWNER
  const membershipResult = await database.client
    .from("memberships")
    .insert({
      organization_id: orgId,
      user_id: userId,
      role_id: ownerRoleId,
      status: "ACTIVE"
    })
    .select("id")
    .single();

  if (membershipResult.error || !membershipResult.data) {
    throwDatabaseError(membershipResult.error, "create owner membership");
    throw new Error("Failed to create owner membership");
  }

  // Every organization starts with an explicit plan record. Entitlements are
  // copied from the plan so the gateway has one server-owned source of truth
  // from the first authenticated request onward.
  const subscriptionResult = await database.client
    .from("subscriptions")
    .insert({
      organization_id: orgId,
      plan_id: "starter",
      provider: "MANUAL",
      status: "TRIALING"
    })
    .select("id")
    .single();
  if (subscriptionResult.error || !subscriptionResult.data) {
    throwDatabaseError(subscriptionResult.error, "create organization subscription");
    throw new Error("Failed to create organization subscription");
  }

  const planEntitlementsResult = await database.client
    .from("plan_entitlements")
    .select("feature_key,is_enabled,limit_value")
    .eq("plan_id", "starter");
  if (planEntitlementsResult.error) {
    throwDatabaseError(planEntitlementsResult.error, "load starter entitlements");
  }
  const planEntitlements = (planEntitlementsResult.data ?? []) as Row[];
  if (planEntitlements.length > 0) {
    const entitlementInsert = await database.client
      .from("organization_entitlements")
      .insert(planEntitlements.map((entitlement) => ({
        organization_id: orgId,
        feature_key: String(entitlement.feature_key),
        is_enabled: Boolean(entitlement.is_enabled),
        custom_override: false,
        limit_value: entitlement.limit_value === null || entitlement.limit_value === undefined
          ? null
          : Number(entitlement.limit_value)
      })));
    if (entitlementInsert.error) {
      throwDatabaseError(entitlementInsert.error, "create organization entitlements");
    }
  }

  return {
    id: orgId,
    name: String(org.name),
    slug: String(org.slug),
    role: "OWNER",
    status: "ACTIVE",
    createdAt: String(org.created_at)
  };
}

export async function getOrganizationProfile(
  database: Database,
  organizationId: string
): Promise<OrganizationProfile | null> {
  const result = await database.client
    .from("organizations")
    .select("id,name,slug,status,legal_name,business_type,currency,timezone,country,logo_url,contact_email,contact_phone,onboarding_status,created_at,updated_at")
    .eq("id", organizationId)
    .maybeSingle();
  if (result.error) throwDatabaseError(result.error, "get organization profile");
  return result.data ? mapOrganizationProfile(result.data as Row) : null;
}

export async function updateOrganization(
  database: Database,
  organizationId: string,
  input: {
    name?: string;
    legalName?: string;
    slug?: string;
    businessType?: string;
    currency?: string;
    timezone?: string;
    country?: string;
    logoUrl?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
  }
): Promise<OrganizationProfile | null> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.legalName !== undefined) payload.legal_name = input.legalName.trim();
  if (input.slug !== undefined) payload.slug = slugify(input.slug);
  if (input.businessType !== undefined) payload.business_type = input.businessType.trim();
  if (input.currency !== undefined) payload.currency = input.currency.trim().toUpperCase();
  if (input.timezone !== undefined) payload.timezone = input.timezone.trim();
  if (input.country !== undefined) payload.country = input.country.trim().toUpperCase();
  if (input.logoUrl !== undefined) payload.logo_url = input.logoUrl?.trim() || null;
  if (input.contactEmail !== undefined) payload.contact_email = input.contactEmail?.trim().toLowerCase() || null;
  if (input.contactPhone !== undefined) payload.contact_phone = input.contactPhone?.trim() || null;

  if (Object.keys(payload).length === 0) return getOrganizationProfile(database, organizationId);
  const result = await database.client
    .from("organizations")
    .update(payload)
    .eq("id", organizationId)
    .select("id,name,slug,status,legal_name,business_type,currency,timezone,country,logo_url,contact_email,contact_phone,onboarding_status,created_at,updated_at")
    .maybeSingle();
  if (result.error) throwDatabaseError(result.error, "update organization profile");
  return result.data ? mapOrganizationProfile(result.data as Row) : null;
}

export async function listOrganizationStores(
  database: Database,
  organizationId: string
): Promise<StoreSummary[]> {
  const result = await database.client
    .from("stores")
    .select("id, organization_id, name, code, timezone")
    .eq("organization_id", organizationId)
    .eq("status", "ACTIVE")
    .order("code", { ascending: true });

  if (result.error) throwDatabaseError(result.error, "list stores");

  return (result.data ?? []).map((row: Row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    code: String(row.code),
    timezone: String(row.timezone)
  }));
}

export async function createStore(
  database: Database,
  organizationId: string,
  input: CreateStoreInput
): Promise<StoreSummary> {
  const result = await database.client
    .from("stores")
    .insert({
      organization_id: organizationId,
      name: input.name,
      code: input.code.trim().toUpperCase(),
      timezone: input.timezone || "Asia/Bangkok",
      currency: "THB",
      status: "ACTIVE"
    })
    .select("id, organization_id, name, code, timezone")
    .single();

  if (result.error || !result.data) throwDatabaseError(result.error, "create store");
  const row = result.data as Row;

  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    code: String(row.code),
    timezone: String(row.timezone)
  };
}

export async function getOrganizationStats(
  database: Database,
  organizationId: string
): Promise<{ totalApps: number; activeApps: number; totalStores: number; totalMembers: number; totalDevices: number }> {
  const [appsRes, subsRes, storesRes, membersRes, devicesRes] = await Promise.all([
    database.client.from("apps").select("id", { count: "exact", head: true }),
    database.client
      .from("organization_entitlements")
      .select("feature_key", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("is_enabled", true)
      .not("feature_key", "like", "max_%"),
    database.client
      .from("stores")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "ACTIVE"),
    database.client
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "ACTIVE"),
    database.client
      .from("devices")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "ACTIVE")
  ]);

  if (appsRes.error) throwDatabaseError(appsRes.error, "count apps");
  if (subsRes.error) throwDatabaseError(subsRes.error, "count subscriptions");
  if (storesRes.error) throwDatabaseError(storesRes.error, "count stores");
  if (membersRes.error) throwDatabaseError(membersRes.error, "count members");
  if (devicesRes.error) throwDatabaseError(devicesRes.error, "count devices");

  return {
    totalApps: appsRes.count ?? 0,
    activeApps: subsRes.count ?? 0,
    totalStores: storesRes.count ?? 0,
    totalMembers: membersRes.count ?? 0,
    totalDevices: devicesRes.count ?? 0
  };
}

export async function updateStore(
  database: Database,
  organizationId: string,
  storeId: string,
  input: { name?: string; code?: string; timezone?: string; currency?: string; status?: "ACTIVE" | "INACTIVE" }
): Promise<StoreSummary | null> {
  const payload: Record<string, unknown> = {};
  if (input.name) payload.name = input.name.trim();
  if (input.code) payload.code = input.code.trim().toUpperCase();
  if (input.timezone) payload.timezone = input.timezone.trim();
  if (input.currency) payload.currency = input.currency.trim();
  if (input.status) payload.status = input.status;

  const result = await database.client
    .from("stores")
    .update(payload)
    .eq("organization_id", organizationId)
    .eq("id", storeId)
    .select("id, organization_id, name, code, timezone")
    .maybeSingle();

  if (result.error) throwDatabaseError(result.error, "update store");
  if (!result.data) return null;
  const row = result.data as Row;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    code: String(row.code),
    timezone: String(row.timezone)
  };
}

export async function deleteStore(
  database: Database,
  organizationId: string,
  storeId: string
): Promise<boolean> {
  const result = await database.client
    .from("stores")
    .update({ status: "INACTIVE" })
    .eq("organization_id", organizationId)
    .eq("id", storeId);

  if (result.error) throwDatabaseError(result.error, "delete store");
  return true;
}

export async function getOrganizationOverviewMetrics(
  database: Database,
  organizationId: string
): Promise<OrganizationOverviewStats> {
  const [storesRes, appsRes, membersRes, storesData] = await Promise.all([
    database.client.from("stores").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "ACTIVE"),
    database.client.from("organization_entitlements").select("feature_key", { count: "exact", head: true }).eq("organization_id", organizationId).eq("is_enabled", true).not("feature_key", "like", "max_%"),
    database.client.from("memberships").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "ACTIVE"),
    database.client.from("stores").select("id, name, code, status").eq("organization_id", organizationId).order("created_at", { ascending: true })
  ]);

  if (storesRes.error) throwDatabaseError(storesRes.error, "count stores");
  if (appsRes.error) throwDatabaseError(appsRes.error, "count active apps");
  if (membersRes.error) throwDatabaseError(membersRes.error, "count members");
  if (storesData.error) throwDatabaseError(storesData.error, "list stores for overview");

  const stores = (storesData.data ?? []) as Row[];
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);

  // Fetch today's and month's orders for this org
  const [todayOrdersRes, monthOrdersRes, devicesRes] = await Promise.all([
    database.client
      .from("orders")
      .select("store_id, total_minor, status")
      .eq("organization_id", organizationId)
      .in("status", ["PAID", "COMPLETED", "SERVED", "READY"])
      .gte("created_at", todayStart.toISOString()),
    database.client
      .from("orders")
      .select("total_minor")
      .eq("organization_id", organizationId)
      .in("status", ["PAID", "COMPLETED", "SERVED", "READY"])
      .gte("created_at", monthStart.toISOString()),
    database.client
      .from("devices")
      .select("store_id, status")
      .eq("organization_id", organizationId)
      .eq("status", "ACTIVE")
  ]);

  const todayOrders = (todayOrdersRes.data ?? []) as Row[];
  const monthOrders = (monthOrdersRes.data ?? []) as Row[];
  const devices = (devicesRes.data ?? []) as Row[];

  let todayRevenueMinor = 0;
  const storeRevenueMap = new Map<string, number>();
  const storeOrderCountMap = new Map<string, number>();

  for (const o of todayOrders) {
    const amount = Number(o.total_minor) || 0;
    todayRevenueMinor += amount;
    const sId = String(o.store_id);
    storeRevenueMap.set(sId, (storeRevenueMap.get(sId) ?? 0) + amount);
    storeOrderCountMap.set(sId, (storeOrderCountMap.get(sId) ?? 0) + 1);
  }

  let monthRevenueMinor = 0;
  for (const o of monthOrders) {
    monthRevenueMinor += Number(o.total_minor) || 0;
  }

  const storeDeviceCountMap = new Map<string, number>();
  for (const d of devices) {
    const sId = String(d.store_id);
    storeDeviceCountMap.set(sId, (storeDeviceCountMap.get(sId) ?? 0) + 1);
  }

  const storePerformance: StorePerformanceMetric[] = stores.map((s) => {
    const sId = String(s.id);
    return {
      storeId: sId,
      name: String(s.name),
      code: String(s.code),
      status: String(s.status),
      todayRevenueMinor: storeRevenueMap.get(sId) ?? 0,
      todayOrdersCount: storeOrderCountMap.get(sId) ?? 0,
      activeDevicesCount: storeDeviceCountMap.get(sId) ?? 0
    };
  });

  return {
    totalStores: storesRes.count ?? stores.length,
    activeApps: appsRes.count ?? 0,
    totalMembers: membersRes.count ?? 0,
    todayRevenueMinor,
    monthRevenueMinor,
    storePerformance
  };
}

export async function getStoreOverviewMetrics(
  database: Database,
  organizationId: string,
  storeId: string
): Promise<StoreOverviewStats> {
  const storeRes = await database.client
    .from("stores")
    .select("id, name, code")
    .eq("organization_id", organizationId)
    .eq("id", storeId)
    .maybeSingle();

  if (storeRes.error) throwDatabaseError(storeRes.error, "get store info");
  if (!storeRes.data) throw new Error("Store not found");
  const storeRow = storeRes.data as Row;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [ordersRes, bookingsRes, devicesRes] = await Promise.all([
    database.client
      .from("orders")
      .select("total_minor, status")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .in("status", ["PAID", "COMPLETED", "SERVED", "READY"])
      .gte("created_at", todayStart.toISOString()),
    database.client
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .gte("start_time", todayStart.toISOString()),
    database.client
      .from("devices")
      .select("id, status")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
  ]);

  const orders = (ordersRes.data ?? []) as Row[];
  let todaySalesMinor = 0;
  for (const o of orders) {
    todaySalesMinor += Number(o.total_minor) || 0;
  }

  const devices = (devicesRes.data ?? []) as Row[];
  const devicesTotal = devices.length;
  const devicesOnline = devices.filter((d) => d.status === "ACTIVE").length;

  return {
    storeId: String(storeRow.id),
    name: String(storeRow.name),
    code: String(storeRow.code),
    todaySalesMinor,
    todayOrders: orders.length,
    todayBookings: bookingsRes.count ?? 0,
    devicesOnline,
    devicesTotal
  };
}
