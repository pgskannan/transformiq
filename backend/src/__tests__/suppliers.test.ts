// TQ-037 (FR-SUP-001/FR-SUP-002): Supplier records link N:1 to exactly one BP; duplicate
// supplier-to-BP relationships are flagged. See db/migrations/0012_suppliers.sql and
// routes/suppliers.ts for the two-tier duplicate design (hard-blocked exact duplicate vs.
// soft-flagged same-source-system re-entry) this test proves.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string): Promise<string> {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Supplier Test", domain: "Direct Procurement", sourceSystem: "Legacy ERP", targetSystem: "SAP S/4HANA" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createBp(token: string, projectId: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/projects/${projectId}/business-partners`)
    .set("Authorization", `Bearer ${token}`)
    .send({ primaryName: "Acme Corp", bpType: "organization" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("Supplier entity model + BP linkage (TQ-037)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("links a supplier N:1 to a business partner", async () => {
    const tenantId = await makeTenant(app, `Supplier Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBp(token, projectId);

    const res = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-ERP" });
    expect(res.status).toBe(201);
    expect(res.body.business_partner_id).toBe(bpId);
    expect(res.body.duplicateWarning).toBeNull();
  });

  it("404s when the business partner doesn't exist", async () => {
    const tenantId = await makeTenant(app, `Supplier Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);

    const res = await request(app)
      .post(`/v1/business-partners/${randomUUID()}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-ERP" });
    expect(res.status).toBe(404);
  });

  it("hard-blocks an exact duplicate (same BP, same source system, same supplier number)", async () => {
    const tenantId = await makeTenant(app, `Supplier Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBp(token, projectId);

    const first = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-ERP" });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-ERP" });
    expect(duplicate.status).toBe(409);
  });

  it("allows the same supplier_number across different source systems (not a real duplicate)", async () => {
    const tenantId = await makeTenant(app, `Supplier Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBp(token, projectId);

    const erp = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-ERP" });
    expect(erp.status).toBe(201);

    const ariba = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-Ariba" });
    expect(ariba.status).toBe(201);
  });

  it("soft-flags (but does not block) a second supplier row from the same source system", async () => {
    const tenantId = await makeTenant(app, `Supplier Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBp(token, projectId);

    const first = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1001", sourceSystem: "SAP-ERP" });
    expect(first.status).toBe(201);
    expect(first.body.duplicateWarning).toBeNull();

    // A different supplier_number, same source system — legitimately possible (a reissued
    // code), but suspicious enough to flag for a steward to look at.
    const second = await request(app)
      .post(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ supplierNumber: "V-1002", sourceSystem: "SAP-ERP" });
    expect(second.status).toBe(201);
    expect(second.body.duplicateWarning).toMatch(/SAP-ERP/);

    const list = await request(app)
      .get(`/v1/business-partners/${bpId}/suppliers`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.suppliers).toHaveLength(2);
    expect(list.body.duplicateSourceSystems).toEqual(["SAP-ERP"]);
  });
});
