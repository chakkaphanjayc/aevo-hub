import { serve } from "bun";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const port = Number(process.env.WEB_PORT || 4321);
const publicDir = join(import.meta.dir, "public");
const publicApiUrl = process.env.PUBLIC_API_URL?.trim();
const csrfCookieName = process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf";
const production = process.env.NODE_ENV === "production";
const modernAppOrigin = process.env.AEVO_HUB_MODERN_URL?.trim() || (production ? "" : "http://localhost:4330");
const appUrls = {
  play: process.env.AEVO_PLAY_URL?.trim() || (production ? "" : "http://localhost:4322"),
  pos: process.env.AEVO_POS_URL?.trim() || (production ? "" : "http://localhost:4323"),
  go: process.env.AEVO_GO_URL?.trim() || (production ? "" : "http://localhost:4324")
};
const staticAssetCache = new Map<string, { body: Buffer; etag: string }>();

async function proxyModernApp(req: Request, url: URL): Promise<Response> {
  if (!modernAppOrigin) return new Response("Modern Hub is not configured", { status: 404 });
  const target = new URL(`${url.pathname}${url.search}`, `${modernAppOrigin}/`);
  const headers = new Headers(req.headers);
  headers.delete("host");
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual"
  };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();

  try {
    const upstream = await fetch(target, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("x-aevo-modern-proxy", "true");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch {
    return new Response("Modern Hub is unavailable", { status: 502 });
  }
}

const server = serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    if (pathname === "/modern" || pathname.startsWith("/modern/")) {
      return proxyModernApp(req, url);
    }

    if (pathname === "/" || pathname === "/landing") {
      pathname = "/landing.html";
    } else if (pathname === "/register") {
      pathname = "/register.html";
    } else if (pathname === "/login") {
      pathname = "/login.html";
    } else if (pathname === "/forgot-password") {
      pathname = "/forgot-password.html";
    } else if (pathname === "/reset-password") {
      pathname = "/reset-password.html";
    } else if (pathname === "/workspace") {
      pathname = "/workspace.html";
    } else if (pathname === "/setup") {
      pathname = "/setup.html";
    } else if (pathname === "/organize") {
      pathname = "/organize.html";
    } else if (pathname === "/admin") {
      pathname = "/admin.html";
    }

    const relativePath = pathname.replace(/^\/+/, "");
    const filePath = join(publicDir, relativePath);
    if (filePath !== publicDir && !filePath.startsWith(`${publicDir}/`)) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const ext = pathname.split(".").pop() || "";
      const mimeTypes: Record<string, string> = {
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "application/javascript; charset=utf-8",
        json: "application/json",
        png: "image/png",
        jpg: "image/jpeg",
        svg: "image/svg+xml"
      };
      const isHtml = ext === "html";
      const isCacheableAsset = production && !isHtml;
      let fileContent = staticAssetCache.get(filePath)?.body;
      let etag = staticAssetCache.get(filePath)?.etag;
      if (!fileContent || !etag || !isCacheableAsset) {
        fileContent = await readFile(filePath);
        if (isCacheableAsset) {
          etag = `"${createHash("sha256").update(fileContent).digest("hex")}"`;
          staticAssetCache.set(filePath, { body: fileContent, etag });
        }
      }

      const responseBody = isHtml
        ? fileContent.toString().replace(
          "<head>",
          `<head><script>window.__AEVO_CSRF_COOKIE__=${JSON.stringify(csrfCookieName)};window.__AEVO_APP_URLS__=${JSON.stringify(appUrls)};${publicApiUrl ? `window.__AEVO_API_URL=${JSON.stringify(publicApiUrl)};` : ""}</script>`
        )
        : fileContent;

      if (isCacheableAsset && etag && req.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            etag,
            "cache-control": "public, max-age=300, must-revalidate"
          }
        });
      }

      return new Response(responseBody as BodyInit, {
        headers: {
          "content-type": mimeTypes[ext] || "text/plain",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
          "cache-control": isCacheableAsset ? "public, max-age=300, must-revalidate" : "private, no-cache",
          ...(isCacheableAsset && etag ? { etag } : {})
        }
      });
    } catch {
      // Return 404
      return new Response("Not Found", { status: 404 });
    }
  }
});

console.log(`[Aevo Hub Web] Running at http://localhost:${port}`);
