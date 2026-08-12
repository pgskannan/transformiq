-- Supplier entity model (TQ-037, FR-SUP-001/FR-SUP-002). AGENTS.md §4.5 and ADR 0002's
-- TQ-028 addendum already committed to this shape before any Supplier code existed: Supplier
-- is a separate entity linked N:1 to BusinessPartner (Supplier -> BusinessPartner), never a
-- type flag bolted onto business_partners. This migration is that commitment made real.
--
-- Supplier-specific attributes (payment terms, approval status, spend category — FR-SUP-003/
-- FR-SUP-004) are explicitly NOT modeled yet; this is the minimal shape TQ-037's DoD asks
-- for ("Supplier records link to exactly one BP; duplicate supplier-to-BP relationships are
-- flagged"), not the full supplier attribute set from SRS §12.5. Extend this table when a
-- later sprint actually needs those fields rather than speculatively adding empty columns now.
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "business_partner_id" TEXT NOT NULL,
    -- The supplier code as it exists in its source system (e.g. an SAP vendor number). Not
    -- globally unique on its own — the same code can be reused across different source
    -- systems — hence the compound uniqueness constraint below rather than a unique column.
    "supplier_number" TEXT,
    "source_system" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppliers_status_check" CHECK ("status" IN ('active', 'inactive', 'obsolete')),
    -- The one true-duplicate shape this schema can detect on its own: the exact same source
    -- system handing back the exact same supplier code twice for one BP is definitionally a
    -- re-entry of the same record, not two legitimately distinct supplier roles. (Postgres
    -- treats NULL as distinct from every other value in a unique constraint, so this only
    -- fires when both fields are actually known — see routes/suppliers.ts for the softer,
    -- "flagged not blocked" check that covers the ambiguous case where supplier_number is
    -- absent but the same source system already has a supplier row for this BP.)
    CONSTRAINT "suppliers_bp_source_number_unique"
      UNIQUE ("business_partner_id", "source_system", "supplier_number")
);

CREATE INDEX "suppliers_tenant_id_idx" ON "suppliers"("tenant_id");
CREATE INDEX "suppliers_project_id_idx" ON "suppliers"("project_id");
CREATE INDEX "suppliers_business_partner_id_idx" ON "suppliers"("business_partner_id");

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Deliberately NOT ON DELETE CASCADE: a Supplier record losing its BP because the BP was
-- deleted is a data-integrity event worth stopping on, not silently cascading away the
-- procurement-role record along with it. business_partners rows aren't deleted anywhere in
-- this codebase today (merges execute in Sprint 7 via redirect, not delete — see the
-- TQ-031-035 addendum), so RESTRICT costs nothing now and avoids a surprise later.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_business_partner_id_fkey"
  FOREIGN KEY ("business_partner_id") REFERENCES "business_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_suppliers ON "suppliers"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- No explicit GRANT needed — 0004_least_privilege_app_role.sql's ALTER DEFAULT PRIVILEGES
-- covers every table a future migration creates.
