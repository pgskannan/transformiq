-- Dataset / DatasetVersion model + lineage skeleton (TQ-014, FR-PROJ-002/003/006).
-- AGENTS.md §1.3: Project 1:N Dataset; Dataset 1:N DatasetVersion.
--
-- Lineage: every DatasetVersion points at the immutable raw artifact it came from
-- (source_artifact_ref — see src/lib/objectStorage.ts) and, optionally, at the
-- DatasetVersion it was derived from (parent_version_id). Chaining parent_version_id lets a
-- later sprint reconstruct "how did we get from raw upload to this state" without needing a
-- separate lineage table yet — this is deliberately the simplest structure that satisfies
-- FR-PROJ-006 today; revisit if lineage needs to represent merges from multiple parents.

CREATE TABLE "datasets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dataset_versions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    -- Pointer to the immutable raw artifact (see src/lib/objectStorage.ts). A URI, not a
    -- foreign key, because raw artifacts live in object storage (GCS/local), not Postgres.
    "source_artifact_ref" TEXT NOT NULL,
    "source_artifact_checksum" TEXT NOT NULL,
    "parent_version_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ingested', -- ingested | profiling | profiled | ... (later sprints add more)
    "row_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "datasets_project_id_name_key" ON "datasets"("project_id", "name");
CREATE INDEX "datasets_tenant_id_idx" ON "datasets"("tenant_id");
CREATE UNIQUE INDEX "dataset_versions_dataset_id_version_number_key" ON "dataset_versions"("dataset_id", "version_number");
CREATE INDEX "dataset_versions_tenant_id_idx" ON "dataset_versions"("tenant_id");
CREATE INDEX "dataset_versions_dataset_id_idx" ON "dataset_versions"("dataset_id");

ALTER TABLE "datasets" ADD CONSTRAINT "datasets_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_id_fkey"
  FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_parent_version_id_fkey"
  FOREIGN KEY ("parent_version_id") REFERENCES "dataset_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation (ADR 0002) — same pattern as 0002_enable_rls.sql.
ALTER TABLE "datasets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "datasets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_datasets ON "datasets"
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "dataset_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dataset_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_dataset_versions ON "dataset_versions"
  USING (tenant_id = current_setting('app.tenant_id', true));
