import { ApiClientError } from "@aevocado/contracts";
import type { ApiClient, AppSubscriptionSummary, ResolvedEntitlements } from "@aevocado/contracts";

export type CoreRead<T> =
  | { state: "available"; data: T }
  | { state: "unavailable"; code: string; message: string }
  | { state: "denied"; code: string; message: string }
  | { state: "error"; code: string; message: string };

export interface BillingCoreSnapshot {
  subscriptions: CoreRead<AppSubscriptionSummary[]>;
  entitlements: CoreRead<ResolvedEntitlements>;
}

export interface UnexposedCoreCapability {
  state: "unavailable";
  code: string;
  message: string;
}

export const unexposedCapabilities = {
  billingPortal: {
    state: "unavailable",
    code: "CORE_BILLING_PORTAL_NOT_EXPOSED",
    message: "Core does not expose billing-provider portal capability or a portal action to Hub.",
  },
  paymentHistory: {
    state: "unavailable",
    code: "CORE_BILLING_HISTORY_NOT_EXPOSED",
    message: "Core does not expose payment methods, invoices, or transaction history to Hub.",
  },
  queryPlatform: {
    state: "unavailable",
    code: "CORE_QUERY_PLATFORM_NOT_EXPOSED",
    message: "Core does not expose Query Platform model metadata, saved definitions, report execution, or export jobs to Hub.",
  },
  imports: {
    state: "unavailable",
    code: "CORE_IMPORT_CAPABILITY_NOT_EXPOSED",
    message: "Core does not expose import schemas, field-mapping metadata, validation, or import jobs to Hub.",
  },
  exports: {
    state: "unavailable",
    code: "CORE_EXPORT_CAPABILITY_NOT_EXPOSED",
    message: "Core does not expose scoped export metadata, export jobs, or result downloads to Hub.",
  },
} satisfies Record<string, UnexposedCoreCapability>;

function failedRead<T>(error: unknown): CoreRead<T> {
  if (error instanceof ApiClientError) {
    if (error.status === 401 || error.status === 403) {
      return { state: "denied", code: error.code || "CORE_PERMISSION_REQUIRED", message: error.message };
    }
    if (error.status === 404 || error.status === 501) {
      return { state: "unavailable", code: error.code || "CORE_CAPABILITY_NOT_EXPOSED", message: error.message };
    }
    return { state: "error", code: error.code || "CORE_REQUEST_FAILED", message: error.message };
  }
  return {
    state: "error",
    code: "CORE_REQUEST_FAILED",
    message: error instanceof Error ? error.message : "Core did not return this workspace data.",
  };
}

async function readCore<T>(read: () => Promise<T>): Promise<CoreRead<T>> {
  try {
    return { state: "available", data: await read() };
  } catch (error) {
    return failedRead<T>(error);
  }
}

export async function loadBillingCoreSnapshot(api: ApiClient): Promise<BillingCoreSnapshot> {
  const [subscriptions, entitlements] = await Promise.all([
    readCore(async () => (await api.request<{ subscriptions: AppSubscriptionSummary[] }>("/api/v1/hub/subscriptions")).subscriptions),
    readCore(async () => (await api.request<{ success: true; entitlements: ResolvedEntitlements }>("/api/v1/me/entitlements")).entitlements),
  ]);
  return { subscriptions, entitlements };
}
