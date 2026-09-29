import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "bun";
import { accountRedirectOrigins, gatewayAllowedOrigins, resolveTunnelOrigins, tunnelOrigin } from "../../scripts/tunnel-config";
import { killProcessTree, stopWorkspaceProcessesOnPorts } from "../../scripts/process-tree";

const hubRoot = resolve(import.meta.dir, "..");
const ecosystemRoot = resolve(hubRoot, "..");
const signingSecret = process.env.AEVO_LOCAL_GATEWAY_SIGNING_SECRET?.trim() || "aevo-local-gateway-signing-secret";
const edgeInspectorPort = String(8787 + 10002);
const accountsOrigin = process.env.AEVO_LOCAL_ACCOUNTS_API_ORIGIN?.trim() || "http://127.0.0.1:8787";
const accountsPort = new URL(accountsOrigin).port || "8787";
const accountsInspectorPort = String(Number(accountsPort) + 10000);

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

const hubEnvironment = readEnvironmentFile(resolve(hubRoot, ".env"));
const tunnelOrigins = resolveTunnelOrigins(
  hubEnvironment,
  readEnvironmentFile(resolve(ecosystemRoot, "aevo-admin/.env")),
  process.env
);
const adminOrigin = tunnelOrigin(tunnelOrigins, "admin", "http://localhost:4335");
const hubOrigin = tunnelOrigin(tunnelOrigins, "hub", "http://localhost:4330");
const allowedOrigins = gatewayAllowedOrigins(tunnelOrigins);
const allowedRedirectOrigins = accountRedirectOrigins(tunnelOrigins);
const databaseUrl = process.env.AEVO_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || hubEnvironment.DATABASE_URL?.trim();
const sessionSecret = process.env.AEVO_SESSION_SECRET?.trim()
  || process.env.SESSION_COOKIE_SECRET?.trim()
  || hubEnvironment.AEVO_SESSION_SECRET?.trim()
  || hubEnvironment.SESSION_COOKIE_SECRET?.trim()
  || "aevo-local-core-session-secret";
const accountsServiceSecret = process.env.AEVO_ACCOUNTS_SERVICE_SECRET?.trim()
  || hubEnvironment.AEVO_ACCOUNTS_SERVICE_SECRET?.trim()
  || "aevo-local-accounts-service-secret";
const coreServiceSecret = process.env.AEVO_CORE_API_SERVICE_SECRET?.trim()
  || hubEnvironment.AEVO_CORE_API_SERVICE_SECRET?.trim()
  || "aevo-local-core-service-secret";
const handshakeSecret = process.env.AEVO_HANDSHAKE_SHARED_SECRET?.trim()
  || hubEnvironment.AEVO_HANDSHAKE_SHARED_SECRET?.trim()
  || "aevo-local-handshake-secret";
const identityProjectId = process.env.AEVO_IDENTITY_PLATFORM_PROJECT_ID?.trim()
  || hubEnvironment.AEVO_IDENTITY_PLATFORM_PROJECT_ID?.trim()
  || "local-development";

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
  AEVO_ENVIRONMENT: process.env.AEVO_ENVIRONMENT?.trim() || "development",
  AEVO_BUILD_VERSION: process.env.AEVO_BUILD_VERSION?.trim() || "local",
  ...(databaseUrl ? { AEVO_DATABASE_URL: databaseUrl } : {}),
  AEVO_SESSION_SECRET: sessionSecret,
  AEVO_ACCOUNTS_API_ORIGIN: accountsOrigin,
  AEVO_ALLOWED_ORIGINS: allowedOrigins,
  AEVO_ACCOUNTS_SERVICE_SECRET: accountsServiceSecret,
  AEVO_CORE_API_SERVICE_SECRET: coreServiceSecret,
  AEVO_HANDSHAKE_SHARED_SECRET: handshakeSecret,
  AEVO_PLAY_API_ORIGIN: "http://localhost:3002",
  AEVO_POS_API_ORIGIN: "http://localhost:3003",
  AEVO_REQUIRE_GATEWAY_SIGNATURE: process.env.AEVO_REQUIRE_GATEWAY_SIGNATURE?.trim() || "true",
  AEVO_ORIGIN_SIGNING_SECRET: process.env.AEVO_ORIGIN_SIGNING_SECRET?.trim() || signingSecret,
  AEVO_TRUSTED_GATEWAYS: process.env.AEVO_TRUSTED_GATEWAYS?.trim() || "aevo-edge-gateway,aevo-edge-gateway-admin"
};

const accountsEnvironment = {
  ...process.env,
  AEVO_ENVIRONMENT: "development",
  AEVO_APP_CODE: "ACCOUNTS",
  AEVO_CORE_API_ORIGIN: "http://127.0.0.1:5099",
  AEVO_HUB_WEB_ORIGIN: hubOrigin,
  AEVO_ALLOWED_REDIRECT_ORIGINS: allowedRedirectOrigins,
  AEVO_ACCOUNTS_SESSION_SECRET: process.env.AEVO_ACCOUNTS_SESSION_SECRET?.trim() || "aevo-local-accounts-session-secret",
  AEVO_ACCOUNTS_SERVICE_SECRET: accountsServiceSecret,
  AEVO_IDENTITY_PLATFORM_PROJECT_ID: identityProjectId,
  ...(hubEnvironment.SUPABASE_URL ? { SUPABASE_URL: hubEnvironment.SUPABASE_URL } : {}),
  ...(hubEnvironment.SUPABASE_ANON_KEY ? { SUPABASE_ANON_KEY: hubEnvironment.SUPABASE_ANON_KEY } : {}),
  ...(hubEnvironment.SUPABASE_SECRET_KEY ? { SUPABASE_SECRET_KEY: hubEnvironment.SUPABASE_SECRET_KEY } : {})
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

try {
  await stopWorkspaceProcessesOnPorts([5099, 8787, 4001, 4335, 18789, 9230], ecosystemRoot);
} catch (error) {
  console.error(`Aevo Admin startup blocked: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const children = [
  {
    label: "accounts",
    child: spawn([
      resolve(ecosystemRoot, "aevo-accounts/node_modules/.bin/wrangler"),
      "dev", "--local", "--port", accountsPort,
      "--inspector-port", accountsInspectorPort,
      "--var", "AEVO_ENVIRONMENT:development",
      "--var", "AEVO_APP_CODE:ACCOUNTS",
      "--var", "AEVO_CORE_API_ORIGIN:http://127.0.0.1:5099",
      "--var", `AEVO_HUB_WEB_ORIGIN:${hubOrigin}`,
      "--var", `AEVO_ALLOWED_REDIRECT_ORIGINS:${allowedRedirectOrigins}`,
      "--var", `AEVO_IDENTITY_PLATFORM_PROJECT_ID:${identityProjectId}`
    ], {
      cwd: resolve(ecosystemRoot, "aevo-accounts"),
      stdout: "inherit",
      stderr: "inherit",
      env: accountsEnvironment
    })
  },
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
      "bun", "run", "dev", "--local", "--persist-to", ".wrangler/state-admin", "--port", "4001",
      "--inspector-port", edgeInspectorPort,
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
    child: spawn(["bun", "run", "dev"], {
      cwd: resolve(ecosystemRoot, "aevo-admin"),
      stdout: "inherit",
      stderr: "inherit",
      env: adminEnvironment
    })
  }
];

console.log("Starting Aevo Admin (Accounts + Core API + Edge + privileged console)...");

let shuttingDown = false;
function cleanup(signal: string, exitCode?: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Aevo Admin services...`);
  for (const { child } of children) killProcessTree(child.pid);
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
