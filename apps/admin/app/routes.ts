import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("login", "./routes/login.tsx"),
  layout("./routes/admin-layout.tsx", [
    index("./routes/dashboard.tsx"),
    route("applications", "./routes/applications.tsx"),
    route("organizations", "./routes/organizations.tsx"),
    route("subscriptions", "./routes/subscriptions.tsx"),
    route("users", "./routes/users.tsx"),
    route("moderation", "./routes/moderation.tsx"),
    route("projections", "./routes/projections.tsx"),
    route("reputation", "./routes/reputation.tsx"),
    route("ranking", "./routes/ranking.tsx"),
    route("system", "./routes/system.tsx")
  ])
] satisfies RouteConfig;
