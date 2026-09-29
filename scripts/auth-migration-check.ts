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
    "../aevo-core-api/db/migrations/0009_hub_onboarding_authority.sql",
    "../aevo-core-api/db/migrations/0010_feed_config_control_plane.sql"
  ];
  for (const relativePath of requiredFiles) {
    const path = join(hubRoot, relativePath);
    check(`migration:${relativePath}`, existsSync(path), existsSync(path) ? "present" : "missing");
  }

  const coreReader = join(ecosystemRoot, "aevo-core-api/src/Aevo.CoreApi/Security/AppSessionReader.cs");
  const coreProgram = join(ecosystemRoot, "aevo-core-api/src/Aevo.CoreApi/Program.cs");
  check("cookie-isolation:core", await contains(coreReader, /aevo_hub_session/u) && await contains(coreReader, /aevo_admin_session/u) && await contains(coreReader, /aevo_go_session/u), "per-application cookie names are declared");
  check("core-session-authority", await contains(join(ecosystemRoot, "aevo-core-api/src/Aevo.CoreApi/Data/CoreDataStore.cs"), /from aevo_app_sessions s/u) && await contains(coreReader, /CookieName\(string\? applicationCode/u), "Core owns app-scoped session storage and cookie selection");
  check("core-revocation", await contains(coreProgram, /\/internal\/auth\/sessions\/revoke/u), "Core exposes a private app-scoped revoke contract");

  if (process.argv.includes("--check-legacy-removal")) {
    const legacyFiles: Array<{ path: string; pattern: RegExp }> = [
      {
        path: join(hubRoot, "apps", "gateway"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "scripts/migrate.ts"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "dist/index.js"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "apps/web"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "apps/worker"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "packages/auth"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "packages/db"),
        pattern: /./u
      },
      {
        path: join(hubRoot, "packages/contracts"),
        pattern: /./u
      },
      {
        path: join(ecosystemRoot, "aevo-play/apps/api/src/app.ts"),
        pattern: /allowLegacyCookie|AEVO_ALLOW_LEGACY_AUTH|hubApiOrigin|\/api\/auth\/handoff\/exchange|AEVO_SSO_EXCHANGE_SECRET|AEVO_ACCOUNTS_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-play/packages/config/src/index.ts"),
        pattern: /AEVO_ACCOUNTS_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-play/apps/worker/src/index.ts"),
        pattern: /AEVO_ACCOUNTS_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-pos/apps/api/src/app.ts"),
        pattern: /allowLegacyCookie|AEVO_ALLOW_LEGACY_AUTH|hubApiOrigin|\/api\/auth\/handoff\/exchange|AEVO_SSO_EXCHANGE_SECRET|AEVO_ACCOUNTS_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-pos/apps/api/src/core-auth.ts"),
        pattern: /AEVO_ACCOUNTS_EXCHANGE_SECRET|accountsExchangeSecret/u
      },
      {
        path: join(ecosystemRoot, "aevo-pos/packages/config/src/index.ts"),
        pattern: /AEVO_ACCOUNTS_EXCHANGE_SECRET|accountsExchangeSecret/u
      },
      {
        path: join(ecosystemRoot, "aevo-pos/apps/worker/src/index.ts"),
        pattern: /AEVO_ACCOUNTS_EXCHANGE_SECRET/u
      },
      {
        path: join(ecosystemRoot, "aevo-play/packages/auth/src/application-session.ts"),
        pattern: /./u
      },
      {
        path: join(ecosystemRoot, "aevo-pos/packages/auth/src/application-session.ts"),
        pattern: /./u
      },
      ...[
        "aevo-hub/supabase/migrations/20260918090000_hub_subscriptions.sql",
        "aevo-hub/supabase/migrations/20260918120000_billing_and_trial_lifecycle.sql",
        "aevo-hub/supabase/migrations/20260918130000_open_testing_and_onboarding.sql",
        "aevo-hub/supabase/migrations/20260918140000_platform_admin_and_quotas.sql",
        "aevo-hub/supabase/migrations/20260918150000_app_sessions.sql",
        "aevo-hub/supabase/migrations/20260918151000_security_policy_hardening.sql",
        "aevo-hub/supabase/migrations/20260918160000_security_and_entitlements_v2.sql",
        "aevo-hub/supabase/migrations/20260918160210_workspace_performance_and_sidebar.sql",
        "aevo-hub/supabase/migrations/20260918164835_production_organize_workspace_hardening.sql",
        "aevo-hub/supabase/migrations/20260918170000_canonical_production_defaults.sql",
        "aevo-hub/supabase/migrations/20260918172221_lock_store_quota_during_create.sql",
        "aevo-hub/supabase/migrations/20260918184000_query_platform_entitlements.sql",
        "aevo-hub/supabase/migrations/20260919024726_admin_query_platform.sql",
        "aevo-hub/supabase/migrations/20260919120000_performance_read_path.sql",
        "aevo-hub/supabase/migrations/20260919130000_application_access_foundation.sql",
        "aevo-hub/supabase/migrations/20260919143000_authorization_codes.sql",
        "aevo-hub/supabase/migrations/20260919144000_authorization_codes_user_index.sql",
        "aevo-hub/supabase/migrations/20260921103403_tracedee_moderation_permission.sql",
        "aevo-hub/supabase/migrations/20260921105319_store_application_access.sql",
        "aevo-hub/supabase/migrations/20260921111000_aevo_go_platform_permissions.sql",
        "aevo-hub/supabase/migrations/20260922071607_store_workspace_templates.sql",
        "aevo-pos/supabase/migrations/20260918090000_hub_subscriptions.sql",
        "aevo-pos/supabase/migrations/20260918120000_billing_and_trial_lifecycle.sql",
        "aevo-pos/supabase/migrations/20260919140000_application_access.sql",
        "aevo-pos/supabase/migrations/20260919142000_app_sessions.sql",
        "aevo-play/supabase/migrations/20260919140000_application_access.sql",
        "aevo-play/supabase/migrations/20260919142000_app_sessions.sql"
      ].map((relativePath) => ({ path: join(ecosystemRoot, relativePath), pattern: /./u })),
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
      if (legacyFile.path === join(hubRoot, "apps", "gateway")
        || legacyFile.path.endsWith("/scripts/migrate.ts")
        || legacyFile.path.endsWith("/apps/web")
        || legacyFile.path.endsWith("/apps/worker")
        || legacyFile.path.endsWith("/packages/auth")
        || legacyFile.path.endsWith("/packages/db")
        || legacyFile.path.endsWith("/packages/contracts")) {
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
