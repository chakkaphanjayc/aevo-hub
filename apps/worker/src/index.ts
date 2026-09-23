import { loadConfig } from "@aevo/config";
import { createDatabase, processPendingQueryJobs, rebuildTraceDeeProjections } from "@aevo/db";

const config = loadConfig(process.env);
const database = createDatabase(config.supabaseUrl, config.supabaseKey);
const pollMs = Math.max(250, Number(process.env.QUERY_WORKER_POLL_MS || 1000));
const tracedeeProjectorEnabled = process.env.TRACEDEE_PROJECTOR_ENABLED === "true";
const tracedeeProjectorIntervalMs = Math.max(60_000, Number(process.env.TRACEDEE_PROJECTOR_INTERVAL_MS || 300_000));
let lastTraceDeeProjectionAt = 0;
let running = true;

async function tick(): Promise<void> {
  try {
    const processed = await processPendingQueryJobs(database, Number(process.env.QUERY_WORKER_BATCH_SIZE || 10));
    if (processed > 0) console.log(`[Aevo Query Worker] Processed ${processed} job(s)`);
    if (tracedeeProjectorEnabled && Date.now() - lastTraceDeeProjectionAt >= tracedeeProjectorIntervalMs) {
      const result = await rebuildTraceDeeProjections(database);
      lastTraceDeeProjectionAt = Date.now();
      console.log(`[TraceDee Projector] Rebuilt v${result.scoreVersion}: ${result.profileCount} profiles, ${result.expertiseCount} expertise, ${result.tasteCount} affinities, ${result.qualityCount} quality rows`);
    }
  } catch (error) {
    console.error(`[Aevo Query Worker] Poll failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

console.log(`[Aevo Query Worker] Running with ${pollMs}ms polling interval`);
while (running) {
  await tick();
  if (running) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await database.close();
