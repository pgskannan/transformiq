# ADR 0003: Gemini integration via Genkit for AI-assisted semantic type resolution

**Status:** Accepted
**Date:** 2026-08-20
**Context:** Hackathon slice of Sprint 5 (TQ-039/040), scoped for the All Things Agentic
Hackathon (allthingsagentichackathon.devpost.com) submission.

## Decision

Implement the AI-assisted second pass for semantic field type inference — the exact
extension point `lib/semantics/engine.ts`'s header comment always described — using
[Genkit](https://genkit.dev) (a Google Agent Framework) with the `@genkit-ai/google-genai`
plugin's `googleAI` initializer, calling Gemini through the public Gemini API with an API
key. This replaces the `lib/vertexAI.ts` stub (previously: always throws "not yet
implemented") with a real implementation.

## Why Genkit + the Gemini API (not raw `@google/generative-ai`, not full Vertex AI/ADC)

- **Genkit is TypeScript-native.** The backend is Node/TypeScript throughout; Genkit's flows,
  structured-output (Zod schema) support, and tracing fit this codebase's existing patterns
  (Zod is already a dependency, used for every request/payload schema in this repo) far more
  naturally than standing up a separate Python ADK service just for one feature.
- **Structured output over free-text parsing.** AGENTS.md Do-Not-Do rule #4 ("never treat
  confidence score alone as authorization") extends to never trusting an unvalidated model
  guess — Genkit's `output: { schema }` plus a second `zod.safeParse()` in
  `aiResolver.ts` means a malformed or hallucinated response degrades to "no suggestion,"
  never a bad write.
- **API-key auth (Gemini API), not Application Default Credentials (Vertex AI/Gemini
  Enterprise Agent Platform).** This sandbox has no live GCP project with billing enabled
  during development (see README "Known gaps" and `docs/adr/0002-gcp-architecture-and-
  tenancy.md`), and API-key auth is what a judge/reviewer can verify in minutes from
  https://aistudio.google.com/apikey without a full GCP project setup. `@genkit-ai/
  google-genai` supports both `googleAI` (API key) and `vertexAI` (ADC or Express-mode API
  key) through one plugin — switching to `vertexAI` later, once a real GCP project exists
  for this backend (as opposed to the separate demo already on Cloud Run — see
  `transformiq_gcp_deploy` notes), is a plugin-config change, not a rewrite.
- **Model:** `gemini-3.6-flash` by default (configurable via `GEMINI_MODEL`) — Gemini 3.5 or
  newer per the hackathon's mandatory stack requirement, Flash tier because AGENTS.md §1.6's
  cost-ascending routing principle applies here too: this module is only ever reached for
  genuine ambiguity the deterministic pass already filtered down to, not bulk classification
  work, so the cheaper/faster tier is the right default.

## What this does NOT change

- The deterministic heuristics engine (`lib/semantics/engine.ts`) is untouched — same pure,
  synchronous, no-I/O function it always was, same tests, same behavior when it successfully
  classifies a column (the common case). The AI call only happens when it returns `null`.
- No field is auto-applied from an AI suggestion. `ai_semantic_type`/`ai_confidence`/
  `ai_reasoning`/`ai_model_version` (migration `0013_ai_semantic_suggestions.sql`) are new,
  separate, nullable columns — `semantic_type` itself is never written by this code path.
- No raw column values ever reach Gemini — see `lib/semantics/aiResolver.ts`'s header comment
  for the shape-generalization privacy rationale (AGENTS.md §3.3).
- A missing `GEMINI_API_KEY` or a failed API call degrades to "no suggestion," not a failed
  profiling job — this feature is additive, never load-bearing for the existing pipeline.

## Google Cloud footprint

- **Secret Manager** (already a real dependency, `lib/secrets.ts`) is how `GEMINI_API_KEY` is
  meant to reach this code in a real deployment — no code change was needed there, only using
  it for one more secret name.
- **Cloud Run** is the deployment target for the backend (`backend/Dockerfile`,
  `backend/cloudbuild.yaml`, both pre-existing from Sprint 1 but never deployed against a real
  project until this hackathon submission — see the deploy runbook this ADR's companion
  hand-off package includes).

## Alternatives considered

- **Vertex AI SDK directly (`@google-cloud/aiplatform`)**, already listed as a possible path
  in the original stub's TODOs. Rejected for this slice: requires a fully configured GCP
  project + ADC before anything works at all, which is a much higher setup bar for a judge
  reproducing the demo than an API key.
- **Google ADK (Python)**, one of the hackathon's other accepted Agent Frameworks. Rejected:
  would mean a second runtime/language in a single-service backend for one feature, with no
  offsetting benefit here (this is a single-shot classification call, not a multi-turn/tool-
  using agent loop where ADK's orchestration would earn its keep).

## Addendum: extending this integration to entity match adjudication

**Date:** 2026-08-20. **Context:** with the deploy pipeline and the first AI feature verified
end-to-end on live Cloud Run, and time remaining before the hackathon deadline, we asked
whether one more strong use case was worth adding rather than treating the semantic-type
slice as the whole submission — see the project's own README "Known gaps" entry on entity
resolution, which flagged AI-assisted second-opinion matching as real, honestly-scoped future
work. AGENTS.md §1.6/FR-AI-001 names exactly four domains for AI assistance —
"normalization, entity resolution, classification, and mapping" — and this ADR's original
decision only covered "classification." "Entity resolution" was the other domain closest to
existing Sprint 4 infrastructure (`lib/matching/engine.ts`'s deterministic/fuzzy matcher
already produces a confidence score and an evidence list per candidate pair — exactly the
shape a second-opinion LLM call needs as input), so it was the natural second slice rather
than a new domain requiring new infrastructure.

**Decision:** reuse this ADR's integration as-is — same Genkit/`googleAI` construction point
in `lib/vertexAI.ts` (`generate()`, unmodified), same `gemini-3.6-flash` default, same
Zod-structured-output-plus-`safeParse` degrade-to-null discipline, same non-authoritative
"suggestion in separate columns" storage pattern (migration
`0014_ai_entity_match_adjudication.sql` mirrors `0013_ai_semantic_suggestions.sql` column-
for-column) — applied to a new module, `lib/matching/aiAdjudicator.ts`, gated by
`isAmbiguousFuzzyMatch()` on the same cost-ascending-routing principle: only fuzzy candidates
in confidence range `[0.5, 0.9)` reach Gemini at all; an exact-identifier match (1.0) is
already maximally certain, and a fuzzy match already past 0.9 has little to gain from a
second opinion.

**One deliberate difference from the semantic-type module, called out explicitly:**
`aiResolver.ts` sends only a structural "shape" of sample values (never the raw value) because
the classification judgment ("does this look like an email/tax ID") only needs the pattern.
Judging "are these two companies the same real-world entity" fundamentally cannot work from
shapes alone — "Acme Corp" and "Acme Corporation" shape-reduce to different strings, and the
actual name/location text is exactly the signal the task needs. So `aiAdjudicator.ts` sends
the real `primary_name` and `city`/`region`/`postal_code`/`country_code` of each Business
Partner. This is a deliberate, documented classification call under AGENTS.md §3.3, not an
oversight: BP name/address is **Confidential** (commercial information about a company), not
**Restricted** (personal/tax/banking identifiers) — Confidential's rule is "minimize/mask
where possible," not the harder Restricted default-redact. The module honors the "minimize"
half even though it doesn't need the full mask: it never sends the street address line
(`bp_addresses.line1`, the most personally-locating part of an address), never `bp_identifiers`
(tax IDs, etc.), and never `Suppliers` banking/contact fields — none of that is needed to
judge "same company," so none of it is sent. This tradeoff is unit-tested directly
(`aiAdjudicator.test.ts`'s privacy-shaped assertion: the prompt contains `primaryName`/city,
never `line1` or an identifier-shaped value).

**What this does NOT change**, mirroring this ADR's original list: the deterministic fuzzy
matcher is untouched (same pure SQL/trigram logic, same tests, same behavior for every
candidate outside the ambiguous band — the common case); no field is auto-applied from an AI
suggestion (`ai_recommendation` is never written to `entity_matches.decision`, and the
existing merge-requires-`approve` guardrail is completely unaffected by this feature); a
missing key or failed call degrades to "no suggestion," never a blocked match-detection run.
