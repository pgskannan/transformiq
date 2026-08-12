// Minimal, dependency-light migration runner. Applies db/migrations/*.sql files in
// filename order, tracking what's already applied in a _migrations table. Each file runs
// inside a transaction. No native binaries, no code generation magic — just SQL.
//
// Usage: npm run db:migrate

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Client } from "pg";
import "dotenv/config";

async function main() {
  // Migrations need DDL/role-management privilege the runtime app role deliberately does
  // not have (see 0004_least_privilege_app_role.sql) — run them as the schema-owning role,
  // not as transformiq_app. Falls back to DATABASE_URL so a single-role setup (e.g. before
  // 0004 has ever run) still works.
  const databaseUrl = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("MIGRATIONS_DATABASE_URL (or DATABASE_URL) is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = join(__dirname, "migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows: applied } = await client.query<{ filename: string }>(
      "SELECT filename FROM _migrations"
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    let appliedCount = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      console.log(`apply ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log(
      appliedCount === 0
        ? "Database already up to date."
        : `Applied ${appliedCount} migration(s).`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
