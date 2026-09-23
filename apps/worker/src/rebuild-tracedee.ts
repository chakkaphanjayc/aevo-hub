import { loadConfig } from "@aevo/config";
import { createDatabase, rebuildTraceDeeProjections } from "@aevo/db";

const config = loadConfig(process.env);
const database = createDatabase(config.supabaseUrl, config.supabaseKey);

try {
  const result = await rebuildTraceDeeProjections(database);
  console.log(JSON.stringify(result));
} finally {
  await database.close();
}
