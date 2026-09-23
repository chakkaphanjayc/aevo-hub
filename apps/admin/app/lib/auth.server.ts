import { ApiClient, ApiClientError } from "@aevocado/contracts";
import type { AccessDecisionResponse, AuthenticatedMeResponse } from "@aevocado/api-contract";
import { createAuthClient } from "@aevocado/auth-client";
import { isAccessAllowed } from "@aevocado/app-access";
import { redirect } from "react-router";
import type { AdminLoaderData } from "./auth.shared";

export type { AdminLoaderData } from "./auth.shared";

export function apiOrigin(): string {
  return process.env.AEVO_API_URL?.trim() || "http://localhost:4001";
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

export function createAdminApiClient(request: Request): ApiClient {
  const cookie = request.headers.get("cookie");
  return new ApiClient({
    baseUrl: apiOrigin(),
    credentials: "include",
    timeoutMs: 5_000,
    ...(cookie ? { defaultHeaders: { cookie } } : {})
  });
}

export function requestCsrfHeaders(request: Request): HeadersInit {
  const token = readCookie(request, process.env.CSRF_COOKIE_NAME?.trim() || "aevo_admin_csrf");
  return token ? { "x-csrf-token": token } : {};
}

function loginRedirect(request: Request): never {
  const url = new URL("/login", request.url);
  const next = `${new URL(request.url).pathname}${new URL(request.url).search}`;
  url.searchParams.set("next", next.startsWith("/") ? next : "/");
  throw redirect(url.toString());
}

export async function requireAdminAccess(request: Request): Promise<AdminLoaderData> {
  const api = createAdminApiClient(request);
  const auth = createAuthClient({ api, application: "ADMIN", accountsPath: "/login" });

  let me: AuthenticatedMeResponse;
  let access: AccessDecisionResponse;
  try {
    me = await auth.me();
    access = await auth.access();
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) loginRedirect(request);
    throw error;
  }

  if (!isAccessAllowed(access)) {
    throw new Response("Platform administration permission required", {
      status: 403,
      statusText: "PLATFORM_ACCESS_REQUIRED"
    });
  }

  return { me, access, apiOrigin: apiOrigin() };
}
