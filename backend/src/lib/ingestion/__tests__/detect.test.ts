import { detectDelimiter, detectHasHeader, majorityType } from "../detect";

describe("detectDelimiter", () => {
  it("detects semicolon-delimited text", () => {
    const text = "id;name;country\n1;Acme Corp;US\n2;Globex;DE\n3;Initech;US\n";
    expect(detectDelimiter(text)).toBe(";");
  });

  it("detects comma-delimited text", () => {
    const text = "id,name,country\n1,Acme Corp,US\n2,Globex,DE\n";
    expect(detectDelimiter(text)).toBe(",");
  });

  it("detects tab-delimited text", () => {
    const text = "id\tname\tcountry\n1\tAcme Corp\tUS\n2\tGlobex\tDE\n";
    expect(detectDelimiter(text)).toBe("\t");
  });

  it("detects pipe-delimited text", () => {
    const text = "id|name|country\n1|Acme Corp|US\n2|Globex|DE\n";
    expect(detectDelimiter(text)).toBe("|");
  });

  it("falls back to comma for a single-column file with no real delimiter", () => {
    expect(detectDelimiter("id\n1\n2\n3\n")).toBe(",");
  });
});

describe("detectHasHeader", () => {
  it("recognizes a string header over numeric data", () => {
    const rows = [
      ["supplier_id", "credit_limit"],
      ["1", "1000"],
      ["2", "2000"],
      ["3", "3000"],
    ];
    expect(detectHasHeader(rows)).toBe(true);
  });

  it("recognizes headerless fully-numeric data as having no header", () => {
    const rows = [
      ["1", "1000"],
      ["2", "2000"],
      ["3", "3000"],
      ["4", "4000"],
    ];
    expect(detectHasHeader(rows)).toBe(false);
  });

  it("defaults to true when there isn't enough signal (all-string columns)", () => {
    const rows = [
      ["name", "country"],
      ["Acme", "US"],
      ["Globex", "DE"],
    ];
    expect(detectHasHeader(rows)).toBe(true);
  });
});

describe("majorityType", () => {
  it("classifies integers", () => {
    expect(majorityType(["1", "2", "3", "42"])).toBe("integer");
  });

  it("classifies decimals", () => {
    expect(majorityType(["1.5", "2.75", "10000.50"])).toBe("decimal");
  });

  it("classifies booleans", () => {
    expect(majorityType(["true", "false", "true", "yes"])).toBe("boolean");
  });

  it("classifies ISO dates", () => {
    expect(majorityType(["2024-01-15", "2023-11-30", "2024-03-02"])).toBe("date");
  });

  it("classifies free text as string", () => {
    expect(majorityType(["Acme Corp", "Globex", "Initech"])).toBe("string");
  });

  it("falls back to string when there's no clear majority", () => {
    expect(majorityType(["1", "abc", "2.5", "hello"])).toBe("string");
  });

  it("treats an all-empty column as string", () => {
    expect(majorityType(["", "", ""])).toBe("string");
  });
});
