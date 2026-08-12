import { profileColumns } from "../engine";

function col(name: string, inferredType: "integer" | "decimal" | "boolean" | "date" | "string") {
  return { name, inferredType };
}

describe("profileColumns", () => {
  it("scores a perfectly clean, fully-unique integer column at 1.0 across every dimension", () => {
    const result = profileColumns(
      [col("supplier_id", "integer")],
      [["1"], ["2"], ["3"], ["4"]]
    );
    const field = result.fields[0];
    expect(field.completeness).toBe(1);
    expect(field.validity).toBe(1);
    expect(field.conformity).toBe(1);
    expect(field.consistency).toBe(1);
    expect(field.uniqueness).toBe(1);
    expect(field.qualityScore).toBe(1);
    expect(field.nullCount).toBe(0);
    expect(field.distinctCount).toBe(4);
  });

  it("completeness drops with empty/null values, independent of the other dimensions", () => {
    const result = profileColumns([col("name", "string")], [["Acme"], [""], ["Globex"], ["  "]]);
    const field = result.fields[0];
    expect(field.nullCount).toBe(2); // "" and "  " both trim to empty
    expect(field.completeness).toBe(0.5);
  });

  it("validity reflects the fraction of non-null values that actually match the inferred type", () => {
    // majorityType would pick "integer" for 3/4 non-null values; "abc" is invalid for that type.
    const result = profileColumns([col("supplier_id", "integer")], [["1"], ["2"], ["3"], ["abc"]]);
    const field = result.fields[0];
    expect(field.validity).toBe(0.75);
  });

  it("conformity is stricter than validity: leading-zero integers are valid but not conformant", () => {
    const result = profileColumns([col("code", "integer")], [["1"], ["007"], ["42"], ["099"]]);
    const field = result.fields[0];
    expect(field.validity).toBe(1); // "007"/"099" are still integers by the loose rule
    expect(field.conformity).toBe(0.5); // only "1" and "42" have no leading zeros
  });

  it("conformity is stricter than validity: yes/no booleans are valid but not conformant", () => {
    const result = profileColumns(
      [col("is_active", "boolean")],
      [["true"], ["false"], ["yes"], ["no"]]
    );
    const field = result.fields[0];
    expect(field.validity).toBe(1);
    expect(field.conformity).toBe(0.5);
  });

  it("conformity catches leading/trailing whitespace on string values", () => {
    const result = profileColumns([col("name", "string")], [["Acme"], [" Globex"], ["Initech "]]);
    const field = result.fields[0];
    expect(field.validity).toBe(1); // whitespace doesn't affect "is this a string"
    expect(field.conformity).toBeCloseTo(1 / 3);
  });

  it("consistency drops when values don't share a common structural shape (mixed date formats)", () => {
    const result = profileColumns(
      [col("signup_date", "date")],
      [["2024-01-15"], ["2024-03-02"], ["1/5/2024"], ["2023-11-30"]]
    );
    const field = result.fields[0];
    // 3 of 4 share the "D-D-D" shape; "1/5/2024" is "D/D/D" — a different shape.
    expect(field.consistency).toBe(0.75);
    // The slash-format date is still a *valid* date (loose rule accepts both formats) but
    // not conformant (strict rule is ISO-only) — conformity should be lower than validity.
    expect(field.validity).toBe(1);
    expect(field.conformity).toBe(0.75);
  });

  it("uniqueness is purely descriptive and does not affect quality_score", () => {
    // "country" is a realistic low-uniqueness, otherwise-perfect column.
    const result = profileColumns([col("country", "string")], [["US"], ["US"], ["US"], ["DE"]]);
    const field = result.fields[0];
    expect(field.uniqueness).toBe(0.5); // 2 distinct / 4 values
    expect(field.qualityScore).toBe(1); // completeness/validity/conformity/consistency all perfect
  });

  it("dataset-level overallQualityScore is the mean of field quality scores", () => {
    const result = profileColumns(
      [col("perfect", "integer"), col("half_null", "integer")],
      [
        ["1", "1"],
        ["2", ""],
        ["3", "3"],
        ["4", ""],
      ]
    );
    const [perfect, halfNull] = result.fields;
    expect(perfect.qualityScore).toBe(1);
    expect(halfNull.completeness).toBe(0.5);
    expect(result.overallQualityScore).toBeCloseTo((perfect.qualityScore + halfNull.qualityScore) / 2);
  });

  it("handles a column with zero rows gracefully (no division by zero / NaN)", () => {
    const result = profileColumns([col("empty_col", "string")], []);
    const field = result.fields[0];
    expect(field.completeness).toBe(1);
    expect(field.validity).toBe(1);
    expect(field.conformity).toBe(1);
    expect(field.consistency).toBe(1);
    expect(field.uniqueness).toBe(0);
    expect(Number.isNaN(field.qualityScore)).toBe(false);
  });
});
