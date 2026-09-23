# Authentication and migration boundary

The development cutover is complete for the Hub/Accounts/Core session path.
The responsibility split is:

- Accounts talks to the identity provider and brokers password/OAuth/passkey
  flows.
- Core API issues, resolves, refreshes, and revokes opaque app-scoped sessions.
- Core API resolves application assignment, organization/store scope, roles,
  permissions, and store app access.
- Hub is a web client and does not own authentication tables or API migrations.

## Local migration commands

Run these from `aevo-hub` or directly from `aevo-core-api`:

```bash
bun run db:migrate:dry-run
bun run db:migrate
bun run db:migrate:verify
```

The commands delegate to `Aevo.CoreApi.Migrator`, which uses
`_aevo_core_migrations`, a PostgreSQL advisory lock, ordered SQL files, and
SHA-256 drift checks. The current development database has all nine Core
migrations applied and verified.

There is no Hub migration write path and no legacy migration command. The old
Supabase migration files are retained only as historical compatibility input
while the database transition is completed by Core API/Infrastructure.

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
