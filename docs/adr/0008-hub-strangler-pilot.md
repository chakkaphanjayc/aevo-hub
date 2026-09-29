# ADR 0008: Hub Framework Mode cutover

- Status: superseded by the completed Hub cutover
- Date: 2026-09-19
- Superseded: 2026-09-24

## Decision

The original additive React Router pilot in `apps/hub` is now the canonical
Hub application. The legacy Bun/static web server and its compatibility routes
were removed after the modern workspace, organization/store management,
onboarding, security, application assignment, and tenant-scope checks were
available in the modern route set.

The active request path is:

```text
Browser :4330/modern -> Edge :4000 -> Core API :5099 -> Accounts :8787
```

Modern loaders and actions call the versioned Core contract through the Edge
boundary. They do not read Supabase directly, create browser bearer tokens,
or make client-only authorization decisions. Core owns app-scoped sessions,
tenant authorization, domain operations, and the migration ledger.

## Cutover result

- `/modern/*` is the only Hub web route family.
- `/workspace`, `/setup`, `/organize`, and static auth routes are deleted.
- The local launcher no longer starts a second Hub web process or checks port
  `4321`.
- Home navigation stays on the modern origin and preserves the authenticated
  Hub session.
- Core migration files remain the only migration write authority.

## Rollback

Rollback is a source-control recovery operation in development, not a runtime
fallback. Reintroducing the deleted adapter, old session path, or direct
Supabase browser calls would violate the current ownership boundary and must
be handled as a new ADR with tenant-security evidence.
