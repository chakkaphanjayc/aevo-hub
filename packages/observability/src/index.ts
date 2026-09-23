export type RuntimeEnvironment = "development" | "test" | "production";

export interface ReleaseMetadata {
  appName: string;
  appVersion: string;
  environment: RuntimeEnvironment;
}

export interface RequestContext {
  requestId: string;
  appName: string;
  appVersion: string;
  environment: RuntimeEnvironment;
  organizationId?: string;
  storeId?: string;
  route?: string;
  action?: string;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function normalizeRequestId(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && requestIdPattern.test(candidate) ? candidate : undefined;
}

export function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  const fallback = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return fallback || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createReleaseMetadata(input: {
  appName: string;
  appVersion?: string;
  environment?: string;
}): ReleaseMetadata {
  const environment = input.environment === "production" || input.environment === "test"
    ? input.environment
    : "development";
  return {
    appName: input.appName,
    appVersion: input.appVersion?.trim() || "development",
    environment
  };
}

export function toLogContext(context: RequestContext): Record<string, string> {
  return {
    request_id: context.requestId,
    app_name: context.appName,
    app_version: context.appVersion,
    environment: context.environment,
    ...(context.organizationId ? { organization_id: context.organizationId } : {}),
    ...(context.storeId ? { store_id: context.storeId } : {}),
    ...(context.route ? { route: context.route } : {}),
    ...(context.action ? { action: context.action } : {})
  };
}
