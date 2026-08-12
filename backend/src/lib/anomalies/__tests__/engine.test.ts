import { detectAnomalies, type AnomalyType } from "../engine";

function col(name: string, inferredType: "integer" | "decimal" | "boolean" | "date" | "string") {
  return { name, inferredType };
}

function byType(anomalies: ReturnType<typeof detectAnomalies>, type: AnomalyType) {
  return anomalies.filter((a) => a.anomalyType === type);
}

describe("detectAnomalies", () => {
  it("flags a blank value in an otherwise highly-complete column, but not blanks in a sparse column", () => {
    // 7/8 = 0.875 complete -> the one blank stands out.
    const denseRows = [["a"], ["b"], ["c"], ["d"], ["e"], ["f"], [""], ["g"]];
    const dense = detectAnomalies([col("dense_col", "string")], denseRows);
    expect(byType(dense, "null")).toHaveLength(1);
    expect(byType(dense, "null")[0].rowNumber).toBe(7);

    // 3/8 = 0.375 complete -> blanks are just the column's normal shape, not surprising.
    const sparseRows = [["a"], [""], [""], ["b"], [""], [""], [""], ["c"]];
    const sparse = detectAnomalies([col("sparse_col", "string")], sparseRows);
    expect(byType(sparse, "null")).toHaveLength(0);
  });

  it("flags a value that does not match the column's inferred type as malformed_value", () => {
    const result = detectAnomalies([col("supplier_id", "integer")], [["1"], ["2"], ["3"], ["abc"]]);
    const malformed = byType(result, "malformed_value");
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ rowNumber: 4, columnName: "supplier_id", value: "abc" });
  });

  it("flags numeric outliers via Tukey IQR fences (hand-computed fences)", () => {
    // sorted: [10,20,30,40,41,1000]; Q1=22.5, Q3=40.75, IQR=18.25 ->
    // fences [-4.875, 68.125] -> only 1000 is outside.
    const result = detectAnomalies(
      [col("amount", "integer")],
      [["30"], ["10"], ["1000"], ["20"], ["40"], ["41"]]
    );
    const outliers = byType(result, "outlier");
    expect(outliers).toHaveLength(1);
    expect(outliers[0]).toMatchObject({ rowNumber: 3, value: "1000" });
  });

  it("does not flag outliers when fewer than 4 numeric samples exist (quartiles aren't meaningful yet)", () => {
    const result = detectAnomalies([col("amount", "integer")], [["1"], ["2"], ["1000"]]);
    expect(byType(result, "outlier")).toHaveLength(0);
  });

  it("flags sentinel placeholder values (e.g. 'N/A') as suspicious_pattern even though they pass the loose string type check", () => {
    const result = detectAnomalies(
      [col("region", "string")],
      [["Acme"], ["N/A"], ["Globex"], ["Initech"]]
    );
    const suspicious = byType(result, "suspicious_pattern");
    // "N/A"'s shape ("A/A") also happens to break from the other three pure-letter values'
    // dominant shape ("A") — a second, independent signal legitimately landing on the same
    // cell, not a bug — so this asserts the sentinel-specific entry exists rather than
    // asserting suspicious_pattern's total length (see the DoD test below for the same
    // "multiple signals, one cell" pattern).
    expect(suspicious).toContainEqual(
      expect.objectContaining({
        rowNumber: 2,
        value: "N/A",
        detail: expect.stringMatching(/placeholder/),
      })
    );
    // Passing the loose type check means it must NOT also be flagged malformed_value —
    // proves the sentinel check and the type check are independent signals.
    expect(byType(result, "malformed_value")).toHaveLength(0);
  });

  it("flags a value whose shape breaks from the column's dominant pattern as suspicious_pattern", () => {
    const result = detectAnomalies(
      [col("code", "string")],
      [["AB-123"], ["CD-456"], ["EF-789"], ["GH-012"], ["XY"]]
    );
    const suspicious = byType(result, "suspicious_pattern");
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]).toMatchObject({ rowNumber: 5, value: "XY" });
  });

  it("does not flag shape breaks when no single shape is dominant (a genuinely multi-format column)", () => {
    // shape() collapses digit runs to a literal "D" and THEN collapses all letter runs
    // (including those "D"s) to "A" in a second pass — so punctuation is what keeps shapes
    // distinct: "abc" -> "A", "abc-1" -> "A-A" ("D" is itself a letter, isolated by "-"),
    // "abc-1-x" -> "A-A-A", "abc.1" -> "A.A". Four genuinely distinct shapes, no repeats ->
    // no single shape reaches the 0.6 dominance bar.
    const result = detectAnomalies(
      [col("mixed", "string")],
      [["abc"], ["abc-1"], ["abc-1-x"], ["abc.1"]]
    );
    expect(byType(result, "suspicious_pattern").filter((a) => a.columnName === "mixed")).toHaveLength(0);
  });

  it("flags an exact duplicate row as suspicious_pattern, citing the first occurrence", () => {
    const result = detectAnomalies(
      [col("id", "integer"), col("name", "string")],
      [
        ["1", "Acme"],
        ["2", "Globex"],
        ["1", "Acme"],
      ]
    );
    const suspicious = byType(result, "suspicious_pattern").filter((a) => a.columnName === "*");
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0].rowNumber).toBe(3);
    expect(suspicious[0].detail).toMatch(/duplicate of row 1/);
  });

  it("does not flag two distinct rows that merely share concatenated field content as duplicates (join-collision safety)", () => {
    // Without a safe separator, ["1","23"] and ["12","3"] would both naively join to "123".
    const result = detectAnomalies(
      [col("a", "string"), col("b", "string")],
      [
        ["1", "23"],
        ["12", "3"],
      ]
    );
    expect(byType(result, "suspicious_pattern").filter((a) => a.columnName === "*")).toHaveLength(0);
  });

  it("DoD (TQ-025): a fixture seeded with one anomaly of each of the four types has all of them flagged", () => {
    const columns = [
      col("supplier_id", "integer"),
      col("region", "string"),
      col("credit_limit", "decimal"),
      col("notes", "string"),
    ];
    // Row-by-row: [supplier_id, region, credit_limit, notes]
    const dataRows = [
      ["1", "EMEA", "100.00", "ok"],
      ["2", "APAC", "150.00", "ok"],
      ["3", "EMEA", "120.00", "ok"],
      ["4", "APAC", "N/A", "ok"], // seeded: sentinel placeholder in credit_limit
      ["5", "EMEA", "130.00", ""], // seeded: blank "notes" in an otherwise-full column
      ["6", "APAC", "not-a-number", "ok"], // seeded: malformed_value in credit_limit
      ["7", "EMEA", "9999999.00", "ok"], // seeded: numeric outlier in credit_limit
      ["8", "APAC", "140.00", "ok"],
    ];

    const anomalies = detectAnomalies(columns, dataRows);
    const types = new Set(anomalies.map((a) => a.anomalyType));

    expect(types.has("null")).toBe(true);
    expect(types.has("malformed_value")).toBe(true);
    expect(types.has("outlier")).toBe(true);
    expect(types.has("suspicious_pattern")).toBe(true);

    expect(anomalies).toContainEqual(
      expect.objectContaining({ rowNumber: 5, columnName: "notes", anomalyType: "null" })
    );
    expect(anomalies).toContainEqual(
      expect.objectContaining({ rowNumber: 6, columnName: "credit_limit", anomalyType: "malformed_value" })
    );
    expect(anomalies).toContainEqual(
      expect.objectContaining({ rowNumber: 7, columnName: "credit_limit", anomalyType: "outlier" })
    );
    expect(anomalies).toContainEqual(
      expect.objectContaining({ rowNumber: 4, columnName: "credit_limit", anomalyType: "suspicious_pattern" })
    );
  });
});
