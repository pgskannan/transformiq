import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { issueDevToken } from "../middleware/auth";

const PLATFORM_ADMIN_KEY = process.env.PLATFORM_ADMIN_API_KEY ?? "test-platform-admin-key";

export async function makeTenant(app: Express, name: string): Promise<string> {
  const res = await request(app)
    .post("/v1/tenants")
    .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
    .send({ name });
  if (res.status !== 201) {
    throw new Error(`makeTenant() failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

export function tokenFor(tenantId: string, role: string = "STEWARD"): string {
  return issueDevToken({ tenantId, email: `user-${randomUUID()}@example.com`, role });
}

/**
 * TQ-023: ingestion runs asynchronously now (POST returns 202 with status "queued"), so
 * tests that need the final state poll GET /v1/ingestion-runs/:id the same way a real caller
 * would. Uses the LocalAsyncJobQueue's setImmediate deferral, which resolves on the next
 * event-loop tick — in practice this resolves almost immediately in tests, but polling with
 * a real timeout (rather than a single setImmediate flush) is what actually proves the job
 * completes asynchronously rather than assuming a specific scheduling order.
 */
export async function pollIngestionRun(
  app: Express,
  token: string,
  runId: string,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/v1/ingestion-runs/${runId}`).set("Authorization", `Bearer ${token}`);
    if (res.status !== 200 || res.body.status === "completed" || res.body.status === "failed") {
      return { status: res.status, body: res.body };
    }
    if (Date.now() > deadline) {
      throw new Error(`pollIngestionRun() timed out after ${timeoutMs}ms; last status: ${res.body.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * TQ-024: profiling is auto-enqueued right after an ingestion job commits (see the
 * post-withTenant enqueue in lib/jobs/ingestionJob.ts), so a test that wants to observe the
 * auto-triggered profile — as opposed to calling the synchronous on-demand
 * POST /v1/profiling-runs trigger — has to poll GET /v1/dataset-versions/:id/profile the
 * same way pollIngestionRun() polls for the ingestion job, rather than assuming it's ready
 * the instant the ingestion run reports "completed" (profiling is a *separate* enqueued job,
 * not part of the ingestion job's own transaction).
 */
export async function pollDatasetProfile(
  app: Express,
  token: string,
  datasetVersionId: string,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app)
      .get(`/v1/dataset-versions/${datasetVersionId}/profile`)
      .set("Authorization", `Bearer ${token}`);
    if (res.status === 200) {
      return { status: res.status, body: res.body };
    }
    if (Date.now() > deadline) {
      throw new Error(`pollDatasetProfile() timed out after ${timeoutMs}ms; last status: ${res.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
