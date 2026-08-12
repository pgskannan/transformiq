-- CSV/XLSX ingestion connector (TQ-021) + rejected-row diagnostics (TQ-022).
--
-- One ingestion_run per uploaded file. On success it produces exactly one dataset_version
-- (see 0003_datasets.sql) whose source_artifact_ref points at the immutable raw upload —
-- ingestion never mutates or re-derives an existing version, it only ever creates a new one,
-- consistent with AGENTS.md §4.1 immutability rules.
--
-- Rejected rows (ragged rows whose field count doesn't match the detected header) are kept
-- as their own table rather than a JSON blob column so they can be queried/paginated and
-- exported as a CSV report per FR-ING-003's "malformed-row report ... downloadable" wording.

CREATE TABLE "ingestion_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "dataset_version_id" TEXT, -- set only once the run completes successfully
    "status" TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
    "source_filename" TEXT NOT NULL,
    "source_format" TEXT NOT NULL, -- csv | xlsx
    "detected_encoding" TEXT,
    "detected_delimiter" TEXT, -- null for xlsx (no delimiter concept)
    "has_header" BOOLEAN,
    "row_count" INTEGER,
    "accepted_row_count" INTEGER,
    "rejected_row_count" INTEGER,
    "error_message" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ingestion_runs_status_check" CHECK ("status" IN ('processing', 'completed', 'failed')),
    CONSTRAINT "ingestion_runs_source_format_check" CHECK ("source_format" IN ('csv', 'xlsx'))
);

CREATE TABLE "ingestion_rejected_rows" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ingestion_run_id" TEXT NOT NULL,
    -- 1-based position among ALL parsed rows in the file, header included if present (e.g. a
    -- ragged header row itself would be row 1). Header/data-row detection happens *after*
    -- parsing (it needs the parsed values), so numbering relative to "data rows only" would
    -- require re-numbering rejected rows after the fact for no real benefit — this is simpler
    -- and still unambiguous once you know whether the file had a header.
    "row_number" INTEGER NOT NULL,
    "raw_content" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_rejected_rows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ingestion_runs_tenant_id_idx" ON "ingestion_runs"("tenant_id");
CREATE INDEX "ingestion_runs_project_id_idx" ON "ingestion_runs"("project_id");
CREATE INDEX "ingestion_runs_dataset_id_idx" ON "ingestion_runs"("dataset_id");
CREATE INDEX "ingestion_rejected_rows_tenant_id_idx" ON "ingestion_rejected_rows"("tenant_id");
CREATE INDEX "ingestion_rejected_rows_ingestion_run_id_idx" ON "ingestion_rejected_rows"("ingestion_run_id");

ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_dataset_id_fkey"
  FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_dataset_version_id_fkey"
  FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ingestion_rejected_rows" ADD CONSTRAINT "ingestion_rejected_rows_ingestion_run_id_fkey"
  FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (ADR 0002) — same pattern as every other tenant-scoped table.
ALTER TABLE "ingestion_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ingestion_runs ON "ingestion_runs"
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "ingestion_rejected_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_rejected_rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ingestion_rejected_rows ON "ingestion_rejected_rows"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- No explicit GRANT needed here: 0004_least_privilege_app_role.sql's
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO transformiq_app` already covers
-- every table a future migration creates (as long as migrations keep running as the schema
-- owner role, per db/migrate.ts's MIGRATIONS_DATABASE_URL preference). Verified, not just
-- assumed — see the ingestion route tests, which run against transformiq_app same as
-- everything else.
