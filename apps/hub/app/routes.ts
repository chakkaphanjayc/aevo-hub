import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("login", "./routes/login.tsx"),
  route("forgot-password", "./routes/forgot-password.tsx"),
  route("reset-password", "./routes/reset-password.tsx"),
  route("onboarding", "./routes/onboarding.tsx"),
  layout("./routes/hub-layout.tsx", [
    index("./routes/workspace.tsx"),
    route("settings", "./routes/settings.tsx"),
    route("stores", "./routes/stores.tsx"),
    route("stores/:storeId", "./routes/store.tsx"),
    route("security", "./routes/security.tsx")
  ])
] satisfies RouteConfig;
