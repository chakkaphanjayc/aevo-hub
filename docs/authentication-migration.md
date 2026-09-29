# Authentication and migration boundary

The development cutover is complete for the Hub/Accounts/Core session path.
The responsibility split is:

- Accounts talks to the identity provider and brokers password flows. OAuth
  provider routes and passkey remain gated until their versioned contracts are
  deployed end to end.
- Core API issues, resolves, refreshes, and revokes opaque app-scoped sessions.
- Core API resolves application assignment, organization/store scope, roles,
  permissions, and store app access.
- Hub is a web client and does not own authentication tables or API migrations.

The local passkey controls remain feature-flagged off until the Accounts/Core
WebAuthn contract is versioned and implemented. This avoids exposing a UI that
would call an unavailable endpoint; password, OAuth, and recovery flows remain
available.

## Local migration commands

Run these from `aevo-hub` or directly from `aevo-core-api`:

```bash
bun run db:migrate:dry-run
bun run db:migrate
bun run db:migrate:verify
```

The commands delegate to `Aevo.CoreApi.Migrator`, which uses
`_aevo_core_migrations`, a PostgreSQL advisory lock, ordered SQL files, and
SHA-256 drift checks. The current development database has the ordered Core
migration set applied and verified.

There is no Hub migration write path and no legacy migration command. Retained
Supabase migration files are app-domain history only; the confirmed
control-plane files were removed and Core API/Infrastructure is the only
authority for the active database migration history.

## Runtime verification

Start the shared boundary with `bun run dev` and verify:

```bash
curl -fsS http://localhost:4400/health
curl -fsS http://localhost:4400/api/v1/hub/contract
```

Use the root test runner for the cross-application matrix:

```bash
bun run test:all --integration
bun run test:tenant-security
```

The security suite verifies that Core rejects unsigned direct traffic, Edge
forwards the versioned contract, anonymous onboarding mutations fail closed,
registration creates an app-scoped Hub session, and foreign tenant resources
cannot be read.
