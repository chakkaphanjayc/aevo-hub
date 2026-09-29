# Ecosystem integration status

Updated 2026-09-26 for the Core API cutover and HUB-013 through HUB-017
development implementation.

## Runtime topology

```text
Hub / Admin / Play / POS
          │
          ├── Accounts: identity provider broker and password/OAuth/passkey flows
          ├── Core API: versioned contracts, sessions, authorization, domain authority
          └── Edge Gateway: ingress, request signing, and routing
```

The Hub repository is no longer an API gateway. Its modern console consumes the
versioned client from `aevo-contracts`; Core API exposes the Hub contract and
Edge is the only network ingress boundary. `aevo-digital-sing` remains an
independent application and is not part of this cutover.

## Completed boundary work

- Hub contract inventory is published as v1 with 54 route entries across 52 unique Hub paths plus two shared `/api/v1/me` paths.
- Core API implements and reports all 54 Hub route entries as ready.
- Accounts issues identity-backed app sessions through Core API.
- Hub, Play, and POS use Core session resolve/refresh/revoke contracts.
- Organization membership, application assignments, store app access, CSRF,
  and tenant scope are server-resolved by Core API.
- Onboarding session/progress/checklist state is owned by Core API.
- Core migration ownership is verified through migration `0037` with 42 applied, checksum-verified records, including the parallel numbered `0034` and `0037` projections and the Hub role-permission alignment backfill.
- Server-side PKCE password recovery, bounded worker delivery, tenant-scoped dashboard projections, and the first Core-owned integration lifecycle are implemented and verified in development.
- Normal Hub launchers start Core, Accounts, Edge, and web surfaces only.
- Legacy Hub gateway, SDK, migration writer, compatibility adapters, and
  retired control-plane migration writers are removed. App-domain migration
  history remains with its owning application.

## Local verification

```bash
bun run dev:all
bun run test:all --integration
bun run test:tenant-security
```

The app-specific test suites remain responsible for their own domain behavior;
the shared boundary tests cover contract versioning, ingress signatures,
app-scoped sessions, registration, and cross-tenant denial.
