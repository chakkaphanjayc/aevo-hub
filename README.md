# Aevo Hub

Aevo Hub is the authenticated control-plane UI for organizations, stores,
members, application assignments, store app access, and workspace setup.

The runtime boundary is now:

```text
Hub Modern Console (:4330) ──> Aevo Edge Gateway (:4000) ──> Aevo Core API (:5099)
                                           │
                                           └──> Aevo Accounts (:8787)
```

`aevo-hub` no longer contains a canonical API gateway. The former Hub gateway
web workspace, legacy SDK, legacy migration runner, and migration compatibility
commands have been removed. The Edge Gateway only provides ingress, request
signing, and routing; Core API owns contracts, authorization, sessions, domain
operations, and the migration boundary.

`aevo-digital-sing` is an independent application and is intentionally outside
this migration.

## Local development

From the ecosystem root:

```bash
bun run dev:hub
```

Or from this repository:

```bash
bun run dev
```

The Hub launcher starts Accounts, Core API, Edge, and the modern console. It
never starts a Hub-owned API or legacy web process.

URLs:

- Modern Hub: `http://localhost:4330/modern`
- Hub Edge: `http://localhost:4000`
- Core API: `http://localhost:5099`
- Accounts: `http://localhost:8787`

The modern Hub uses the `AEVO_*_URL` bindings only to construct the callback
destination after a successful identity handoff. Opening Play/POS is a Core
mediated launch: Core checks assignment, store binding, entitlement, and a
signed readiness handshake against the target API before returning its
`/api/auth/start` URL. A configured web URL alone never grants access.

For a complete local ecosystem session, use the root launcher:

```bash
bun run dev:all
```

It starts the shared Core/Accounts boundary and the Hub, Admin, Play, and POS
processes requested by the profile. Play and POS authenticate through Core and
Accounts; they do not use a Hub session database or bearer-token fallback.

## Migrations

Only `aevo-core-api` owns migration writes. The Hub commands delegate to the
Core API migrator for local convenience:

```bash
bun run db:migrate:dry-run
bun run db:migrate
bun run db:migrate:verify
```

The Core migration ledger currently includes session lifecycle, authorization
codes, Hub permission alignment, onboarding ownership, canonical projections,
workspace template authority, typed store application configuration, template
configuration copy, dashboard projections, integration lifecycle, feed
moderation/feedback, and compatibility retirement (`0001`–`0037`, 42
checksum-verified entries, including the parallel numbered `0034` and `0037`
projections).
The retained Supabase files in this repository are app-domain history only;
the Hub launcher never applies them and the retired control-plane migration
files have been removed.

## Contracts and authorization

The modern Hub uses the versioned client exported by `aevo-contracts`. Every
request carries `x-aevo-contract-version: v1`. Core API resolves the opaque,
application-bound session, CSRF state, organization/store scope, assignment,
permission, and store-level app policy server-side.

The store workspace supports:

- organization and store creation;
- store-scoped app access for Play, POS, Kiosk, and Queue;
- store features and catalog configuration;
- typed per-app store configuration rendered from Core-owned schemas;
- template and duplicate flows for multi-branch setup;
- connection probes through Core API.

## Verification

```bash
bun run typecheck
bun test packages/auth-client packages/app-access packages/tenant-context packages/permissions packages/api-contract
bun run auth:migration-check
bun run auth:legacy-removal-check
```

From the ecosystem root, the full cross-application checks are:

```bash
bun run test:all
bun run test:tenant-security
```

Add `--integration` to the full test runner when the local Core/Accounts/Edge
processes are running and live Hub registration plus tenant checks should run.

## Logs

`bun run dev` forwards each service's stdout/stderr with a service prefix.
Core API emits structured ASP.NET request logs; the modern Hub emits request,
response, duration, and slow-request telemetry. Settings navigation also emits
`settings.loader.base` and `settings.loader.complete`, so the critical path can
be separated from batch reads without guessing from browser paint time. Set
`AEVO_HUB_LOG_LEVEL=debug` to increase Hub server-loader detail during local
diagnosis. A useful local filter is:

```bash
bun run dev 2>&1 | rg 'hub.access|settings.loader|api.response|slow'
```

After changing Core API code or migrations, restart `bun run dev` once so the
`:5099` Core process loads the new binary; the modern route can hot-reload
independently.
