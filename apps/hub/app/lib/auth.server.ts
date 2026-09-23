import { ApiClient, ApiClientError } from "@aevocado/contracts";
import type { AccessDecisionResponse, AuthenticatedMeResponse } from "@aevocado/api-contract";
import { createAuthClient } from "@aevocado/auth-client";
import { redirect } from "react-router";
import type { HubLoaderData } from "./auth.shared";
import { hubSlowRequestThresholdMs, logHubEvent } from "./server-log.server";

export type { HubLoaderData } from "./auth.shared";

const hubAccessCache = new WeakMap<Request, Promise<HubLoaderData>>();

export function apiOrigin(request?: Request): string {
  return request?.headers.get("x-aevo-runtime-api-url")?.trim()
    || process.env.AEVO_CORE_API_URL?.trim()
    || process.env.AEVO_API_URL?.trim()
    || "http://localhost:4000";
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createHubApiClient(request: Request): ApiClient {
  const cookie = request.headers.get("cookie");
  return new ApiClient({
    baseUrl: apiOrigin(request),
    credentials: "include",
    timeoutMs: 5_000,
    defaultHeaders: {
      "x-aevo-app": "HUB",
      ...(cookie ? { cookie } : {})
    },
    onRequest: ({ requestId, method, path }) => {
      logHubEvent("debug", "api.request", {
        request_id: requestId,
        method,
        target: path,
        loader_route: new URL(request.url).pathname
      });
    },
    onResponse: ({ requestId, method, path, durationMs, status, error }) => {
      const duration = durationMs ?? 0;
      const level = error || (status ?? 0) >= 500 ? "error" : (status ?? 0) >= 400 ? "warn" : "info";
      logHubEvent(level, "api.response", {
        request_id: requestId,
        method,
        target: path,
        status: status ?? 0,
        duration_ms: duration,
        slow: duration >= hubSlowRequestThresholdMs(),
        ...(error ? { transport_error: error } : {})
      });
    }
  });
}

export function requestCsrfHeaders(request: Request): HeadersInit {
  const token = readCookie(request, process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf");
  return token ? { "x-csrf-token": token } : {};
}

export function hubWebOrigin(): string {
  const configured = process.env.AEVO_HUB_WEB_URL?.trim() || process.env.WEB_ORIGIN?.trim();
  return configured?.replace(/\/+$/u, "") || "http://localhost:4330";
}

export function hubHomeUrl(): string {
  const configured = process.env.AEVO_HUB_HOME_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
      // Fall through to the local/public home fallback.
    }
  }
  return process.env.NODE_ENV === "production" ? "/" : "http://localhost:4321/";
}

function loginRedirect(path = "/modern"): never {
  const loginUrl = new URL("/modern/login", hubWebOrigin());
  loginUrl.searchParams.set("next", path);
  throw redirect(loginUrl.toString());
}

export async function requireAuthenticated(request: Request, returnPath = "/modern/onboarding"): Promise<{
  me: AuthenticatedMeResponse;
  api: ApiClient;
}> {
  const api = createHubApiClient(request);
  const auth = createAuthClient({ api, application: "HUB" });
  try {
    return { me: await auth.me(), api };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) loginRedirect(returnPath);
    throw error;
  }
}

async function resolveHubAccess(request: Request, returnPath: string): Promise<HubLoaderData> {
  const api = createHubApiClient(request);
  const auth = createAuthClient({ api, application: "HUB" });
  const loaderRoute = new URL(request.url).pathname;
  const startedAt = performance.now();

  try {
    const [me, access] = await Promise.all([auth.me(), auth.access()]);
    logHubEvent("info", "hub.access", {
      route: loaderRoute,
      duration_ms: Math.round(performance.now() - startedAt),
      access_reason: access.reason,
      authenticated: Boolean(me.user?.id),
      organization_id: access.organizationId
    });
    return { me, access, apiOrigin: apiOrigin(request), homeUrl: hubHomeUrl() };
  } catch (error) {
    logHubEvent("warn", "hub.access.error", {
      route: loaderRoute,
      duration_ms: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "unknown"
    });
    if (error instanceof ApiClientError && error.status === 401) loginRedirect(returnPath);
    throw error;
  }
}

export function requireHubAccess(request: Request, returnPath = "/modern"): Promise<HubLoaderData> {
  const cached = hubAccessCache.get(request);
  if (cached) return cached;
  const pending = resolveHubAccess(request, returnPath);
  hubAccessCache.set(request, pending);
  return pending;
}
