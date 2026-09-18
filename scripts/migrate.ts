import { SQL } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");
const db = new SQL(databaseUrl);

async function runMigrations() {
  console.log(`[Migrations] Connecting to Supabase database...`);

  // Ensure migration tracking table exists
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS _hub_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRows = await db.unsafe(`SELECT filename FROM _hub_migrations ORDER BY id ASC;`) as Array<{ filename: string }>;
  const appliedSet = new Set(appliedRows.map((r) => r.filename));

  const migrationsDir = join(import.meta.dir, "..", "supabase", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  console.log(`[Migrations] Found ${files.length} migration files. ${appliedSet.size} already recorded.`);

  let newlyApplied = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }

    console.log(`[Migrations] Applying ${file}...`);
    const filePath = join(migrationsDir, file);
    const sqlContent = await readFile(filePath, "utf-8");

    try {
      await db.unsafe(sqlContent);
      await db.unsafe(`INSERT INTO _hub_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING;`, [file]);
      console.log(`[Migrations] ✓ Successfully applied ${file}`);
      newlyApplied++;
    } catch (err: any) {
      console.error(`[Migrations] Failed during ${file}: ${err.message}`);
      throw err;
    }
  }

  console.log(`[Migrations] Done! Applied ${newlyApplied} new migrations.`);

  // Verify total public tables
  const tables = await db.unsafe(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC;
  `) as Array<{ tablename: string }>;

  console.log(`[Migrations] Active public tables in Supabase: ${tables.length}`);
  await db.close();
}

if (import.meta.main) {
  runMigrations().catch((err) => {
    console.error("[Migrations] Fatal migration error:", err);
    process.exit(1);
  });
}
