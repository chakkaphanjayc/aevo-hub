import type {
  OrganizationEntitlement,
  PlanEntitlement,
  ResolvedEntitlements,
  UsageCounter
} from "@aevo/contracts";
import type { Database } from "@aevo/db";

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

export async function resolveOrganizationEntitlements(
  database: Database,
  organizationId: string
): Promise<ResolvedEntitlements> {
  // 1. Fetch active subscription
  const subRes = await database.client
    .from("subscriptions")
    .select("id,plan_id,status,trial_end,current_period_end,grace_period_ends_at")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const sub = subRes.data as Row | null;
  const planId = sub ? String(sub.plan_id) : "starter";
  const status = sub ? String(sub.status) : "ACTIVE";

  // 2. Fetch organization entitlements (includes custom overrides)
  const entRes = await database.client
    .from("organization_entitlements")
    .select("feature_key,is_enabled,limit_value,custom_override")
    .eq("organization_id", organizationId);

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

  // 3. Fetch current usage counters
  const usageRes = await database.client
    .from("usage_counters")
    .select("feature_key,current_count")
    .eq("organization_id", organizationId);

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
