# Aevo Hub

Aevo Hub is the authenticated control-plane UI for organizations, stores,
members, application assignments, store app access, and workspace setup.

The runtime boundary is now:

```text
Hub Modern Console (:4330) ──> Aevo Edge Gateway (:4000) ──> Aevo Core API (:5099)
                                           │
                                           └──> Aevo Accounts (:8787)
```

`aevo-hub` no longer contains a canonical API gateway. The former
`apps/gateway`, legacy SDK, legacy migration runner, and migration compatibility
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

The Hub launcher starts Accounts, Core API, Edge, the public home, and the
modern console. It never starts a Hub-owned API process.

URLs:

- Modern Hub: `http://localhost:4330/modern`
- Public home: `http://localhost:4321`
- Hub Edge: `http://localhost:4000`
- Core API: `http://localhost:5099`
- Accounts: `http://localhost:8787`

The modern Hub worker reads first-party launch targets from the `AEVO_*_URL`
bindings in `apps/hub/wrangler.jsonc`. The local defaults include
`AEVO_PLAY_URL=http://localhost:4331/modern`; set the corresponding values in
each preview, staging, or production environment before deploying.

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
codes, Hub permission alignment, and Hub onboarding ownership (`0001`–`0009`).
The old Supabase migrations remain historical compatibility input during the
data transition; the Hub launcher never applies them.

## Contracts and authorization

The modern Hub uses the versioned client exported by `aevo-contracts`. Every
request carries `x-aevo-contract-version: v1`. Core API resolves the opaque,
application-bound session, CSRF state, organization/store scope, assignment,
permission, and store-level app policy server-side.

The store workspace supports:

- organization and store creation;
- store-scoped app access for Play, POS, Kiosk, and Queue;
- store features and catalog configuration;
- template and duplicate flows for multi-branch setup;
- connection probes through Core API.

## Verification

```bash
bun run typecheck
bun test packages/auth packages/auth-client packages/app-access packages/tenant-context packages/permissions packages/api-contract
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
response, duration, and slow-request telemetry. Set `AEVO_HUB_LOG_LEVEL=debug`
to increase Hub server-loader detail during local diagnosis.
