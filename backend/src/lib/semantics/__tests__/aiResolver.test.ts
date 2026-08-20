// Mocked unit tests for the Gemini-assisted second pass (TQ-039/040). Never calls a real
// Gemini API — lib/vertexAI.ts's generate() is mocked, same "mock the one construction/call
// point" approach the rest of this codebase uses for GCS/Secret Manager. This means these
// tests run in plain `jest`/CI with no GEMINI_API_KEY and no network, same as every other
// test in this repo (see jest.config.js — no live-API suite exists here on purpose).
import { resolveAmbiguousSemanticType, shapesForAI, CANDIDATE_SEMANTIC_TYPES } from "../aiResolver";
import * as vertexAI from "../../vertexAI";

jest.mock("../../vertexAI");
const mockGenerate = vertexAI.generate as jest.MockedFunction<typeof vertexAI.generate>;

describe("shapesForAI — privacy-safe sample reduction", () => {
  it("never returns a raw value — only its shape", () => {
    const shapes = shapesForAI(["alice@acme.com", "94105-1234"]);
    expect(shapes).not.toContain("alice@acme.com");
    expect(shapes).not.toContain("94105-1234");
    // Reuses profiling/engine.ts's shape() as-is (letter runs -> "A", digit runs -> "D", then
    // a second pass over the *result* also folds any lone "D" placeholder into "A" since "D"
    // is itself alphabetic — an existing, already-tested quirk of that shared function, not
    // something this module changes. Net effect: punctuation position/count is preserved
    // (still enough signal for "this looks like an email"), digit-vs-letter is not — which is
    // fine, arguably better, for the privacy goal here.
    expect(shapes).toEqual(expect.arrayContaining(["A@A.A", "A-A"]));
  });

  it("drops empty values and de-duplicates identical shapes", () => {
    const shapes = shapesForAI(["12345", "67890", "", "  ", "54321"]);
    expect(shapes).toEqual(["A"]); // all three non-empty values share the same shape (see above)
  });

  it("caps the number of shapes sent, regardless of dataset size", () => {
    const manyDistinctValues = Array.from({ length: 500 }, (_, i) => `value-${i}-${"x".repeat(i % 5)}`);
    const shapes = shapesForAI(manyDistinctValues);
    expect(shapes.length).toBeLessThanOrEqual(12);
  });

  it("returns an empty array for an all-empty column", () => {
    expect(shapesForAI(["", "  ", ""])).toEqual([]);
  });
});

describe("resolveAmbiguousSemanticType — routing and degradation", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("returns null without calling Gemini when there is no usable sample (cost-ascending routing)", async () => {
    const result = await resolveAmbiguousSemanticType({
      columnName: "notes",
      inferredType: "string",
      rawValues: ["", "  ", ""],
    });
    expect(result).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns a validated suggestion on a well-formed structured response", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: {
        semanticType: "tax_id",
        confidence: 0.82,
        reasoning: "Column name and consistent alphanumeric shape suggest a tax identifier.",
      },
    });

    const result = await resolveAmbiguousSemanticType({
      columnName: "fed_tax_number",
      inferredType: "string",
      rawValues: ["12-3456789", "98-7654321"],
    });

    expect(result).toEqual({
      semanticType: "tax_id",
      confidence: 0.82,
      reasoning: expect.any(String),
      modelVersion: "gemini-3.6-flash",
    });
  });

  it("never sends a raw value to the model — only shapes and the column name reach the prompt", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: { semanticType: "unknown", confidence: 0.1, reasoning: "insufficient signal" },
    });

    await resolveAmbiguousSemanticType({
      columnName: "ssn",
      inferredType: "string",
      rawValues: ["078-05-1120"],
    });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const call = mockGenerate.mock.calls[0][0];
    expect(call.prompt).not.toContain("078-05-1120");
    expect(call.prompt).toContain("ssn");
  });

  it("degrades to null, not a thrown error, when the model returns 'unknown'", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: { semanticType: "unknown", confidence: 0.2, reasoning: "no clear signal" },
    });

    const result = await resolveAmbiguousSemanticType({
      columnName: "misc_field",
      inferredType: "string",
      rawValues: ["abc123", "xyz789"],
    });
    expect(result).toBeNull();
  });

  it("degrades to null, not a thrown error, when the model's output fails schema validation", async () => {
    mockGenerate.mockResolvedValue({
      text: "",
      model: "gemini-3.6-flash",
      output: { semanticType: "not_a_real_type", confidence: 2, reasoning: "" },
    });

    const result = await resolveAmbiguousSemanticType({
      columnName: "weird_field",
      inferredType: "string",
      rawValues: ["abc123"],
    });
    expect(result).toBeNull();
  });

  it("degrades to null, not a thrown error, when Gemini is not configured (generate() throws)", async () => {
    mockGenerate.mockRejectedValue(new Error('Secret "GEMINI_API_KEY" not found in environment.'));

    const result = await resolveAmbiguousSemanticType({
      columnName: "unclassified_col",
      inferredType: "string",
      rawValues: ["abc123", "def456"],
    });
    expect(result).toBeNull();
  });

  it("only ever suggests a type from the declared candidate list", async () => {
    for (const candidate of CANDIDATE_SEMANTIC_TYPES) {
      mockGenerate.mockResolvedValueOnce({
        text: "",
        model: "gemini-3.6-flash",
        output: { semanticType: candidate, confidence: 0.9, reasoning: "test" },
      });
      const result = await resolveAmbiguousSemanticType({
        columnName: "some_column",
        inferredType: "string",
        rawValues: ["sample"],
      });
      expect(result?.semanticType).toBe(candidate);
    }
  });
});
