# ADR 0007: Package naming during the modernization

- Status: superseded
- Date: 2026-09-19

The modernization originally introduced framework-neutral foundation packages
under the `@aevocado/*` scope. The migration is now complete for Hub: the
versioned API contract and client live in `aevo-contracts`, while Hub-local
compatibility wrappers have been removed.

The first packages are:

- `@aevocado/api-contract`
- `@aevocado/contracts` (versioned contract and client)
- `@aevocado/auth-client`
- `@aevocado/app-access`
- `@aevocado/tenant-context`
- `@aevocado/permissions`
- `@aevocado/observability`

External applications consume the same versioned contract package; no Hub
gateway SDK or migration adapter is retained.
