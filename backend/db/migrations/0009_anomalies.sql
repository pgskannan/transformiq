-- Anomaly detection (TQ-025, FR-PROF-002): "Detect nulls, malformed values, outliers and
-- suspicious patterns." Distinct from FR-PROF-001's dataset_profiles/field_profiles
-- (aggregate dimension *scores* per column) — this table stores individual, citable
-- anomalies: which row, which column, what kind, why. A user fixing data quality issues
-- needs "row 47's credit_limit is a 40x outlier" a lot more than "this column's consistency
-- is 0.86".
--
-- Tied to dataset_version_id directly (not dataset_profile_id) — anomaly detection runs
-- alongside profiling (same re-parsed data, see lib/jobs/profilingJob.ts) but is a
-- conceptually separate concern with its own re-run/replace lifecycle, so it isn't forced to
-- exist only when a dataset_profiles row also exists.
CREATE TABLE "dataset_anomalies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dataset_version_id" TEXT NOT NULL,
    -- 1-based, over data rows only (header excluded) — same convention lib/ingestion/engine.ts
    -- already uses for dataRows indexing, so a row_number here maps directly onto row
    -- position in the original file (plus the header offset, if any, which the ingestion_runs
    -- record for this version already captures).
    "row_number" INTEGER NOT NULL,
    -- "*" for anomalies that describe a whole row rather than one column (e.g. an exact
    -- duplicate row) — not modeled as nullable because every anomaly is either column-scoped
    -- or row-scoped, never neither, and a sentinel is simpler to query/index than a nullable
    -- column with an implied meaning attached to NULL.
    "column_name" TEXT NOT NULL,
    "anomaly_type" TEXT NOT NULL,
    "value" TEXT,
    "detail" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_anomalies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dataset_anomalies_anomaly_type_check"
      CHECK ("anomaly_type" IN ('null', 'malformed_value', 'outlier', 'suspicious_pattern'))
);

CREATE INDEX "dataset_anomalies_tenant_id_idx" ON "dataset_anomalies"("tenant_id");
CREATE INDEX "dataset_anomalies_dataset_version_id_idx" ON "dataset_anomalies"("dataset_version_id");
CREATE INDEX "dataset_anomalies_anomaly_type_idx" ON "dataset_anomalies"("anomaly_type");

ALTER TABLE "dataset_anomalies" ADD CONSTRAINT "dataset_anomalies_dataset_version_id_fkey"
  FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dataset_anomalies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dataset_anomalies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_dataset_anomalies ON "dataset_anomalies"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- No explicit GRANT needed — 0004_least_privilege_app_role.sql's ALTER DEFAULT PRIVILEGES
-- covers every table a future migration creates (verified via \dp after this migration, same
-- as every prior one).
