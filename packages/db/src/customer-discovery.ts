import type {
  CustomerStoreProfile,
  PublicStoreDiscoveryPage,
  PublicStoreDiscoverySummary,
  UpsertCustomerStoreProfileInput
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

const PROFILE_COLUMNS = [
  "store_id",
  "organization_id",
  "public_slug",
  "public_enabled",
  "area",
  "category",
  "price_range",
  "availability_label",
  "description",
  "image_url",
  "media_urls",
  "facilities",
  "policy_summary",
  "latitude",
  "longitude",
  "rating",
  "review_count",
  "created_at",
  "updated_at"
].join(",");

const PUBLIC_DISCOVERY_SCAN_LIMIT = 1_000;
const PUBLIC_DISCOVERY_PAGE_SIZE = 48;
const PUBLIC_DISCOVERY_RPC_LIMIT = PUBLIC_DISCOVERY_PAGE_SIZE + 1;

interface ActiveStoreRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  venueSlug?: string;
  venueId?: string;
  venueAddress?: string;
  venueTimezone?: string;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function normalizedSearchTerm(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .toLocaleLowerCase();
  return normalized || null;
}

function normalizedFilter(value: string | undefined): string | null {
  const normalized = normalizedSearchTerm(value);
  return normalized ? normalized : null;
}

function priceLevelFromRange(value: string): number | null {
  const digits = value.replace(/[^0-9]/gu, "");
  if (digits) {
    const parsed = Number(digits);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : null;
  }
  const symbols = value.match(/[฿$€£]/gu);
  return symbols && symbols.length >= 1 && symbols.length <= 4 ? symbols.length : null;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor || !/^\d+$/.test(cursor)) return 0;
  return Math.min(Number(cursor), PUBLIC_DISCOVERY_SCAN_LIMIT);
}

export interface PublicDiscoveryBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function parsePublicDiscoveryBounds(value: string | undefined): PublicDiscoveryBounds | null {
  if (!value) return null;
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.length !== 4 || values.some((part) => !Number.isFinite(part))) return null;
  const [west, south, east, north] = values;
  if (west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || south > 90 || north < -90 || north > 90) return null;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

export function isPublicDiscoveryBoundsAllowed(bounds: PublicDiscoveryBounds, zoom = 12): boolean {
  const normalizedZoom = Number.isFinite(zoom) ? Math.max(0, Math.min(22, zoom)) : 12;
  const maxSpan = normalizedZoom <= 5 ? 30 : normalizedZoom <= 8 ? 12 : 5;
  return bounds.east - bounds.west <= maxSpan && bounds.north - bounds.south <= maxSpan;
}

function mapProfile(row: Row): CustomerStoreProfile {
  return {
    storeId: String(row.store_id),
    organizationId: String(row.organization_id),
    publicSlug: String(row.public_slug),
    publicEnabled: row.public_enabled === true,
    area: String(row.area),
    category: String(row.category),
    priceRange: String(row.price_range),
    availabilityLabel: nullableString(row.availability_label),
    description: nullableString(row.description),
    imageUrl: nullableString(row.image_url),
    mediaUrls: stringArray(row.media_urls),
    facilities: stringArray(row.facilities),
    policySummary: nullableString(row.policy_summary),
    latitude: nullableNumber(row.latitude),
    longitude: nullableNumber(row.longitude),
    rating: nullableNumber(row.rating),
    reviewCount: Number(row.review_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function loadActiveStoreMap(
  database: Database,
  profiles: CustomerStoreProfile[]
): Promise<Map<string, ActiveStoreRow>> {
  const storeIds = [...new Set(profiles.map((profile) => profile.storeId))];
  if (storeIds.length === 0) return new Map();

  const storesResult = await database.client
    .from("stores")
    .select("id,organization_id,name,code,status")
    .in("id", storeIds)
    .eq("status", "ACTIVE");
  throwDatabaseError(storesResult.error, "public store discovery lookup");

  const storeRows = (storesResult.data ?? []) as unknown as Row[];
  const organizationIds = [...new Set(storeRows.map((row) => String(row.organization_id)))];
  if (organizationIds.length === 0) return new Map();

  const venuesResult = await database.client
    .from("venues")
    .select("id,store_id,slug,address,timezone")
    .in("store_id", storeIds)
    .eq("status", "ACTIVE")
    .order("slug", { ascending: true });
  throwDatabaseError(venuesResult.error, "public store venue lookup");
  const venueByStore = new Map<string, { id: string; slug: string; address: string; timezone: string }>();
  for (const row of (venuesResult.data ?? []) as unknown as Row[]) {
    const storeId = typeof row.store_id === "string" ? row.store_id : "";
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (storeId && id && slug && !venueByStore.has(storeId)) {
      venueByStore.set(storeId, {
        id,
        slug,
        address: typeof row.address === "string" ? row.address.trim() : "",
        timezone: typeof row.timezone === "string" ? row.timezone.trim() : "Asia/Bangkok"
      });
    }
  }

  const organizationsResult = await database.client
    .from("organizations")
    .select("id,status")
    .in("id", organizationIds)
    .eq("status", "ACTIVE");
  throwDatabaseError(organizationsResult.error, "public organization discovery lookup");

  const activeOrganizations = new Set(
    ((organizationsResult.data ?? []) as unknown as Row[]).map((row) => String(row.id))
  );
  return new Map(
    storeRows.flatMap((row) => {
      const organizationId = String(row.organization_id);
      if (!activeOrganizations.has(organizationId)) return [];
      const id = String(row.id);
      const venue = venueByStore.get(id);
      return [[id, {
        id,
        organizationId,
        name: String(row.name),
        code: String(row.code),
        ...(venue ? {
          venueId: venue.id,
          venueSlug: venue.slug,
          ...(venue.address ? { venueAddress: venue.address } : {}),
          ...(venue.timezone ? { venueTimezone: venue.timezone } : {})
        } : {})
      } satisfies ActiveStoreRow] as const];
    })
  );
}

async function loadPublicVenueDetails(
  database: Database,
  venueId: string | undefined
): Promise<Array<{ dayOfWeek: number; openTime: string; closeTime: string; enabled: boolean }>> {
  if (!venueId) return [];
  const result = await database.client
    .from("operating_hours")
    .select("day_of_week,open_time,close_time,enabled")
    .eq("venue_id", venueId)
    .order("day_of_week", { ascending: true });
  throwDatabaseError(result.error, "public operating hours lookup");
  return ((result.data ?? []) as unknown as Row[]).map((row) => ({
    dayOfWeek: Number(row.day_of_week),
    openTime: String(row.open_time),
    closeTime: String(row.close_time),
    enabled: row.enabled !== false
  }));
}

function mapPublicStore(
  profile: CustomerStoreProfile,
  store: ActiveStoreRow,
  operatingHours?: Array<{ dayOfWeek: number; openTime: string; closeTime: string; enabled: boolean }>
): PublicStoreDiscoverySummary {
  return {
    id: store.id,
    slug: profile.publicSlug,
    storeCode: store.code,
    ...(store.venueSlug ? { venueSlug: store.venueSlug } : {}),
    name: store.name,
    area: profile.area,
    category: profile.category,
    rating: profile.rating,
    reviewCount: profile.reviewCount,
    priceRange: profile.priceRange,
    imageUrl: profile.imageUrl,
    ...(profile.mediaUrls.length > 0 ? { mediaUrls: profile.mediaUrls } : {}),
    ...(profile.facilities.length > 0 ? { facilities: profile.facilities } : {}),
    ...(profile.policySummary ? { policySummary: profile.policySummary } : {}),
    ...(store.venueAddress ? { address: store.venueAddress } : {}),
    ...(store.venueTimezone ? { timezone: store.venueTimezone } : {}),
    ...(operatingHours && operatingHours.length > 0 ? { operatingHours } : {}),
    availabilityLabel: profile.availabilityLabel,
    description: profile.description,
    latitude: profile.latitude,
    longitude: profile.longitude,
    categoryIconKey: profile.category.toLocaleLowerCase().replace(/\s+/gu, "-"),
    priceLevel: priceLevelFromRange(profile.priceRange),
    availableToday: profile.availabilityLabel ? true : null
  };
}

function mapSpatialPublicStore(row: Row): PublicStoreDiscoverySummary {
  const priceRange = String(row.price_range ?? "฿฿");
  const availabilityLabel = nullableString(row.availability_label);
  return {
    id: String(row.store_id),
    slug: String(row.public_slug),
    storeCode: String(row.store_code),
    ...(nullableString(row.venue_slug) ? { venueSlug: String(row.venue_slug) } : {}),
    name: String(row.store_name),
    area: String(row.area),
    category: String(row.category),
    rating: nullableNumber(row.rating),
    reviewCount: Number(row.review_count ?? 0),
    priceRange,
    imageUrl: nullableString(row.image_url),
    ...(stringArray(row.media_urls).length > 0 ? { mediaUrls: stringArray(row.media_urls) } : {}),
    ...(stringArray(row.facilities).length > 0 ? { facilities: stringArray(row.facilities) } : {}),
    ...(nullableString(row.policy_summary) ? { policySummary: String(row.policy_summary) } : {}),
    ...(nullableString(row.venue_address) ? { address: String(row.venue_address) } : {}),
    ...(nullableString(row.venue_timezone) ? { timezone: String(row.venue_timezone) } : {}),
    availabilityLabel,
    description: nullableString(row.description),
    latitude: nullableNumber(row.latitude),
    longitude: nullableNumber(row.longitude),
    categoryIconKey: String(row.category).toLocaleLowerCase().replace(/\s+/gu, "-"),
    priceLevel: priceLevelFromRange(priceRange),
    availableToday: availabilityLabel ? true : null
  };
}

async function listPublicStoreDiscoveryInView(
  database: Database,
  input: {
    bounds: PublicDiscoveryBounds;
    query?: string;
    area?: string;
    categoryIds?: string[];
    priceLevels?: number[];
    availableAt?: string;
    partySize?: number;
    cursor?: string;
    limit: number;
  }
): Promise<PublicStoreDiscoveryPage> {
  const offset = parseCursor(input.cursor);
  const rpcResult = await database.client.rpc("public_store_discovery_in_view", {
    p_west: input.bounds.west,
    p_south: input.bounds.south,
    p_east: input.bounds.east,
    p_north: input.bounds.north,
    p_query: normalizedSearchTerm(input.query),
    p_area: normalizedFilter(input.area),
    p_category_ids: input.categoryIds?.map((value) => normalizedFilter(value)).filter((value): value is string => Boolean(value)) ?? null,
    p_price_levels: input.priceLevels?.filter((value) => Number.isInteger(value) && value >= 1 && value <= 4) ?? null,
    p_available_at: input.availableAt ?? null,
    p_party_size: input.partySize ?? null,
    p_limit: Math.min(input.limit + 1, PUBLIC_DISCOVERY_RPC_LIMIT),
    p_offset: offset
  });
  throwDatabaseError(rpcResult.error, "public store discovery spatial query");

  const rows = (rpcResult.data ?? []) as unknown as Row[];
  const truncated = rows.length > input.limit;
  const data = rows.slice(0, input.limit).map(mapSpatialPublicStore);
  const buildFacets = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  };

  return {
    data,
    nextCursor: truncated ? String(offset + input.limit) : null,
    bounds: input.bounds,
    truncated,
    facets: {
      categories: buildFacets(data.map((store) => store.category)),
      areas: buildFacets(data.map((store) => store.area)),
      priceRanges: buildFacets(data.map((store) => store.priceRange))
    }
  };
}

function matchesPublicStore(
  store: PublicStoreDiscoverySummary,
  query: string | null,
  category: string | null,
  area: string | null,
  bounds: PublicDiscoveryBounds | null,
  categoryIds: string[] = [],
  priceLevels: number[] = [],
  availableAt?: string
): boolean {
  if (category && store.category.toLocaleLowerCase() !== category) return false;
  if (categoryIds.length > 0 && !categoryIds.includes(store.category.toLocaleLowerCase())) return false;
  if (area && store.area.toLocaleLowerCase() !== area) return false;
  if (priceLevels.length > 0 && (typeof store.priceLevel !== "number" || !priceLevels.includes(store.priceLevel))) return false;
  if (availableAt && !store.availabilityLabel) return false;
  if (bounds && (
    store.latitude === null || store.longitude === null
    || store.latitude < bounds.south || store.latitude > bounds.north
    || store.longitude < bounds.west || store.longitude > bounds.east
  )) return false;
  if (!query) return true;
  const searchable = [store.name, store.area, store.category, store.description ?? "", store.storeCode]
    .join(" ")
    .toLocaleLowerCase();
  return searchable.includes(query);
}

export async function listPublicStoreDiscovery(
  database: Database,
  input: {
    query?: string;
    category?: string;
    categoryIds?: string[];
    area?: string;
    bbox?: string;
    zoom?: number;
    priceLevels?: number[];
    availableAt?: string;
    partySize?: number;
    cursor?: string;
    limit?: number;
  } = {}
): Promise<PublicStoreDiscoveryPage> {
  const pageSize = Math.min(Math.max(input.limit ?? 24, 1), PUBLIC_DISCOVERY_PAGE_SIZE);
  const bounds = parsePublicDiscoveryBounds(input.bbox);
  if (input.bbox && !bounds) {
    throw new Error("INVALID_DISCOVERY_BBOX");
  }
  if (bounds && !isPublicDiscoveryBoundsAllowed(bounds, input.zoom ?? 12)) {
    throw new Error("DISCOVERY_BBOX_TOO_LARGE");
  }
  if (bounds) {
    return listPublicStoreDiscoveryInView(database, {
      bounds,
      ...(input.query ? { query: input.query } : {}),
      ...(input.area ? { area: input.area } : {}),
      ...(input.categoryIds ? { categoryIds: input.categoryIds } : input.category ? { categoryIds: [input.category] } : {}),
      ...(input.priceLevels ? { priceLevels: input.priceLevels } : {}),
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
      ...(input.partySize ? { partySize: input.partySize } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: pageSize
    });
  }
  const profileResult = await database.client
    .from("customer_store_profiles")
    .select(PROFILE_COLUMNS)
    .eq("public_enabled", true)
    .order("public_slug", { ascending: true })
    .limit(PUBLIC_DISCOVERY_SCAN_LIMIT);
  throwDatabaseError(profileResult.error, "public store discovery profiles");

  const profiles = ((profileResult.data ?? []) as unknown as Row[]).map(mapProfile);
  const stores = await loadActiveStoreMap(database, profiles);
  const query = normalizedSearchTerm(input.query);
  const category = normalizedFilter(input.category);
  const area = normalizedFilter(input.area);
  const categoryIds = (input.categoryIds ?? (category ? [category] : []))
    .map((value) => normalizedFilter(value))
    .filter((value): value is string => Boolean(value));
  const priceLevels = (input.priceLevels ?? [])
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 4);
  const matched = profiles
    .flatMap((profile) => {
      const store = stores.get(profile.storeId);
      if (!store || store.organizationId !== profile.organizationId) return [];
      const summary = mapPublicStore(profile, store);
      return matchesPublicStore(summary, query, category, area, bounds, categoryIds, priceLevels, input.availableAt) ? [summary] : [];
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));

  const offset = parseCursor(input.cursor);
  const data = matched.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const buildFacets = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  };
  return {
    data,
    nextCursor: nextOffset < matched.length ? String(nextOffset) : null,
    facets: {
      categories: buildFacets(matched.map((store) => store.category)),
      areas: buildFacets(matched.map((store) => store.area)),
      priceRanges: buildFacets(matched.map((store) => store.priceRange))
    }
  };
}

export interface PublicStoreSuggestion {
  kind: "STORE" | "CATEGORY" | "AREA";
  value: string;
  label: string;
  storeSlug?: string;
}

export async function listPublicStoreSuggestions(
  database: Database,
  query: string,
  limit = 8
): Promise<{ suggestions: PublicStoreSuggestion[]; serverTime: string }> {
  const normalizedQuery = normalizedSearchTerm(query);
  if (!normalizedQuery) return { suggestions: [], serverTime: new Date().toISOString() };
  const page = await listPublicStoreDiscovery(database, { query: normalizedQuery, limit: Math.min(Math.max(limit, 1), 24) });
  const suggestions: PublicStoreSuggestion[] = [
    ...page.data.map((store) => ({ kind: "STORE" as const, value: store.name, label: store.name, storeSlug: store.slug })),
    ...(page.facets?.categories ?? []).map((facet) => ({ kind: "CATEGORY" as const, value: facet.value, label: facet.value })),
    ...(page.facets?.areas ?? []).map((facet) => ({ kind: "AREA" as const, value: facet.value, label: facet.value }))
  ];
  const unique = suggestions.filter((suggestion, index, all) => all.findIndex((candidate) => candidate.kind === suggestion.kind && candidate.value === suggestion.value) === index);
  return { suggestions: unique.slice(0, Math.min(Math.max(limit, 1), 24)), serverTime: new Date().toISOString() };
}

export async function getPublicStoreBySlug(
  database: Database,
  publicSlug: string
): Promise<PublicStoreDiscoverySummary | null> {
  const normalizedSlug = publicSlug.trim().toLowerCase();
  const profileResult = await database.client
    .from("customer_store_profiles")
    .select(PROFILE_COLUMNS)
    .eq("public_slug", normalizedSlug)
    .eq("public_enabled", true)
    .maybeSingle();
  throwDatabaseError(profileResult.error, "public store profile lookup");
  if (!profileResult.data) return null;

  const profile = mapProfile(profileResult.data as unknown as Row);
  const stores = await loadActiveStoreMap(database, [profile]);
  const store = stores.get(profile.storeId);
  if (!store || store.organizationId !== profile.organizationId) return null;
  const operatingHours = await loadPublicVenueDetails(database, store.venueId);
  return mapPublicStore(profile, store, operatingHours);
}

export async function getCustomerStoreProfile(
  database: Database,
  organizationId: string,
  storeId: string
): Promise<CustomerStoreProfile | null> {
  const result = await database.client
    .from("customer_store_profiles")
    .select(PROFILE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .maybeSingle();
  throwDatabaseError(result.error, "customer store profile lookup");
  return result.data ? mapProfile(result.data as unknown as Row) : null;
}

export interface CustomerFavoriteSummary {
  storeSlug: string;
  savedAt: string;
}

export async function listCustomerFavorites(
  database: Database,
  customerId: string
): Promise<CustomerFavoriteSummary[]> {
  const favoritesResult = await database.client
    .from("customer_favorites")
    .select("store_id,created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  throwDatabaseError(favoritesResult.error, "customer favorites lookup");
  const rows = (favoritesResult.data ?? []) as unknown as Row[];
  const storeIds = rows.map((row) => String(row.store_id)).filter(Boolean);
  if (storeIds.length === 0) return [];

  const profilesResult = await database.client
    .from("customer_store_profiles")
    .select("store_id,public_slug,public_enabled")
    .in("store_id", storeIds)
    .eq("public_enabled", true);
  throwDatabaseError(profilesResult.error, "customer favorite public profile lookup");
  const slugByStore = new Map(
    ((profilesResult.data ?? []) as unknown as Row[]).map((row) => [String(row.store_id), String(row.public_slug)])
  );
  return rows.flatMap((row) => {
    const storeSlug = slugByStore.get(String(row.store_id));
    return storeSlug ? [{ storeSlug, savedAt: String(row.created_at) }] : [];
  });
}

export async function setCustomerFavorite(
  database: Database,
  customerId: string,
  publicSlug: string,
  saved: boolean
): Promise<CustomerFavoriteSummary | null> {
  const store = await getPublicStoreBySlug(database, publicSlug);
  if (!store) return null;

  if (!saved) {
    const deleteResult = await database.client
      .from("customer_favorites")
      .delete()
      .eq("customer_id", customerId)
      .eq("store_id", store.id);
    throwDatabaseError(deleteResult.error, "customer favorite removal");
    return null;
  }

  const result = await database.client
    .from("customer_favorites")
    .upsert({ customer_id: customerId, store_id: store.id }, { onConflict: "customer_id,store_id" })
    .select("created_at")
    .single();
  throwDatabaseError(result.error, "customer favorite save");
  return { storeSlug: store.slug, savedAt: String((result.data as Row).created_at) };
}

export async function upsertCustomerStoreProfile(
  database: Database,
  organizationId: string,
  storeId: string,
  input: UpsertCustomerStoreProfileInput
): Promise<CustomerStoreProfile> {
  const result = await database.client
    .from("customer_store_profiles")
    .upsert({
      store_id: storeId,
      organization_id: organizationId,
      public_slug: input.publicSlug.trim().toLowerCase(),
      public_enabled: input.publicEnabled,
      area: input.area.trim(),
      category: input.category.trim(),
      price_range: input.priceRange.trim(),
      availability_label: input.availabilityLabel?.trim() || null,
      description: input.description?.trim() || null,
      image_url: input.imageUrl?.trim() || null,
      media_urls: input.mediaUrls ?? [],
      facilities: input.facilities ?? [],
      policy_summary: input.policySummary?.trim() || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      rating: input.rating ?? null,
      review_count: input.reviewCount ?? 0
    }, { onConflict: "store_id" })
    .select(PROFILE_COLUMNS)
    .single();
  throwDatabaseError(result.error, "customer store profile upsert");
  return mapProfile(result.data as unknown as Row);
}
