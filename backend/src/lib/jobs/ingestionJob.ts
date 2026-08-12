// The ingestion job handler (TQ-023): the actual parse-and-persist work, now running
// deferred/async instead of inline in the HTTP request (see routes/ingestion.ts, which does
// only the fast synchronous prep — resolve project/dataset, write the immutable raw
// artifact, insert a "queued" ingestion_runs row — before enqueuing this).
import { randomUUID } from "crypto";
import { z } from "zod";
import { withTenant } from "../db";
import { recordAuditEvent } from "../audit";
import { createDatasetVersion } from "../datasetVersioning";
import { getObjectStorage } from "../objectStorage";
import { ingestFile } from "../ingestion/engine";
import { getMaxRows } from "../ingestion/limits";
import { PROFILING_JOB_TYPE } from "./profilingJob";
import { getJobQueue, registerJobHandler } from "./queue";

export const INGESTION_JOB_TYPE = "ingestion.process";

const payloadSchema = z.object({
  runId: z.string(),
  tenantId: z.string(),
  projectId: z.string(),
  datasetName: z.string(),
  filename: z.string(),
  sourceArtifactRef: z.string(),
  sourceArtifactChecksum: z.string(),
  userId: z.string(),
});

export type IngestionJobPayload = z.infer<typeof payloadSchema>;

export async function processIngestionJob(rawPayload: unknown): Promise<void> {
  const payload = payloadSchema.parse(rawPayload);
  const {
    runId,
    tenantId,
    projectId,
    datasetName,
    filename,
    sourceArtifactRef,
    sourceArtifactChecksum,
    userId,
  } = payload;

  try {
    // The withTenant callback returns a small result object instead of doing any
    // post-commit work (e.g. enqueueing the profiling job) itself — see the comment below,
    // after the await withTenant(...) line, for why that matters.
    const result = await withTenant(tenantId, async (trx) => {
      await trx
        .updateTable("ingestion_runs")
        .set({ status: "processing" })
        .where("id", "=", runId)
        .execute();

      const bytes = await getObjectStorage().getObject(sourceArtifactRef);
      const ingested = await ingestFile(filename, bytes);

      const totalRows = ingested.dataRows.length + ingested.rejected.length;
      const maxRows = getMaxRows();
      if (totalRows > maxRows) {
        const failed = await trx
          .updateTable("ingestion_runs")
          .set({
            status: "failed",
            error_message: `File has ${totalRows} rows, exceeding the configured limit of ${maxRows} (INGESTION_MAX_ROWS).`,
            source_format: ingested.format,
            detected_encoding: ingested.encoding,
            detected_delimiter: ingested.delimiter,
            has_header: ingested.hasHeader,
            row_count: totalRows,
            completed_at: new Date(),
          })
          .where("id", "=", runId)
          .returningAll()
          .executeTakeFirstOrThrow();

        await recordAuditEvent(trx, {
          tenantId,
          actorUserId: userId,
          action: "ingestion.failed",
          entityType: "IngestionRun",
          entityId: runId,
          newValue: failed,
        });
        return { kind: "failed" as const };
      }

      const { version } = await createDatasetVersion(trx, {
        tenantId,
        projectId,
        datasetName,
        sourceArtifactRef,
        sourceArtifactChecksum,
        sourceFilename: filename,
        createdByUserId: userId,
        rowCount: ingested.dataRows.length,
      });

      const completedRun = await trx
        .updateTable("ingestion_runs")
        .set({
          status: "completed",
          dataset_version_id: version.id,
          source_format: ingested.format,
          detected_encoding: ingested.encoding,
          detected_delimiter: ingested.delimiter,
          has_header: ingested.hasHeader,
          row_count: totalRows,
          accepted_row_count: ingested.dataRows.length,
          rejected_row_count: ingested.rejected.length,
          completed_at: new Date(),
        })
        .where("id", "=", runId)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (ingested.rejected.length > 0) {
        await trx
          .insertInto("ingestion_rejected_rows")
          .values(
            ingested.rejected.map((r) => ({
              id: randomUUID(),
              tenant_id: tenantId,
              ingestion_run_id: runId,
              row_number: r.rowNumber,
              raw_content: r.raw,
              reason: r.reason,
            }))
          )
          .execute();
      }

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: userId,
        action: "ingestion.completed",
        entityType: "IngestionRun",
        entityId: runId,
        newValue: completedRun,
      });

      return { kind: "completed" as const, datasetVersionId: version.id };
    });

    // Chain straight into profiling (TQ-024) — deliberately AFTER withTenant() has fully
    // returned, i.e. after the ingestion transaction has committed. Enqueueing from *inside*
    // the transaction callback would race: the LocalAsyncJobQueue defers via setImmediate,
    // and Node's event-loop phase ordering does not guarantee that fires only after the
    // transaction's COMMIT has become visible to the profiling job's own (separate) DB
    // connection. Enqueueing out here means the profiling job can only ever see committed
    // data. It's also not awaited inline, so a slow profiling run doesn't extend how long
    // this job holds its transaction open (though by this point the transaction is already
    // closed either way — the non-blocking property is preserved as a matter of design, not
    // just accident). If enqueueing itself fails (extremely unlikely for the local queue;
    // more plausible for a real Pub/Sub outage), that's a profiling gap to notice via the
    // absence of a dataset_profiles row, not a reason to fail the ingestion that already
    // succeeded and committed.
    if (result.kind === "completed") {
      await getJobQueue()
        .enqueue(PROFILING_JOB_TYPE, { tenantId, datasetVersionId: result.datasetVersionId, userId })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `Failed to enqueue profiling job for dataset_version ${result.datasetVersionId}:`,
            err
          );
        });
    }
  } catch (err) {
    // Anything above throwing (corrupt file, object storage read failure, etc.) lands here —
    // record it as a failed run in its own transaction rather than leaving the run stuck at
    // "processing" forever, which would make polling GET /v1/ingestion-runs/:id hang.
    await withTenant(tenantId, (trx) =>
      trx
        .updateTable("ingestion_runs")
        .set({
          status: "failed",
          error_message: err instanceof Error ? err.message : "Unknown ingestion error",
          completed_at: new Date(),
        })
        .where("id", "=", runId)
        .execute()
    );
  }
}

registerJobHandler(INGESTION_JOB_TYPE, processIngestionJob);
