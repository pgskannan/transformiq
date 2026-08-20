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
