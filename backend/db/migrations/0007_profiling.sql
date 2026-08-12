-- Profiling engine v1 (TQ-024, FR-PROF-001). One dataset_profiles row per profiled
-- dataset_version (re-profiling replaces it — see the unique index below — profiles aren't
-- versioned themselves, the dataset_version they describe already is), with one
-- field_profiles row per column underneath it.
--
-- Profiling reads the immutable raw artifact back out of object storage and re-parses it
-- (lib/ingestion/engine.ts) rather than persisting parsed row data in Postgres — consistent
-- with "immutable raw + derive on demand" (see ADR 0002). This does mean profiling costs a
-- re-parse; acceptable for Sprint 3's data volumes, revisit if that becomes a real bottleneck.

CREATE TABLE "dataset_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dataset_version_id" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "column_count" INTEGER NOT NULL,
    "overall_quality_score" DOUBLE PRECISION NOT NULL,
    "profiled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profiled_by_user_id" TEXT,

    CONSTRAINT "dataset_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "field_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dataset_profile_id" TEXT NOT NULL,
    "column_name" TEXT NOT NULL,
    "inferred_type" TEXT NOT NULL,
    -- Semantic type (TQ-026) — nullable until that sprint item lands; column added now so
    -- profiling's schema doesn't need a second migration just to attach it.
    "semantic_type" TEXT,
    "row_count" INTEGER NOT NULL,
    "null_count" INTEGER NOT NULL,
    "distinct_count" INTEGER NOT NULL,
    -- All four in [0, 1]. See lib/profiling/engine.ts for exact definitions — briefly:
    -- completeness = non-null fraction; validity = fraction matching the inferred type at
    -- all; conformity = fraction matching a *strict* canonical form for that type (stricter
    -- than validity); consistency = fraction sharing the column's single most common
    -- structural "shape" (digits/letters pattern). uniqueness is stored as a diagnostic
    -- ratio but deliberately NOT folded into quality_score — see the code comment for why.
    "completeness" DOUBLE PRECISION NOT NULL,
    "uniqueness" DOUBLE PRECISION NOT NULL,
    "validity" DOUBLE PRECISION NOT NULL,
    "conformity" DOUBLE PRECISION NOT NULL,
    "consistency" DOUBLE PRECISION NOT NULL,
    "quality_score" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dataset_profiles_dataset_version_id_key" ON "dataset_profiles"("dataset_version_id");
CREATE INDEX "dataset_profiles_tenant_id_idx" ON "dataset_profiles"("tenant_id");
CREATE INDEX "field_profiles_tenant_id_idx" ON "field_profiles"("tenant_id");
CREATE INDEX "field_profiles_dataset_profile_id_idx" ON "field_profiles"("dataset_profile_id");

ALTER TABLE "dataset_profiles" ADD CONSTRAINT "dataset_profiles_dataset_version_id_fkey"
  FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_profiles" ADD CONSTRAINT "field_profiles_dataset_profile_id_fkey"
  FOREIGN KEY ("dataset_profile_id") REFERENCES "dataset_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (ADR 0002) — same pattern as every other tenant-scoped table.
ALTER TABLE "dataset_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dataset_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_dataset_profiles ON "dataset_profiles"
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "field_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "field_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_field_profiles ON "field_profiles"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- No explicit GRANT needed — 0004_least_privilege_app_role.sql's ALTER DEFAULT PRIVILEGES
-- covers every table a future migration creates, verified again for these two tables the
-- same way it was for 0005/0006 (see src/__tests__ for this sprint's profiling tests).
