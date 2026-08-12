// Integration test proving the requireAuth -> attachTenant -> withTenant chain actually
// enforces tenant isolation through the HTTP layer, on a real Postgres instance (not
// mocked). Requires DATABASE_URL to point at a migrated database — see jest.config.js /
// README "Verification".
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { db, closeDb } from "../lib/db";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

describe("tenant isolation (real Postgres + RLS)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("a tenant only ever sees its own projects", async () => {
    const tenantA = await makeTenant(app, `Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `Tenant B ${randomUUID()}`);

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
    const projectId = createRes.body.id as string;

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

    // IDOR check: tenant B knows tenant A's real project ID (e.g. guessed, leaked, or
    // enumerated) and tries to fetch it directly by ID rather than via list. RLS must make
    // it look like it simply doesn't exist — a 404, not a 403 (which would confirm the ID
    // is valid and belongs to someone else) and not a 200 (which would leak the data).
    const getAsB = await request(app)
      .get(`/v1/projects/${projectId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(getAsB.status).toBe(404);

    const getAsA = await request(app)
      .get(`/v1/projects/${projectId}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(getAsA.status).toBe(200);
    expect(getAsA.body.id).toBe(projectId);

    // Same check against the mutation path: tenant B must not be able to PATCH tenant A's
    // project, even though the request is otherwise well-formed and authorized for B's own data.
    const patchAsB = await request(app)
      .patch(`/v1/projects/${projectId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ name: "Hijacked" });
    expect(patchAsB.status).toBe(404);

    const afterHijackAttempt = await request(app)
      .get(`/v1/projects/${projectId}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(afterHijackAttempt.body.name).toBe("A's Procurement Cleanup"); // unchanged
  });

  it("rejects requests with no auth token", async () => {
    const res = await request(app).get("/v1/projects");
    expect(res.status).toBe(401);
  });

  it("rejects tenant creation with no or wrong platform admin key", async () => {
    const noKey = await request(app).post("/v1/tenants").send({ name: "No Key Co" });
    expect(noKey.status).toBe(403);

    const wrongKey = await request(app)
      .post("/v1/tenants")
      .set("x-platform-admin-key", "wrong-key")
      .send({ name: "Wrong Key Co" });
    expect(wrongKey.status).toBe(403);
  });

  it("IDOR check: dataset endpoints also 404 (not 403/200) across tenants", async () => {
    const tenantA = await makeTenant(app, `Dataset Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `Dataset Tenant B ${randomUUID()}`);
    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);

    const project = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        name: "A's Dataset Project",
        domain: "Direct Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP S/4HANA",
      });
    expect(project.status).toBe(201);
    const projectId = project.body.id as string;

    // B tries to upload a dataset into A's project by guessing/knowing the project ID.
    const uploadAsB = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({
        datasetName: "hijack",
        filename: "hijack.csv",
        contentBase64: Buffer.from("x").toString("base64"),
      });
    expect(uploadAsB.status).toBe(404);

    const uploadAsA = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        datasetName: "suppliers",
        filename: "suppliers.csv",
        contentBase64: Buffer.from("supplier_id\n1\n").toString("base64"),
      });
    expect(uploadAsA.status).toBe(201);
    const datasetId = uploadAsA.body.dataset.id as string;

    // B lists datasets scoped to A's project — RLS-filtered project_id match yields nothing,
    // not an error, so this is a 200 with an empty array rather than a 403/404.
    const listAsB = await request(app)
      .get(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body.datasets).toHaveLength(0);

    // B tries to read version history for a dataset ID it knows belongs to A.
    const versionsAsB = await request(app)
      .get(`/v1/datasets/${datasetId}/versions`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(versionsAsB.status).toBe(200);
    expect(versionsAsB.body.versions).toHaveLength(0); // RLS-invisible, not an error

    const versionsAsA = await request(app)
      .get(`/v1/datasets/${datasetId}/versions`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(versionsAsA.status).toBe(200);
    expect(versionsAsA.body.versions).toHaveLength(1);
  });

  it("RLS rejects a write that forgets to go through withTenant(), even from app code", async () => {
    const tenantId = await makeTenant(app, `Tenant RLS-check ${randomUUID()}`);

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
