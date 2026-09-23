import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, loadEnv } from "vite";

function tunnelEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.AEVO_API_URL?.trim() || "http://localhost:4000";

  return {
  plugins: [
    {
      name: "hub-dev-root-redirect",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? "").split("?", 1)[0];

          if (pathname === "/" || pathname === "") {
            res.statusCode = 302;
            res.setHeader("Location", "/modern");
            res.end();
            return;
          }
          if (pathname === "/login") {
            res.statusCode = 302;
            res.setHeader("Location", "/modern/login");
            res.end();
            return;
          }
          if (pathname === "/favicon.ico") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (pathname === "/.well-known/appspecific/com.chrome.devtools.json") {
            res.statusCode = 204;
            res.end();
            return;
          }
          next();
        });
      }
    },
    reactRouter(),
    cloudflare({ tunnel: tunnelEnabled(env.AEVO_DEV_TUNNEL), viteEnvironment: { name: "ssr" } })
  ],
  server: {
    host: "0.0.0.0",
    port: 4330,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/health": { target: apiTarget, changeOrigin: true },
      "/ready": { target: apiTarget, changeOrigin: true }
    }
  }
  };
});
