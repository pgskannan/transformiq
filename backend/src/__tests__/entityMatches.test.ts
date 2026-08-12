// TQ-034/035 (FR-DUP-005/FR-DUP-006): the four-state decision workflow and the
// unauthorized-auto-merge guardrail, against real Postgres + real RBAC roles.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb, withTenant } from "../lib/db";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string): Promise<string> {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Entity Match Test", domain: "Direct Procurement", sourceSystem: "Legacy ERP", targetSystem: "SAP S/4HANA" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createBp(token: string, projectId: string, primaryName: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/projects/${projectId}/business-partners`)
    .set("Authorization", `Bearer ${token}`)
    .send({ primaryName, bpType: "organization" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Sets up two exact-duplicate BPs (shared identifier) and runs matching, returning the match id. */
async function setupOneMatch(token: string, projectId: string): Promise<string> {
  const bpA = await createBp(token, projectId, "Acme Corp");
  const bpB = await createBp(token, projectId, "Acme Corporation");
  for (const bpId of [bpA, bpB]) {
    const res = await request(app)
      .post(`/v1/business-partners/${bpId}/identifiers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ identifierType: "tax_id", identifierValue: "12-3456789" });
    expect(res.status).toBe(201);
  }
  const run = await request(app)
    .post(`/v1/projects/${projectId}/entity-matches/run`)
    .set("Authorization", `Bearer ${token}`)
    .send();
  expect(run.status).toBe(200);
  expect(run.body.candidatesFound).toBeGreaterThanOrEqual(1);

  const list = await request(app)
    .get(`/v1/projects/${projectId}/entity-matches`)
    .set("Authorization", `Bearer ${token}`);
  expect(list.body.matches.length).toBeGreaterThanOrEqual(1);
  return list.body.matches[0].id as string;
}

describe("Entity match decision workflow (TQ-034)", () => {
  it("defaults a freshly-detected candidate to needs_review", async () => {
    const tenantId = await makeTenant(app, `EM Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId, "STEWARD");
    const projectId = await createProject(token);
    const matchId = await setupOneMatch(token, projectId);

    const res = await request(app)
      .get(`/v1/entity-matches/${matchId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.match.decision).toBe("needs_review");
    expect(res.body.match.evidence.signals.length).toBeGreaterThan(0);
    // Both sides + linked supplier "roles" (empty here, but the shape must be present).
    expect(res.body.businessPartner.primary_name).toBeDefined();
    expect(res.body.candidateBusinessPartner.primary_name).toBeDefined();
    expect(Array.isArray(res.body.businessPartner.suppliers)).toBe(true);
  });

  it.each(["keep_separate", "reject", "needs_review"] as const)(
    "a STEWARD can record a '%s' decision, persisted with the deciding user",
    async (decision) => {
      const tenantId = await makeTenant(app, `EM Tenant ${randomUUID()}`);
      const token = tokenFor(tenantId, "STEWARD");
      const projectId = await createProject(token);
      const matchId = await setupOneMatch(token, projectId);

      const res = await request(app)
        .patch(`/v1/entity-matches/${matchId}/decision`)
        .set("Authorization", `Bearer ${token}`)
        .send({ decision });
      expect(res.status).toBe(200);
      expect(res.body.decision).toBe(decision);
      expect(res.body.decided_by_user_id).toBeTruthy();
      expect(res.body.decided_at).toBeTruthy();
    }
  );

  it("rejects an unrecognized decision value", async () => {
    const tenantId = await makeTenant(app, `EM Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId, "STEWARD");
    const projectId = await createProject(token);
    const matchId = await setupOneMatch(token, projectId);

    const res = await request(app)
      .patch(`/v1/entity-matches/${matchId}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "delete_forever" });
    expect(res.status).toBe(400);
  });

  it("an APPROVER can record a 'merge' decision", async () => {
    const tenantId = await makeTenant(app, `EM Tenant ${randomUUID()}`);
    const stewardToken = tokenFor(tenantId, "STEWARD");
    const approverToken = tokenFor(tenantId, "APPROVER");
    const projectId = await createProject(stewardToken);
    const matchId = await setupOneMatch(stewardToken, projectId);

    const res = await request(app)
      .patch(`/v1/entity-matches/${matchId}/decision`)
      .set("Authorization", `Bearer ${approverToken}`)
      .send({ decision: "merge" });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("merge");
  });

  it("re-running the matcher after a decision does not overwrite it", async () => {
    const tenantId = await makeTenant(app, `EM Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId, "STEWARD");
    const projectId = await createProject(token);
    const matchId = await setupOneMatch(token, projectId);

    const decide = await request(app)
      .patch(`/v1/entity-matches/${matchId}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "reject" });
    expect(decide.status).toBe(200);

    const rerun = await request(app)
      .post(`/v1/projects/${projectId}/entity-matches/run`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(rerun.status).toBe(200);
    expect(rerun.body.skippedAlreadyDecided).toBeGreaterThanOrEqual(1);

    const after = await request(app)
      .get(`/v1/entity-matches/${matchId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(after.body.match.decision).toBe("reject");
  });
});

describe("Unauthorized-auto-merge guardrail (TQ-035, FR-DUP-006, Do-Not-Do #3)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("rejects an unauthenticated decision attempt entirely", async () => {
    const res = await request(app).patch(`/v1/entity-matches/${randomUUID()}/decision`).send({ decision: "merge" });
    expect(res.status).toBe(401);
  });

  it("rejects a STEWARD's merge attempt (insufficient permission) and audits the denial", async () => {
    const tenantId = await makeTenant(app, `Guardrail Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId, "STEWARD");
    const projectId = await createProject(token);
    const matchId = await setupOneMatch(token, projectId);

    const res = await request(app)
      .patch(`/v1/entity-matches/${matchId}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "merge" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/approve/i);

    // The decision must be untouched — still needs_review, not silently merged.
    const after = await request(app)
      .get(`/v1/entity-matches/${matchId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(after.body.match.decision).toBe("needs_review");

    // And the denial itself must be a real, persisted audit event — not just an app log line.
    // No Audit Explorer endpoint exists yet (that's TQ-071, Sprint 8), so this reads
    // audit_events directly through the app's own connection, same pattern as
    // __tests__/audit.test.ts (TQ-015).
    const events = await withTenant(tenantId, (trx) =>
      trx.selectFrom("audit_events").selectAll().where("entity_id", "=", matchId).execute()
    );
    expect(events.some((e) => e.action === "entity_match.merge_denied")).toBe(true);
    const denial = events.find((e) => e.action === "entity_match.merge_denied")!;
    expect(denial.new_value).toMatchObject({ attemptedDecision: "merge", role: "STEWARD" });
  });

  it("a VIEWER cannot record any decision at all (fails closed below STEWARD too)", async () => {
    const tenantId = await makeTenant(app, `Guardrail Tenant ${randomUUID()}`);
    const stewardToken = tokenFor(tenantId, "STEWARD");
    const viewerToken = tokenFor(tenantId, "VIEWER");
    const projectId = await createProject(stewardToken);
    const matchId = await setupOneMatch(stewardToken, projectId);

    const res = await request(app)
      .patch(`/v1/entity-matches/${matchId}/decision`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ decision: "keep_separate" });
    expect(res.status).toBe(403);
  });
});
