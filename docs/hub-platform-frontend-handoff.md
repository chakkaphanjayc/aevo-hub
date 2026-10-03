# Hub platform surface handoff

This branch adds `/billing`, `/access`, `/reports`, and `/data` without changing the dirty main worktree’s `hub-layout.tsx` or `app.css`. Route pages reuse Core API clients and render unavailable states when a capability is not exposed.

## Backend contract observed

- Billing reads use the existing `GET /api/v1/hub/subscriptions` and `GET /api/v1/me/entitlements` responses. Core owns plan, status, period, feature, limit, and usage values.
- The member workspace uses Core’s `GET /api/v1/hub/members`, `GET /api/v1/hub/members/applications`, `PATCH /api/v1/hub/members/{membershipId}`, and `PATCH /api/v1/hub/members/{membershipId}/applications/{applicationCode}` contracts. The current API supports organization role updates, application assignment status, and store scopes. Writes stay in the route action and report the Core response.
- The current Hub assignment response contains application status and scopes. It does not contain the `roleCodes` field required by the shared `MemberApplicationAssignmentSummary` TypeScript interface, and there is no app-role catalog or app-role mutation endpoint. The UI leaves app roles unavailable.
- The backend worktree has no Hub contract for payment methods, transaction history, or billing-portal capability/action; Query Platform model/field metadata, saved definitions, run/export jobs; or import/export schema, validation, jobs, retries, and result downloads. Those controls remain explicitly unavailable and no browser persistence or fabricated results are used.

## Minimal merge into the dirty main settings shell

Copy the four route entries into the existing `layout(..., [ ... ])` list in `apps/hub/app/routes.ts`; retain all dirty main routes:

```diff
     index("./routes/workspace.tsx"),
     route("settings", "./routes/settings.tsx"),
+    route("billing", "./routes/billing.tsx"),
+    route("access", "./routes/access.tsx"),
+    route("reports", "./routes/reports.tsx"),
+    route("data", "./routes/data-operations.tsx"),
```

In the dirty main `settingsNavSections` array in `apps/hub/app/routes/hub-layout.tsx`, change only the destination strings and add the two new destinations. Keep the surrounding labels/descriptions unchanged:

```diff
-      { id: "team", label: "Team & Access", description: "Members, roles, and application assignments", to: "/org/team" },
+      { id: "team", label: "Team & Access", description: "Members, roles, and application assignments", to: "/access" },
         id: "billing",
         label: "Billing & Payment",
         description: "Payment methods, transactions, and billing state",
-        to: "/settings#billing-heading",
+        to: "/billing",
         children: [
-          { id: "payment-methods", label: "Payment Methods", to: "/settings#payment-methods" },
-          { id: "transaction-history", label: "Transaction History", to: "/settings#transaction-history" }
+          { id: "payment-methods", label: "Payment Methods", to: "/billing#payment-methods" },
+          { id: "transaction-history", label: "Transaction History", to: "/billing#transaction-history" }
         ]
       },
-      { id: "subscriptions", label: "Subscriptions", description: "Application subscriptions and entitlement periods", to: "/settings#subscriptions" }
+      { id: "subscriptions", label: "Subscriptions", description: "Application subscriptions and entitlement periods", to: "/billing#subscriptions" },
+      { id: "reports", label: "Reports", description: "Build and run Core-authorized reports", to: "/reports" },
+      { id: "data-operations", label: "Import & export", description: "Run Core-authorized data jobs", to: "/data" }
```

Append the new route paths to the current `isSettingsSurface` allowlist so the existing settings shell remains active on these pages:

```diff
-  return ["/", "/org/overview", "/org/locations", "/org/stores", "/stores", "/org/apps", "/org/team", "/settings", "/security"].includes(location.pathname);
+  return ["/", "/org/overview", "/org/locations", "/org/stores", "/stores", "/org/apps", "/org/team", "/settings", "/security", "/billing", "/access", "/reports", "/data"].includes(location.pathname);
```

No shell CSS hunk is required; each new page loads the scoped `platform-settings.css` stylesheet.
