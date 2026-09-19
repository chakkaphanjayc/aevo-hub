import { spawn } from "bun";

console.log("\x1b[36m%s\x1b[0m", "🚀 Starting Aevo Hub (Gateway + Web Console)...");

const gateway = spawn(["bun", "run", "--watch", "apps/gateway/src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const web = spawn(["bun", "run", "--watch", "apps/web/src/server.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

function cleanup() {
  console.log("\n\x1b[33m%s\x1b[0m", "🛑 Stopping Aevo Hub services...");
  gateway.kill();
  web.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Promise.race([gateway.exited, web.exited]);
