// TQ-027 (FR-PROF-004) HTTP-layer coverage: field-level (field_profiles.quality_score) and
// dataset-version-level (dataset_profiles.overall_quality_score) rollups already exist from
// TQ-024 — this covers what's new here: the project-level rollup, and the DoD's "quality
// score recomputes correctly after a fixture is remediated" claim, scoped pragmatically since
// real remediation doesn't exist yet (see lib/profiling/projectQualityScore.ts's header
// comment for the full rationale) as "recomputes correctly across dataset versions when the
// underlying data changes."
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { makeTenant, pollDatasetProfile, pollIngestionRun, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string, name = "Quality Score Test Project") {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name,
      domain: "Direct Procurement",
      sourceSystem: "Legacy ERP",
      targetSystem: "SAP S/4HANA",
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function ingestAndProfile(token: string, projectId: string, datasetName: string, csv: string) {
  const res = await request(app)
    .post(`/v1/projects/${projectId}/ingestions`)
    .set("Authorization", `Bearer ${token}`)
    .field("datasetName", datasetName)
    .attach("file", Buffer.from(csv, "utf8"), `${datasetName}.csv`);
  expect(res.status).toBe(202);
  const { body: run } = await pollIngestionRun(app, token, res.body.ingestionRun.id as string);
  expect(run.status).toBe("completed");
  const datasetVersionId = run.dataset_version_id as string;
  const { body: profileBody } = await pollDatasetProfile(app, token, datasetVersionId);
  const overallQualityScore = Number(
    (profileBody.profile as Record<string, unknown>).overall_quality_score
  );
  return { datasetVersionId, overallQualityScore };
}

// Deliberately dirty: two blank cells in an otherwise-complete-looking sheet, one malformed
// value, one non-conformant date -> a real, unambiguously-lower quality score.
const DIRTY_CSV = [
  "supplier_id,name,signup_date",
  "1,Acme Corp,2024-01-15",
  "2,,2024-03-02",
  "3,Initech,not-a-date",
  "4,BadCo,",
].join("\n");

// Same shape, remediated: every field filled in correctly and conformant.
const CLEAN_CSV = [
  "supplier_id,name,signup_date",
  "1,Acme Corp,2024-01-15",
  "2,Globex,2024-03-02",
  "3,Initech,2024-06-01",
  "4,BadCo,2024-07-10",
].join("\n");

describe("Quality score calculation (TQ-027)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("a new, cleaner version of the same dataset scores higher than the dirty version it replaces", async () => {
    const tenantId = await makeTenant(app, `Quality Score Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const dirty = await ingestAndProfile(token, projectId, "suppliers", DIRTY_CSV);
    const clean = await ingestAndProfile(token, projectId, "suppliers", CLEAN_CSV);

    expect(clean.overallQualityScore).toBeGreaterThan(dirty.overallQualityScore);
  });

  it("re-triggering profiling on an unchanged version reproduces the identical score (deterministic, not just 'different when re-run')", async () => {
    const tenantId = await makeTenant(app, `Quality Score Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const { datasetVersionId, overallQualityScore } = await ingestAndProfile(
      token,
      projectId,
      "suppliers",
      DIRTY_CSV
    );

    const retrigger = await request(app)
      .post("/v1/profiling-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetVersionId });
    expect(retrigger.status).toBe(200);
    expect(Number(retrigger.body.profile.overall_quality_score)).toBeCloseTo(overallQualityScore, 10);
  });

  it("project quality score rolls up across datasets using each dataset's latest version, updating as remediated versions land", async () => {
    const tenantId = await makeTenant(app, `Quality Score Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const dirty = await ingestAndProfile(token, projectId, "suppliers", DIRTY_CSV);

    const afterDirty = await request(app)
      .get(`/v1/projects/${projectId}/quality-score`)
      .set("Authorization", `Bearer ${token}`);
    expect(afterDirty.status).toBe(200);
    expect(afterDirty.body.datasetCount).toBe(1);
    expect(afterDirty.body.profiledDatasetCount).toBe(1);
    expect(Number(afterDirty.body.overallQualityScore)).toBeCloseTo(dirty.overallQualityScore, 10);
    expect(afterDirty.body.datasets[0].latestVersionId).toBe(dirty.datasetVersionId);

    // A second, cleaner version of the SAME dataset lands -> project score must move to
    // reflect the LATEST version, not average the two or stay stuck on the old one.
    const clean = await ingestAndProfile(token, projectId, "suppliers", CLEAN_CSV);

    const afterClean = await request(app)
      .get(`/v1/projects/${projectId}/quality-score`)
      .set("Authorization", `Bearer ${token}`);
    expect(afterClean.status).toBe(200);
    expect(afterClean.body.datasetCount).toBe(1); // still one dataset, not two
    expect(Number(afterClean.body.overallQualityScore)).toBeCloseTo(clean.overallQualityScore, 10);
    expect(afterClean.body.datasets[0].latestVersionId).toBe(clean.datasetVersionId);
    expect(Number(afterClean.body.overallQualityScore)).toBeGreaterThan(Number(afterDirty.body.overallQualityScore));
  });

  it("averages across multiple datasets, excluding any dataset that hasn't been profiled yet", async () => {
    const tenantId = await makeTenant(app, `Quality Score Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    await ingestAndProfile(token, projectId, "clean-suppliers", CLEAN_CSV);

    // A second dataset created via the JSON+base64 MVP path (routes/datasets.ts) never gets
    // profiled (no ingestion job, no auto-trigger) -> must be counted in datasetCount but
    // excluded from the quality-score average, not treated as a 0.
    const rawUpload = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        datasetName: "unprofiled-dataset",
        filename: "raw.csv",
        contentBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
      });
    expect(rawUpload.status).toBe(201);

    const res = await request(app)
      .get(`/v1/projects/${projectId}/quality-score`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.datasetCount).toBe(2);
    expect(res.body.profiledDatasetCount).toBe(1);
    // If the unprofiled dataset were averaged in as 0, this would be roughly halved.
    const cleanDataset = (res.body.datasets as Array<Record<string, unknown>>).find(
      (d) => d.datasetName === "clean-suppliers"
    );
    expect(Number(res.body.overallQualityScore)).toBeCloseTo(Number(cleanDataset!.qualityScore), 10);
  });

  it("returns 404 for a project that doesn't exist", async () => {
    const tenantId = await makeTenant(app, `Quality Score Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);

    const res = await request(app)
      .get(`/v1/projects/${randomUUID()}/quality-score`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns a null overallQualityScore (not 0 or an error) for a project with no datasets yet", async () => {
    const tenantId = await makeTenant(app, `Quality Score Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .get(`/v1/projects/${projectId}/quality-score`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.datasetCount).toBe(0);
    expect(res.body.overallQualityScore).toBeNull();
  });

  it("IDOR check: a second tenant cannot read another tenant's project quality score", async () => {
    const tenantA = await makeTenant(app, `Quality Score Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `Quality Score Tenant B ${randomUUID()}`);
    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);
    const projectId = await createProject(tokenA);
    await ingestAndProfile(tokenA, projectId, "suppliers", CLEAN_CSV);

    const res = await request(app)
      .get(`/v1/projects/${projectId}/quality-score`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404); // RLS-filtered: project invisible to tenant B
  });
});
