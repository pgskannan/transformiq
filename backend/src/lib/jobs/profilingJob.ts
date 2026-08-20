// Profiling job (TQ-024): re-reads a dataset_version's immutable raw artifact, re-parses it,
// and computes/stores the five FR-PROF-001 dimensions per field. Runs as its own async job
// (lib/jobs/queue.ts) — automatically enqueued right after a successful ingestion (see
// lib/jobs/ingestionJob.ts) and also triggerable on demand (routes/profiling.ts), e.g. to
// re-profile after a later sprint's remediation step changes the data.
//
// TQ-025 (FR-PROF-002, anomaly detection) and TQ-026 (FR-PROF-003, semantic field type
// inference) both ride along in the same job rather than getting their own enqueue/job-type:
// all three need the exact same re-parsed `ingested` data, so running them separately would
// mean redundant re-parses of the same raw artifact for no benefit — each is cheap, pure,
// synchronous logic (no extra I/O), so there's no latency reason to split them out the way
// ingestion and profiling are split from each other.
import { randomUUID } from "crypto";
import { z } from "zod";
import { withTenant } from "../db";
import { recordAuditEvent } from "../audit";
import { detectAnomalies } from "../anomalies/engine";
import { ingestFile } from "../ingestion/engine";
import { getObjectStorage } from "../objectStorage";
import { profileColumns } from "../profiling/engine";
import { inferSemanticType } from "../semantics/engine";
import { resolveAmbiguousSemanticType } from "../semantics/aiResolver";
import { registerJobHandler } from "./queue";

export const PROFILING_JOB_TYPE = "profiling.process";

const payloadSchema = z.object({
  tenantId: z.string(),
  datasetVersionId: z.string(),
  userId: z.string().nullable().optional(),
});

export type ProfilingJobPayload = z.infer<typeof payloadSchema>;

export async function processProfilingJob(rawPayload: unknown): Promise<void> {
  const { tenantId, datasetVersionId, userId } = payloadSchema.parse(rawPayload);

  await withTenant(tenantId, async (trx) => {
    const version = await trx
      .selectFrom("dataset_versions")
      .selectAll()
      .where("id", "=", datasetVersionId)
      .executeTakeFirst();
    if (!version) {
      throw new Error(`Cannot profile: dataset_version ${datasetVersionId} not found`);
    }

    const bytes = await getObjectStorage().getObject(version.source_artifact_ref);
    // source_filename is nullable (see 0008_dataset_version_filename.sql) for versions
    // created before it existed, or via a caller that never had a real filename — fall back
    // to a generic ".csv" so detectFormat() has *something* to key off of rather than
    // throwing. This is a real, if narrow, precision gap: a filename-less XLSX version would
    // be mis-profiled as CSV. Flagged rather than silently assumed fine.
    const filename = version.source_filename ?? "unknown.csv";

    const ingested = await ingestFile(filename, bytes);
    const profile = profileColumns(ingested.columns, ingested.dataRows);
    const anomalies = detectAnomalies(ingested.columns, ingested.dataRows);

    // Re-profiling replaces the previous profile for this version (unique index on
    // dataset_version_id) rather than accumulating history — a dataset_version's raw bytes
    // never change (immutability), so a later profile run reflects a better/different
    // *profiling algorithm*, not different underlying data. If profiling-run history ever
    // becomes a real requirement, that's a schema change, not a workaround here.
    await trx.deleteFrom("dataset_profiles").where("dataset_version_id", "=", datasetVersionId).execute();
    // Same replace-not-accumulate rule for anomalies, and for the same reason.
    await trx.deleteFrom("dataset_anomalies").where("dataset_version_id", "=", datasetVersionId).execute();

    const datasetProfile = await trx
      .insertInto("dataset_profiles")
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        dataset_version_id: datasetVersionId,
        row_count: profile.rowCount,
        column_count: profile.columnCount,
        overall_quality_score: profile.overallQualityScore,
        profiled_by_user_id: userId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // TQ-026/TQ-039-040: deterministic heuristics first (lib/semantics/engine.ts), then — only
    // for the columns that came back genuinely ambiguous (null) — a Gemini-assisted second
    // pass (lib/semantics/aiResolver.ts). This is the cost-ascending routing AGENTS.md §1.6
    // requires: most columns never reach the AI call at all, and even for the ones that do,
    // a failed/unconfigured call degrades to no suggestion rather than blocking the job (see
    // aiResolver.ts header comment).
    let aiSuggestionCount = 0;
    let aiModelVersion: string | null = null;
    const fieldRows = await Promise.all(
      profile.fields.map(async (f, colIndex) => {
        const rawValues = ingested.dataRows.map((row) => row[colIndex] ?? "");
        const semanticType = inferSemanticType(f.columnName, f.inferredType, rawValues);

        const aiSuggestion =
          semanticType === null
            ? await resolveAmbiguousSemanticType({
                columnName: f.columnName,
                inferredType: f.inferredType,
                rawValues,
              })
            : null;
        if (aiSuggestion) {
          aiSuggestionCount += 1;
          aiModelVersion = aiSuggestion.modelVersion;
        }

        return {
          id: randomUUID(),
          tenant_id: tenantId,
          dataset_profile_id: datasetProfile.id,
          column_name: f.columnName,
          inferred_type: f.inferredType,
          semantic_type: semanticType,
          // AI suggestion columns (migration 0013) are deliberately separate from
          // semantic_type above: this is a recommendation for a steward to review, never
          // written to the deterministic column itself (AGENTS.md Do-Not-Do rules #1, #4).
          ai_semantic_type: aiSuggestion?.semanticType ?? null,
          ai_confidence: aiSuggestion?.confidence ?? null,
          ai_reasoning: aiSuggestion?.reasoning ?? null,
          ai_model_version: aiSuggestion?.modelVersion ?? null,
          row_count: f.rowCount,
          null_count: f.nullCount,
          distinct_count: f.distinctCount,
          completeness: f.completeness,
          uniqueness: f.uniqueness,
          validity: f.validity,
          conformity: f.conformity,
          consistency: f.consistency,
          quality_score: f.qualityScore,
        };
      })
    );

    if (fieldRows.length > 0) {
      await trx.insertInto("field_profiles").values(fieldRows).execute();
    }

    if (anomalies.length > 0) {
      await trx
        .insertInto("dataset_anomalies")
        .values(
          anomalies.map((a) => ({
            id: randomUUID(),
            tenant_id: tenantId,
            dataset_version_id: datasetVersionId,
            row_number: a.rowNumber,
            column_name: a.columnName,
            anomaly_type: a.anomalyType,
            value: a.value,
            detail: a.detail,
          }))
        )
        .execute();
    }

    await recordAuditEvent(trx, {
      tenantId,
      actorUserId: userId ?? null,
      action: "dataset_version.profiled",
      entityType: "DatasetProfile",
      entityId: datasetProfile.id,
      newValue: {
        ...datasetProfile,
        fieldCount: profile.fields.length,
        anomalyCount: anomalies.length,
        aiSuggestionCount,
      },
      // FR-AUD-004/FR-AI-003: record which model produced any AI-influenced part of this
      // change. Null when no field was ambiguous enough to reach the AI resolver at all.
      modelVersion: aiModelVersion,
    });
  });
}

registerJobHandler(PROFILING_JOB_TYPE, processProfilingJob);
