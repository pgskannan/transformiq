// AI-assisted entity match adjudication (Sprint 5 continuation, TQ-039/040's sibling slice).
// lib/matching/engine.ts's deterministic detectors (exact identifier + pg_trgm fuzzy name/
// address similarity) already handle FR-DUP-001/002 without any AI involvement — this module
// exists only for the fuzzy candidates that land in a genuinely ambiguous confidence band,
// where a raw similarity number alone gives a steward little to reason from. This is the
// second of the two domains AGENTS.md §1.6 (FR-AI-001) names for AI assistance —
// "classification" was semantic type resolution (lib/semantics/aiResolver.ts); this is
// "entity resolution." Same architecture, same file layout, same privacy posture, applied to
// a different judgment call.
//
// Privacy (AGENTS.md §3.3): Business Partner name and city/region/postal/country are
// Confidential (commercial information about a company, not a natural person's personal
// data) — "minimize/mask where possible," not the harder Restricted-class block that applies
// to personal/tax/banking identifiers. Unlike aiResolver.ts's structural "shape" abstraction
// (sufficient there because the whole judgment was "does this look like an email/tax ID"),
// judging whether two company names/locations plausibly refer to the same real-world entity
// fundamentally requires the actual text — a shape-only view ("AAAA AAAA" for "Acme Corp")
// would destroy the exact signal the task needs, which would be building something that only
// looks privacy-safe while quietly not doing its job. So this module DOES send the primary
// name and city/region/postal/country of each side. It still minimizes deliberately: never
// the street address line (bp_addresses.line1 — the most personally-locating part of an
// address), never tax IDs/other bp_identifiers, never Supplier banking/contact fields — none
// of that is needed to judge "same company," so none of it is sent, matching the "minimize"
// half of the Confidential default even though this class doesn't require the full mask.
//
// Cost-ascending routing (AGENTS.md §1.6): only reached for matchMethod "fuzzy" candidates
// with confidence in AMBIGUOUS_CONFIDENCE_RANGE below — an exact-identifier match (confidence
// 1.0) is already maximally certain and never reaches this module, and a fuzzy match already
// past the "fairly confident" edge of that range has little to gain from a second opinion.
//
// Same non-authoritative posture as aiResolver.ts: the result is stored in ai_recommendation/
// ai_confidence/ai_reasoning/ai_model_version (migration 0014), never written to
// entity_matches.decision — only a human (via PATCH .../decision, still gated by the existing
// merge-requires-"approve" guardrail) can record an actual decision. A failed/unconfigured
// call degrades to `null`, never blocking the match-detection run.

import { z } from "zod";
import { generate } from "../vertexAI";
import type { MatchCandidate } from "./engine";

export type MatchRecommendation = "merge" | "keep_separate" | "uncertain";

// Lower bound matches lib/matching/engine.ts's FUZZY_NAME_SIMILARITY_THRESHOLD — nothing
// below that is even considered a candidate. Upper bound is deliberately short of 1.0: a
// blended confidence this high (see confidence.ts) means both name and address similarity
// were already very strong, which is about as certain as fuzzy matching gets — AI adjudication
// adds the least value there and cost-ascending routing says skip it.
export const AMBIGUOUS_CONFIDENCE_RANGE: [number, number] = [0.5, 0.9];

export function isAmbiguousFuzzyMatch(candidate: MatchCandidate): boolean {
  if (candidate.matchMethod !== "fuzzy") return false;
  const [low, high] = AMBIGUOUS_CONFIDENCE_RANGE;
  return candidate.confidence >= low && candidate.confidence < high;
}

const RECOMMENDATION_SCHEMA = z.object({
  recommendation: z.enum(["merge", "keep_separate", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(400),
});

export interface AIMatchAdjudication {
  recommendation: MatchRecommendation;
  confidence: number;
  reasoning: string;
  modelVersion: string;
}

export interface BusinessPartnerAISummary {
  primaryName: string;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

function describeSide(label: string, bp: BusinessPartnerAISummary): string {
  const location = [bp.city, bp.region, bp.postalCode, bp.countryCode].filter(Boolean).join(", ");
  return `${label} name: "${bp.primaryName}"${location ? ` — location: ${location}` : " — no location on file"}`;
}

function buildPrompt(
  a: BusinessPartnerAISummary,
  b: BusinessPartnerAISummary,
  candidate: MatchCandidate
): string {
  const signalLines = candidate.evidence.signals
    .map((s) => `- ${s.type}: ${s.detail} (score ${s.score.toFixed(2)})`)
    .join("\n");

  return [
    "You are helping a data steward at a company decide whether two Business Partner records",
    "in a procurement system (e.g. from an SAP migration) represent the SAME real-world",
    "company, or two genuinely different companies that happen to look similar.",
    "",
    describeSide("Record A", a),
    describeSide("Record B", b),
    "",
    "Deterministic similarity signals already computed for this pair:",
    signalLines,
    "",
    "Consider common real-world patterns: legal-entity suffix differences (Corp/Corporation/",
    'Ltd/Inc), abbreviations, minor spelling variants, and DBA names usually mean the SAME',
    "company. Similar names at clearly different locations, or generic/common business names",
    "that happen to collide, usually mean DIFFERENT companies. You were not shown any other",
    "identifying details (tax IDs, banking, contacts) — decide from name and location only.",
    "",
    'Respond with your best recommendation: "merge" (same company), "keep_separate"',
    '(different companies), or "uncertain" (genuinely can\'t tell from what you were shown).',
    "Give a short reasoning grounded only in the names/locations and signals above.",
  ].join("\n");
}

/** Only ever called for candidates isAmbiguousFuzzyMatch() has already approved — callers
 *  (routes/entityMatches.ts) are responsible for that gate, same division of responsibility
 *  as lib/semantics/aiResolver.ts and its caller. */
export async function resolveAmbiguousMatch(
  candidate: MatchCandidate,
  businessPartner: BusinessPartnerAISummary,
  candidateBusinessPartner: BusinessPartnerAISummary
): Promise<AIMatchAdjudication | null> {
  const prompt = buildPrompt(businessPartner, candidateBusinessPartner, candidate);

  let response;
  try {
    response = await generate({ prompt, outputSchema: RECOMMENDATION_SCHEMA });
  } catch {
    // Not configured (no GEMINI_API_KEY) or a transient API failure. Same posture as
    // aiResolver.ts: degrade quietly, never block the match-detection run.
    return null;
  }

  const parsed = RECOMMENDATION_SCHEMA.safeParse(response.output);
  if (!parsed.success) return null;

  return {
    recommendation: parsed.data.recommendation,
    confidence: parsed.data.confidence,
    reasoning: parsed.data.reasoning,
    modelVersion: response.model,
  };
}
