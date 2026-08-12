// TQ-021 acceptance criteria, tested directly against messy fixtures rather than a happy-path
// sample: "Ingesting a messy real-world CSV/XLSX sample correctly detects encoding, delimiter,
// headers, and column types."
import iconv from "iconv-lite";
import ExcelJS from "exceljs";
import { ingestFile } from "../engine";

describe("ingestFile — CSV", () => {
  it("detects windows-1252 encoding, semicolon delimiter, header, column types, and rejects a ragged row", async () => {
    // Deliberately messy: semicolon-delimited (not the "default" comma), windows-1252
    // encoded (accented characters that would mangle if mis-decoded as UTF-8), a header row,
    // mixed column types, and one ragged data row.
    const csvText = [
      "supplier_id;name;signup_date;credit_limit;is_active",
      "1;Acme Corp;2024-01-15;10000.50;true",
      "2;Globex Straße GmbH;2024-03-02;25000.00;true", // "Straße" needs windows-1252 to decode correctly
      "3;Initech;2023-11-30;5000.00;false",
      "4;BadRow;2024-01-01", // ragged — missing 2 fields
      "5;Umbrella Corp;2022-07-19;7500.25;true",
    ].join("\n");
    const buffer = iconv.encode(csvText, "windows-1252");

    const result = await ingestFile("suppliers-export.csv", buffer);

    expect(result.format).toBe("csv");
    expect(result.delimiter).toBe(";");
    expect(result.hasHeader).toBe(true);

    // The accented text must round-trip correctly — this is the actual observable proof
    // encoding detection worked, not just an assertion on the detected label.
    const globexRow = result.dataRows.find((r) => r[0] === "2");
    expect(globexRow?.[1]).toBe("Globex Straße GmbH");

    expect(result.columns.map((c) => c.name)).toEqual([
      "supplier_id",
      "name",
      "signup_date",
      "credit_limit",
      "is_active",
    ]);
    expect(result.columns.map((c) => c.inferredType)).toEqual([
      "integer",
      "string",
      "date",
      "decimal",
      "boolean",
    ]);

    expect(result.dataRows).toHaveLength(4); // 5 data rows minus the 1 ragged one
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/found 3/);
  });

  it("detects comma delimiter and no header for headerless numeric data", async () => {
    const csvText = ["1,100.00", "2,200.50", "3,300.75"].join("\n");
    const result = await ingestFile("plain-export.csv", Buffer.from(csvText, "utf8"));

    expect(result.delimiter).toBe(",");
    expect(result.hasHeader).toBe(false);
    expect(result.columns.map((c) => c.name)).toEqual(["column_1", "column_2"]);
    expect(result.dataRows).toHaveLength(3);
  });
});

describe("ingestFile — XLSX", () => {
  it("detects header and column types from a workbook (no encoding/delimiter concept)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Suppliers");
    sheet.addRow(["supplier_id", "name", "credit_limit"]);
    sheet.addRow([1, "Acme Corp", 10000.5]);
    sheet.addRow([2, "Globex", 25000.75]);
    sheet.addRow([3, "Initech", 5000.25]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await ingestFile("suppliers.xlsx", buffer);

    expect(result.format).toBe("xlsx");
    expect(result.encoding).toBeNull();
    expect(result.delimiter).toBeNull();
    expect(result.hasHeader).toBe(true);
    expect(result.columns.map((c) => c.name)).toEqual(["supplier_id", "name", "credit_limit"]);
    expect(result.columns.map((c) => c.inferredType)).toEqual(["integer", "string", "decimal"]);
    expect(result.dataRows).toHaveLength(3);
  });
});
