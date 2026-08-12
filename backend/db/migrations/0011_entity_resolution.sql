-- Entity resolution schema (TQ-031/032/033/034/035, FR-DUP-001/002/004/005/006). Sprint 4
-- scope: detect candidate duplicate Business Partners (exact identifier match + fuzzy
-- name/address similarity), record confidence + structured evidence per candidate, and let a
-- steward decide Merge / Keep Separate / Reject / Needs Review on each one.
--
-- Deliberately NOT in scope here: actually merging the two BP records into one (rewriting
-- foreign keys, deleting/redirecting the loser row). AGENTS.md Do-Not-Do #3 and FR-DUP-006
-- forbid an *automatic* merge, but even an *authorized* merge is real, governed data mutation
-- with its own rollback/audit story — that's the remediation execution engine, TQ-062,
-- Sprint 7. Recording a "merge" decision here is the trigger that later feeds that engine; it
-- does not itself touch business_partners rows. Same separation-of-concerns the profiling
-- (Sprint 3) and remediation (Sprint 7) split already established: decide now, execute later,
-- both governed and both audited, but not the same transaction or even the same sprint.
--
-- pg_trgm powers the fuzzy-match similarity() calls in lib/matching/engine.ts (TQ-032) and
-- the GIN trigram index below (TQ-082) that keeps those queries off a full table scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One row per unordered candidate pair of business_partners believed to represent the same
-- real-world entity. "Unordered" matters: A-matches-B and B-matches-A are the same fact, not
-- two — unlike bp_relationships (0010), which is a genuinely directed edge (subsidiary_of has
-- a direction; "these two records are duplicates of each other" does not). To keep exactly one
-- row per pair, the app always inserts with business_partner_id < candidate_business_partner_id
-- (plain TEXT/UUID comparison) and the CHECK below enforces that ordering — a second detection
-- pass finding the same pair again hits the UNIQUE constraint instead of creating a mirror row.
CREATE TABLE "entity_matches" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    -- Generic on purpose — Do-Not-Do #3 names BP, Supplier, and Material as things that must
    -- never auto-merge, implying this table's shape is meant to be reused for all three.
    -- Sprint 4 only populates 'business_partner'; the CHECK is intentionally narrow rather
    -- than pre-declaring 'supplier'/'material' values nothing can produce yet — widen it in
    -- the sprint that actually builds Supplier- or Material-level matching, not before.
    "entity_type" TEXT NOT NULL DEFAULT 'business_partner',
    "business_partner_id" TEXT NOT NULL,
    "candidate_business_partner_id" TEXT NOT NULL,
    -- FR-DUP-001 vs FR-DUP-002 — which detector produced this candidate. A pair can in
    -- principle be found by both; the app keeps the higher-confidence row on conflict (see
    -- lib/matching/engine.ts) rather than storing one row per method.
    "match_method" TEXT NOT NULL,
    -- FR-DUP-004: confidence is a plain 0..1 fraction (not a 0-100 int) to match the
    -- 95%/75% bands in AGENTS.md §2.4 without a scaling step at every call site.
    -- DOUBLE PRECISION, not NUMERIC — same choice 0007_profiling.sql made for its score
    -- columns, and for the same reason: node-postgres returns NUMERIC as a string (to avoid
    -- silent float precision loss on arbitrary-precision values), which is the wrong default
    -- for a plain 0..1 score every call site treats as a number.
    "confidence" DOUBLE PRECISION NOT NULL,
    -- FR-DUP-004's "structured evidence payload" — see lib/matching/confidence.ts's
    -- MatchEvidence shape (list of named signals, each with its own contribution) rather than
    -- a free-text explanation string; a steward-facing UI and a future automated audit both
    -- need to enumerate *which* fields corroborated the match, not just read a sentence.
    "evidence" JSONB NOT NULL,
    -- FR-DUP-005: exactly these four states, nothing else.
    "decision" TEXT NOT NULL DEFAULT 'needs_review',
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "entity_matches_entity_type_check" CHECK ("entity_type" IN ('business_partner')),
    CONSTRAINT "entity_matches_match_method_check" CHECK ("match_method" IN ('exact', 'fuzzy')),
    CONSTRAINT "entity_matches_confidence_range_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
    CONSTRAINT "entity_matches_decision_check"
      CHECK ("decision" IN ('needs_review', 'merge', 'keep_separate', 'reject')),
    CONSTRAINT "entity_matches_not_self_check"
      CHECK ("business_partner_id" != "candidate_business_partner_id"),
    CONSTRAINT "entity_matches_canonical_order_check"
      CHECK ("business_partner_id" < "candidate_business_partner_id"),
    CONSTRAINT "entity_matches_pair_unique" UNIQUE ("business_partner_id", "candidate_business_partner_id")
);

CREATE INDEX "entity_matches_tenant_id_idx" ON "entity_matches"("tenant_id");
CREATE INDEX "entity_matches_project_id_idx" ON "entity_matches"("project_id");
CREATE INDEX "entity_matches_business_partner_id_idx" ON "entity_matches"("business_partner_id");
CREATE INDEX "entity_matches_candidate_business_partner_id_idx" ON "entity_matches"("candidate_business_partner_id");
CREATE INDEX "entity_matches_decision_idx" ON "entity_matches"("decision");

ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_business_partner_id_fkey"
  FOREIGN KEY ("business_partner_id") REFERENCES "business_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_candidate_business_partner_id_fkey"
  FOREIGN KEY ("candidate_business_partner_id") REFERENCES "business_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entity_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_matches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_entity_matches ON "entity_matches"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- TQ-082 (Cloud SQL indexing & pg_trgm tuning): the fuzzy-match query in
-- lib/matching/engine.ts runs `similarity(a.primary_name, b.primary_name)` across every BP
-- pair in a project. A GIN trigram index on primary_name lets Postgres use the `%` similarity
-- operator's index support instead of a full sequential scan + compute-similarity-for-every-
-- row; see docs/adr/0002-gcp-architecture-and-tenancy.md's TQ-082 addendum for the local
-- latency numbers this was actually measured against (no Cloud SQL instance is reachable from
-- this sandbox — same documented gap as every other GCP-dependent item in this project).
-- Indexed on upper(primary_name), not the raw column: lib/matching/engine.ts's fuzzy query
-- compares upper(a.primary_name) against upper(b.primary_name) so that casing differences
-- ("Acme Corp" vs "ACME CORP") don't erode trigram similarity purely from letter-case noise.
-- An expression index only accelerates a query using that exact expression, so the query and
-- the index must stay in sync — see the fuzzy-match query for the matching expression.
CREATE INDEX "business_partners_primary_name_trgm_idx"
  ON "business_partners" USING GIN ((upper("primary_name")) gin_trgm_ops);

-- No explicit GRANT needed — 0004_least_privilege_app_role.sql's ALTER DEFAULT PRIVILEGES
-- covers every table a future migration creates (verified again for this table below).
