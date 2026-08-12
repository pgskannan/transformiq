// Dataset ingestion MVP shape (TQ-013/TQ-014, FR-PROJ-002/003/006): a JSON body carrying
// base64 content, no format detection. Kept alongside the real CSV/XLSX connector
// (routes/ingestion.ts, TQ-021) as a lightweight path for callers that already have parsed/
// structured bytes and don't need encoding/delimiter/header detection — e.g. a future
// programmatic API client, or tests that want to seed a dataset without a real file. Both
// routes share the same version-increment logic (lib/datasetVersioning.ts) so there's one
// code path for "what does the next version number look like," not two that could drift.
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { createDatasetVersion } from "../lib/datasetVersioning";
import { getObjectStorage } from "../lib/objectStorage";

export const datasetsRouter = Router();

const uploadSchema = z.object({
  datasetName: z.string().min(1),
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
});

datasetsRouter.post(
  "/v1/projects/:projectId/datasets",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const projectId = req.params.projectId;
    const data = Buffer.from(parsed.data.contentBase64, "base64");

    const result = await withTenant(tenantId, async (trx) => {
      const project = await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!project) return null;

      // Immutable raw artifact goes to object storage FIRST — the DB row is a pointer to
      // it, never the bytes themselves (AGENTS.md §4.1).
      const stored = await getObjectStorage().putImmutable({
        tenantId,
        filename: parsed.data.filename,
        data,
      });

      const { dataset, version } = await createDatasetVersion(trx, {
        tenantId,
        projectId,
        datasetName: parsed.data.datasetName,
        sourceArtifactRef: stored.ref,
        sourceArtifactChecksum: stored.checksum,
        sourceFilename: parsed.data.filename,
        createdByUserId: req.user!.userId,
      });

      return { dataset, version, bytes: stored.bytes };
    });

    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(201).json(result);
  })
);

datasetsRouter.get(
  "/v1/projects/:projectId/datasets",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const datasets = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("datasets")
        .selectAll()
        .where("project_id", "=", req.params.projectId)
        .orderBy("created_at", "desc")
        .execute()
    );
    res.status(200).json({ datasets });
  })
);

datasetsRouter.get(
  "/v1/datasets/:id/versions",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const versions = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("dataset_versions")
        .selectAll()
        .where("dataset_id", "=", req.params.id)
        .orderBy("version_number", "desc")
        .execute()
    );
    res.status(200).json({ versions });
  })
);
