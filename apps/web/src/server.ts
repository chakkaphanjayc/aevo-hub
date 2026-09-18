import { serve } from "bun";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const port = Number(process.env.WEB_PORT || 4321);
const publicDir = join(import.meta.dir, "public");
const publicApiUrl = process.env.PUBLIC_API_URL?.trim();
const csrfCookieName = process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf";

const server = serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

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
      const fileContent = await readFile(filePath);
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

      const responseBody = ext === "html"
        ? fileContent.toString().replace(
          "<head>",
          `<head><script>window.__AEVO_CSRF_COOKIE__=${JSON.stringify(csrfCookieName)};${publicApiUrl ? `window.__AEVO_API_URL=${JSON.stringify(publicApiUrl)};` : ""}</script>`
        )
        : fileContent;

      return new Response(responseBody, {
        headers: {
          "content-type": mimeTypes[ext] || "text/plain",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=(), microphone=(), geolocation=()"
        }
      });
    } catch {
      // Return 404
      return new Response("Not Found", { status: 404 });
    }
  }
});

console.log(`[Aevo Hub Web] Running at http://localhost:${port}`);
