import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "bun";
import { gatewayAllowedOrigins, resolveTunnelOrigins, tunnelOrigin } from "../../scripts/tunnel-config.ts";

const hubRoot = resolve(import.meta.dir, "..");
const ecosystemRoot = resolve(hubRoot, "..");
const signingSecret = process.env.AEVO_LOCAL_GATEWAY_SIGNING_SECRET?.trim() || "aevo-local-gateway-signing-secret";

function readEnvironmentFile(file: string): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/u).flatMap((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
      if (!match) return [];
      const value = match[2] ?? "";
      return [[match[1]!, value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2")]];
    }));
  } catch {
    return {};
  }
}

const tunnelOrigins = resolveTunnelOrigins(
  readEnvironmentFile(resolve(hubRoot, ".env")),
  readEnvironmentFile(resolve(ecosystemRoot, "aevo-admin/.env")),
  process.env
);
const adminOrigin = tunnelOrigin(tunnelOrigins, "admin", "http://localhost:4335");
const hubOrigin = tunnelOrigin(tunnelOrigins, "hub", "http://localhost:4330");
const allowedOrigins = gatewayAllowedOrigins(tunnelOrigins);

const adminEnvironment = {
  ...process.env,
  API_PORT: "4001",
  WEB_ORIGIN: adminOrigin,
  PUBLIC_API_URL: "http://localhost:4001",
  AEVO_API_URL: "http://localhost:4001",
  AEVO_APP_CODE: "ADMIN",
  SESSION_COOKIE_NAME: "aevo_admin_session",
  CSRF_COOKIE_NAME: "aevo_admin_csrf",
  AEVO_ALLOWED_WEB_ORIGINS: adminOrigin,
  AEVO_HUB_WEB_URL: hubOrigin,
};

const coreEnvironment = {
  ...process.env,
  AEVO_ENVIRONMENT: process.env.AEVO_ENVIRONMENT?.trim() || "local",
  AEVO_BUILD_VERSION: process.env.AEVO_BUILD_VERSION?.trim() || "local",
  AEVO_REQUIRE_GATEWAY_SIGNATURE: process.env.AEVO_REQUIRE_GATEWAY_SIGNATURE?.trim() || "true",
  AEVO_ORIGIN_SIGNING_SECRET: process.env.AEVO_ORIGIN_SIGNING_SECRET?.trim() || signingSecret,
  AEVO_TRUSTED_GATEWAYS: process.env.AEVO_TRUSTED_GATEWAYS?.trim() || "aevo-edge-gateway"
};

const edgeEnvironment = {
  ...process.env,
  AEVO_ENVIRONMENT: process.env.AEVO_ENVIRONMENT?.trim() || "local",
  AEVO_GATEWAY_NAME: "aevo-edge-gateway-admin",
  AEVO_APP_CODE: "ADMIN",
  AEVO_CORE_API_ORIGIN: "http://127.0.0.1:5099",
  AEVO_ALLOWED_ORIGINS: allowedOrigins,
  AEVO_GATEWAY_SIGNING_SECRET: signingSecret
};

const children = [
  {
    label: "core-api",
    child: spawn(["dotnet", "run", "--project", "src/Aevo.CoreApi/Aevo.CoreApi.csproj", "--", "--urls", "http://127.0.0.1:5099"], {
      cwd: resolve(ecosystemRoot, "aevo-core-api"),
      stdout: "inherit",
      stderr: "inherit",
      env: coreEnvironment
    })
  },
  {
    label: "edge-admin",
    child: spawn([
      "bun", "run", "dev", "--local", "--port", "4001",
      "--var", "AEVO_CORE_API_ORIGIN:http://127.0.0.1:5099",
      "--var", `AEVO_GATEWAY_SIGNING_SECRET:${signingSecret}`,
      "--var", `AEVO_ALLOWED_ORIGINS:${allowedOrigins}`,
      "--var", "AEVO_APP_CODE:ADMIN",
      "--var", "AEVO_ENVIRONMENT:local"
    ], {
      cwd: resolve(ecosystemRoot, "aevo-edge-gateway"),
      stdout: "inherit",
      stderr: "inherit",
      env: edgeEnvironment
    })
  },
  {
    label: "admin",
    child: spawn(["bun", "run", "--cwd", "apps/admin", "dev"], {
      cwd: hubRoot,
      stdout: "inherit",
      stderr: "inherit",
      env: adminEnvironment
    })
  }
];

console.log("Starting Aevo Admin (Core API + Edge + privileged console)...");

let shuttingDown = false;
function cleanup(signal: string, exitCode?: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Aevo Admin services...`);
  for (const { child } of children) child.kill();
  if (exitCode !== undefined) process.exitCode = exitCode;
}

process.on("SIGINT", () => cleanup("SIGINT", 0));
process.on("SIGTERM", () => cleanup("SIGTERM", 0));

const firstExit = await Promise.race(children.map(async ({ label, child }) => ({ label, code: await child.exited })));
if (!shuttingDown) {
  console.error(`Aevo Admin ${firstExit.label} exited unexpectedly with code ${firstExit.code}.`);
  cleanup(`service ${firstExit.label} exit`, firstExit.code === 0 ? 1 : firstExit.code);
}

await Promise.all(children.map(({ child }) => child.exited));
