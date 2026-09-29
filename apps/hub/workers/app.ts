/// <reference types="@cloudflare/workers-types" />

import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";

import { aevoWorkerContext, type AevoAppEnv } from "../app/lib/cloudflare-context";

type Env = AevoAppEnv;

const loadServerBuild = async (): Promise<ServerBuild> => (
  await import("virtual:react-router/server-build")
) as unknown as ServerBuild;

const requestHandler = createRequestHandler(loadServerBuild, import.meta.env.MODE);

function withWebSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  const development = import.meta.env.MODE === "development";
  const connectSources = development ? "'self' http: https: ws: wss:" : "'self' https:";
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "trusted-types aevo-default"
  ].join("; ");
  headers.set("content-security-policy", policy);
  headers.set("content-security-policy-report-only", "require-trusted-types-for 'script'; report-uri /api/security/csp-report");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (env.ASSETS && request.method === "GET" && (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico")) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withWebSecurityHeaders(asset);
    }

    const runtimeRequest = new Request(request);
    if (env.AEVO_API_URL?.trim()) {
      runtimeRequest.headers.set("x-aevo-runtime-api-url", env.AEVO_API_URL.trim());
    } else {
      runtimeRequest.headers.delete("x-aevo-runtime-api-url");
    }

    const routerContext = new RouterContextProvider();
    routerContext.set(aevoWorkerContext, { env, ctx, request: runtimeRequest });
    return withWebSecurityHeaders(await requestHandler(runtimeRequest, routerContext));
  }
} satisfies ExportedHandler<Env>;
