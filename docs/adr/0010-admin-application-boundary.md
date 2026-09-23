# ADR 0010: Aevo Admin as a Separate Application Boundary

## Status

Accepted

## Context

Aevo Hub manages organization-facing configuration, while platform operators
need a privileged surface that can inspect and control multiple applications:
Hub, Go, Play, POS, Kiosk, Queue, and future first-party runtimes. Hiding that
surface behind a Hub route would make the browser boundary and the privilege
boundary indistinguishable.

## Decision

Create `apps/admin` as the canonical Aevo Admin application. It is separate in
runtime and deployment even though it currently lives in the `aevo-hub`
monorepo.

- Admin uses React Router Framework Mode and the shared Aevo design system.
- Admin runs against a separate gateway process configured with
  `AEVO_APP_CODE=ADMIN`.
- Admin has its own web origin, session cookie, CSRF cookie, and API origin.
- `/api/v1/admin/*` is available only from the Admin gateway runtime.
- Platform roles and permissions are resolved independently from organization
  membership and application assignments.
- The Core API remains the source of truth for application registry, tenant
  state, billing, entitlements, and audit records.
- Application registry status is enforced at access-decision and new SSO
  handoff boundaries, so disabling an application has server-side effect.
- Dangerous controls require a reason, a server-side permission check, and a
  before/after audit record. The Admin application cannot disable its own
  application boundary.

## Local topology

| Boundary | Web | Gateway | Runtime code |
| --- | --- | --- | --- |
| Aevo Hub | `localhost:4330` | `localhost:4000` | `AEVO_APP_CODE=HUB` |
| Aevo Admin | `localhost:4335` | `localhost:4001` | `AEVO_APP_CODE=ADMIN` |

The root launcher starts both runtimes with `bun run dev:hub+admin`. Production
uses an Admin-specific hostname such as `admin.aevo.app` and a separately
managed gateway deployment.

## Consequences

Admin can become a clean privileged deployment without extracting the shared
contracts and domain packages into a second repository. A Hub user can still
use Hub organization settings without receiving platform administration
rights. Operational changes must go through the Core API, which keeps audit,
entitlement, and tenant-safety rules centralized.
