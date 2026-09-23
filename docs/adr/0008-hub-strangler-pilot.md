# ADR 0008: Hub Framework Mode strangler pilot

- Status: accepted
- Date: 2026-09-19

## Decision

Start the Hub migration with an additive React Router Framework Mode shell in
`apps/hub`. The legacy Bun web server remains the public same-origin entry
point and proxies `/modern` to the pilot. Existing `/workspace`, `/setup`,
`/organize`, and `/admin` routes are not replaced by this slice.

The pilot's server loader calls the existing typed gateway contract using the
request's application session cookie:

1. `GET /api/auth/me` resolves the server-owned identity and principal.
2. `GET /api/v1/access?application=HUB` resolves membership, Hub assignment,
   scope, role, and permissions on the trusted gateway.
3. Anonymous requests redirect to the legacy login route with the safe relative
   return path `/modern`.
4. Denied Hub decisions render an explicit permission state; they never grant
   a child route or rely on CSS/client-only hiding.

`@aevocado/design-system` owns the first shared semantic tokens and baseline
accessibility states. Future Hub routes should reuse this package and the
gateway/API client rather than reading Supabase or duplicating authorization.

The pilot now includes a real `/modern/settings` route. Its loader resolves
organization, store, member, application, subscription, entitlement, and
runtime-assignment state through the gateway. Its actions re-check the Hub
session and permission, validate allow-listed form values, forward the
HttpOnly session cookie plus CSRF token to the canonical mutation endpoints,
and redirect only after a successful gateway response. Assignment and
subscription entitlement remain separate in the UI and in the server
decision model. Member application mutations are limited to workforce apps,
validate store scope on the server, and emit an audit record; platform Admin
and compatibility Hub assignments are not organization-managed settings.

React Router Framework Mode removes server-only exports from the client
bundle. Route components may use only shared types and pure helpers; API
clients, session readers, and CSRF utilities stay in `*.server.ts` modules.

## Rollback

Set `AEVO_HUB_MODERN_URL` to an unavailable/disabled origin or stop the modern
app. Legacy routes remain directly available, so the pilot can be rolled back
without a database rollback or session-format change.

## Exit criteria for the next route

Before moving `/workspace` or `/organize`, add parity tests for each loader and
mutation, verify cross-organization denial, and keep the legacy route as a
canary fallback until the new route has passed the same integration suite.
