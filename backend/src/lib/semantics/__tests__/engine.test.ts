import { inferSemanticType, type SemanticType } from "../engine";
import type { ColumnType } from "../../ingestion/detect";

describe("inferSemanticType — targeted cases", () => {
  it("recognizes email addresses by value pattern alone, regardless of column name", () => {
    expect(
      inferSemanticType("contact", "string", ["alice@acme.com", "bob@globex.com", "carol@initech.com"])
    ).toBe("email");
  });

  it("recognizes URLs by value pattern", () => {
    expect(
      inferSemanticType("website", "string", ["https://acme.com", "https://globex.com", "http://initech.com"])
    ).toBe("url");
  });

  it("recognizes a known ISO currency code by value, independent of column name", () => {
    expect(inferSemanticType("ccy", "string", ["USD", "EUR", "GBP", "USD"])).toBe("currency_code");
  });

  it("requires a name hint for country_code (bare 2-letter values are too ambiguous alone)", () => {
    expect(inferSemanticType("country_code", "string", ["US", "DE", "GB", "US"])).toBe("country_code");
    // Same 2-letter values, no "country" in the name -> not inferred (could be a state/unit code).
    expect(inferSemanticType("region", "string", ["US", "DE", "GB", "US"])).not.toBe("country_code");
  });

  it("recognizes phone numbers by digit-rich formatted values plus a name hint", () => {
    expect(
      inferSemanticType("phone", "string", ["+1 415-555-0100", "(415) 555-0101", "415.555.0102"])
    ).toBe("phone_number");
  });

  it("recognizes a percentage/rate column by name plus a 0-100 numeric range", () => {
    expect(inferSemanticType("discount_rate", "decimal", ["10", "25.5", "0", "100"])).toBe("percentage");
  });

  it("recognizes a monetary amount by name keyword plus numeric type", () => {
    expect(inferSemanticType("credit_limit", "decimal", ["100.00", "250.50", "5000.00"])).toBe(
      "currency_amount"
    );
  });

  it("recognizes a generic identifier column by name", () => {
    expect(inferSemanticType("supplier_id", "integer", ["1", "2", "3"])).toBe("identifier");
  });

  it("postal_code wins over identifier's overlapping '_code' name pattern (checked first)", () => {
    expect(inferSemanticType("zip_code", "string", ["10001", "90210", "02139"])).toBe("postal_code");
  });

  it("recognizes organization names by name keyword", () => {
    expect(inferSemanticType("supplier_name", "string", ["Acme Corp", "Globex Inc", "Initech LLC"])).toBe(
      "organization_name"
    );
  });

  it("recognizes person names by name keyword", () => {
    expect(inferSemanticType("contact_name", "string", ["Alice Smith", "Bob Jones", "Carol White"])).toBe(
      "person_name"
    );
  });

  it("recognizes address lines by name keyword", () => {
    expect(inferSemanticType("billing_address", "string", ["123 Main St", "456 Oak Ave"])).toBe(
      "address_line"
    );
  });

  it("recognizes tax/VAT identifiers by name keyword", () => {
    expect(inferSemanticType("vat_number", "string", ["DE123456789", "FR98765432101"])).toBe("tax_id");
  });

  it("returns null for columns with no matching semantic signal", () => {
    expect(inferSemanticType("status", "string", ["active", "inactive", "pending"])).toBeNull();
    expect(inferSemanticType("quantity", "integer", ["5", "10", "3"])).toBeNull();
    expect(inferSemanticType("notes", "string", ["shipped late", "n/a", "see PO"])).toBeNull();
  });

  it("returns null for an all-empty column rather than guessing", () => {
    expect(inferSemanticType("mystery", "string", ["", "", ""])).toBeNull();
  });
});

// DoD (TQ-026): "≥90% field-type inference accuracy on the golden fixture set." A broader,
// two-example-per-type fixture set than the targeted cases above, scored in aggregate so a
// single hard case can't fail the whole feature — the DoD is a percentage, not "every case
// must pass."
interface GoldenCase {
  columnName: string;
  inferredType: ColumnType;
  values: string[];
  expected: SemanticType | null;
}

const GOLDEN_FIXTURES: GoldenCase[] = [
  { columnName: "email", inferredType: "string", values: ["a@x.com", "b@y.com", "c@z.com"], expected: "email" },
  {
    columnName: "billing_email",
    inferredType: "string",
    values: ["ap@acme.com", "billing@globex.com", "finance@initech.com"],
    expected: "email",
  },
  {
    columnName: "site",
    inferredType: "string",
    values: ["https://acme.example", "https://globex.example", "https://initech.example"],
    expected: "url",
  },
  {
    columnName: "homepage_url",
    inferredType: "string",
    values: ["http://a.com", "http://b.com", "http://c.com"],
    expected: "url",
  },
  { columnName: "currency", inferredType: "string", values: ["USD", "EUR", "USD", "GBP"], expected: "currency_code" },
  {
    columnName: "invoice_currency",
    inferredType: "string",
    values: ["JPY", "CNY", "INR", "JPY"],
    expected: "currency_code",
  },
  {
    columnName: "country_code",
    inferredType: "string",
    values: ["US", "CA", "MX", "US"],
    expected: "country_code",
  },
  {
    columnName: "supplier_country",
    inferredType: "string",
    values: ["DE", "FR", "IT", "DE"],
    expected: "country_code",
  },
  {
    columnName: "phone_number",
    inferredType: "string",
    values: ["+1 212-555-0180", "212-555-0181", "(212) 555-0182"],
    expected: "phone_number",
  },
  {
    columnName: "fax",
    inferredType: "string",
    values: ["+44 20 7946 0958", "+44 20 7946 0959"],
    expected: "phone_number",
  },
  {
    columnName: "tax_rate",
    inferredType: "decimal",
    values: ["7.5", "8.25", "0", "10"],
    expected: "percentage",
  },
  { columnName: "discount_percent", inferredType: "integer", values: ["5", "10", "15"], expected: "percentage" },
  {
    columnName: "unit_price",
    inferredType: "decimal",
    values: ["19.99", "5.00", "120.00"],
    expected: "currency_amount",
  },
  {
    columnName: "total_spend",
    inferredType: "decimal",
    values: ["150000.00", "98000.50"],
    expected: "currency_amount",
  },
  { columnName: "supplier_id", inferredType: "integer", values: ["101", "102", "103"], expected: "identifier" },
  { columnName: "po_number", inferredType: "string", values: ["PO-1001", "PO-1002"], expected: "identifier" },
  {
    columnName: "postal_code",
    inferredType: "string",
    values: ["94105", "10001", "02139"],
    expected: "postal_code",
  },
  { columnName: "zip", inferredType: "string", values: ["94105", "10001"], expected: "postal_code" },
  {
    columnName: "vendor_name",
    inferredType: "string",
    values: ["Acme Corp", "Globex Inc"],
    expected: "organization_name",
  },
  {
    columnName: "company",
    inferredType: "string",
    values: ["Wayne Enterprises", "Stark Industries"],
    expected: "organization_name",
  },
  {
    columnName: "first_name",
    inferredType: "string",
    values: ["Alice", "Bob", "Carol"],
    expected: "person_name",
  },
  {
    columnName: "employee_name",
    inferredType: "string",
    values: ["Dana White", "Evan Black"],
    expected: "person_name",
  },
  {
    columnName: "street_address",
    inferredType: "string",
    values: ["1 Infinite Loop", "500 5th Ave"],
    expected: "address_line",
  },
  {
    columnName: "vat_id",
    inferredType: "string",
    values: ["GB123456789", "IE9876543A"],
    expected: "tax_id",
  },
  // Negative cases — no semantic type should be inferred.
  { columnName: "status", inferredType: "string", values: ["open", "closed", "pending"], expected: null },
  { columnName: "quantity", inferredType: "integer", values: ["1", "2", "3"], expected: null },
  { columnName: "description", inferredType: "string", values: ["widget A", "gadget B"], expected: null },
  { columnName: "category", inferredType: "string", values: ["hardware", "software"], expected: null },
];

describe("inferSemanticType — golden fixture set (TQ-026 DoD)", () => {
  it("achieves >=90% accuracy across the golden fixture set", () => {
    const results = GOLDEN_FIXTURES.map((c) => ({
      ...c,
      actual: inferSemanticType(c.columnName, c.inferredType, c.values),
    }));
    const correct = results.filter((r) => r.actual === r.expected);
    const accuracy = correct.length / results.length;

    if (accuracy < 0.9) {
      const misses = results.filter((r) => r.actual !== r.expected);
      // eslint-disable-next-line no-console
      console.error("Misclassified:", misses.map((m) => `${m.columnName}: expected ${m.expected}, got ${m.actual}`));
    }

    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });
});
