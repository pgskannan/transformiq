// TQ-028 (FR-BP-001) HTTP-layer coverage: BP is modeled as a first-class canonical entity,
// with Address/Identifier/Relationship as genuine 1:N child records — proving that structural
// claim through real Postgres, plus RBAC/IDOR consistent with every other route in this repo.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string) {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "BP Test Project",
      domain: "Direct Procurement",
      sourceSystem: "Legacy ERP",
      targetSystem: "SAP S/4HANA",
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createBusinessPartner(token: string, projectId: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/v1/projects/${projectId}/business-partners`)
    .set("Authorization", `Bearer ${token}`)
    .send({ primaryName: "Acme Corp", bpType: "organization", ...body });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("Business Partner canonical entity (TQ-028)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("creates a BP as a first-class entity, defaulting bp_type to 'unknown' when not specified", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/business-partners`)
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryName: "Wayne Enterprises" });
    expect(res.status).toBe(201);
    expect(res.body.primary_name).toBe("Wayne Enterprises");
    expect(res.body.bp_type).toBe("unknown");
    expect(res.body.project_id).toBe(projectId);
  });

  it("rejects an unrecognized bp_type", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/business-partners`)
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryName: "Acme Corp", bpType: "not-a-real-type" });
    expect(res.status).toBe(400);
  });

  it("supports multiple addresses per BP — a genuine 1:N relationship", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBusinessPartner(token, projectId);

    const billing = await request(app)
      .post(`/v1/business-partners/${bpId}/addresses`)
      .set("Authorization", `Bearer ${token}`)
      .send({ addressType: "billing", line1: "1 Infinite Loop", city: "Cupertino", countryCode: "US", isPrimary: true });
    expect(billing.status).toBe(201);

    const shipping = await request(app)
      .post(`/v1/business-partners/${bpId}/addresses`)
      .set("Authorization", `Bearer ${token}`)
      .send({ addressType: "shipping", line1: "500 5th Ave", city: "New York", countryCode: "US" });
    expect(shipping.status).toBe(201);

    const getRes = await request(app)
      .get(`/v1/business-partners/${bpId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.addresses).toHaveLength(2);
    const types = (getRes.body.addresses as Array<Record<string, unknown>>).map((a) => a.address_type);
    expect(types).toContain("billing");
    expect(types).toContain("shipping");
  });

  it("supports multiple identifiers per BP — a genuine 1:N relationship (FR-BP-005 crosswalks)", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBusinessPartner(token, projectId);

    const duns = await request(app)
      .post(`/v1/business-partners/${bpId}/identifiers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ identifierType: "duns", identifierValue: "123456789" });
    expect(duns.status).toBe(201);

    const vat = await request(app)
      .post(`/v1/business-partners/${bpId}/identifiers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ identifierType: "vat_number", identifierValue: "GB123456789", issuingAuthority: "HMRC" });
    expect(vat.status).toBe(201);

    const getRes = await request(app)
      .get(`/v1/business-partners/${bpId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.body.identifiers).toHaveLength(2);
    const types = (getRes.body.identifiers as Array<Record<string, unknown>>).map((i) => i.identifier_type);
    expect(types).toEqual(expect.arrayContaining(["duns", "vat_number"]));
  });

  it("supports relationships between two BPs — a genuine 1:N relationship (FR-BP-007)", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const parentId = await createBusinessPartner(token, projectId, { primaryName: "Global Holdings Inc" });
    const child1Id = await createBusinessPartner(token, projectId, { primaryName: "Acme US LLC" });
    const child2Id = await createBusinessPartner(token, projectId, { primaryName: "Acme EU GmbH" });

    const rel1 = await request(app)
      .post(`/v1/business-partners/${parentId}/relationships`)
      .set("Authorization", `Bearer ${token}`)
      .send({ relatedBusinessPartnerId: child1Id, relationshipType: "parent_of" });
    expect(rel1.status).toBe(201);

    const rel2 = await request(app)
      .post(`/v1/business-partners/${parentId}/relationships`)
      .set("Authorization", `Bearer ${token}`)
      .send({ relatedBusinessPartnerId: child2Id, relationshipType: "parent_of", provenance: "manual entry" });
    expect(rel2.status).toBe(201);

    const getRes = await request(app)
      .get(`/v1/business-partners/${parentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.body.relationships).toHaveLength(2);
    const relatedIds = (getRes.body.relationships as Array<Record<string, unknown>>).map(
      (r) => r.related_business_partner_id
    );
    expect(relatedIds).toEqual(expect.arrayContaining([child1Id, child2Id]));
  });

  it("rejects a self-referential relationship", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBusinessPartner(token, projectId);

    const res = await request(app)
      .post(`/v1/business-partners/${bpId}/relationships`)
      .set("Authorization", `Bearer ${token}`)
      .send({ relatedBusinessPartnerId: bpId, relationshipType: "parent_of" });
    expect(res.status).toBe(400);
  });

  it("rejects a relationship pointing at a business partner that doesn't exist", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const bpId = await createBusinessPartner(token, projectId);

    const res = await request(app)
      .post(`/v1/business-partners/${bpId}/relationships`)
      .set("Authorization", `Bearer ${token}`)
      .send({ relatedBusinessPartnerId: randomUUID(), relationshipType: "parent_of" });
    expect(res.status).toBe(400);
  });

  it("lists BPs scoped to their project", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    await createBusinessPartner(token, projectId, { primaryName: "Acme" });
    await createBusinessPartner(token, projectId, { primaryName: "Globex" });

    const res = await request(app)
      .get(`/v1/projects/${projectId}/business-partners`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.businessPartners).toHaveLength(2);
  });

  it("VIEWER can read BPs but cannot create one", async () => {
    const tenantId = await makeTenant(app, `BP Tenant ${randomUUID()}`);
    const stewardToken = tokenFor(tenantId, "STEWARD");
    const viewerToken = tokenFor(tenantId, "VIEWER");
    const projectId = await createProject(stewardToken);

    const viewerCreate = await request(app)
      .post(`/v1/projects/${projectId}/business-partners`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ primaryName: "Acme" });
    expect(viewerCreate.status).toBe(403);

    const bpId = await createBusinessPartner(stewardToken, projectId);
    const viewerRead = await request(app)
      .get(`/v1/business-partners/${bpId}`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(viewerRead.status).toBe(200);
  });

  it("IDOR check: a second tenant cannot create, read, or attach children to another tenant's business partner", async () => {
    const tenantA = await makeTenant(app, `BP Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `BP Tenant B ${randomUUID()}`);
    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);
    const projectId = await createProject(tokenA);

    const createAsB = await request(app)
      .post(`/v1/projects/${projectId}/business-partners`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ primaryName: "Hijack Inc" });
    expect(createAsB.status).toBe(404);

    const bpId = await createBusinessPartner(tokenA, projectId);

    const readAsB = await request(app)
      .get(`/v1/business-partners/${bpId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(readAsB.status).toBe(404);

    const addressAsB = await request(app)
      .post(`/v1/business-partners/${bpId}/addresses`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ addressType: "billing", line1: "hijacked" });
    expect(addressAsB.status).toBe(404);

    const listAsB = await request(app)
      .get(`/v1/projects/${projectId}/business-partners`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(listAsB.status).toBe(200); // RLS-filtered empty, not an error — the project itself is B's own 404 case
  });
});
