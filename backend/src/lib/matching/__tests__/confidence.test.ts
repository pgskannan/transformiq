// TQ-033 (FR-DUP-004): "Every candidate match carries a confidence score and a structured
// evidence payload." Confidence-combination rules are documented in confidence.ts's header.
import { computeMatchConfidence, type MatchEvidence } from "../confidence";

describe("computeMatchConfidence (TQ-033)", () => {
  it("returns 1.0 for an exact identifier match regardless of anything else present", () => {
    const evidence: MatchEvidence = {
      signals: [
        { type: "identifier_exact", detail: "Shared tax_id", score: 1 },
        { type: "name_similarity", detail: "low", score: 0.1 },
      ],
    };
    expect(computeMatchConfidence(evidence)).toBe(1);
  });

  it("blends name + address similarity 0.65/0.35 when both are present", () => {
    const evidence: MatchEvidence = {
      signals: [
        { type: "name_similarity", detail: "", score: 0.8 },
        { type: "address_similarity", detail: "", score: 0.6 },
      ],
    };
    // 0.65*0.8 + 0.35*0.6 = 0.52 + 0.21 = 0.73
    expect(computeMatchConfidence(evidence)).toBeCloseTo(0.73, 4);
  });

  it("discounts a single uncorroborated name-only signal", () => {
    const evidence: MatchEvidence = { signals: [{ type: "name_similarity", detail: "", score: 0.9 }] };
    expect(computeMatchConfidence(evidence)).toBeCloseTo(0.765, 4); // 0.9 * 0.85
  });

  it("discounts a single uncorroborated address-only signal more than a name-only one", () => {
    const evidence: MatchEvidence = { signals: [{ type: "address_similarity", detail: "", score: 0.9 }] };
    expect(computeMatchConfidence(evidence)).toBeCloseTo(0.63, 4); // 0.9 * 0.7
  });

  it("a low address similarity pulls a strong name match's confidence down, not just gets ignored", () => {
    const nameOnly = computeMatchConfidence({ signals: [{ type: "name_similarity", detail: "", score: 0.95 }] });
    const nameWithWeakAddress = computeMatchConfidence({
      signals: [
        { type: "name_similarity", detail: "", score: 0.95 },
        { type: "address_similarity", detail: "", score: 0.05 },
      ],
    });
    expect(nameWithWeakAddress).toBeLessThan(nameOnly);
  });

  it("returns 0 when no signals are present at all", () => {
    expect(computeMatchConfidence({ signals: [] })).toBe(0);
  });

  it("never returns a value outside [0, 1]", () => {
    const evidence: MatchEvidence = {
      signals: [
        { type: "name_similarity", detail: "", score: 1.5 }, // malformed input, defensively clamped
      ],
    };
    const confidence = computeMatchConfidence(evidence);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });
});
