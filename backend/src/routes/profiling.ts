// Data profiling + anomaly endpoints (TQ-024/TQ-025, FR-PROF-001/002). Both run together
// inside lib/jobs/profilingJob.ts (see that file's header comment for why anomaly detection
// isn't a separate job), normally auto-triggered right after a successful ingestion
// (lib/jobs/ingestionJob.ts). This route adds what the auto-trigger doesn't cover: an
// on-demand re-run trigger, a GET for the latest profile, and a GET for the latest anomalies.
//
// On-demand trigger: SYNCHRONOUS, not queued — a deliberate, finalized decision (earlier
// draft comments left this open). Reasoning: profiling a single dataset_version means
// re-reading one already-downloaded-once artifact and running pure in-memory logic
// (profileColumns()) over it — there's no external I/O latency or fan-out that would make a
// caller's HTTP request hang unacceptably long, unlike ingestion (which parses a
// freshly-uploaded, potentially large, unvalidated file — see routes/ingestion.ts's 202
// pattern). On-demand re-profiling is also expected to be an infrequent, manual, "I just
// changed something, show me the new score" action, not something under sustained
// concurrent load. If a future sprint's remediation step needs to trigger profiling
// automatically and at volume, that's the moment to revisit this as async — not now, on
// spec.
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { processProfilingJob } from "../lib/jobs/profilingJob";
import { computeProjectQualityScore, type DatasetLatestQualityScore } from "../lib/profiling/projectQualityScore";

export const profilingRouter = Router();

const triggerSchema = z.object({
  datasetVersionId: z.string().min(1),
});

profilingRouter.post(
  "/v1/profiling-runs",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const userId = req.user!.userId;
    const { datasetVersionId } = parsed.data;

    // Confirm the version exists (and is this tenant's, via RLS) before doing any work, so
    // a bad id gets a clean 404 rather than processProfilingJob's generic "not found" Error
    // surfacing as a 500 through asyncHandler's default error path.
    const version = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("dataset_versions")
        .select("id")
        .where("id", "=", datasetVersionId)
        .executeTakeFirst()
    );
    if (!version) {
      res.status(404).json({ error: "Dataset version not found" });
      return;
    }

    await processProfilingJob({ tenantId, datasetVersionId, userId });

    const [profile, anomalyCountRow] = await withTenant(tenantId, async (trx) => {
      const profileRow = await trx
        .selectFrom("dataset_profiles")
        .selectAll()
        .where("dataset_version_id", "=", datasetVersionId)
        .executeTakeFirstOrThrow();
      const countRow = await trx
        .selectFrom("dataset_anomalies")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("dataset_version_id", "=", datasetVersionId)
        .executeTakeFirstOrThrow();
      return [profileRow, countRow] as const;
    });
    res.status(200).json({ profile, anomalyCount: Number(anomalyCountRow.count) });
  })
);

profilingRouter.get(
  "/v1/dataset-versions/:id/profile",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const datasetVersionId = req.params.id;

    const profile = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("dataset_profiles")
        .selectAll()
        .where("dataset_version_id", "=", datasetVersionId)
        .executeTakeFirst()
    );
    if (!profile) {
      res.status(404).json({ error: "No profile found for this dataset version" });
      return;
    }

    const fields = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("field_profiles")
        .selectAll()
        .where("dataset_profile_id", "=", profile.id)
        .orderBy("column_name", "asc")
        .execute()
    );

    res.status(200).json({ profile, fields });
  })
);

const ANOMALY_TYPES = ["null", "malformed_value", "outlier", "suspicious_pattern"] as const;

profilingRouter.get(
  "/v1/dataset-versions/:id/anomalies",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const datasetVersionId = req.params.id;

    const typeFilter = req.query.type;
    if (typeFilter !== undefined && !ANOMALY_TYPES.includes(typeFilter as (typeof ANOMALY_TYPES)[number])) {
      res.status(400).json({ error: `?type must be one of: ${ANOMALY_TYPES.join(", ")}` });
      return;
    }

    const anomalies = await withTenant(tenantId, (trx) => {
      let query = trx
        .selectFrom("dataset_anomalies")
        .selectAll()
        .where("dataset_version_id", "=", datasetVersionId);
      if (typeFilter) {
        query = query.where("anomaly_type", "=", typeFilter as string);
      }
      return query.orderBy("row_number", "asc").execute();
    });

    // No 404-vs-empty distinction here (unlike GET .../profile) — a dataset_version with zero
    // anomalies is a perfectly valid, common, *good* outcome, not a "not found" state. A
    // caller that needs to know whether profiling ran at all should check GET .../profile.
    res.status(200).json({ anomalies });
  })
);

profilingRouter.get(
  "/v1/projects/:projectId/quality-score",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const projectId = req.params.projectId;

    const project = await withTenant(tenantId, (trx) =>
      trx.selectFrom("projects").select("id").where("id", "=", projectId).executeTakeFirst()
    );
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const datasets = await withTenant(tenantId, (trx) =>
      trx.selectFrom("datasets").select(["id", "name"]).where("project_id", "=", projectId).execute()
    );

    // One query per dataset for its latest version + that version's profile score, rather
    // than a single DISTINCT-ON/window-function query — this project's dataset counts are
    // small in every environment this has been run against (Sprint 3 scale), and the
    // straightforward per-dataset query is far easier to read/verify than a Postgres-
    // specific DISTINCT ON join. Revisit if a project's dataset count ever makes N+1 a real
    // cost, not preemptively.
    const datasetScores: DatasetLatestQualityScore[] = await withTenant(tenantId, async (trx) => {
      const results: DatasetLatestQualityScore[] = [];
      for (const dataset of datasets) {
        const latestVersion = await trx
          .selectFrom("dataset_versions")
          .select(["id", "version_number"])
          .where("dataset_id", "=", dataset.id)
          .orderBy("version_number", "desc")
          .executeTakeFirst();

        if (!latestVersion) {
          results.push({
            datasetId: dataset.id,
            datasetName: dataset.name,
            latestVersionId: null,
            versionNumber: null,
            qualityScore: null,
          });
          continue;
        }

        const profile = await trx
          .selectFrom("dataset_profiles")
          .select("overall_quality_score")
          .where("dataset_version_id", "=", latestVersion.id)
          .executeTakeFirst();

        results.push({
          datasetId: dataset.id,
          datasetName: dataset.name,
          latestVersionId: latestVersion.id,
          versionNumber: latestVersion.version_number,
          qualityScore: profile?.overall_quality_score ?? null,
        });
      }
      return results;
    });

    res.status(200).json(computeProjectQualityScore(datasetScores));
  })
);
