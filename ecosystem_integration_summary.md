# Ecosystem integration status

Updated 2026-09-23 for the Core API cutover.

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

- Hub contract inventory is published as v1 with 48 routes.
- Core API implements and reports all 48 Hub routes as ready.
- Accounts issues identity-backed app sessions through Core API.
- Hub, Play, and POS use Core session resolve/refresh/revoke contracts.
- Organization membership, application assignments, store app access, CSRF,
  and tenant scope are server-resolved by Core API.
- Onboarding session/progress/checklist state is owned by Core API.
- Core migration ownership is verified through migration `0009`.
- Normal Hub launchers start Core, Accounts, Edge, and web surfaces only.
- Legacy Hub gateway, SDK, migration writer, and unused API client wrapper are
  removed.

## Local verification

```bash
bun run dev:all
bun run test:all --integration
bun run test:tenant-security
```

The app-specific test suites remain responsible for their own domain behavior;
the shared boundary tests cover contract versioning, ingress signatures,
app-scoped sessions, registration, and cross-tenant denial.
