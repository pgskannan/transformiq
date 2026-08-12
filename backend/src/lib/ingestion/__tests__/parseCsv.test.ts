import { parseCsv } from "../parseCsv";

describe("parseCsv", () => {
  it("parses well-formed rows and rejects ragged ones (TQ-022)", () => {
    const text = [
      "supplier_id,name,country",
      "1,Acme Corp,US",
      "2,Globex,DE",
      "3,BadRow", // missing a field — ragged
      "4,Initech,US,EXTRA", // extra field — also ragged
      "5,Umbrella Corp,US",
    ].join("\n");

    const { rows, rejected } = parseCsv(text, ",");

    // Header included in `rows` — header/data split happens one layer up in engine.ts.
    expect(rows.map((r) => r.values)).toEqual([
      ["supplier_id", "name", "country"],
      ["1", "Acme Corp", "US"],
      ["2", "Globex", "DE"],
      ["5", "Umbrella Corp", "US"],
    ]);

    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toMatchObject({ rowNumber: 4, reason: expect.stringContaining("found 2") });
    expect(rejected[1]).toMatchObject({ rowNumber: 5, reason: expect.stringContaining("found 4") });
  });

  it("correctly splits fields with quoted values containing the delimiter (not a false ragged-row rejection)", () => {
    const text = ['name,city', '"Acme, Inc.",Springfield', '"Globex, LLC",Shelbyville'].join("\n");

    const { rows, rejected } = parseCsv(text, ",");

    expect(rejected).toHaveLength(0);
    expect(rows.map((r) => r.values)).toEqual([
      ["name", "city"],
      ["Acme, Inc.", "Springfield"],
      ["Globex, LLC", "Shelbyville"],
    ]);
  });

  it("handles an empty file", () => {
    const { rows, rejected } = parseCsv("", ",");
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });
});
