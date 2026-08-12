// XLSX parsing (TQ-021), via exceljs — not the npm "xlsx"/SheetJS package: the npm registry
// build of "xlsx" is stuck at 0.18.5 with unpatched high-severity advisories (prototype
// pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9) because SheetJS stopped
// publishing patched releases to npm; exceljs is actively maintained there instead. Found
// via `npm audit` immediately after installing xlsx, swapped before it was ever used.
import ExcelJS from "exceljs";

export interface XlsxParseResult {
  rows: string[][]; // every row as strings, header row included at index 0 if present
}

/**
 * Reads the first worksheet of an XLSX buffer into rows of strings. Cell values are
 * stringified here (numbers, dates, booleans all become their string form) so the same
 * detect.ts type-inference heuristics used for CSV apply uniformly — ingestion doesn't need
 * two different "what type is this column" code paths for the two formats.
 */
export async function parseXlsx(buffer: Buffer): Promise<XlsxParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { rows: [] };
  }

  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // exceljs rows are 1-indexed and row.values[0] is always undefined — slice it off.
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const cell of cells) {
      values.push(stringifyCell(cell));
    }
    rows.push(values);
  });

  return { rows };
}

function stringifyCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10); // yyyy-mm-dd, matches detect.ts's DATE_RE
  if (typeof cell === "object") {
    // Rich text / formula result objects — exceljs returns { text } or { result } shapes for
    // these rather than a plain scalar.
    const obj = cell as { text?: string; result?: unknown; richText?: Array<{ text: string }> };
    if (obj.richText) return obj.richText.map((r) => r.text).join("");
    if (obj.result !== undefined) return stringifyCell(obj.result);
    if (obj.text !== undefined) return obj.text;
    return String(cell);
  }
  return String(cell);
}
