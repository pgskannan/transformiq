// Kysely database client + the tenant-isolation helper described in
// docs/adr/0002-gcp-architecture-and-tenancy.md.
//
// withTenant() is the ONLY sanctioned way to run a tenant-scoped query. It opens a
// transaction, sets the Postgres session variable app.tenant_id (which the RLS policies in
// db/migrations/0002_enable_rls.sql key off), and runs your callback inside it. There is no
// "trusted" shortcut that skips this — see AGENTS.md Do-Not-Do rule #7 (never collapse
// tenant boundaries) and the Database Rules section.

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { DB } from "../../db/types";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Run `fn` with Postgres RLS scoped to `tenantId` for the duration of one transaction.
 * Every route handler touching tenant-scoped tables (users, projects, policies,
 * audit_events) must go through this.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (trx: Kysely<DB>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}
