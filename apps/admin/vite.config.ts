import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, loadEnv } from "vite";

function tunnelEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.AEVO_API_URL?.trim() || env.VITE_API_BASE_URL?.trim() || "http://localhost:4001";

  return {
    plugins: [reactRouter(), cloudflare({ tunnel: tunnelEnabled(env.AEVO_DEV_TUNNEL) })],
    server: {
      host: "0.0.0.0",
      port: 4335,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, secure: false },
        "/health": { target: apiTarget, changeOrigin: true, secure: false },
        "/ready": { target: apiTarget, changeOrigin: true, secure: false }
      }
    },
    preview: {
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, secure: false },
        "/health": { target: apiTarget, changeOrigin: true, secure: false },
        "/ready": { target: apiTarget, changeOrigin: true, secure: false }
      }
    },
    build: {
      sourcemap: mode !== "production"
    }
  };
});
