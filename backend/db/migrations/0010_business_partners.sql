-- Business Partner canonical entity schema (TQ-028, FR-BP-001). Sprint 3 scope is the schema
-- itself, not entity resolution (FR-BP-002, later sprint), normalization (FR-BP-004, later),
-- or reversible merge (FR-BP-008, later) — this DoD is "BP is modeled as first-class;
-- Address/Identifier/Relationship are 1:N child records," which is a data-model claim.
--
-- FR-BP-006 ("distinguish BP-level data from supplier/procurement-level data") is why this is
-- its own top-level entity — business_partners — rather than a column bolted onto a future
-- "suppliers" table (which doesn't exist yet; see SRS §12.5, a later sprint). A supplier is a
-- procurement-context ROLE a business partner plays, not the business partner itself: the
-- same legal entity can be a supplier on one deal and a customer or partner on another, and
-- collapsing BP into Supplier would make that distinction impossible to represent later.
--
-- Scoped to project_id (like datasets — AGENTS.md §1.3's Project 1:N pattern) rather than
-- tenant-wide: a business partner discovered while transforming one project's procurement
-- data doesn't automatically apply to a different project's data, at least not until a later
-- sprint's cross-project BP resolution (not in scope here) says otherwise.
CREATE TABLE "business_partners" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    -- FR-BP-003 ("identify organization/person where supported by source/target design") —
    -- 'unknown' is a legitimate, common starting state when source data doesn't distinguish
    -- them; this is heuristic classification territory for a later sprint, not this one.
    "bp_type" TEXT NOT NULL DEFAULT 'unknown',
    "primary_name" TEXT NOT NULL,
    -- Where this BP record came from, and what it was called there — needed for FR-BP-005
    -- (identifier crosswalks) even before entity resolution exists: a BP created directly
    -- from one source system's export still needs to record which system and what that
    -- system's own key was, so a later dedup pass has something to resolve against.
    "source_system" TEXT,
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_partners_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "business_partners_bp_type_check" CHECK ("bp_type" IN ('organization', 'person', 'unknown'))
);

-- 1:N child — a BP can have multiple addresses (billing vs. shipping vs. registered office,
-- or simply multiple sites), per FR-BP-001's DoD wording.
CREATE TABLE "bp_addresses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "business_partner_id" TEXT NOT NULL,
    "address_type" TEXT NOT NULL DEFAULT 'other',
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bp_addresses_pkey" PRIMARY KEY ("id")
);

-- 1:N child — FR-BP-005 (identifier crosswalks): a BP is commonly known by several external
-- identifiers at once (a DUNS number, a VAT number, one or more source-ERP internal IDs).
CREATE TABLE "bp_identifiers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "business_partner_id" TEXT NOT NULL,
    "identifier_type" TEXT NOT NULL,
    "identifier_value" TEXT NOT NULL,
    "issuing_authority" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bp_identifiers_pkey" PRIMARY KEY ("id")
);

-- 1:N child — FR-BP-007 (BP relationships). Directed edge between two business_partners
-- (e.g. "subsidiary_of") rather than a symmetric pair, since most relevant procurement/BP
-- relationships (parent/subsidiary, headquarters/branch) are naturally directional; a
-- symmetric relationship (e.g. "affiliate_of") is just represented as two rows, one per
-- direction — simpler than a bidirectional-edge model for the handful of relationship types
-- in scope, and consistent with how the rest of this schema favors explicit rows over clever
-- structure.
CREATE TABLE "bp_relationships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "business_partner_id" TEXT NOT NULL,
    "related_business_partner_id" TEXT NOT NULL,
    "relationship_type" TEXT NOT NULL,
    -- FR-BP-007's "...and provenance where configured" — where this relationship claim came
    -- from (a source system's own hierarchy field, a manual entry, etc.), nullable since not
    -- every relationship will have one recorded.
    "provenance" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bp_relationships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bp_relationships_not_self_check" CHECK ("business_partner_id" != "related_business_partner_id")
);

CREATE INDEX "business_partners_tenant_id_idx" ON "business_partners"("tenant_id");
CREATE INDEX "business_partners_project_id_idx" ON "business_partners"("project_id");
CREATE INDEX "bp_addresses_tenant_id_idx" ON "bp_addresses"("tenant_id");
CREATE INDEX "bp_addresses_business_partner_id_idx" ON "bp_addresses"("business_partner_id");
CREATE INDEX "bp_identifiers_tenant_id_idx" ON "bp_identifiers"("tenant_id");
CREATE INDEX "bp_identifiers_business_partner_id_idx" ON "bp_identifiers"("business_partner_id");
CREATE INDEX "bp_relationships_tenant_id_idx" ON "bp_relationships"("tenant_id");
CREATE INDEX "bp_relationships_business_partner_id_idx" ON "bp_relationships"("business_partner_id");
CREATE INDEX "bp_relationships_related_business_partner_id_idx" ON "bp_relationships"("related_business_partner_id");

ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bp_addresses" ADD CONSTRAINT "bp_addresses_business_partner_id_fkey"
  FOREIGN KEY ("business_partner_id") REFERENCES "business_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bp_identifiers" ADD CONSTRAINT "bp_identifiers_business_partner_id_fkey"
  FOREIGN KEY ("business_partner_id") REFERENCES "business_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bp_relationships" ADD CONSTRAINT "bp_relationships_business_partner_id_fkey"
  FOREIGN KEY ("business_partner_id") REFERENCES "business_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bp_relationships" ADD CONSTRAINT "bp_relationships_related_business_partner_id_fkey"
  FOREIGN KEY ("related_business_partner_id") REFERENCES "business_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (ADR 0002) — same pattern as every other tenant-scoped table.
ALTER TABLE "business_partners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_partners" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_business_partners ON "business_partners"
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "bp_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bp_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_bp_addresses ON "bp_addresses"
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "bp_identifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bp_identifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_bp_identifiers ON "bp_identifiers"
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "bp_relationships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bp_relationships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_bp_relationships ON "bp_relationships"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- No explicit GRANT needed — 0004_least_privilege_app_role.sql's ALTER DEFAULT PRIVILEGES
-- covers every table a future migration creates (verified again for these four tables the
-- same way it was for every migration since).
