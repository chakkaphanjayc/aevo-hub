import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("login", "./routes/login.tsx"),
  route("forgot-password", "./routes/forgot-password.tsx"),
  route("reset-password", "./routes/reset-password.tsx"),
  route("api/security/csp-report", "./routes/api-security-csp-report.ts"),
  route("api/v1/sync/manifest", "./routes/api-v1-sync-manifest.ts"),
  route("onboarding", "./routes/onboarding.tsx"),
  layout("./routes/hub-layout.tsx", [
    index("./routes/workspace.tsx"),
    route("settings", "./routes/settings.tsx"),
    route("stores", "./routes/stores.tsx"),
    route("stores/:storeId/apps/:applicationCode", "./routes/store-application.tsx"),
    route("stores/:storeId", "./routes/store.tsx"),
    route("security", "./routes/security.tsx")
  ])
] satisfies RouteConfig;
