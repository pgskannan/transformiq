// TQ-021 (real HTTP layer over lib/ingestion/engine.ts, which has its own detailed unit
// tests) + TQ-022 (rejected-row report is queryable and downloadable) + TQ-023 (async: POST
// returns immediately, GET is the poll target) + IDOR/RBAC coverage consistent with every
// other route in this repo.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { makeTenant, pollIngestionRun, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string) {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Ingestion Test Project",
      domain: "Direct Procurement",
      sourceSystem: "Legacy ERP",
      targetSystem: "SAP S/4HANA",
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const MESSY_CSV = [
  "supplier_id;name;signup_date;credit_limit;is_active",
  "1;Acme Corp;2024-01-15;10000.50;true",
  "2;Globex;2024-03-02;25000.00;true",
  "3;Initech;2023-11-30;5000.00;false",
  "4;BadRow;2024-01-01", // ragged — missing 2 fields
].join("\n");

describe("POST /v1/projects/:projectId/ingestions (async, TQ-023)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("returns 202 immediately with status 'queued', not the finished result (does not block the API)", async () => {
    const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "suppliers")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");

    expect(res.status).toBe(202);
    expect(res.body.ingestionRun.status).toBe("queued");
    // Detection fields aren't known yet — that only happens once the deferred job runs.
    expect(res.body.ingestionRun.detected_delimiter).toBeNull();
    expect(res.body.dataset.name).toBe("suppliers");
  });

  it("job status is pollable: queued -> completed, with full detection results once done", async () => {
    const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "suppliers")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
    const runId = res.body.ingestionRun.id as string;

    const { body: run } = await pollIngestionRun(app, token, runId);

    expect(run.status).toBe("completed");
    expect(run.detected_delimiter).toBe(";");
    expect(run.has_header).toBe(true);
    expect(run.accepted_row_count).toBe(3);
    expect(run.rejected_row_count).toBe(1);
    expect(run.dataset_version_id).toBeTruthy();

    // The dataset version the job created should be independently visible through the
    // existing dataset-versions endpoint too — proves the shared datasetVersioning.ts path
    // really is shared, not a second parallel implementation with its own bugs.
    const versions = await request(app)
      .get(`/v1/datasets/${res.body.dataset.id}/versions`)
      .set("Authorization", `Bearer ${token}`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0].id).toBe(run.dataset_version_id);
    expect(versions.body.versions[0].row_count).toBe(3);
  });

  it("rejected-rows is queryable and downloadable once the job completes", async () => {
    const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const ingest = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "suppliers")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
    const runId = ingest.body.ingestionRun.id as string;
    await pollIngestionRun(app, token, runId);

    const rejectedRes = await request(app)
      .get(`/v1/ingestion-runs/${runId}/rejected-rows`)
      .set("Authorization", `Bearer ${token}`);
    expect(rejectedRes.status).toBe(200);
    expect(rejectedRes.body.rows).toHaveLength(1);
    expect(rejectedRes.body.rows[0].reason).toMatch(/found 3/);
    expect(rejectedRes.body.rows[0].raw_content).toContain("BadRow");

    // FR-ING-003: "downloadable" — a real CSV attachment, not just a JSON array.
    const csvRes = await request(app)
      .get(`/v1/ingestion-runs/${runId}/rejected-rows?format=csv`)
      .set("Authorization", `Bearer ${token}`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers["content-type"]).toMatch(/text\/csv/);
    expect(csvRes.headers["content-disposition"]).toMatch(/attachment/);
    expect(csvRes.text).toContain("row_number,reason,raw_content");
    expect(csvRes.text).toContain("BadRow");
  });

  it("returns 400 when no file is attached", async () => {
    const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "suppliers");
    expect(res.status).toBe(400);
  });

  it("a corrupt file is accepted (202, queued) but the job later marks the run failed — polling surfaces it, and the server stays responsive", async () => {
    const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const res = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${token}`)
      .field("datasetName", "broken")
      .attach("file", Buffer.from("this is not a real xlsx file"), "broken.xlsx");
    expect(res.status).toBe(202);
    const runId = res.body.ingestionRun.id as string;

    const { body: run } = await pollIngestionRun(app, token, runId);
    expect(run.status).toBe("failed");
    expect(run.error_message).toBeTruthy();

    // The server must still be responsive after a failed ingestion job — the try/catch in
    // lib/jobs/ingestionJob.ts plus the LocalAsyncJobQueue's own catch are what stop this
    // from being a repeat of the Sprint 1 "unhandled rejection crashes the process" bug, now
    // that the failure happens off the request's call stack entirely.
    const health = await request(app).get("/v1/health");
    expect(health.status).toBe(200);
  });

  it("respects the configurable row-count limit (INGESTION_MAX_ROWS) and fails the run rather than silently truncating", async () => {
    const originalMaxRows = process.env.INGESTION_MAX_ROWS;
    process.env.INGESTION_MAX_ROWS = "2"; // MESSY_CSV has 5 data rows (4 accepted-shape + 1 ragged)
    try {
      const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
      const token = tokenFor(tenantId);
      const projectId = await createProject(token);

      const res = await request(app)
        .post(`/v1/projects/${projectId}/ingestions`)
        .set("Authorization", `Bearer ${token}`)
        .field("datasetName", "suppliers")
        .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
      const runId = res.body.ingestionRun.id as string;

      const { body: run } = await pollIngestionRun(app, token, runId);
      expect(run.status).toBe("failed");
      expect(run.error_message).toMatch(/exceeding the configured limit/);
      expect(run.error_message).toMatch(/INGESTION_MAX_ROWS/);
    } finally {
      if (originalMaxRows === undefined) delete process.env.INGESTION_MAX_ROWS;
      else process.env.INGESTION_MAX_ROWS = originalMaxRows;
    }
  });

  it("VIEWER cannot ingest (403) but can read ingestion runs", async () => {
    const tenantId = await makeTenant(app, `Ingestion Tenant ${randomUUID()}`);
    const stewardToken = tokenFor(tenantId, "STEWARD");
    const viewerToken = tokenFor(tenantId, "VIEWER");
    const projectId = await createProject(stewardToken);

    const viewerUpload = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .field("datasetName", "suppliers")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
    expect(viewerUpload.status).toBe(403);

    const ingest = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${stewardToken}`)
      .field("datasetName", "suppliers")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
    const runId = ingest.body.ingestionRun.id as string;

    const viewerRead = await request(app)
      .get(`/v1/ingestion-runs/${runId}`)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(viewerRead.status).toBe(200);
  });

  it("IDOR check: a second tenant cannot upload into or read another tenant's project/ingestion run", async () => {
    const tenantA = await makeTenant(app, `Ingestion Tenant A ${randomUUID()}`);
    const tenantB = await makeTenant(app, `Ingestion Tenant B ${randomUUID()}`);
    const tokenA = tokenFor(tenantA);
    const tokenB = tokenFor(tenantB);
    const projectId = await createProject(tokenA);

    const uploadAsB = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${tokenB}`)
      .field("datasetName", "hijack")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
    expect(uploadAsB.status).toBe(404);

    const ingestAsA = await request(app)
      .post(`/v1/projects/${projectId}/ingestions`)
      .set("Authorization", `Bearer ${tokenA}`)
      .field("datasetName", "suppliers")
      .attach("file", Buffer.from(MESSY_CSV, "utf8"), "suppliers-export.csv");
    const runId = ingestAsA.body.ingestionRun.id as string;

    const readAsB = await request(app)
      .get(`/v1/ingestion-runs/${runId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(readAsB.status).toBe(404);

    const rejectedAsB = await request(app)
      .get(`/v1/ingestion-runs/${runId}/rejected-rows`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(rejectedAsB.status).toBe(200); // RLS-filtered empty result, not an error
    expect(rejectedAsB.body.rows).toHaveLength(0);
  });
});
