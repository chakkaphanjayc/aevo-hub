# Hub API and auth inventory

## Authentication surfaces

| Surface | Current contract | Modernization rule |
| --- | --- | --- |
| `/api/auth/login` | Supabase Auth login, opaque Hub cookie, CSRF cookie | preserve while Accounts handoff is introduced |
| `/api/auth/refresh` | rotates server-managed session | keep rotation and bounded expiry |
| `/api/auth/logout` | revokes remote and local session | clear cookies even when remote revocation is unavailable |
| `/api/auth/me` | resolves identity and tenant principal | extend with app access without trusting client hints |
| `/api/auth/sessions*` | lists/revokes current user's sessions | keep server-only session lookup |
| `/api/auth/password/reset-request` | starts a generic password recovery email with server-side PKCE | keep responses enumeration-safe and keep tokens server-side |
| `/api/auth/password/recovery/callback` | exchanges the recovery PKCE code and creates a short-lived recovery grant | never expose Supabase access/refresh tokens to browser code |
| `/api/auth/password/update` | updates a password and revokes local/remote sessions | require current password except for a valid recovery grant |
| `/api/auth/passkey/*` | WebAuthn options, verification, and passkey management | keep provider APIs behind the Accounts/Core session and CSRF boundary |
| `/api/v1/access` | typed app access decision | resolves platform Admin separately and organization app assignments server-side |

## API surfaces

- `/api/v1/hub/*`: organization control plane, onboarding, subscriptions,
  billing, members, stores, application assignments, and preferences.
- `/api/v1/staff/*`: staff catalog, orders, payments, cash, preparation, and
  reports.
- `/api/v1/public/*`: consumer menu, order, booking, and tracking surfaces.
- `/api/v1/device/*`: pairing and device-scoped operational access.
- `/api/v1/query/*`: universal tenant-safe query, import, export, and saved
  query surfaces.
- `/api/v1/admin/*`: privileged platform administration, isolated from org
  membership RBAC.

## Cross-cutting contract

Every request gets a bounded `x-request-id`; error responses keep the existing
`{ error: { code, message, requestId } }` shape; mutating operations continue
to accept `idempotency-key` where the domain supports retries. The versioned
`@aevocado/contracts` client adds the contract header consistently and uses
credentials by default for the application session.

The browser may call the Edge Gateway with an application session cookie, but
never with `SUPABASE_SECRET_KEY`. Direct database access is limited to Core API,
trusted workers, and server-only Supabase clients.

The modern Hub settings route uses these assignment endpoints for organization
members with `member.manage`:

- `GET /api/v1/hub/members/:membershipId/applications` — returns active,
  suspended, or revoked assignments with scope and app-role projections.
- `PATCH /api/v1/hub/members/:membershipId/applications/:applicationCode` —
  updates only workforce applications (`PLAY`, `POS`, `KIOSK`, `QUEUE`),
  validates organization store scope, and writes an audit entry.

`HUB` is provisioned by the membership trigger and `ADMIN` remains a platform
RBAC boundary; neither can be granted by this organization endpoint.
