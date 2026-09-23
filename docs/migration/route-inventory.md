# Hub route inventory

This is the Phase 0 inventory for the current Bun static web adapter. Route
ownership is recorded before introducing a React Router Framework Mode shell.
The Phase 2 design-system primitives are consumed by the modern Hub pilot;
route ownership remains unchanged until a route passes parity and rollback
checks.

| Current route | Current owner | Target disposition | Boundary note |
| --- | --- | --- | --- |
| `/` | Bun web server | compatibility redirect/shell | keep same-origin entry point |
| `/landing` | Bun web server | public/content route | may move to Astro later |
| `/register` | Bun web server | Accounts/onboarding route | server-side auth and CSRF |
| `/login` | Bun web server | Accounts handoff route | preserve safe return path |
| `/forgot-password` | Bun web server | Accounts route | do not reveal account existence |
| `/reset-password` | Bun web server | Accounts route | one-time recovery token only |
| `/workspace` | Bun web server | React Router Framework Mode | organization control plane |
| `/modern` | Bun web server proxy -> `apps/hub` | React Router Framework Mode | first migration pilot; server loader checks Hub access |
| `/modern/login` | `apps/hub` React Router route | React Router Framework Mode | password, OAuth, passkey, and safe app handoff context |
| `/modern/forgot-password` | `apps/hub` React Router route | React Router Framework Mode | generic password recovery response; no account enumeration |
| `/modern/reset-password` | `apps/hub` React Router route | React Router Framework Mode | server-side PKCE recovery grant; browser never receives Supabase tokens |
| `/modern/onboarding` | `apps/hub` React Router route | React Router Framework Mode | creates the first organization membership and Hub assignment before access evaluation |
| `/modern/settings` | `apps/hub` React Router route | React Router Framework Mode | live organization/team/app state; loader and actions use Core authorization + CSRF |
| `/modern/stores` | `apps/hub` React Router route | React Router Framework Mode | live store/branch and public store profile state; exposed as a first-class persistent sidebar area |
| `/modern/stores/:storeId` | `apps/hub` React Router route | React Router Framework Mode | store context and store-level application availability; server enforces tenant, store scope, permission, and CSRF on mutations |
| `/modern/security` | `apps/hub` React Router route | React Router Framework Mode | password rotation and passkey registration/list/revoke |
| `/setup` | Bun web server | React Router Framework Mode | onboarding writes through API |
| `/organize` | Bun web server | React Router Framework Mode | tenant/RBAC/entitlement checks server-side; users without a workspace enter canonical `/modern/onboarding` |
| `/admin` | Bun web server | privileged Admin boundary | platform RBAC is separate from org RBAC |

Static asset routes under `/assets/*`, `/auth.js`, and the current HTML shell
remain legacy compatibility routes until the first workspace canary is
verified. No route is removed as part of Phase 0/1.
