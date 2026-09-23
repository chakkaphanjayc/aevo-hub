import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "bun";

const hubRoot = resolve(import.meta.dir, "..");
const coreRoot = resolve(hubRoot, "..", "aevo-core-api");
const coreProject = resolve(coreRoot, "src", "Aevo.CoreApi.Migrator", "Aevo.CoreApi.Migrator.csproj");

function readEnvironmentFile(file: string): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
      if (!match) continue;
      let value = match[2] ?? "";
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

const hubEnvironment = readEnvironmentFile(resolve(hubRoot, ".env"));
const databaseUrl = process.env.AEVO_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || hubEnvironment.DATABASE_URL?.trim();
if (!databaseUrl && !process.argv.includes("--dry-run")) {
  throw new Error("AEVO_DATABASE_URL or DATABASE_URL is required. Set it in aevo-hub/.env for development.");
}

const environment = {
  ...process.env,
  ...(databaseUrl ? { AEVO_DATABASE_URL: databaseUrl } : {}),
  AEVO_ENVIRONMENT: process.env.AEVO_ENVIRONMENT?.trim() || "development"
};
const child = spawn([
  "dotnet",
  "run",
  "--project",
  coreProject,
  "--",
  ...process.argv.slice(2)
], {
  cwd: coreRoot,
  env: environment,
  stdout: "inherit",
  stderr: "inherit"
});

process.exit(await child.exited);
