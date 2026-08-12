// Match confidence + evidence model (TQ-033, FR-DUP-004): "Every candidate match carries a
// confidence score and a structured evidence payload."
//
// A structured list of named signals — not a free-text explanation string — because both a
// steward-facing comparison screen (TQ-038) and any future automated policy check need to
// enumerate *which* fields corroborated a match, not just read a sentence about it.

export type MatchSignalType = "identifier_exact" | "name_similarity" | "address_similarity";

export interface MatchSignal {
  type: MatchSignalType;
  /** Human-readable detail for the steward-facing comparison screen. */
  detail: string;
  /** This signal's own strength in isolation, 0..1 — NOT yet combined into overall confidence. */
  score: number;
}

export interface MatchEvidence {
  signals: MatchSignal[];
}

/**
 * Combines a candidate's evidence signals into a single 0..1 confidence score.
 *
 * Rules (documented here since there's no separate confidence-model spec to cite):
 *  - An exact configured-identifier match (TQ-031) is treated as definitive on its own:
 *    confidence 1.0, regardless of what else is or isn't present. This mirrors FR-DUP-001
 *    being checked before FR-DUP-002 in the matching pipeline (lib/matching/engine.ts) —
 *    exact identity is the strongest evidence type this system has.
 *  - Otherwise (fuzzy-only), name and address similarity are blended 0.65/0.35 when both are
 *    available — name carries more weight since every BP has one and address data quality
 *    varies more, but a low address similarity still pulls the blended score down rather than
 *    being ignored: two same-named entities at very different addresses are less likely to
 *    actually be the same real-world BP, and that should show up in confidence, not just in
 *    a discarded signal.
 *  - A single uncorroborated signal (name only, no address data to compare) is discounted —
 *    0.85x for name alone — reflecting that one signal alone is weaker evidence than the same
 *    score corroborated by a second, independent signal. This also keeps a lone borderline
 *    fuzzy name match below the 95% "auto-remediation-eligible" band in AGENTS.md §2.4 even
 *    when its raw similarity score is very high, which is the right conservative default for
 *    a signal this system has never independently corroborated. (Not that confidence alone
 *    authorizes anything here anyway — see AGENTS.md Do-Not-Do #3/#4 — but the discount keeps
 *    the number itself honest about how much evidence actually backs it.)
 */
export function computeMatchConfidence(evidence: MatchEvidence): number {
  const identifierExact = evidence.signals.find((s) => s.type === "identifier_exact");
  if (identifierExact) return 1;

  const nameSig = evidence.signals.find((s) => s.type === "name_similarity");
  const addressSig = evidence.signals.find((s) => s.type === "address_similarity");

  let raw: number;
  if (nameSig && addressSig) {
    raw = 0.65 * nameSig.score + 0.35 * addressSig.score;
  } else if (nameSig) {
    raw = nameSig.score * 0.85;
  } else if (addressSig) {
    raw = addressSig.score * 0.7; // address alone is a weaker standalone signal than name alone
  } else {
    raw = 0;
  }

  const clamped = Math.min(1, Math.max(0, raw));
  return Math.round(clamped * 10000) / 10000; // matches the entity_matches.confidence NUMERIC(5,4) column
}
