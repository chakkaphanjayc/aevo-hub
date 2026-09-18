import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required to run SQL");

export const db = new SQL(databaseUrl);

async function runSqlCli() {
  const query = process.argv.slice(2).join(" ").trim();

  if (!query) {
    console.error("Usage: bun run scripts/sql.ts \"<SQL_STATEMENT>\"");
    process.exit(1);
  }

  console.log(`[SQL Runner] Executing:\n${query}\n`);

  try {
    const result = await db.unsafe(query);
    console.log(`[SQL Runner] Success. Rows returned: ${Array.isArray(result) ? result.length : "N/A"}`);
    if (Array.isArray(result) && result.length > 0) {
      console.table(result);
    } else if (result) {
      console.log(result);
    }
  } catch (err: any) {
    console.error("[SQL Runner] Error executing SQL:", err.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  runSqlCli();
}
