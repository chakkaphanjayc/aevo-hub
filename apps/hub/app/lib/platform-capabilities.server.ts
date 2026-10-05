import { ApiClientError } from "@aevocado/contracts";
import type { ApiClient, AppSubscriptionSummary, ResolvedEntitlements } from "@aevocado/contracts";
export { unexposedCapabilities } from "./platform-capabilities";
export type { UnexposedCoreCapability } from "./platform-capabilities";

export type CoreRead<T> =
  | { state: "available"; data: T }
  | { state: "unavailable"; code: string; message: string }
  | { state: "denied"; code: string; message: string }
  | { state: "error"; code: string; message: string };

export interface BillingCoreSnapshot {
  subscriptions: CoreRead<AppSubscriptionSummary[]>;
  entitlements: CoreRead<ResolvedEntitlements>;
}

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
