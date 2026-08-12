// RBAC (TQ-011) acceptance test: a user with the view-only role gets 403 on modify/approve/
// export/admin routes. Run against the real app + real Postgres, not mocked middleware.
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

describe("RBAC", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("VIEWER can list and read but cannot create or modify projects", async () => {
    const tenantId = await makeTenant(app, `RBAC Tenant ${randomUUID()}`);
    const viewerToken = tokenFor(tenantId, "VIEWER");
    const stewardToken = tokenFor(tenantId, "STEWARD");

    const createAsViewer = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({
        name: "Should be rejected",
        domain: "Direct Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP S/4HANA",
      });
    expect(createAsViewer.status).toBe(403);

    // Seed a real project as STEWARD (who has modify) so we can prove VIEWER can read it.
    const created = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${stewardToken}`)
      .send({
        name: "Steward-created project",
        domain: "Direct Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP S/4HANA",
      });
    expect(created.status).toBe(201);

    const listAsViewer = await request(app)
      .get("/v1/projects")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(listAsViewer.status).toBe(200);
    expect(listAsViewer.body.projects).toHaveLength(1);

    const patchAsViewer = await request(app)
      .patch(`/v1/projects/${created.body.id}`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "Hijacked by viewer" });
    expect(patchAsViewer.status).toBe(403);
  });

  it("rejects an unrecognized role outright (fails closed, not open)", async () => {
    const tenantId = await makeTenant(app, `RBAC Tenant ${randomUUID()}`);
    const bogusToken = tokenFor(tenantId, "NOT_A_REAL_ROLE");

    const res = await request(app)
      .post("/v1/projects")
      .set("Authorization", `Bearer ${bogusToken}`)
      .send({
        name: "Should be rejected",
        domain: "Direct Procurement",
        sourceSystem: "Legacy ERP",
        targetSystem: "SAP S/4HANA",
      });
    expect(res.status).toBe(403);
  });
});
