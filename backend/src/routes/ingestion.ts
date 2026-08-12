// Real CSV/XLSX file ingestion (TQ-021, FR-ING-001/002) with rejected-row diagnostics
// (TQ-022, FR-ING-003), processed asynchronously (TQ-023, FR-ING-004): this route does only
// the fast synchronous prep — resolve the project/dataset, write the immutable raw artifact,
// insert a "queued" ingestion_runs row — then enqueues the actual parse/detect/persist work
// (lib/jobs/ingestionJob.ts) and returns 202 immediately. Poll GET /v1/ingestion-runs/:id for
// status; the parsing/detection logic itself (lib/ingestion/engine.ts) is unchanged by any of
// this — only *when* it runs relative to the HTTP response changed.
import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { getOrCreateDataset } from "../lib/datasetVersioning";
import { detectFormat } from "../lib/ingestion/engine";
import { getMaxFileSizeBytes } from "../lib/ingestion/limits";
import { INGESTION_JOB_TYPE } from "../lib/jobs/ingestionJob";
import { getJobQueue } from "../lib/jobs/queue";
import { getObjectStorage } from "../lib/objectStorage";

export const ingestionRouter = Router();

// Memory storage: even the synchronous prep this route now does (checksum + object storage
// write) needs the whole buffer, and the deferred job needs the file re-read from object
// storage anyway — streaming to disk first would just add a second I/O pass for no benefit
// at the file sizes this MVP targets. getMaxFileSizeBytes() is env-configurable
// (INGESTION_MAX_FILE_SIZE_BYTES) — see lib/ingestion/limits.ts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getMaxFileSizeBytes() },
});

const requestSchema = z.object({
  datasetName: z.string().min(1),
});

ingestionRouter.post(
  "/v1/projects/:projectId/ingestions",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
      return;
    }
    const parsedBody = requestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.flatten() });
      return;
    }

    const tenantId = req.tenantId!;
    const projectId = req.params.projectId;
    const userId = req.user!.userId;
    const { datasetName } = parsedBody.data;
    const file = req.file;

    const result = await withTenant(tenantId, async (trx) => {
      const project = await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!project) return { kind: "project_not_found" as const };

      const dataset = await getOrCreateDataset(trx, {
        tenantId,
        projectId,
        datasetName,
        createdByUserId: userId,
      });

      // Immutable raw artifact goes to object storage FIRST, synchronously — the upload
      // itself must never be lost even if the job that parses it never runs. AGENTS.md §4.1.
      const stored = await getObjectStorage().putImmutable({
        tenantId,
        filename: file.originalname,
        data: file.buffer,
      });

      const run = await trx
        .insertInto("ingestion_runs")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          project_id: projectId,
          dataset_id: dataset.id,
          status: "queued",
          source_filename: file.originalname,
          source_format: detectFormat(file.originalname),
          created_by_user_id: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        kind: "ok" as const,
        run,
        dataset,
        sourceArtifactRef: stored.ref,
        sourceArtifactChecksum: stored.checksum,
      };
    });

    if (result.kind === "project_not_found") {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await getJobQueue().enqueue(INGESTION_JOB_TYPE, {
      runId: result.run.id,
      tenantId,
      projectId,
      datasetName,
      filename: file.originalname,
      sourceArtifactRef: result.sourceArtifactRef,
      sourceArtifactChecksum: result.sourceArtifactChecksum,
      userId,
    });

    // 202 Accepted, not 201 Created: the ingestion_runs row exists, but the thing it
    // represents (a completed ingestion) does not yet — poll GET /v1/ingestion-runs/:id.
    res.status(202).json({ ingestionRun: result.run, dataset: result.dataset });
  })
);

ingestionRouter.get(
  "/v1/ingestion-runs/:id",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const run = await withTenant(tenantId, (trx) =>
      trx.selectFrom("ingestion_runs").selectAll().where("id", "=", req.params.id).executeTakeFirst()
    );
    if (!run) {
      res.status(404).json({ error: "Ingestion run not found" });
      return;
    }
    res.status(200).json(run);
  })
);

ingestionRouter.get(
  "/v1/ingestion-runs/:id/rejected-rows",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const rows = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("ingestion_rejected_rows")
        .selectAll()
        .where("ingestion_run_id", "=", req.params.id)
        .orderBy("row_number", "asc")
        .execute()
    );

    // FR-ING-003: "a malformed-row report is generated and downloadable" — ?format=csv makes
    // it an actual downloadable file rather than only a JSON array a UI has to render itself.
    if (req.query.format === "csv") {
      const header = "row_number,reason,raw_content\n";
      const body = rows
        .map((r) => [r.row_number, csvEscape(r.reason), csvEscape(r.raw_content)].join(","))
        .join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ingestion-${req.params.id}-rejected-rows.csv"`
      );
      res.status(200).send(header + body);
      return;
    }

    res.status(200).json({ rows });
  })
);

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
