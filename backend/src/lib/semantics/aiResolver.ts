// AI-assisted semantic type resolution (Sprint 5, TQ-039/040 slice) — the second-pass signal
// engine.ts's header comment always intended for columns the deterministic heuristics
// genuinely cannot classify (inferSemanticType() returns null). Only reached for that
// genuine-ambiguity case: never called for a column the deterministic pass already resolved
// (AGENTS.md Do-Not-Do rule #17 — never route a cheap decision through an LLM just because
// it's available; §1.6 cost-ascending routing).
//
// Privacy: this module never sends raw column values to Gemini. AGENTS.md §3.3 classifies
// personal/tax/banking identifiers as Restricted, defaulting to masked/redacted before any
// external AI call, and there is no per-field classification metadata yet to tell a real tax
// ID column from an ordinary string column — so instead of guessing, every sample value is
// reduced to its *structural shape* only (reusing lib/profiling/engine.ts's shape(): digit
// runs -> "D", letter runs -> "A", punctuation kept) plus the column name. That is enough for
// a model to recognize "this looks like an email" or "this looks like a tax ID" from
// structure alone, without ever seeing a real name, address, or identifier value.
//
// The result is always a *suggestion*, never an authoritative classification: callers must
// store it separately from field_profiles.semantic_type (see migration 0013's
// ai_semantic_type/ai_confidence/ai_reasoning columns) so a steward reviews it like any other
// AI recommendation (AGENTS.md Do-Not-Do rules #1 and #4 — AI output is a recommendation
// until a human approves it; confidence alone is never authorization). A failed or
// unconfigured call degrades to `null`, never a thrown error — the deterministic profiling
// pipeline must keep working even when Gemini is unreachable, same "AI is additive, never
// load-bearing" posture as the rest of this codebase.

import { z } from "zod";
import { generate } from "../vertexAI";
import { shape } from "../profiling/engine";
import type { ColumnType } from "../ingestion/detect";
import type { SemanticType } from "./engine";

export const CANDIDATE_SEMANTIC_TYPES: SemanticType[] = [
  "email",
  "url",
  "phone_number",
  "currency_code",
  "country_code",
  "postal_code",
  "percentage",
  "currency_amount",
  "identifier",
  "tax_id",
  "organization_name",
  "person_name",
  "address_line",
];

const ALLOWED_SUGGESTION_TYPES = [...CANDIDATE_SEMANTIC_TYPES, "unknown"] as unknown as [
  string,
  ...string[],
];

const SUGGESTION_SCHEMA = z.object({
  semanticType: z.enum(ALLOWED_SUGGESTION_TYPES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(400),
});

export interface AISemanticSuggestion {
  semanticType: SemanticType;
  confidence: number;
  reasoning: string;
  modelVersion: string;
}

// Capped, deduplicated — keeps the prompt small and bounds cost regardless of dataset size
// (a 500k-row column still yields at most this many distinct shapes to reason about).
const MAX_SAMPLE_SHAPES = 12;

/** Exported for tests: turns raw sample values into the privacy-safe shapes actually sent to
 *  Gemini. Never returns a raw value. */
export function shapesForAI(rawValues: string[]): string[] {
  const nonEmpty = rawValues.map((v) => (v ?? "").trim()).filter((v) => v !== "");
  const distinctShapes = Array.from(new Set(nonEmpty.map(shape)));
  return distinctShapes.slice(0, MAX_SAMPLE_SHAPES);
}

function buildPrompt(columnName: string, inferredType: ColumnType, sampleShapes: string[]): string {
  return [
    "You are classifying a database column's semantic type from structural SHAPE patterns",
    'only (letter runs generalized to "A", digit runs to "D", punctuation kept as-is) — you',
    "are not shown any real data values, only their shape, for privacy.",
    "",
    `Column name: "${columnName}"`,
    `Structural type: ${inferredType}`,
    `Sample value shapes: ${JSON.stringify(sampleShapes)}`,
    "",
    `Pick the single best-fitting semantic type from exactly this list: ` +
      `${CANDIDATE_SEMANTIC_TYPES.join(", ")}, or "unknown" if none genuinely fit — do not`,
    "invent a type outside this list. Give a short reasoning grounded only in the column name",
    "and the shape patterns you were shown.",
  ].join("\n");
}

export async function resolveAmbiguousSemanticType(input: {
  columnName: string;
  inferredType: ColumnType;
  rawValues: string[];
}): Promise<AISemanticSuggestion | null> {
  const sampleShapes = shapesForAI(input.rawValues);
  if (sampleShapes.length === 0) return null;

  const prompt = buildPrompt(input.columnName, input.inferredType, sampleShapes);

  let response;
  try {
    response = await generate({ prompt, outputSchema: SUGGESTION_SCHEMA });
  } catch {
    // Not configured (no GEMINI_API_KEY) or a transient API failure. See header comment:
    // this must degrade quietly, not block or fail the deterministic profiling job.
    return null;
  }

  const parsed = SUGGESTION_SCHEMA.safeParse(response.output);
  if (!parsed.success || parsed.data.semanticType === "unknown") return null;

  return {
    semanticType: parsed.data.semanticType as SemanticType,
    confidence: parsed.data.confidence,
    reasoning: parsed.data.reasoning,
    modelVersion: response.model,
  };
}
