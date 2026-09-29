# Hub route inventory after cutover

The Hub cutover is complete for the web runtime. The React Router Framework
Mode application in `apps/hub` is the only Hub web owner and uses the
`/modern` basename. The deleted Bun/static compatibility surface is retained
only in the repository history; it is not a supported local or deployed route.

| Route | Owner | Status | Boundary note |
| --- | --- | --- | --- |
| `/modern` | `apps/hub` React Router | canonical | authenticated workspace overview |
| `/modern/login` | `apps/hub` React Router | canonical | password, OAuth and safe app handoff context |
| `/modern/forgot-password` | `apps/hub` React Router | canonical | generic recovery response; no account enumeration |
| `/modern/reset-password` | `apps/hub` React Router | canonical | server-side recovery grant |
| `/modern/onboarding` | `apps/hub` React Router | canonical | first organization and Hub assignment |
| `/modern/settings` | `apps/hub` React Router | canonical | organization, members, app assignments, subscriptions and entitlements |
| `/modern/stores` | `apps/hub` React Router | canonical | store/branch and public profile management |
| `/modern/stores/:storeId` | `apps/hub` React Router | canonical | store app access, features, catalog, templates and probes |
| `/modern/security` | `apps/hub` React Router | canonical | password and passkey capability state |

The following paths are intentionally removed, not compatibility aliases:

```text
/landing
/register
/login
/forgot-password
/reset-password
/workspace
/setup
/organize
/admin
```

`/admin` remains a separate privileged `aevo-admin` application and is not a
Hub route. Historical Supabase migrations are not route/runtime compatibility
code and remain read-only until the Core/Infrastructure data transition is
fully verified.
