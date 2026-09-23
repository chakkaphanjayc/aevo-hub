import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const hubRoot = join(import.meta.dir, "..");
const ecosystemRoot = dirname(hubRoot);
const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

async function contains(path: string, pattern: RegExp): Promise<boolean> {
  try {
    return pattern.test(await readFile(path, "utf8"));
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const requiredFiles = [
    "../aevo-core-api/db/migrations/0001_core_authority.sql",
    "../aevo-core-api/db/migrations/0002_admin_control_plane.sql",
    "../aevo-core-api/db/migrations/0003_runtime_identity_support.sql",
    "../aevo-core-api/db/migrations/0004_application_registry_reconciliation.sql",
    "../aevo-core-api/db/migrations/0005_session_lifecycle.sql",
    "../aevo-core-api/db/migrations/0006_auth_session_contract.sql",
    "../aevo-core-api/db/migrations/0007_authorization_code_boundary.sql",
    "../aevo-core-api/db/migrations/0008_hub_permission_alignment.sql",
    "../aevo-core-api/db/migrations/0009_hub_onboarding_authority.sql"
  ];
  for (const relativePath of requiredFiles) {
    const path = join(hubRoot, relativePath);
    check(`migration:${relativePath}`, existsSync(path), existsSync(path) ? "present" : "missing");
  }

  const coreReader = join(ecosystemRoot, "aevo-core-api/src/Aevo.CoreApi/Security/AppSessionReader.cs");
  const coreProgram = join(ecosystemRoot, "aevo-core-api/src/Aevo.CoreApi/Program.cs");
  const hubSession = join(hubRoot, "packages/auth/src/session.ts");
  const playSession = join(ecosystemRoot, "aevo-play/packages/auth/src/application-session.ts");
  const posSession = join(ecosystemRoot, "aevo-pos/packages/auth/src/application-session.ts");
  check("cookie-isolation:core", await contains(coreReader, /aevo_admin_session/u) && await contains(coreReader, /aevo_go_session/u), "per-application cookie names are declared");
  check("cookie-isolation:hub", await contains(hubSession, /eq\("app_code", this\.options\.applicationCode/u), "Hub session queries bind to app_code");
  check("cookie-isolation:play", await contains(playSession, /eq\('app_code', this\.options\.applicationCode\)/u), "Play session queries bind to app_code");
  check("cookie-isolation:pos", await contains(posSession, /eq\("app_code", this\.options\.applicationCode\)/u), "POS session queries bind to app_code");
  check("core-revocation", await contains(coreProgram, /\/internal\/auth\/sessions\/revoke/u), "Core exposes a private app-scoped revoke contract");

  if (process.argv.includes("--check-legacy-removal")) {
    const legacyFiles: Array<{ path: string; pattern: RegExp }> = [
      {
        path: join(hubRoot, "apps/gateway"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "scripts/migrate.ts"),
        pattern: /./u
      },
      {
        path: join(ecosystemRoot, "aevo-play/apps/api/src/app.ts"),
        pattern: /allowLegacyCookie|AEVO_ALLOW_LEGACY_AUTH|hubApiOrigin|\/api\/auth\/handoff\/exchange|AEVO_SSO_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-pos/apps/api/src/app.ts"),
        pattern: /allowLegacyCookie|AEVO_ALLOW_LEGACY_AUTH|hubApiOrigin|\/api\/auth\/handoff\/exchange|AEVO_SSO_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-accounts/src/index.ts"),
        pattern: /AEVO_HUB_API_ORIGIN|AEVO_SSO_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-go/src/lib/sso.ts"),
        pattern: /authCompatMode|hubWebUrl|new URL\("\/modern\/login", hubWebUrl\)/u
      }
    ];
    const blockers: string[] = [];
    for (const legacyFile of legacyFiles) {
      if (legacyFile.path.endsWith("/apps/gateway") || legacyFile.path.endsWith("/scripts/migrate.ts")) {
        if (existsSync(legacyFile.path)) blockers.push(legacyFile.path);
      } else if (await contains(legacyFile.path, legacyFile.pattern)) {
        blockers.push(legacyFile.path);
      }
    }
    check("legacy-removal", blockers.length === 0, blockers.length === 0 ? "no compatibility reader remains" : `compatibility reader remains in ${blockers.join(", ")}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else {
    for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
    console.log(`Auth migration check: ${failed.length === 0 ? "PASS" : `${failed.length} check(s) failed`}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

if (import.meta.main) await run();
