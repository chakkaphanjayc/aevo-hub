import type { ResolvedEntitlements } from "@aevo/contracts";
import type { Database } from "@aevo/db";
import { throwDatabaseError } from "@aevo/db";

export class EntitlementError extends Error {
  readonly code: string;
  readonly featureKey: string;
  readonly limit?: number | null;
  readonly currentUsage?: number;

  constructor(message: string, options: {
    code: "FEATURE_NOT_ENTITLED" | "QUOTA_EXCEEDED" | "SUBSCRIPTION_INACTIVE";
    featureKey: string;
    limit?: number | null;
    currentUsage?: number;
  }) {
    super(message);
    this.name = "EntitlementError";
    this.code = options.code;
    this.featureKey = options.featureKey;
    this.limit = options.limit;
    this.currentUsage = options.currentUsage;
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapResolvedEntitlements(value: unknown, organizationId: string): ResolvedEntitlements | null {
  if (!isRow(value)) return null;

  const features: Record<string, boolean> = {};
  const limits: Record<string, number | null> = {};
  const usage: Record<string, number> = {};
  const rawFeatures = isRow(value.features) ? value.features : {};
  const rawLimits = isRow(value.limits) ? value.limits : {};
  const rawUsage = isRow(value.usage) ? value.usage : {};

  for (const [key, enabled] of Object.entries(rawFeatures)) features[key] = enabled === true;
  for (const [key, limit] of Object.entries(rawLimits)) {
    if (limit === null || limit === undefined) {
      limits[key] = null;
    } else {
      const parsed = Number(limit);
      limits[key] = Number.isFinite(parsed) ? parsed : null;
    }
  }
  for (const [key, count] of Object.entries(rawUsage)) {
    const parsed = Number(count);
    usage[key] = Number.isFinite(parsed) ? parsed : 0;
  }

  return {
    organizationId,
    planId: String(value.planId ?? "starter"),
    status: String(value.status ?? "ACTIVE"),
    features,
    limits,
    usage
  };
}

function isMissingEntitlementRoutine(error: { code?: string } | null): boolean {
  return Boolean(error && ["PGRST202", "42883"].includes(error.code ?? ""));
}

export async function resolveOrganizationEntitlements(
  database: Database,
  organizationId: string
): Promise<ResolvedEntitlements> {
  // The read model collapses subscription, resolved features, limits, and
  // current usage into one database round trip. Keep the query fallback so a
  // rolling deployment remains compatible before the migration is applied.
  const rpcResult = await database.client.rpc("hub_organization_entitlements", {
    p_organization_id: organizationId
  });
  if (!rpcResult.error) {
    const resolved = mapResolvedEntitlements(rpcResult.data, organizationId);
    if (!resolved) throw new Error("Organization entitlement read model returned an invalid payload");
    return resolved;
  }
  if (!isMissingEntitlementRoutine(rpcResult.error)) {
    throwDatabaseError(rpcResult.error, "organization entitlement read model");
  }

  // Fallback for deployments that have not run the read-model migration yet.
  const [subRes, entRes, usageRes] = await Promise.all([
    database.client
      .from("subscriptions")
      .select("id,plan_id,status,trial_end,current_period_end,grace_period_ends_at")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    database.client
      .from("organization_entitlements")
      .select("feature_key,is_enabled,limit_value,custom_override")
      .eq("organization_id", organizationId),
    database.client
      .from("usage_counters")
      .select("feature_key,current_count")
      .eq("organization_id", organizationId)
  ]);
  throwDatabaseError(subRes.error, "load organization subscription");
  throwDatabaseError(entRes.error, "load organization entitlements");
  throwDatabaseError(usageRes.error, "load organization usage");

  const sub = subRes.data as Row | null;
  const planId = sub ? String(sub.plan_id) : "starter";
  const status = sub ? String(sub.status) : "ACTIVE";

  const features: Record<string, boolean> = {};
  const limits: Record<string, number | null> = {};

  if (entRes.data && Array.isArray(entRes.data)) {
    for (const row of entRes.data as Row[]) {
      const key = String(row.feature_key);
      features[key] = Boolean(row.is_enabled);
      if (row.limit_value !== undefined) {
        limits[key] = row.limit_value === null ? null : Number(row.limit_value);
      }
    }
  }

  // If no organization_entitlements found yet, fall back to plan_entitlements
  if (Object.keys(features).length === 0) {
    const planEntRes = await database.client
      .from("plan_entitlements")
      .select("feature_key,is_enabled,limit_value")
      .eq("plan_id", planId);

    if (planEntRes.data && Array.isArray(planEntRes.data)) {
      for (const row of planEntRes.data as Row[]) {
        const key = String(row.feature_key);
        features[key] = Boolean(row.is_enabled);
        if (row.limit_value !== undefined) {
          limits[key] = row.limit_value === null ? null : Number(row.limit_value);
        }
      }
    }
  }

  const usage: Record<string, number> = {};
  if (usageRes.data && Array.isArray(usageRes.data)) {
    for (const row of usageRes.data as Row[]) {
      usage[String(row.feature_key)] = Number(row.current_count ?? 0);
    }
  }

  return {
    organizationId,
    planId,
    status,
    features,
    limits,
    usage
  };
}

export async function checkFeatureEntitlement(
  database: Database,
  organizationId: string,
  featureKey: string
): Promise<boolean> {
  const resolved = await resolveOrganizationEntitlements(database, organizationId);
  return Boolean(resolved.features[featureKey]);
}

export async function requireFeatureEntitlement(
  database: Database,
  organizationId: string,
  featureKey: string
): Promise<void> {
  const resolved = await resolveOrganizationEntitlements(database, organizationId);
  if (!resolved.features[featureKey]) {
    throw new EntitlementError(
      `Feature '${featureKey}' is not enabled for this organization's subscription plan.`,
      {
        code: "FEATURE_NOT_ENTITLED",
        featureKey
      }
    );
  }
}

export async function checkUsageQuota(
  database: Database,
  organizationId: string,
  featureKey: string,
  quantity = 1
): Promise<{ allowed: boolean; currentUsage: number; limit: number | null }> {
  const resolved = await resolveOrganizationEntitlements(database, organizationId);
  const limit = resolved.limits[featureKey] ?? null;
  const currentUsage = resolved.usage[featureKey] ?? 0;

  if (limit === null) {
    return { allowed: true, currentUsage, limit: null };
  }

  const allowed = currentUsage + quantity <= limit;
  return { allowed, currentUsage, limit };
}

export async function requireUsageQuota(
  database: Database,
  organizationId: string,
  featureKey: string,
  quantity = 1
): Promise<void> {
  const check = await checkUsageQuota(database, organizationId, featureKey, quantity);
  if (!check.allowed) {
    throw new EntitlementError(
      `Usage limit exceeded for '${featureKey}'. Current: ${check.currentUsage}, Limit: ${check.limit}`,
      {
        code: "QUOTA_EXCEEDED",
        featureKey,
        limit: check.limit,
        currentUsage: check.currentUsage
      }
    );
  }
}

export async function recordUsage(
  database: Database,
  organizationId: string,
  featureKey: string,
  delta = 1
): Promise<number> {
  const existingRes = await database.client
    .from("usage_counters")
    .select("id,current_count")
    .eq("organization_id", organizationId)
    .eq("feature_key", featureKey)
    .maybeSingle();

  const current = existingRes.data ? Number((existingRes.data as Row).current_count ?? 0) : 0;
  const nextCount = Math.max(0, current + delta);

  await database.client
    .from("usage_counters")
    .upsert({
      organization_id: organizationId,
      feature_key: featureKey,
      current_count: nextCount,
      period_start: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "organization_id,feature_key" });

  return nextCount;
}

export async function overrideOrganizationEntitlement(
  database: Database,
  input: {
    organizationId: string;
    featureKey: string;
    isEnabled: boolean;
    limitValue?: number | null;
  }
): Promise<void> {
  await database.client
    .from("organization_entitlements")
    .upsert({
      organization_id: input.organizationId,
      feature_key: input.featureKey,
      is_enabled: input.isEnabled,
      limit_value: input.limitValue ?? null,
      custom_override: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "organization_id,feature_key" });
}
