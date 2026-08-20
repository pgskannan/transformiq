// Mocked unit tests for the Gemini-assisted entity match adjudicator (Sprint 5 continuation,
// TQ-039/040's sibling slice). Never calls a real Gemini API — lib/vertexAI.ts's generate() is
// mocked, same "mock the one construction/call point" approach as
// lib/semantics/__tests__/aiResolver.test.ts. Runs in plain `jest`/CI with no GEMINI_API_KEY
// and no network.
import {
  resolveAmbiguousMatch,
  isAmbiguousFuzzyMatch,
  AMBIGUOUS_CONFIDENCE_RANGE,
  type BusinessPartnerAISummary,
} from "../aiAdjudicator";
import type { MatchCandidate } from "../engine";
import * as vertexAI from "../../vertexAI";

jest.mock("../../vertexAI");
const mockGenerate = vertexAI.generate as jest.MockedFunction<typeof vertexAI.generate>;

function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    businessPartnerId: "bp-a",
    candidateBusinessPartnerId: "bp-b",
    matchMethod: "fuzzy",
    confidence: 0.7,
    evidence: {
      signals: [{ type: "name_similarity", detail: "Name trigram similarity 0.70", score: 0.7 }],
    },
    ...overrides,
  };
}

const RECORD_A: BusinessPartnerAISummary = {
  primaryName: "Acme Corp",
  city: "Springfield",
  region: "IL",
  postalCode: "62701",
  countryCode: "US",
};

const RECORD_B: BusinessPartnerAISummary = {
  primaryName: "Acme Corporation",
  city: "Springfield",
  region: "IL",
  postalCode: "62701",
  countryCode: "US",
};

describe("isAmbiguousFuzzyMatch — cost-ascending routing band", () => {
  const [low, high] = AMBIGUOUS_CONFIDENCE_RANGE;

  it("is true for a fuzzy candidate inside the ambiguous band", () => {
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "fuzzy", confidence: 0.7 }))).toBe(true);
  });

  it("is false for a fuzzy candidate below the band's lower bound", () => {
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "fuzzy", confidence: low - 0.01 }))).toBe(false);
  });

  it("is true at the lower bound itself (inclusive)", () => {
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "fuzzy", confidence: low }))).toBe(true);
  });

  it("is false at/above the band's upper bound (exclusive)", () => {
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "fuzzy", confidence: high }))).toBe(false);
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "fuzzy", confidence: 0.99 }))).toBe(false);
  });

  it("is false for an exact-method candidate regardless of confidence — already maximally certain", () => {
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "exact", confidence: 1.0 }))).toBe(false);
    expect(isAmbiguousFuzzyMatch(makeCandidate({ matchMethod: "exact", confidence: 0.7 }))).toBe(false);
  });
});

describe("resolveAmbiguousMatch — structured parsing and degradation", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("returns a validated adjudication on a well-formed structured response", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: {
        recommendation: "merge",
        confidence: 0.88,
        reasoning: "Same name (legal-suffix variant) and identical location.",
      },
    });

    const result = await resolveAmbiguousMatch(makeCandidate(), RECORD_A, RECORD_B);

    expect(result).toEqual({
      recommendation: "merge",
      confidence: 0.88,
      reasoning: expect.any(String),
      modelVersion: "gemini-3.6-flash",
    });
  });

  it("degrades to null, not a thrown error, when Gemini is not configured (generate() throws)", async () => {
    mockGenerate.mockRejectedValue(new Error('Secret "GEMINI_API_KEY" not found in environment.'));

    const result = await resolveAmbiguousMatch(makeCandidate(), RECORD_A, RECORD_B);
    expect(result).toBeNull();
  });

  it("degrades to null, not a thrown error, when the model's output fails schema validation", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: { recommendation: "not_a_real_recommendation", confidence: 2, reasoning: "" },
    });

    const result = await resolveAmbiguousMatch(makeCandidate(), RECORD_A, RECORD_B);
    expect(result).toBeNull();
  });

  it("only ever recommends a value from the declared MatchRecommendation set", async () => {
    for (const recommendation of ["merge", "keep_separate", "uncertain"] as const) {
      mockGenerate.mockResolvedValueOnce({
        text: "",
        model: "gemini-3.6-flash",
        output: { recommendation, confidence: 0.75, reasoning: "test" },
      });
      const result = await resolveAmbiguousMatch(makeCandidate(), RECORD_A, RECORD_B);
      expect(result?.recommendation).toBe(recommendation);
    }
  });

  it("sends primary name and location to the model, but never a street address line or an identifier value", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: { recommendation: "uncertain", confidence: 0.5, reasoning: "insufficient signal" },
    });

    await resolveAmbiguousMatch(makeCandidate(), RECORD_A, RECORD_B);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const call = mockGenerate.mock.calls[0][0];
    // Confidential-but-minimized data (AGENTS.md §3.3) DOES reach the prompt for this module —
    // name/city/region/postal/country are needed for the actual judgment, unlike aiResolver.ts's
    // shape-only approach.
    expect(call.prompt).toContain("Acme Corp");
    expect(call.prompt).toContain("Springfield");
    // Never sent: street address line1, or anything identifier/tax-ID-shaped — this module's
    // BusinessPartnerAISummary type has no field for either, so there is nothing in the prompt
    // builder's inputs that could leak them even by mistake.
    expect(call.prompt).not.toContain("line1");
    expect(call.prompt).not.toMatch(/\b\d{2}-\d{7}\b/); // EIN-shaped value
    expect(call.prompt).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/); // SSN-shaped value
  });

  it("passes the deterministic evidence signals through to the prompt for grounding", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: { recommendation: "merge", confidence: 0.8, reasoning: "test" },
    });

    await resolveAmbiguousMatch(
      makeCandidate({
        evidence: {
          signals: [
            { type: "name_similarity", detail: "Name trigram similarity 0.70", score: 0.7 },
            { type: "address_similarity", detail: "Primary-address trigram similarity 0.65", score: 0.65 },
          ],
        },
      }),
      RECORD_A,
      RECORD_B
    );

    const call = mockGenerate.mock.calls[0][0];
    expect(call.prompt).toContain("name_similarity");
    expect(call.prompt).toContain("address_similarity");
  });
});
