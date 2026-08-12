// TQ-024 (FR-PROF-001) HTTP-layer coverage: (a) profiling auto-triggers after a successful
// ingestion and its results become queryable, (b) the on-demand synchronous trigger works
// and correctly re-reads the immutable raw artifact end-to-end through real Postgres, (c)
// dimension scores are computed correctly against a known fixture, (d) tenant isolation/RLS
// holds for dataset_profiles/field_profiles, consistent with every other route in this repo.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { makeTenant, pollDatasetProfile, pollIngestionRun, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string) {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Profiling Test Project",
      domain: "Direct Procurement",
      sourceSystem: "Legacy ERP",
      targetSystem: "SAP S/4HANA",
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Deliberately known/hand-computed fixture so the dimension-score assertions below are
// checking real arithmetic, not just "some number came back":
//  - supplier_id: 4/4 non-empty, all integers, all distinct -> completeness 1, validity 1,
//    conformity 1 (strict-integer regex matches all), uniqueness 1.
//  - name: 4/4 non-empty, all strings -> completeness 1; one value has leading/trailing
//    whitespace ("  Globex  ") so it fails strict conformity (raw === raw.trim()) though it
//    still counts as "valid" (any non-empty string is a valid string) -> completeness 1,
//    validity 1, conformity 3/4 = 0.75.
//  - signup_date: 3/4 non-empty (one blank) -> completeness 3/4 = 0.75. Of the 3 non-empty,
//    2 are ISO yyyy-mm-dd and 1 is "03/02/2024" (still classifies as "date" per the looser
//    validity rules, but fails the strict ISO conformity regex) -> validity 3/3 = 1 (of
//    non-empty), conformity 2/3.
const FIXTURE_CSV = [
  "supplier_id,name,signup_date",
  "1,Acme Corp,2024-01-15",
  "2,  Globex  ,2024-03-02",
  '3,Initech,03/02/2024',
  "4,BadCo,",
].join("\n");

async function ingestFixture(token: string, projectId: string) {
  const res = await request(app)
    .post(`/v1/projects/${projectId}/ingestions`)
    .set("Authorization", `Bearer ${token}`)
    .field("datasetName", "suppliers")
    .attach("file", Buffer.from(FIXTURE_CSV, "utf8"), "suppliers.csv");
  expect(res.status).toBe(202);
  const runId = res.body.ingestionRun.id as string;
  const { body: run } = await pollIngestionRun(app, token, runId);
  expect(run.status).toBe("completed");
  return { runId, datasetVersionId: run.dataset_version_id as string, datasetId: res.body.dataset.id as string };
}

describe("Profiling (TQ-024)", () => {
  // closeDb() is called once, in the final describe block's afterAll below — calling it here
  // too would destroy the shared connection pool before the "Anomaly detection" describe
  // block (which runs after this one, same file) gets to use it.
  it("auto-triggers right after a successful ingestion, without any explicit profiling call", async () => {
    const tenantId = await makeTenant(app, `Profiling Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestFixture(token, projectId);

    // No POST /v1/profiling-runs call here at all — this proves the auto-chain from
    // lib/jobs/ingestionJob.ts actually enqueues and runs lib/jobs/profilingJob.ts.
    const { body } = await pollDatasetProfile(app, token, datasetVersionId);
    expect(body.profile).toBeTruthy();
    const profile = body.profile as Record<string, unknown>;
    expect(profile.dataset_version_id).toBe(datasetVersionId);
    expect(profile.row_count).toBe(4);
    expect(profile.column_count).toBe(3);
  });

  it("computes correct per-field dimension scores against a known fixture", async () => {
    const tenantId = await makeTenant(app, `Profiling Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestFixture(token, projectId);

    await pollDatasetProfile(app, token, datasetVersionId);
    const res = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const fields = res.body.fields as Array<Record<string, unknown>>;
    expect(fields).toHaveLength(3);
    const byName = Object.fromEntries(fields.map((f) => [f.column_name, f]));

    const supplierId = byName["supplier_id"];
    expect(supplierId.inferred_type).toBe("integer");
    expect(Number(supplierId.completeness)).toBeCloseTo(1, 5);
    expect(Number(supplierId.validity)).toBeCloseTo(1, 5);
    expect(Number(supplierId.conformity)).toBeCloseTo(1, 5);
    expect(Number(supplierId.uniqueness)).toBeCloseTo(1, 5);

    const name = byName["name"];
    expect(Number(name.completeness)).toBeCloseTo(1, 5);
    expect(Number(name.validity)).toBeCloseTo(1, 5);
    expect(Number(name.conformity)).toBeCloseTo(0.75, 5); // "  Globex  " fails strict trim check

    const signupDate = byName["signup_date"];
    expect(Number(signupDate.completeness)).toBeCloseTo(0.75, 5); // 3/4 non-empty
    expect(Number(signupDate.validity)).toBeCloseTo(1, 5); // all 3 non-empty values classify as date
    expect(Number(signupDate.conformity)).toBeCloseTo(2 / 3, 5); // only 2/3 are strict ISO yyyy-mm-dd

    // quality_score = mean(completeness, validity, conformity, consistency) — verify the
    // stored value matches that formula rather than trusting it blindly.
    const consistency = Number(signupDate.consistency);
    const expectedQualityScore =
      (Number(signupDate.completeness) + Number(signupDate.validity) + Number(signupDate.conformity) + consistency) /
      4;
    expect(Number(signupDate.quality_score)).toBeCloseTo(expectedQualityScore, 5);
  });

  it("on-demand trigger (POST /v1/profiling-runs) is synchronous — profile is queryable immediately, no polling needed", async () => {
    const tenantId = await makeTenant(app, `Profiling Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestFixture(token, projectId);

    // Let the auto-trigger finish first so this test is exercising re-profiling via the
    // on-demand path, not racing the auto-trigger.
    await pollDatasetProfile(app, token, datasetVersionId);

    const trigger = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId });
    expect(trigger.status).toBe(200);
    expect(trigger.body.profile.dataset_version_id).toBe(datasetVersionId);

    // Immediately queryable — no poll — proving the trigger really is synchronous.
    const getRes = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.profile.id).toBe(trigger.body.profile.id);
  });

  it("re-profiling replaces the prior profile rather than accumulating duplicate rows", async () => {
    const tenantId = await makeTenant(app, `Profiling Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestFixture(token, projectId);
    await pollDatasetProfile(app, token, datasetVersionId);

    const first = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId });
    const second = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId });
    expect(second.status).toBe(200);
    expect(second.body.profile.id).not.toBe(first.body.profile.id); // old row deleted, new one inserted

    const getRes = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.body.fields).toHaveLength(3); // not 6 — no duplicate accumulation
  });

  it("returns 404 for a dataset version that doesn't exist or has no profile yet", async () => {
    const tenantId = await makeTenant(app, `Profiling Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);

    const trigger = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId: randomUUID() });
    expect(trigger.status).toBe(404);

    const getRes = await request(app)
      .get(`/v1/dataset-versions/${randomUUID()}/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(404);
  });

  it("VIEWER can read profiles but cannot trigger on-demand re-profiling", async () => {
    const tenantId = await makeTenant(app, `Profiling Tenant ${randomUUID()}`);
    const stewardToken = tokenFor(tenantId, "STEWARD");
    const viewerToken = tokenFor(tenantId, "VIEWER");
    const projectId = await createProject(stewardToken);
    const { datasetVersionId } = await ingestFixture(stewardToken, projectId);
    await pollDatasetProfile(app, stewardToken, datasetVersionId);

    const viewerTrigger = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ datasetVersionId });
    expect(viewerTrigger.status).toBe(403);

    const viewerRead = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(viewerRead.status).toBe(200);
  });

  it("IDOR check: a second tenant cannot trigger or read another tenant's dataset profile", async () => {
    const tenantA = await makeTenant(app, `Profiling Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `Profiling Tenant B ${randomUUID()}`);
    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);
    const projectId = await createProject(tokenA);
    const { datasetVersionId } = await ingestFixture(tokenA, projectId);
    await pollDatasetProfile(app, tokenA, datasetVersionId);

    const triggerAsB = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ datasetVersionId });
    expect(triggerAsB.status).toBe(404); // RLS-filtered: version invisible to tenant B

    const readAsB = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(readAsB.status).toBe(404); // RLS-filtered: no profile visible either
  });
});

// TQ-025 (FR-PROF-002): anomaly detection rides along in the same profiling job (see
// lib/jobs/profilingJob.ts), so this fixture is deliberately seeded with one instance of
// each of the four anomaly types — the same DoD wording ("known-seeded anomalies in a test
// fixture are all flagged") the unit tests in lib/anomalies/__tests__/engine.test.ts already
// cover in isolation; this proves the same thing end-to-end through the real HTTP + DB path.
const ANOMALY_FIXTURE_CSV = [
  "supplier_id,region,credit_limit,notes",
  "1,EMEA,100.00,ok",
  "2,APAC,150.00,ok",
  "3,EMEA,120.00,ok",
  "4,APAC,N/A,ok", // seeded: sentinel placeholder -> suspicious_pattern
  "5,EMEA,130.00,", // seeded: blank in an otherwise-full column -> null
  "6,APAC,not-a-number,ok", // seeded: malformed_value
  "7,EMEA,9999999.00,ok", // seeded: numeric outlier
  "8,APAC,140.00,ok",
].join("\n");

async function ingestAnomalyFixture(token: string, projectId: string) {
  const res = await request(app)
    .post(`/v1/projects/${projectId}/ingestions`)
    .set("Authorization", `Bearer ${token}`)
    .field("datasetName", "anomaly-suppliers")
    .attach("file", Buffer.from(ANOMALY_FIXTURE_CSV, "utf8"), "anomaly-suppliers.csv");
  expect(res.status).toBe(202);
  const runId = res.body.ingestionRun.id as string;
  const { body: run } = await pollIngestionRun(app, token, runId);
  expect(run.status).toBe("completed");
  return { datasetVersionId: run.dataset_version_id as string };
}

describe("Anomaly detection (TQ-025)", () => {
  // closeDb() is called once, in the final describe block's afterAll below.
  it("auto-triggers alongside profiling and flags all four seeded anomaly types", async () => {
    const tenantId = await makeTenant(app, `Anomaly Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestAnomalyFixture(token, projectId);

    // Poll on the profile (anomaly detection completes in the same transaction/job) rather
    // than polling the anomalies endpoint directly — GET .../anomalies returns 200 with an
    // empty array even before the job has run, so it can't be used as a "is it done yet"
    // signal the way GET .../profile's 404-until-ready can.
    await pollDatasetProfile(app, token, datasetVersionId);

    const res = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/anomalies`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const anomalies = res.body.anomalies as Array<Record<string, unknown>>;
    const types = new Set(anomalies.map((a) => a.anomaly_type));
    expect(types.has("null")).toBe(true);
    expect(types.has("malformed_value")).toBe(true);
    expect(types.has("outlier")).toBe(true);
    expect(types.has("suspicious_pattern")).toBe(true);

    expect(anomalies).toContainEqual(
      expect.objectContaining({ row_number: 5, column_name: "notes", anomaly_type: "null" })
    );
    expect(anomalies).toContainEqual(
      expect.objectContaining({ row_number: 6, column_name: "credit_limit", anomaly_type: "malformed_value" })
    );
    expect(anomalies).toContainEqual(
      expect.objectContaining({ row_number: 7, column_name: "credit_limit", anomaly_type: "outlier" })
    );
    expect(anomalies).toContainEqual(
      expect.objectContaining({ row_number: 4, column_name: "credit_limit", anomaly_type: "suspicious_pattern" })
    );

    // The on-demand trigger's response also reports the count, independent of the GET list.
    const trigger = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId });
    expect(trigger.status).toBe(200);
    expect(trigger.body.anomalyCount).toBe(anomalies.length);
  });

  it("?type= filters to a single anomaly type", async () => {
    const tenantId = await makeTenant(app, `Anomaly Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestAnomalyFixture(token, projectId);
    await pollDatasetProfile(app, token, datasetVersionId);

    const res = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/anomalies?type=outlier`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const anomalies = res.body.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies.every((a) => a.anomaly_type === "outlier")).toBe(true);
  });

  it("rejects an unrecognized ?type= value with 400", async () => {
    const tenantId = await makeTenant(app, `Anomaly Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);

    const res = await request(app)
      .get(`/v1/dataset-versions/${randomUUID()}/anomalies?type=not-a-real-type`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("returns 200 with an empty array (not 404) for a version with no anomalies", async () => {
    const tenantId = await makeTenant(app, `Anomaly Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    // Deliberately clean: uniform single-token values (every value shares the exact same
    // structural "shape", so dominance == 1 and the shape-break check has nothing to flag —
    // see lib/anomalies/engine.ts), no blanks, no sentinels, and small integers with a
    // near-zero IQR spread so nothing clears the outlier fences either. (FIXTURE_CSV above
    // is NOT this clean — "Acme Corp" is a two-word value among single-word peers, which
    // legitimately breaks the dominant shape; that's a real anomaly, not a fixture bug.)
    const CLEAN_CSV = ["id,category", "1,Alpha", "2,Beta", "3,Gamma", "4,Delta"].join("\n");
    const upload = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "clean-fixture")
      .attach("file", Buffer.from(CLEAN_CSV, "utf8"), "clean.csv");
    expect(upload.status).toBe(202);
    const { body: run } = await pollIngestionRun(app, token, upload.body.ingestionRun.id as string);
    expect(run.status).toBe("completed");
    const datasetVersionId = run.dataset_version_id as string;
    await pollDatasetProfile(app, token, datasetVersionId);

    const res = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/anomalies`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.anomalies).toEqual([]);
  });

  it("re-profiling replaces the prior anomaly set rather than accumulating duplicates", async () => {
    const tenantId = await makeTenant(app, `Anomaly Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const { datasetVersionId } = await ingestAnomalyFixture(token, projectId);
    await pollDatasetProfile(app, token, datasetVersionId);

    const first = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/anomalies`)
      .set("Authorization", `Bearer ${token}`);
    const firstCount = (first.body.anomalies as unknown[]).length;

    await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId });

    const second = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/anomalies`)
      .set("Authorization", `Bearer ${token}`);
    expect((second.body.anomalies as unknown[]).length).toBe(firstCount); // not doubled
  });

  it("IDOR check: a second tenant cannot read another tenant's anomalies", async () => {
    const tenantA = await makeTenant(app, `Anomaly Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `Anomaly Tenant B ${randomUUID()}`);
    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);
    const projectId = await createProject(tokenA);
    const { datasetVersionId } = await ingestAnomalyFixture(tokenA, projectId);
    await pollDatasetProfile(app, tokenA, datasetVersionId);

    const readAsB = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/anomalies`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(readAsB.status).toBe(200); // RLS-filtered empty result, not an error (IDOR pattern used elsewhere)
    expect(readAsB.body.anomalies).toEqual([]);
  });
});

// TQ-026 (FR-PROF-003): semantic type inference rides along in the same profiling job (see
// lib/jobs/profilingJob.ts) and lands on field_profiles.semantic_type. lib/semantics/
// __tests__/engine.test.ts already covers the classifier's accuracy in isolation (including
// the DoD's golden-fixture-set accuracy check) — this proves the same classification reaches
// a real HTTP response through real Postgres.
const SEMANTIC_FIXTURE_CSV = [
  "supplier_id,contact_email,credit_limit,status",
  "1,ap@acme.com,10000.00,active",
  "2,billing@globex.com,25000.00,active",
  "3,finance@initech.com,5000.00,inactive",
].join("\n");

describe("Semantic field type inference (TQ-026)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("populates semantic_type on field_profiles via the auto-triggered profiling job", async () => {
    const tenantId = await makeTenant(app, `Semantic Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "semantic-suppliers")
      .attach("file", Buffer.from(SEMANTIC_FIXTURE_CSV, "utf8"), "semantic-suppliers.csv");
    expect(res.status).toBe(202);
    const { body: run } = await pollIngestionRun(app, token, res.body.ingestionRun.id as string);
    expect(run.status).toBe("completed");
    const datasetVersionId = run.dataset_version_id as string;

    await pollDatasetProfile(app, token, datasetVersionId);
    const profileRes = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(profileRes.status).toBe(200);

    const fields = profileRes.body.fields as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(fields.map((f) => [f.column_name, f]));

    expect(byName["supplier_id"].semantic_type).toBe("identifier");
    expect(byName["contact_email"].semantic_type).toBe("email");
    expect(byName["credit_limit"].semantic_type).toBe("currency_amount");
    // "status" has no semantic signal — must be null, not a guessed value.
    expect(byName["status"].semantic_type).toBeNull();
  });
});
