# ADR 0004: Framework allocation for the strangler migration

- Status: accepted
- Date: 2026-09-19
- Scope: `aevo-hub` first migration slice

## Decision

The public/content surface remains Astro-oriented. Authenticated Hub and
Admin workspaces move toward React Router Framework Mode with server rendering
on the eventual Cloudflare Workers runtime. Operational surfaces such as POS,
Kiosk, and Queue remain React + Vite/React Router applications.

The current Hub gateway and static Bun web server remain the compatibility
adapter during the migration. The first slice extracts framework-neutral
contracts, API client behavior, app access, tenant context, permissions, and
observability. It does not replace the gateway or perform a route rewrite.

## Constraints

- The canonical API, Supabase data model, server-managed session behavior, and
  existing RBAC/entitlement checks remain the source of truth.
- A new UI route must be introduced behind a route-level flag or canary path
  before the legacy route is removed.
- A failed canary rolls back by routing traffic to the existing web adapter;
  rollback must not require a database rollback.
- Platform Admin access stays isolated from organization membership access.

## Consequences

The repository temporarily contains legacy `@aevo/*` packages and new
`@aevocado/*` framework packages. The package scope migration is incremental;
existing consumers are not renamed until their boundary has tests and a
rollback path.
