-- AI-assisted semantic type suggestions (Sprint 5, TQ-039/040 slice — see
-- src/lib/semantics/aiResolver.ts). Adds four nullable columns to field_profiles for the
-- Gemini-assisted second pass over columns the deterministic heuristics engine
-- (semantic_type IS NULL) genuinely could not classify.
--
-- Deliberately separate from the existing "semantic_type" column rather than overwriting it
-- with an AI guess: AGENTS.md Do-Not-Do rules #1 and #4 mean an AI suggestion is never
-- authoritative on its own — a steward reviews ai_semantic_type/ai_confidence/ai_reasoning
-- like any other AI recommendation. No new table (no dataset_profiles/field_profiles
-- restructure) — this is additive, matching the "extend when a sprint actually needs it"
-- pattern already used for suppliers (migration 0012) and prior additive columns here.
ALTER TABLE "field_profiles" ADD COLUMN "ai_semantic_type" TEXT;
ALTER TABLE "field_profiles" ADD COLUMN "ai_confidence" DOUBLE PRECISION;
ALTER TABLE "field_profiles" ADD COLUMN "ai_reasoning" TEXT;
-- Model/provider version string (e.g. "gemini-3.6-flash") the suggestion came from —
-- FR-AUD-004/FR-AI-003 require every AI-influenced value to be traceable to the model
-- version that produced it. Null whenever ai_semantic_type is null (no AI call was made, or
-- it degraded to no suggestion — see aiResolver.ts).
ALTER TABLE "field_profiles" ADD COLUMN "ai_model_version" TEXT;

-- No RLS/GRANT changes needed: these are new columns on an existing RLS-enabled,
-- already-granted table (0007_profiling.sql), not a new table.
