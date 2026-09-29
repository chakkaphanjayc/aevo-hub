# ADR 0004: Framework allocation for the strangler migration

- Status: superseded by the completed Hub cutover
- Date: 2026-09-19
- Scope: `aevo-hub` first migration slice

## Decision

The public/content surface remains Astro-oriented. Authenticated Hub and
Admin workspaces move toward React Router Framework Mode with server rendering
on the eventual Cloudflare Workers runtime. Operational surfaces such as POS,
Kiosk, and Queue remain React + Vite/React Router applications.

The former Hub gateway, static Bun web server, direct-Supabase domain packages,
and in-repository worker are not runtime owners after cutover. Framework-neutral
contracts, API client behavior, app access, tenant context, permissions, and
observability now live in the versioned `@aevocado/*` boundary and Core API.

## Constraints

- The canonical API, Supabase data model, server-managed session behavior, and
  existing RBAC/entitlement checks remain the source of truth.
- The modern route set must pass loader/action, cross-tenant, and migration
  verification before the legacy route is removed.
- A failed cutover is recovered from source control; the deleted adapter is not
  reintroduced as a second authorization or migration owner.
- Platform Admin access stays isolated from organization membership access.

## Consequences

Historical Supabase migration SQL remains in the repository as read-only
archive during data transition. Runtime packages are owned by Core API,
Accounts, Edge, or the separate background-worker repository.
