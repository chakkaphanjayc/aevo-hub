import type {
  AppDefinition,
  AppEntitlement,
  AppPricingModel,
  AppStatus,
  AppSubscriptionSummary,
  EntitlementResult,
  FeatureEntitlement,
  SessionPrincipal,
  SubscriptionStatus
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

const appFeatureKeys: Record<string, string> = {
  pos: "pos",
  kiosk: "kiosk",
  booking: "booking",
  crm: "advanced_analytics",
  inventory: "odoo_integration",
  odoo_connector: "odoo_integration"
};

const appFeatureMap: Record<string, FeatureEntitlement[]> = {
  pos: ["pos.use", "reports.advanced"],
  kiosk: ["kiosk.use"],
  booking: ["booking.use", "booking.waitlist"],
  crm: ["reports.advanced"],
  inventory: ["odoo.sync"],
  odoo_connector: ["odoo.sync"]
};

export async function isSystemTestingMode(database: Database): Promise<boolean> {
  try {
    const result = await database.client
      .from("system_settings")
      .select("value")
      .eq("key", "operating_mode")
      .maybeSingle();

    if (result.data?.value) {
      const value = typeof result.data.value === "string" ? JSON.parse(result.data.value) : result.data.value;
      if (value && typeof value === "object") {
        const mode = (value as Record<string, unknown>).mode;
        const unlimited = (value as Record<string, unknown>).unlimited;
        return mode === "testing" && unlimited === true;
      }
    }
  } catch {
    // Entitlement checks fail closed when the setting cannot be read.
  }
  return false;
}

function mapApp(row: Row): AppDefinition {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    icon: String(row.icon),
    pricingModel: String(row.pricing_model) as AppPricingModel,
    basePriceMonthlyMinor: Number(row.base_price_monthly_minor ?? 0),
    status: String(row.status) as AppStatus,
    features: Array.isArray(row.features) ? (row.features as string[]) : [],
    createdAt: String(row.created_at)
  };
}

function calculateDaysRemaining(targetDate?: string | null): number | undefined {
  if (!targetDate) return undefined;
  const diffMs = new Date(targetDate).getTime() - Date.now();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function mapPlanStatus(value: unknown): SubscriptionStatus {
  switch (String(value ?? "TRIALING")) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAST_DUE":
      return "PAST_DUE";
    case "CANCELED":
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "TRIAL";
  }
}

function planIsUsable(value: unknown): boolean {
  return ["TRIALING", "ACTIVE", "GRACE_PERIOD"].includes(String(value ?? "TRIALING"));
}

export async function listApps(database: Database): Promise<AppDefinition[]> {
  const result = await database.client
    .from("apps")
    .select("id,name,description,icon,pricing_model,base_price_monthly_minor,status,features,created_at")
    .order("created_at", { ascending: true });

  throwDatabaseError(result.error, "list apps");
  if (!result.data) return [];
  return (result.data as Row[]).map(mapApp);
}

export async function listOrganizationSubscriptions(
  database: Database,
  principal: SessionPrincipal,
  storeId?: string
): Promise<AppSubscriptionSummary[]> {
  const [appsResult, subscriptionResult, organizationEntitlementsResult] = await Promise.all([
    database.client
      .from("apps")
      .select("id")
      .order("created_at", { ascending: true }),
    database.client
      .from("subscriptions")
      .select("id,plan_id,status,trial_end,current_period_start,current_period_end,created_at,updated_at")
      .eq("organization_id", principal.organizationId)
      .maybeSingle(),
    database.client
      .from("organization_entitlements")
      .select("feature_key,is_enabled,limit_value")
      .eq("organization_id", principal.organizationId)
  ]);

  throwDatabaseError(appsResult.error, "list subscription apps");
  throwDatabaseError(subscriptionResult.error, "load organization subscription");
  throwDatabaseError(organizationEntitlementsResult.error, "load organization entitlements");

  const subscription = subscriptionResult.data as Row | null;
  const planId = String(subscription?.plan_id ?? "starter");
  let entitlementRows = (organizationEntitlementsResult.data ?? []) as Row[];

  if (entitlementRows.length === 0) {
    const planEntitlementsResult = await database.client
      .from("plan_entitlements")
      .select("feature_key,is_enabled,limit_value")
      .eq("plan_id", planId);
    throwDatabaseError(planEntitlementsResult.error, "load plan entitlements");
    entitlementRows = (planEntitlementsResult.data ?? []) as Row[];
  }

  const entitlements = new Map<string, { enabled: boolean; limit: number | null }>();
  for (const row of entitlementRows) {
    entitlements.set(String(row.feature_key), {
      enabled: Boolean(row.is_enabled),
      limit: row.limit_value === null || row.limit_value === undefined ? null : Number(row.limit_value)
    });
  }

  const operatingMode = await isSystemTestingMode(database);
  const rawPlanStatus = subscription?.status ?? "TRIALING";
  const status = mapPlanStatus(rawPlanStatus);
  const now = new Date().toISOString();
  const trialEndsAt = subscription?.trial_end ? String(subscription.trial_end) : null;
  const currentPeriodStartsAt = subscription?.current_period_start
    ? String(subscription.current_period_start)
    : now;
  const currentPeriodEndsAt = subscription?.current_period_end
    ? String(subscription.current_period_end)
    : now;
  const createdAt = subscription?.created_at ? String(subscription.created_at) : now;
  const updatedAt = subscription?.updated_at ? String(subscription.updated_at) : createdAt;

  return ((appsResult.data ?? []) as Row[]).map((app) => {
    const appId = String(app.id);
    const featureKey = appFeatureKeys[appId] ?? appId;
    const feature = entitlements.get(featureKey);
    const isEntitled = operatingMode || (planIsUsable(rawPlanStatus) && Boolean(feature?.enabled));
    const appStatus: SubscriptionStatus = isEntitled ? status : "EXPIRED";
    const daysRemaining = status === "TRIAL"
      ? calculateDaysRemaining(trialEndsAt)
      : calculateDaysRemaining(currentPeriodEndsAt);

    return {
      id: `${String(subscription?.id ?? principal.organizationId)}:${appId}`,
      organizationId: principal.organizationId,
      storeId: storeId ?? null,
      appId,
      status: appStatus,
      planCode: planId,
      trialEndsAt,
      currentPeriodStartsAt,
      currentPeriodEndsAt,
      deviceLimit: entitlements.get("max_devices")?.limit ?? null,
      resourceLimit: feature?.limit ?? null,
      isEntitled,
      daysRemaining,
      createdAt,
      updatedAt
    };
  });
}

export async function getAppEntitlement(
  database: Database,
  principal: SessionPrincipal,
  appId: string,
  storeId?: string
): Promise<AppEntitlement> {
  const subscriptions = await listOrganizationSubscriptions(database, principal, storeId);
  const matched = subscriptions.find((subscription) => subscription.appId === appId);
  if (!matched) {
    return { appId, isEntitled: false, status: "UNSUBSCRIBED", features: [] };
  }

  return {
    appId,
    isEntitled: matched.isEntitled,
    status: matched.isEntitled ? matched.status : "UNSUBSCRIBED",
    trialEndsAt: matched.trialEndsAt,
    currentPeriodEndsAt: matched.currentPeriodEndsAt,
    daysRemaining: matched.daysRemaining,
    features: matched.isEntitled ? (appFeatureMap[appId] ?? []) : []
  };
}

export async function checkAppEntitlement(
  database: Database,
  principal: SessionPrincipal,
  appId: string,
  storeId?: string
): Promise<EntitlementResult> {
  const testing = await isSystemTestingMode(database);
  if (testing) {
    return {
      allowed: true,
      mode: "testing",
      limit: null,
      currentUsage: 0,
      reason: "unlimited_testing_mode"
    };
  }

  const entitlement = await getAppEntitlement(database, principal, appId, storeId);
  return {
    allowed: entitlement.isEntitled,
    mode: "production",
    limit: 100,
    currentUsage: 0,
    reason: entitlement.isEntitled ? "subscription_active" : "subscription_required"
  };
}
