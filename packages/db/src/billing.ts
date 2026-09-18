import type {
  BillingCustomer,
  BillingProvider,
  BillingSubscription,
  BillingWebhookEvent,
  ChangePlanInput,
  CreateCustomerInput,
  CreateSubscriptionInput
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

function mapBillingCustomer(row: Row): BillingCustomer {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    provider: String(row.provider) as BillingCustomer["provider"],
    providerCustomerId: String(row.provider_customer_id),
    email: String(row.email),
    createdAt: String(row.created_at)
  };
}

export async function getBillingCustomer(
  database: Database,
  organizationId: string,
  provider = "STRIPE"
): Promise<BillingCustomer | null> {
  const result = await database.client
    .from("billing_customers")
    .select("id,organization_id,provider,provider_customer_id,email,created_at")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();

  if (result.error) throwDatabaseError(result.error, "get billing customer");
  if (!result.data) return null;
  return mapBillingCustomer(result.data as Row);
}

export async function recordBillingCustomer(
  database: Database,
  customer: {
    organizationId: string;
    provider: "STRIPE" | "OPN" | "XENDIT" | "MANUAL";
    providerCustomerId: string;
    email: string;
  }
): Promise<BillingCustomer> {
  const result = await database.client
    .from("billing_customers")
    .upsert({
      organization_id: customer.organizationId,
      provider: customer.provider,
      provider_customer_id: customer.providerCustomerId,
      email: customer.email
    }, { onConflict: "organization_id,provider" })
    .select("id,organization_id,provider,provider_customer_id,email,created_at")
    .single();

  if (result.error) throwDatabaseError(result.error, "record billing customer");
  return mapBillingCustomer(result.data as Row);
}

export async function recordBillingWebhookEvent(
  database: Database,
  event: {
    id: string;
    provider: "STRIPE" | "OPN" | "XENDIT" | "MANUAL";
    eventType: string;
    payload: Record<string, unknown>;
  }
): Promise<{ processed: boolean; duplicate: boolean }> {
  // Check if already processed
  const existing = await database.client
    .from("billing_webhook_events")
    .select("id,processed")
    .eq("id", event.id)
    .maybeSingle();

  if (existing.data) {
    return { processed: Boolean(existing.data.processed), duplicate: true };
  }

  const insertRes = await database.client
    .from("billing_webhook_events")
    .insert({
      id: event.id,
      provider: event.provider,
      event_type: event.eventType,
      payload: event.payload,
      processed: true
    });

  if (insertRes.error) throwDatabaseError(insertRes.error, "record billing webhook");
  return { processed: true, duplicate: false };
}

/**
 * In-memory Mock Billing Provider for CI, local development, and tests
 */
export class MockBillingAdapter implements BillingProvider {
  private customers = new Map<string, BillingCustomer>();
  private subscriptions = new Map<string, BillingSubscription>();

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    const customer: BillingCustomer = {
      id: `cus-db-${Date.now()}`,
      organizationId: input.organizationId,
      provider: "STRIPE",
      providerCustomerId: `cus_stripe_${Date.now()}`,
      email: input.email,
      createdAt: new Date().toISOString()
    };
    this.customers.set(customer.providerCustomerId, customer);
    return customer;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<BillingSubscription> {
    const sub: BillingSubscription = {
      id: `sub-db-${Date.now()}`,
      providerSubscriptionId: `sub_stripe_${Date.now()}`,
      customerId: input.customerId,
      status: "ACTIVE",
      planCode: input.planCode,
      currentPeriodStartsAt: new Date().toISOString(),
      currentPeriodEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    this.subscriptions.set(sub.providerSubscriptionId, sub);
    return sub;
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) {
      sub.status = "CANCELED";
    }
  }

  async changePlan(input: ChangePlanInput): Promise<BillingSubscription> {
    const sub = this.subscriptions.get(input.subscriptionId);
    if (!sub) {
      throw new Error(`Subscription ${input.subscriptionId} not found`);
    }
    sub.planCode = input.newPlanCode;
    return sub;
  }

  async getPortalUrl(customerId: string, returnUrl: string): Promise<string> {
    return `https://billing.stripe.com/p/session/test_${customerId}?return_url=${encodeURIComponent(returnUrl)}`;
  }

  async verifyWebhook(request: Request): Promise<BillingWebhookEvent> {
    const sigHeader = request.headers.get("stripe-signature");
    if (sigHeader && (sigHeader.includes("invalid") || sigHeader.includes("fraud"))) {
      throw new Error("Invalid Stripe webhook signature");
    }
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      id: String(payload.id ?? `evt_${Date.now()}`),
      type: String(payload.type ?? "invoice.paid"),
      provider: "STRIPE",
      data: payload,
      createdAt: new Date().toISOString()
    };
  }
}

/**
 * Synchronize plan entitlements to organization_entitlements table.
 * Preserves custom overrides (custom_override = true).
 */
export async function syncPlanEntitlements(
  database: Database,
  organizationId: string,
  planId: string
): Promise<void> {
  const planEntRes = await database.client
    .from("plan_entitlements")
    .select("feature_key,is_enabled,limit_value")
    .eq("plan_id", planId);

  if (planEntRes.error) throwDatabaseError(planEntRes.error, "fetch plan entitlements");
  if (!planEntRes.data || !Array.isArray(planEntRes.data)) return;

  const existingRes = await database.client
    .from("organization_entitlements")
    .select("feature_key,custom_override")
    .eq("organization_id", organizationId);

  const customOverrides = new Set<string>();
  if (existingRes.data && Array.isArray(existingRes.data)) {
    for (const row of existingRes.data as Row[]) {
      if (row.custom_override) {
        customOverrides.add(String(row.feature_key));
      }
    }
  }

  for (const item of planEntRes.data as Row[]) {
    const featureKey = String(item.feature_key);
    if (customOverrides.has(featureKey)) {
      continue; // Respect manual overrides
    }

    await database.client
      .from("organization_entitlements")
      .upsert({
        organization_id: organizationId,
        feature_key: featureKey,
        is_enabled: Boolean(item.is_enabled),
        limit_value: item.limit_value !== undefined ? item.limit_value : null,
        custom_override: false,
        updated_at: new Date().toISOString()
      }, { onConflict: "organization_id,feature_key" });
  }
}

/**
 * Process a verified Stripe Webhook event and update database ground truth.
 */
export async function processStripeWebhookEvent(
  database: Database,
  event: BillingWebhookEvent
): Promise<{ success: boolean; eventType: string; duplicate: boolean }> {
  // 1. Idempotency Check
  const provider = (event.provider || "STRIPE") as "STRIPE" | "OPN" | "XENDIT" | "MANUAL";
  const rec = await recordBillingWebhookEvent(database, {
    id: event.id,
    provider,
    eventType: event.type,
    payload: event.data
  });

  if (rec.duplicate) {
    return { success: true, eventType: event.type, duplicate: true };
  }

  const obj = (event.data?.object ?? event.data) as Record<string, unknown>;

  // 2. Dispatch event handlers
  switch (event.type) {
    case "checkout.session.completed": {
      const orgId = String(obj?.client_reference_id || (obj?.metadata as Row)?.organization_id || "");
      const customerId = String(obj?.customer ?? "");
      const subscriptionId = String(obj?.subscription ?? "");
      const planId = String((obj?.metadata as Row)?.plan_id || "business");

      if (orgId) {
        await database.client
          .from("subscriptions")
          .upsert({
            organization_id: orgId,
            plan_id: planId,
            provider: "STRIPE",
            provider_customer_id: customerId,
            provider_subscription_id: subscriptionId,
            status: "ACTIVE",
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }, { onConflict: "organization_id" });

        await syncPlanEntitlements(database, orgId, planId);
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const customerId = String(obj?.customer ?? "");
      const subId = String(obj?.id ?? "");
      const statusRaw = String(obj?.status ?? "active").toLowerCase();
      const planCode = String((obj?.metadata as Row)?.plan_id || "business");

      const statusMap: Record<string, string> = {
        active: "ACTIVE",
        trialing: "TRIALING",
        past_due: "PAST_DUE",
        canceled: "CANCELED",
        unpaid: "PAST_DUE"
      };
      const status = statusMap[statusRaw] || "ACTIVE";

      // Find organization by provider_customer_id or metadata
      let orgId = String((obj?.metadata as Row)?.organization_id || "");
      if (!orgId && customerId) {
        const custRes = await database.client
          .from("billing_customers")
          .select("organization_id")
          .eq("provider_customer_id", customerId)
          .maybeSingle();
        if (custRes.data) orgId = String((custRes.data as Row).organization_id);
      }

      if (orgId) {
        const startSec = Number(obj?.current_period_start) || Math.floor(Date.now() / 1000);
        const endSec = Number(obj?.current_period_end) || Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);

        await database.client
          .from("subscriptions")
          .upsert({
            organization_id: orgId,
            plan_id: planCode,
            provider: "STRIPE",
            provider_customer_id: customerId,
            provider_subscription_id: subId,
            status,
            current_period_start: new Date(startSec * 1000).toISOString(),
            current_period_end: new Date(endSec * 1000).toISOString(),
            cancel_at_period_end: Boolean(obj?.cancel_at_period_end),
            updated_at: new Date().toISOString()
          }, { onConflict: "organization_id" });

        await syncPlanEntitlements(database, orgId, planCode);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const customerId = String(obj?.customer ?? "");
      let orgId = String((obj?.metadata as Row)?.organization_id || "");
      if (!orgId && customerId) {
        const custRes = await database.client
          .from("billing_customers")
          .select("organization_id")
          .eq("provider_customer_id", customerId)
          .maybeSingle();
        if (custRes.data) orgId = String((custRes.data as Row).organization_id);
      }

      if (orgId) {
        await database.client
          .from("subscriptions")
          .update({
            status: "CANCELED",
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq("organization_id", orgId);

        // Downgrade to starter
        await syncPlanEntitlements(database, orgId, "starter");
      }
      break;
    }

    case "invoice.paid": {
      const customerId = String(obj?.customer ?? "");
      const subId = String(obj?.subscription ?? "");
      if (subId) {
        await database.client
          .from("subscriptions")
          .update({
            status: "ACTIVE",
            updated_at: new Date().toISOString()
          })
          .eq("provider_subscription_id", subId);
      }
      break;
    }

    case "invoice.payment_failed": {
      const subId = String(obj?.subscription ?? "");
      if (subId) {
        await database.client
          .from("subscriptions")
          .update({
            status: "PAST_DUE",
            updated_at: new Date().toISOString()
          })
          .eq("provider_subscription_id", subId);
      }
      break;
    }
  }

  return { success: true, eventType: event.type, duplicate: false };
}
