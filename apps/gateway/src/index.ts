import { loadConfig } from "@aevo/config";
import { AuthService } from "@aevo/auth";
import { createDatabase } from "@aevo/db";
import { createApp } from "./app";

const config = loadConfig(process.env);
const database = createDatabase(config.supabaseUrl, config.supabaseKey);
const app = createApp({ config, database });

const port = Number(process.env.API_PORT || config.apiPort || 4000);
const host = process.env.API_HOST || config.apiHost || "0.0.0.0";

app.listen({ port, hostname: host }, () => {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│                   AEVO CANONICAL API GATEWAY                │
│                 Central Gateway & Platform Hub              │
├─────────────────────────────────────────────────────────────┤
│  Status:  ONLINE                                            │
│  Host:    http://${host}:${port}                             │
│  Env:     ${config.nodeEnv}                                 │
├─────────────────────────────────────────────────────────────┤
│  Canonical Surfaces:                                        │
│  • Surface 1 (Hub):    http://${host}:${port}/api/v1/hub    │
│  • Surface 2 (Staff):  http://${host}:${port}/api/v1/staff  │
│  • Surface 3 (Public): http://${host}:${port}/api/v1/public │
│  • Surface 4 (Device): http://${host}:${port}/api/v1/device │
│  • Query Platform:     http://${host}:${port}/api/v1/query  │
│  • Swagger Docs:       http://${host}:${port}/swagger       │
└─────────────────────────────────────────────────────────────┘
`);
});

export type GatewayApp = typeof app;
export { app };
