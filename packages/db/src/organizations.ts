import type {
  CreateOrganizationInput,
  CreateStoreInput,
  OrganizationOverviewStats,
  OrganizationSummary,
  Role,
  SessionPrincipal,
  StoreOverviewStats,
  StorePerformanceMetric,
  StoreSummary
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapOrganizationOverviewStats(value: unknown): OrganizationOverviewStats | null {
  if (!isRow(value)) return null;
  const storePerformance = Array.isArray(value.storePerformance)
    ? value.storePerformance.filter(isRow).map((store) => ({
        storeId: String(store.storeId ?? ""),
        name: String(store.name ?? ""),
        code: String(store.code ?? ""),
        status: String(store.status ?? "ACTIVE"),
        todayRevenueMinor: numericValue(store.todayRevenueMinor),
        todayOrdersCount: numericValue(store.todayOrdersCount),
        activeDevicesCount: numericValue(store.activeDevicesCount)
      }))
    : [];

  return {
    totalStores: numericValue(value.totalStores),
    activeApps: numericValue(value.activeApps),
    totalMembers: numericValue(value.totalMembers),
    todayRevenueMinor: numericValue(value.todayRevenueMinor),
    monthRevenueMinor: numericValue(value.monthRevenueMinor),
    storePerformance
  };
}

function mapStoreOverviewStats(value: unknown): StoreOverviewStats | null {
  if (!isRow(value) || !value.storeId) return null;
  return {
    storeId: String(value.storeId),
    name: String(value.name ?? ""),
    code: String(value.code ?? ""),
    todaySalesMinor: numericValue(value.todaySalesMinor),
    todayOrders: numericValue(value.todayOrders),
    todayBookings: numericValue(value.todayBookings),
    devicesOnline: numericValue(value.devicesOnline),
    devicesTotal: numericValue(value.devicesTotal)
  };
}

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

export class OrganizationLifecycleError extends Error {
  constructor(
    readonly code: "STORE_QUOTA_EXCEEDED" | "ORGANIZATION_NOT_ACTIVE" | "STORE_CODE_ALREADY_EXISTS" | "ORGANIZATION_SLUG_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "OrganizationLifecycleError";
  }
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
  // The read model joins memberships, organizations, and roles in one
  // statement. Keep the legacy path for rolling deployments where the
  // migration has not reached this gateway instance's database yet.
  const readModelResult = await database.client.rpc("hub_user_organizations", {
    p_user_id: userId
  });
  if (!readModelResult.error) {
    if (!Array.isArray(readModelResult.data)) {
      throw new Error("User organization read model returned an invalid payload");
    }
    return (readModelResult.data as Row[]).flatMap((row) => {
      if (!row.id || !row.name || !row.slug) return [];
      const status = String(row.status) === "ACTIVE" ? "ACTIVE" : "INACTIVE";
      return [{
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        ...(row.role ? { role: String(row.role) as Role } : {}),
        status,
        createdAt: String(row.created_at)
      } satisfies OrganizationSummary];
    });
  }
  if (!['PGRST202', '42883'].includes(readModelResult.error.code ?? "")) {
    throwDatabaseError(readModelResult.error, "user organization read model");
  }

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
  return createOrganizationWithProfile(database, userId, input);
}

export async function createOrganizationWithProfile(
  database: Database,
  userId: string,
  input: CreateOrganizationInput & {
    legalName?: string;
    businessType?: string;
    country?: string;
    timezone?: string;
    currency?: string;
    logoUrl?: string;
    contactEmail?: string;
    contactPhone?: string;
  }
): Promise<OrganizationSummary> {
  const result = await database.client.rpc("hub_create_organization", {
    p_owner_user_id: userId,
    p_name: input.name.trim(),
    p_slug: input.slug ? slugify(input.slug) : null,
    p_legal_name: input.legalName?.trim() || null,
    p_business_type: input.businessType?.trim() || "GENERAL",
    p_country: input.country?.trim().toUpperCase() || "TH",
    p_timezone: input.timezone?.trim() || "Asia/Bangkok",
    p_currency: input.currency?.trim().toUpperCase() || "THB",
    p_logo_url: input.logoUrl?.trim() || null,
    p_contact_email: input.contactEmail?.trim().toLowerCase() || null,
    p_contact_phone: input.contactPhone?.trim() || null
  });

  if (result.error) {
    if (result.error.code === "23505" || /slug unavailable/i.test(result.error.message)) {
      throw new OrganizationLifecycleError("ORGANIZATION_SLUG_UNAVAILABLE", "The organization slug could not be reserved");
    }
    throwDatabaseError(result.error, "create organization transaction");
  }

  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as Row | null;
  if (!row?.id) throw new Error("Organization creation returned no identifier");
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    role: "OWNER",
    status: "ACTIVE",
    createdAt: String(row.created_at)
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
  organizationId: string,
  principal?: SessionPrincipal
): Promise<StoreSummary[]> {
  let allowedStoreIds: string[] | undefined;
  if (principal && !["OWNER", "ADMIN", "ORGANIZATION_MANAGER"].includes(principal.role)) {
    const accessResult = await database.client
      .from("membership_stores")
      .select("store_id")
      .eq("membership_id", principal.membershipId);
    if (accessResult.error) throwDatabaseError(accessResult.error, "store access lookup");
    allowedStoreIds = (accessResult.data ?? []).map((row) => String((row as Row).store_id));
    if (allowedStoreIds.length === 0) return [];
  }
  let storeQuery = database.client
    .from("stores")
    .select("id, organization_id, name, code, timezone, currency, store_mode, address, phone, tax_id, status")
    .eq("organization_id", organizationId)
    .eq("status", "ACTIVE")
    .order("code", { ascending: true });

  if (allowedStoreIds) storeQuery = storeQuery.in("id", allowedStoreIds);
  const result = await storeQuery;

  if (result.error) throwDatabaseError(result.error, "list stores");

  return (result.data ?? []).map((row: Row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    code: String(row.code),
    timezone: String(row.timezone),
    currency: String(row.currency ?? "THB"),
    storeMode: String(row.store_mode ?? "POS") as StoreSummary["storeMode"],
    address: row.address ? String(row.address) : null,
    phone: row.phone ? String(row.phone) : null,
    taxId: row.tax_id ? String(row.tax_id) : null,
    status: String(row.status ?? "ACTIVE") as StoreSummary["status"]
  }));
}

export async function createStore(
  database: Database,
  organizationId: string,
  input: CreateStoreInput
): Promise<StoreSummary> {
  const result = await database.client.rpc("hub_create_store", {
    p_organization_id: organizationId,
    p_name: input.name.trim(),
    p_code: input.code.trim().toUpperCase(),
    p_timezone: input.timezone?.trim() || "Asia/Bangkok",
    p_currency: input.currency?.trim().toUpperCase() || "THB",
    p_store_mode: input.storeMode || "POS",
    p_address: input.address?.trim() || null,
    p_phone: input.phone?.trim() || null,
    p_tax_id: input.taxId?.trim() || null
  });

  if (result.error) {
    if (result.error.code === "23505") {
      throw new OrganizationLifecycleError("STORE_CODE_ALREADY_EXISTS", "A store with this code already exists in the organization");
    }
    if (result.error.message.includes("STORE_QUOTA_EXCEEDED")) {
      throw new OrganizationLifecycleError("STORE_QUOTA_EXCEEDED", "The organization has reached its active store limit");
    }
    if (result.error.message.includes("ORGANIZATION_NOT_ACTIVE")) {
      throw new OrganizationLifecycleError("ORGANIZATION_NOT_ACTIVE", "The organization is not active");
    }
    throwDatabaseError(result.error, "create store transaction");
  }

  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as Row | null;
  if (!row?.id) throw new Error("Store creation returned no identifier");

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
  input: {
    name?: string;
    code?: string;
    timezone?: string;
    currency?: string;
    storeMode?: "POS" | "KIOSK" | "BOOKING" | "POS_BOOKING" | "CUSTOM";
    address?: string;
    phone?: string;
    taxId?: string;
    status?: "ACTIVE" | "INACTIVE";
  }
): Promise<StoreSummary | null> {
  const payload: Record<string, unknown> = {};
  if (input.name) payload.name = input.name.trim();
  if (input.code) payload.code = input.code.trim().toUpperCase();
  if (input.timezone) payload.timezone = input.timezone.trim();
  if (input.currency) payload.currency = input.currency.trim().toUpperCase();
  if (input.storeMode) payload.store_mode = input.storeMode;
  if (input.address !== undefined) payload.address = input.address.trim() || null;
  if (input.phone !== undefined) payload.phone = input.phone.trim() || null;
  if (input.taxId !== undefined) payload.tax_id = input.taxId.trim() || null;
  if (input.status) payload.status = input.status;

  const result = await database.client
    .from("stores")
    .update(payload)
    .eq("organization_id", organizationId)
    .eq("id", storeId)
    .select("id, organization_id, name, code, timezone, currency, store_mode, address, phone, tax_id, status")
    .maybeSingle();

  if (result.error) {
    if (result.error.code === "23505") {
      throw new OrganizationLifecycleError("STORE_CODE_ALREADY_EXISTS", "A store with this code already exists in the organization");
    }
    throwDatabaseError(result.error, "update store");
  }
  if (!result.data) return null;
  const row = result.data as Row;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    code: String(row.code),
    timezone: String(row.timezone),
    currency: String(row.currency ?? "THB"),
    storeMode: String(row.store_mode ?? "POS") as StoreSummary["storeMode"],
    address: row.address ? String(row.address) : null,
    phone: row.phone ? String(row.phone) : null,
    taxId: row.tax_id ? String(row.tax_id) : null,
    status: String(row.status ?? "ACTIVE") as StoreSummary["status"]
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
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1));
  const rpcResult = await database.client.rpc("hub_organization_overview_metrics", {
    p_organization_id: organizationId,
    p_today_start: todayStart.toISOString(),
    p_month_start: monthStart.toISOString()
  });
  if (rpcResult.error) {
    if (!["PGRST202", "42883"].includes(rpcResult.error.code ?? "")) {
      throwDatabaseError(rpcResult.error, "organization overview metrics");
    }
  } else {
    const mapped = mapOrganizationOverviewStats(rpcResult.data);
    if (mapped) return mapped;
  }

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
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const rpcResult = await database.client.rpc("hub_store_overview_metrics", {
    p_organization_id: organizationId,
    p_store_id: storeId,
    p_today_start: todayStart.toISOString()
  });
  if (rpcResult.error) {
    if (!["PGRST202", "42883"].includes(rpcResult.error.code ?? "")) {
      throwDatabaseError(rpcResult.error, "store overview metrics");
    }
  } else {
    const mapped = mapStoreOverviewStats(rpcResult.data);
    if (mapped) return mapped;
  }

  const [storeRes, venuesRes] = await Promise.all([
    database.client
      .from("stores")
      .select("id, name, code")
      .eq("organization_id", organizationId)
      .eq("id", storeId)
      .maybeSingle(),
    database.client
      .from("venues")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("status", "ACTIVE")
  ]);

  if (storeRes.error) throwDatabaseError(storeRes.error, "get store info");
  if (venuesRes.error) throwDatabaseError(venuesRes.error, "list store venues");
  if (!storeRes.data) throw new Error("Store not found");
  const storeRow = storeRes.data as Row;

  const venueIds = ((venuesRes.data ?? []) as Row[]).map((venue) => String(venue.id));
  const [ordersRes, devicesRes] = await Promise.all([
    database.client
      .from("orders")
      .select("total_minor, status")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .in("status", ["PAID", "COMPLETED", "SERVED", "READY"])
      .gte("created_at", todayStart.toISOString()),
    database.client
      .from("devices")
      .select("id, status")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
  ]);

  if (ordersRes.error) throwDatabaseError(ordersRes.error, "list store orders");
  if (devicesRes.error) throwDatabaseError(devicesRes.error, "list store devices");

  let todayBookings = 0;
  if (venueIds.length > 0) {
    const bookingsRes = await database.client
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("venue_id", venueIds)
      .gte("start_at", todayStart.toISOString());
    if (bookingsRes.error) throwDatabaseError(bookingsRes.error, "count store bookings");
    todayBookings = bookingsRes.count ?? 0;
  }

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
    todayBookings,
    devicesOnline,
    devicesTotal
  };
}
