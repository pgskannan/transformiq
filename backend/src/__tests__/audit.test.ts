// TQ-015: proves append-only audit_events using the app's OWN Kysely connection (i.e. the
// exact DB role and client the running server uses), not just a raw psql session. If
// DATABASE_URL in .env / CI ever gets pointed back at the schema-owning role by mistake,
// this test is what catches it.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { db, closeDb, withTenant } from "../lib/db";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

describe("audit_events append-only enforcement (TQ-015)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("recordAuditEvent() succeeds for project.created", async () => {
    const tenantId = await makeTenant(app, `Audit Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);

    const created = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Audited Project",
        domain: "Direct Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP S/4HANA",
      });
    expect(created.status).toBe(201);

    // Reading audit_events is also RLS-scoped (see db/migrations/0002_enable_rls.sql), so
    // this goes through withTenant() same as any other tenant-scoped read would.
    const events = await withTenant(tenantId, (trx) =>
      trx.selectFrom("audit_events").selectAll().where("entity_id", "=", created.body.id).execute()
    );
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("project.created");
    expect(events[0].tenant_id).toBe(tenantId);
  });

  it("the app's own DB connection cannot UPDATE or DELETE audit_events", async () => {
    const tenantId = await makeTenant(app, `Audit Tamper Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);

    const created = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Tamper Target",
        domain: "Direct Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP S/4HANA",
      });
    expect(created.status).toBe(201);

    await expect(
      db
        .updateTable("audit_events")
        .set({ action: "tampered" })
        .where("entity_id", "=", created.body.id)
        .execute()
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.deleteFrom("audit_events").where("entity_id", "=", created.body.id).execute()
    ).rejects.toThrow(/permission denied/i);
  });
});
