/// <reference types="@cloudflare/workers-types" />

import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";

import { aevoWorkerContext, type AevoAppEnv } from "../app/lib/cloudflare-context";

type Env = AevoAppEnv;

const loadServerBuild = async (): Promise<ServerBuild> => (
  await import("virtual:react-router/server-build")
) as unknown as ServerBuild;

const requestHandler = createRequestHandler(loadServerBuild, import.meta.env.MODE);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (env.ASSETS && request.method === "GET" && (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico")) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    const runtimeRequest = new Request(request);
    if (env.AEVO_API_URL?.trim()) {
      runtimeRequest.headers.set("x-aevo-runtime-api-url", env.AEVO_API_URL.trim());
    } else {
      runtimeRequest.headers.delete("x-aevo-runtime-api-url");
    }

    const routerContext = new RouterContextProvider();
    routerContext.set(aevoWorkerContext, { env, ctx, request: runtimeRequest });
    return requestHandler(runtimeRequest, routerContext);
  }
} satisfies ExportedHandler<Env>;
