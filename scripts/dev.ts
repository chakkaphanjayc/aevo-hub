import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawn } from "bun";
import {
  accountRedirectOrigins,
  appOriginEnvironment,
  gatewayAllowedOrigins,
  resolveTunnelOrigins,
  tunnelOrigin
} from "../../scripts/tunnel-config.ts";

type ServiceSpec = {
  label: string;
  command: string;
  args: string[];
  directory: string;
  environment: Record<string, string | undefined>;
};

const hubRoot = resolve(import.meta.dir, "..");
const ecosystemRoot = resolve(hubRoot, "..");

function readEnvironmentFile(file: string): Record<string, string> {
  try {
    const contents = readFileSync(file, "utf8");
    const values: Record<string, string> = {};
    for (const line of contents.split(/\r?\n/u)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2] ?? "";
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function serviceEnvironment(file: string, defaults: Record<string, string>): Record<string, string | undefined> {
  return {
    ...readEnvironmentFile(file),
    ...process.env,
    ...defaults
  };
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be a valid TCP port, received: ${value}`);
  }
  return port;
}

type PortCheck = {
  label: string;
  port: number;
};

async function assertPortsAvailable(checks: PortCheck[]): Promise<void> {
  await Promise.all(checks.map(({ label, port }) => new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
      reject(new Error(`${label} port ${port} is already in use (${code})`));
    });
    server.listen({ host: "0.0.0.0", port }, () => {
      server.close((closeError) => closeError ? reject(closeError) : resolvePort());
    });
  })));
}

const sharedSecret = process.env.AEVO_LOCAL_GATEWAY_SIGNING_SECRET?.trim() || "aevo-local-gateway-signing-secret";
const coreOrigin = process.env.AEVO_LOCAL_CORE_API_ORIGIN?.trim() || "http://127.0.0.1:5099";
const apiOrigin = process.env.AEVO_LOCAL_EDGE_API_ORIGIN?.trim() || "http://localhost:4000";
const apiPort = parsePort(new URL(apiOrigin).port || "4000", "Edge API");
const accountsOrigin = process.env.AEVO_LOCAL_ACCOUNTS_API_ORIGIN?.trim() || "http://127.0.0.1:8787";
const accountsPort = parsePort(new URL(accountsOrigin).port || "8787", "Accounts API");
const corePort = parsePort(new URL(coreOrigin).port || "5099", "Core API");
const hubFileEnvironment = readEnvironmentFile(resolve(hubRoot, ".env"));
const tunnelOrigins = resolveTunnelOrigins(
  hubFileEnvironment,
  readEnvironmentFile(resolve(ecosystemRoot, "aevo-play/.env")),
  readEnvironmentFile(resolve(ecosystemRoot, "aevo-pos/.env")),
  readEnvironmentFile(resolve(ecosystemRoot, "aevo-go/.env")),
  process.env
);
const localAllowedRedirectOrigins = accountRedirectOrigins(tunnelOrigins);
const localAllowedOrigins = gatewayAllowedOrigins(tunnelOrigins);
const publicPort = parsePort(
  process.env.WEB_PORT?.trim() || hubFileEnvironment.WEB_PORT?.trim() || "4321",
  "Public Home"
);
const modernPort = 4330;
const developmentDatabaseUrl = process.env.AEVO_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || hubFileEnvironment.DATABASE_URL?.trim();
const developmentSessionSecret = process.env.AEVO_SESSION_SECRET?.trim()
  || hubFileEnvironment.AEVO_SESSION_SECRET?.trim()
  || hubFileEnvironment.SESSION_COOKIE_SECRET?.trim()
  || "aevo-local-core-session-secret";
const developmentAccountsSecret = process.env.AEVO_ACCOUNTS_SERVICE_SECRET?.trim()
  || hubFileEnvironment.AEVO_ACCOUNTS_SERVICE_SECRET?.trim()
  || "aevo-local-accounts-service-secret";

const hubEnvironment = serviceEnvironment(resolve(hubRoot, ".env"), {
  PUBLIC_API_URL: apiOrigin,
  AEVO_API_URL: apiOrigin,
  AEVO_CORE_API_URL: apiOrigin,
  API_PORT: String(apiPort),
  WEB_PORT: String(publicPort),
  WEB_ORIGIN: tunnelOrigin(tunnelOrigins, "hub", `http://localhost:${modernPort}`),
  AEVO_HUB_WEB_URL: tunnelOrigin(tunnelOrigins, "hub", `http://localhost:${modernPort}`),
  AEVO_HUB_MODERN_URL: tunnelOrigin(tunnelOrigins, "hub", `http://localhost:${modernPort}`),
  AEVO_ALLOWED_WEB_ORIGINS: localAllowedOrigins,
  AEVO_APP_CODE: "HUB",
  SESSION_COOKIE_NAME: "aevo_hub_session",
  ...appOriginEnvironment("hub", tunnelOrigins)
});

const accountsEnvironment = serviceEnvironment(resolve(ecosystemRoot, "aevo-accounts/.env"), {
  AEVO_ENVIRONMENT: "development",
  AEVO_CORE_API_ORIGIN: coreOrigin,
  AEVO_HUB_WEB_ORIGIN: tunnelOrigin(tunnelOrigins, "hub", `http://localhost:${modernPort}`),
  AEVO_ALLOWED_REDIRECT_ORIGINS: localAllowedRedirectOrigins,
  AEVO_ACCOUNTS_SESSION_SECRET: process.env.AEVO_ACCOUNTS_SESSION_SECRET?.trim() || "aevo-local-accounts-session-secret",
  AEVO_ACCOUNTS_SERVICE_SECRET: developmentAccountsSecret,
  AEVO_IDENTITY_PLATFORM_PROJECT_ID: process.env.AEVO_IDENTITY_PLATFORM_PROJECT_ID?.trim() || hubFileEnvironment.AEVO_IDENTITY_PLATFORM_PROJECT_ID?.trim() || "local-development",
  ...(hubFileEnvironment.SUPABASE_URL ? { SUPABASE_URL: hubFileEnvironment.SUPABASE_URL } : {}),
  ...(hubFileEnvironment.SUPABASE_SECRET_KEY ? { SUPABASE_SECRET_KEY: hubFileEnvironment.SUPABASE_SECRET_KEY } : {})
});

// Wrangler config vars intentionally contain empty placeholders. Pass the local
// runtime bindings explicitly so the Accounts worker cannot silently start with
// the preview defaults from wrangler.jsonc.
const accountsInspectorPort = String(Number(accountsPort) + 10000);
const accountsArgs = [
  "run", "dev", "--local", "--port", String(accountsPort),
  "--inspector-port", accountsInspectorPort,
  "--var", `AEVO_ENVIRONMENT:development`,
  "--var", `AEVO_CORE_API_ORIGIN:${coreOrigin}`,
  "--var", `AEVO_HUB_WEB_ORIGIN:${tunnelOrigin(tunnelOrigins, "hub", `http://localhost:${modernPort}`)}`,
  "--var", `AEVO_ALLOWED_REDIRECT_ORIGINS:${localAllowedRedirectOrigins}`,
  "--var", `AEVO_IDENTITY_PLATFORM_PROJECT_ID:${accountsEnvironment.AEVO_IDENTITY_PLATFORM_PROJECT_ID}`,
  "--var", `AEVO_ACCOUNTS_SESSION_SECRET:${accountsEnvironment.AEVO_ACCOUNTS_SESSION_SECRET}`,
  "--var", `AEVO_ACCOUNTS_SERVICE_SECRET:${accountsEnvironment.AEVO_ACCOUNTS_SERVICE_SECRET}`
];
if (accountsEnvironment.SUPABASE_URL) {
  accountsArgs.push("--var", `SUPABASE_URL:${accountsEnvironment.SUPABASE_URL}`);
}
if (accountsEnvironment.SUPABASE_ANON_KEY) {
  accountsArgs.push("--var", `SUPABASE_ANON_KEY:${accountsEnvironment.SUPABASE_ANON_KEY}`);
}
if (accountsEnvironment.SUPABASE_SECRET_KEY) {
  accountsArgs.push("--var", `SUPABASE_SECRET_KEY:${accountsEnvironment.SUPABASE_SECRET_KEY}`);
}

const coreEnvironment = serviceEnvironment(resolve(ecosystemRoot, "aevo-core-api/.env"), {
  AEVO_ENVIRONMENT: "development",
  AEVO_BUILD_VERSION: "local",
  ASPNETCORE_ENVIRONMENT: "Development",
  DOTNET_ENVIRONMENT: "Development",
  ...(developmentDatabaseUrl ? { AEVO_DATABASE_URL: developmentDatabaseUrl } : {}),
  AEVO_IDENTITY_PLATFORM_PROJECT_ID: process.env.AEVO_IDENTITY_PLATFORM_PROJECT_ID?.trim() || "local-development",
  AEVO_SESSION_SECRET: developmentSessionSecret,
  AEVO_ACCOUNTS_API_ORIGIN: accountsOrigin,
  AEVO_ACCOUNTS_SERVICE_SECRET: developmentAccountsSecret,
  AEVO_CORE_API_SERVICE_SECRET: process.env.AEVO_CORE_API_SERVICE_SECRET?.trim() || developmentAccountsSecret,
  AEVO_REQUIRE_GATEWAY_SIGNATURE: process.env.AEVO_REQUIRE_GATEWAY_SIGNATURE?.trim() || "true",
  AEVO_ORIGIN_SIGNING_SECRET: process.env.AEVO_ORIGIN_SIGNING_SECRET?.trim() || sharedSecret,
  AEVO_TRUSTED_GATEWAYS: process.env.AEVO_TRUSTED_GATEWAYS?.trim() || "aevo-edge-gateway"
});

const edgeEnvironment = serviceEnvironment(resolve(ecosystemRoot, "aevo-edge-gateway/.env"), {
  AEVO_ENVIRONMENT: "development",
  AEVO_GATEWAY_NAME: "aevo-edge-gateway",
  AEVO_APP_CODE: "HUB",
  AEVO_CORE_API_ORIGIN: coreOrigin,
  AEVO_ALLOWED_ORIGINS: process.env.AEVO_ALLOWED_ORIGINS?.trim() || localAllowedOrigins,
  AEVO_GATEWAY_SIGNING_SECRET: sharedSecret
});

const hubWebServices: ServiceSpec[] = [
  {
    label: "public-home",
    command: "bun",
    args: ["run", "--watch", "apps/web/src/server.ts"],
    directory: hubRoot,
    environment: hubEnvironment
  },
  {
    label: "modern",
    command: "bun",
    args: ["run", "--cwd", "apps/hub", "dev"],
    directory: hubRoot,
    environment: hubEnvironment
  }
];

const services: ServiceSpec[] = [
  {
    label: "accounts",
    command: resolve(ecosystemRoot, "aevo-accounts/node_modules/.bin/wrangler"),
    args: accountsArgs.slice(1),
    directory: resolve(ecosystemRoot, "aevo-accounts"),
    environment: accountsEnvironment
  },
  {
    label: "core-api",
    command: "dotnet",
    args: ["run", "--project", "src/Aevo.CoreApi/Aevo.CoreApi.csproj", "--", "--urls", coreOrigin],
    directory: resolve(ecosystemRoot, "aevo-core-api"),
    environment: coreEnvironment
  },
  {
    label: "edge",
    command: "bun",
    args: [
      "run", "dev", "--local", "--port", String(apiPort),
      "--var", `AEVO_CORE_API_ORIGIN:${coreOrigin}`,
      "--var", `AEVO_GATEWAY_SIGNING_SECRET:${sharedSecret}`,
      "--var", `AEVO_ALLOWED_ORIGINS:${edgeEnvironment.AEVO_ALLOWED_ORIGINS}`,
      "--var", "AEVO_APP_CODE:HUB",
      "--var", "AEVO_ENVIRONMENT:development"
    ],
    directory: resolve(ecosystemRoot, "aevo-edge-gateway"),
    environment: edgeEnvironment
  },
  ...hubWebServices
];

try {
  await assertPortsAvailable([
    { label: "Edge API", port: apiPort },
    { label: "Accounts API", port: accountsPort },
    { label: "Core API", port: corePort },
    { label: "Public Home", port: publicPort },
    { label: "Modern Console", port: modernPort }
  ]);
} catch (error: unknown) {
  console.error(
    `Aevo Hub startup blocked: ${error instanceof Error ? error.message : String(error)}. `
      + "Stop the previous local session before starting another one."
  );
  process.exit(1);
}

console.log("\x1b[36m%s\x1b[0m", "🚀 Starting Aevo Hub (Core API + Edge + Public Home + Modern Console)...");

type Child = ReturnType<typeof spawn>;
const children: Array<{ label: string; child: Child }> = services.map((service) => ({
  label: service.label,
  child: spawn([service.command, ...service.args], {
    cwd: service.directory,
    env: service.environment,
    stdout: "pipe",
    stderr: "pipe"
  })
}));

function outputStream(child: Child): ReadableStream<Uint8Array> | undefined {
  return typeof child.stdout === "object" && child.stdout !== null && "getReader" in child.stdout
    ? child.stdout as ReadableStream<Uint8Array>
    : undefined;
}

async function forwardOutput(name: string, stream: ReadableStream<Uint8Array> | undefined, error = false): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = `[${name}] ${line}`;
      if (error) console.error(message);
      else console.log(message);
    }
  }
  const finalLine = pending.trim();
  if (finalLine) {
    const message = `[${name}] ${finalLine}`;
    if (error) console.error(message);
    else console.log(message);
  }
}

for (const { label, child } of children) {
  void forwardOutput(label, outputStream(child)).catch((error: unknown) => {
    console.error(`[${label}] output stream failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  void forwardOutput(label, typeof child.stderr === "object" && child.stderr !== null && "getReader" in child.stderr
    ? child.stderr as ReadableStream<Uint8Array>
    : undefined, true).catch((error: unknown) => {
    console.error(`[${label}] error stream failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  void child.exited.then((exitCode) => console.log(`[${label}] exited with code ${exitCode}`));
}

let cleaningUp = false;
function cleanup(exitCode = 0): void {
  if (cleaningUp) return;
  cleaningUp = true;
  console.log("\n\x1b[33m%s\x1b[0m", "🛑 Stopping Aevo Hub services...");
  for (const { child } of children) child.kill();
  process.exit(exitCode);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

const firstExit = await Promise.race(children.map(async ({ label, child }) => ({ label, code: await child.exited })));
if (!cleaningUp) {
  console.error(`Aevo Hub service ${firstExit.label} exited unexpectedly with code ${firstExit.code}.`);
  cleanup(firstExit.code === 0 ? 1 : firstExit.code);
}
