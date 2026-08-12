// Shared "get-or-create dataset, append the next version" logic (TQ-014). Extracted out of
// routes/datasets.ts during Sprint 3 so routes/ingestion.ts can create dataset versions from
// parsed files the same way the raw JSON+base64 upload path does — one version-increment
// code path, not two that could drift or race differently.
import { randomUUID } from "crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../db/types";
import { recordAuditEvent } from "./audit";

export interface GetOrCreateDatasetInput {
  tenantId: string;
  projectId: string;
  datasetName: string;
  createdByUserId: string;
}

/** Get-or-create split out so callers that need the dataset's id *before* they have a
 *  version to attach (e.g. routes/ingestion.ts needs dataset_id to write the ingestion_runs
 *  row before parsing even completes) don't have to duplicate this lookup. */
export async function getOrCreateDataset(trx: Kysely<DB>, input: GetOrCreateDatasetInput) {
  const existing = await trx
    .selectFrom("datasets")
    .selectAll()
    .where("project_id", "=", input.projectId)
    .where("name", "=", input.datasetName)
    .executeTakeFirst();
  if (existing) return existing;

  const dataset = await trx
    .insertInto("datasets")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      project_id: input.projectId,
      name: input.datasetName,
      updated_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAuditEvent(trx, {
    tenantId: input.tenantId,
    actorUserId: input.createdByUserId,
    action: "dataset.created",
    entityType: "Dataset",
    entityId: dataset.id,
    newValue: dataset,
  });

  return dataset;
}

export interface CreateDatasetVersionInput {
  tenantId: string;
  projectId: string;
  datasetName: string;
  sourceArtifactRef: string;
  sourceArtifactChecksum: string;
  createdByUserId: string;
  rowCount?: number | null;
  /** Original uploaded filename — needed later to re-parse the raw artifact for profiling
   *  (lib/ingestion/engine.ts's detectFormat() is extension-based). Nullable because the
   *  JSON+base64 MVP upload path (routes/datasets.ts) predates this and some callers may
   *  not have a real filename to give. */
  sourceFilename?: string | null;
}

export async function createDatasetVersion(trx: Kysely<DB>, input: CreateDatasetVersionInput) {
  const dataset = await getOrCreateDataset(trx, input);

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
      tenant_id: input.tenantId,
      dataset_id: dataset.id,
      version_number: (latest?.version_number ?? 0) + 1,
      source_artifact_ref: input.sourceArtifactRef,
      source_artifact_checksum: input.sourceArtifactChecksum,
      source_filename: input.sourceFilename ?? null,
      parent_version_id: latest?.id ?? null,
      row_count: input.rowCount ?? null,
      created_by_user_id: input.createdByUserId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAuditEvent(trx, {
    tenantId: input.tenantId,
    actorUserId: input.createdByUserId,
    action: "dataset_version.created",
    entityType: "DatasetVersion",
    entityId: version.id,
    newValue: version,
  });

  return { dataset, version };
}
