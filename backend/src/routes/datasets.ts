// Dataset ingestion (TQ-013/TQ-014, FR-PROJ-002/003/006). MVP ingestion shape only — a JSON
// body carrying base64 content. A real multipart/CSV/XLSX upload path with encoding/
// delimiter/header detection (FR-ING-001/002) is Sprint 3 scope (TQ-021); this sprint just
// proves the immutable-storage + versioned-dataset plumbing works end to end.
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { recordAuditEvent } from "../lib/audit";
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

      let dataset = await trx
        .selectFrom("datasets")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("name", "=", parsed.data.datasetName)
        .executeTakeFirst();

      if (!dataset) {
        dataset = await trx
          .insertInto("datasets")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            project_id: projectId,
            name: parsed.data.datasetName,
            updated_at: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await recordAuditEvent(trx, {
          tenantId,
          actorUserId: req.user!.userId,
          action: "dataset.created",
          entityType: "Dataset",
          entityId: dataset.id,
          newValue: dataset,
        });
      }

      const latest = await trx
        .selectFrom("dataset_versions")
        .select(["id", "version_number"])
        .where("dataset_id", "=", dataset.id)
        .orderBy("version_number", "desc")
        .executeTakeFirst();

      const version = await trx
        .insertInto("dataset_versions")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          dataset_id: dataset.id,
          version_number: (latest?.version_number ?? 0) + 1,
          source_artifact_ref: stored.ref,
          source_artifact_checksum: stored.checksum,
          parent_version_id: latest?.id ?? null,
          created_by_user_id: req.user!.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: req.user!.userId,
        action: "dataset_version.created",
        entityType: "DatasetVersion",
        entityId: version.id,
        newValue: { ...version, bytes: stored.bytes },
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
