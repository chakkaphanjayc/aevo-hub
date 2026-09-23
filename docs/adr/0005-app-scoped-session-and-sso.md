# ADR 0005: Accounts SSO and application-scoped sessions

- Status: accepted
- Date: 2026-09-19

## Decision

Accounts/SSO is the identity entry point. After authentication, the Accounts
boundary issues a short-lived one-time handoff to the target application. The
target server exchanges it and creates an opaque, HttpOnly, application-scoped
session. The browser never receives a Supabase access token or refresh token.

The current Hub login flow remains supported while the exchange is introduced.
Its cookie name is application-specific and its session row is server-managed.
The application registry and `app_code` session column added in
`20260919130000_application_access_foundation.sql` make the boundary explicit
without invalidating existing Hub sessions.

## Authorization order

Every target application resolves access on the server in this order:

1. authenticated identity and active account status;
2. organization membership and active membership status;
3. application assignment and assignment status;
4. organization/store/resource scope;
5. organization RBAC permissions;
6. plan entitlement and usage limits.

The client may suggest an organization or store context, but a URL parameter,
local storage value, or client-side guard is never an authorization decision.

## Security constraints

- No bearer tokens in URL query strings, local storage, or browser-readable
  application state.
- Session cookies use `HttpOnly`, `Secure` in production, an explicit
  `SameSite` policy, CSRF protection for cookie-authenticated mutations, and
  bounded idle/absolute expiry.
- The Supabase service-role key is server-only and is never bundled into a
  browser application.
- Return paths are same-origin relative paths and are treated as hints only.
