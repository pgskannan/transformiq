// Integration test proving the requireAuth -> attachTenant -> withTenant chain actually
// enforces tenant isolation through the HTTP layer, on a real Postgres instance (not
// mocked). Requires DATABASE_URL to point at a migrated database — see jest.config.js /
// README "Verification".
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { db, closeDb } from "../lib/db";
import { issueDevToken } from "../middleware/auth";

const app = createApp();

async function makeTenant(name: string) {
  const res = await request(app).post("/v1/tenants").send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function tokenFor(tenantId: string) {
  return issueDevToken({ tenantId, email: `user-${randomUUID()}@example.com`, role: "STEWARD" });
}

describe("tenant isolation (real Postgres + RLS)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("a tenant only ever sees its own projects", async () => {
    const tenantA = await makeTenant(`Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(`Tenant B ${randomUUID()}`);

    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);

    const createRes = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        name: "A's Procurement Cleanup",
        domain: "Indirect Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP Ariba",
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.tenant_id).toBe(tenantA);

    const listAsA = await request(app)
      .get("/v1/projects")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(listAsA.status).toBe(200);
    expect(listAsA.body.projects).toHaveLength(1);
    expect(listAsA.body.projects[0].name).toBe("A's Procurement Cleanup");

    const listAsB = await request(app)
      .get("/v1/projects")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body.projects).toHaveLength(0);
  });

  it("rejects requests with no auth token", async () => {
    const res = await request(app).get("/v1/projects");
    expect(res.status).toBe(401);
  });

  it("RLS rejects a write that forgets to go through withTenant(), even from app code", async () => {
    const tenantId = await makeTenant(`Tenant RLS-check ${randomUUID()}`);

    // withTenant() is deliberately NOT used here, to prove RLS is a real backstop and not
    // just a convention: with no app.tenant_id set on this connection, Postgres itself
    // refuses the insert rather than silently accepting an unscoped row.
    await expect(
      db
        .insertInto("projects")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          name: "Should never be written without tenant context",
          domain: "Direct Procurement",
          source_system: "Legacy ERP",
          target_system: "SAP S/4HANA",
          owner_user_id: "seed-script",
          updated_at: new Date(),
        })
        .execute()
    ).rejects.toThrow(/row-level security/i);
  });
});
