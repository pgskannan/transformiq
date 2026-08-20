-- AI-assisted entity match adjudication (Sprint 5 continuation — see
-- src/lib/matching/aiAdjudicator.ts). Adds four nullable columns to entity_matches, mirroring
-- 0013_ai_semantic_suggestions.sql's pattern exactly: a Gemini-assisted second opinion for
-- fuzzy match candidates that land in a genuinely ambiguous confidence band
-- (aiAdjudicator.ts's AMBIGUOUS_CONFIDENCE_RANGE), stored separately from the authoritative
-- "decision" column so it is a recommendation a steward reviews, never an auto-applied merge
-- (AGENTS.md Do-Not-Do rules #1, #3, #4 — same guardrail the existing merge-requires-
-- "approve" permission check on PATCH .../decision already enforces for every decision,
-- human or AI-suggested).
ALTER TABLE "entity_matches" ADD COLUMN "ai_recommendation" TEXT;
ALTER TABLE "entity_matches" ADD COLUMN "ai_confidence" DOUBLE PRECISION;
ALTER TABLE "entity_matches" ADD COLUMN "ai_reasoning" TEXT;
-- Model/provider version string (e.g. "gemini-3.6-flash") — FR-AUD-004/FR-AI-003 traceability,
-- same rationale as 0013. Null whenever ai_recommendation is null (no AI call was made, the
-- candidate wasn't in the ambiguous band, or the call degraded to no suggestion).
ALTER TABLE "entity_matches" ADD COLUMN "ai_model_version" TEXT;

ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_ai_recommendation_check"
  CHECK ("ai_recommendation" IS NULL OR "ai_recommendation" IN ('merge', 'keep_separate', 'uncertain'));
ALTER TABLE "entity_matches" ADD CONSTRAINT "entity_matches_ai_confidence_range_check"
  CHECK ("ai_confidence" IS NULL OR ("ai_confidence" >= 0 AND "ai_confidence" <= 1));

-- No RLS/GRANT changes needed: these are new columns on an existing RLS-enabled,
-- already-granted table (0011_entity_resolution.sql), not a new table.
