import { ApiClient, ApiClientError } from "@aevocado/contracts";
import type { StoreSummary } from "@aevocado/contracts";
import type { AccessDecisionResponse, AuthenticatedMeResponse } from "@aevocado/api-contract";
import { createAuthClient } from "@aevocado/auth-client";
import { redirect } from "react-router";
import type { HubLoaderData } from "./auth.shared";
import { hubSlowRequestThresholdMs, logHubEvent } from "./server-log.server";

export type { HubLoaderData } from "./auth.shared";

const hubAccessCache = new WeakMap<Request, Promise<HubLoaderData>>();

interface CachedHubSessionAccess {
  data: HubLoaderData;
  expiresAt: number;
}

const hubSessionAccessCache = new Map<string, CachedHubSessionAccess>();
const hubSessionAccessFlights = new Map<string, Promise<HubLoaderData>>();

export function invalidateHubAccessCache(_cookieHeader?: string): void {
  // The cache is keyed by a one-way digest rather than the opaque session
  // cookie itself. Clear the whole short-lived read cache after a mutation so
  // callers do not need to retain or re-hash a sensitive cookie value.
  hubSessionAccessCache.clear();
}

async function sessionCacheKey(cookieHeader: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cookieHeader.trim())
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function apiOrigin(request?: Request): string {
  return request?.headers.get("x-aevo-runtime-api-url")?.trim()
    || process.env.AEVO_CORE_API_URL?.trim()
    || process.env.AEVO_API_URL?.trim()
    || "http://localhost:4000";
}

export async function proxyHubApi(request: Request, path: string): Promise<Response> {
  const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json", "x-aevo-app": "HUB" });
  for (const name of ["cookie", "if-none-match", "x-csrf-token", "x-request-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(new URL(path, `${apiOrigin(request).replace(/\/+$/u, "/")}`), {
      method: "GET",
      headers,
      redirect: "manual"
    });
    const responseHeaders = new Headers();
    for (const name of ["cache-control", "content-type", "etag", "vary", "x-request-id"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return new Response(JSON.stringify({ error: { code: "CORE_API_UNAVAILABLE", message: "Aevo Core API is temporarily unavailable" } }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
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
      // Fall through to the local modern-console fallback.
    }
  }
  return process.env.NODE_ENV === "production" ? "/" : "http://localhost:4330";
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
    // The Hub session contract includes the access decision. Treat a missing
    // decision as a contract failure instead of probing a second endpoint and
    // hiding an out-of-date Core process.
    const storesPromise = api.request<{ stores: StoreSummary[] }>("/api/v1/hub/stores")
      .then((response) => response.stores)
      .catch((error: unknown) => {
        logHubEvent("warn", "hub.store_context.unavailable", {
          route: loaderRoute,
          error: error instanceof Error ? error.message : "unknown"
        });
        return [] as StoreSummary[];
      });
    const me = await auth.me();
    if (!me.access) throw new Error("Core did not return the Hub access decision");
    const access = me.access;
    // Resolve the optional context index alongside auth to avoid making every
    // first navigation pay two sequential Core round trips.
    const stores = access.allowed ? await storesPromise : [];
    logHubEvent("info", "hub.access", {
      route: loaderRoute,
      duration_ms: Math.round(performance.now() - startedAt),
      access_reason: access.reason,
      authenticated: Boolean(me.user?.id),
      organization_id: access.organizationId,
      store_count: stores.length
    });
    const result: HubLoaderData = { me, access, stores, apiOrigin: apiOrigin(request), homeUrl: hubHomeUrl() };
    const cookie = request.headers.get("cookie");
    if (cookie && me.user?.id) {
      hubSessionAccessCache.set(await sessionCacheKey(cookie), {
        data: result,
        expiresAt: Date.now() + 3_000
      });
    }
    return result;

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

export async function requireHubAccess(request: Request, returnPath = "/modern"): Promise<HubLoaderData> {
  const cached = hubAccessCache.get(request);
  if (cached) return cached;

  const cookie = request.headers.get("cookie");
  if (cookie && (request.method === "GET" || request.method === "HEAD")) {
    const key = await sessionCacheKey(cookie);
    const sessionCached = hubSessionAccessCache.get(key);
    if (sessionCached && sessionCached.expiresAt > Date.now()) {
      const resolved = Promise.resolve(sessionCached.data);
      hubAccessCache.set(request, resolved);
      return resolved;
    }
    const inFlight = hubSessionAccessFlights.get(key);
    if (inFlight) {
      hubAccessCache.set(request, inFlight);
      return inFlight;
    }

    const pending = resolveHubAccess(request, returnPath);
    hubSessionAccessFlights.set(key, pending);
    void pending.then(
      () => {
        if (hubSessionAccessFlights.get(key) === pending) hubSessionAccessFlights.delete(key);
      },
      () => {
        if (hubSessionAccessFlights.get(key) === pending) hubSessionAccessFlights.delete(key);
      }
    );
    hubAccessCache.set(request, pending);
    return pending;
  }

  const pending = resolveHubAccess(request, returnPath);
  hubAccessCache.set(request, pending);
  return pending;
}
