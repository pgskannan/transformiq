// CSV parsing (TQ-021). Delimiter and encoding are detected by detect.ts before this runs;
// this module is just "given decoded text + a delimiter, produce rows" plus ragged-row
// detection for TQ-022's rejected-row diagnostics.
import { parse } from "csv-parse/sync";

export interface ParsedRow {
  /** 1-based row number over data rows only (header, if any, is not counted). */
  rowNumber: number;
  values: string[];
  /** Raw, unparsed line — kept for the rejected-row report so a user can see exactly what
   *  they uploaded, not a reconstruction of it. */
  raw: string;
}

export interface CsvParseResult {
  rows: ParsedRow[];
  rejected: Array<{ rowNumber: number; raw: string; reason: string }>;
}

/**
 * Parses already-decoded CSV text into rows, using csv-parse in permissive mode (so a
 * malformed row doesn't abort the whole file) and then separately flagging rows whose field
 * count doesn't match the expected column count as rejected — this is TQ-022's concrete,
 * testable definition of "malformed row" for CSV: ragged rows, not e.g. bad data *values*
 * (that's profiling's job in TQ-024/025, a different concern from "does this row parse").
 *
 * The expected column count is derived from csv-parse's own output (the mode/most-common
 * width across all parsed records), not a naive `line.split(delimiter)` probe — a naive
 * split would miscount any row with a quoted field containing the delimiter (e.g.
 * `"Acme, Inc.",123`), flagging perfectly valid rows as ragged. csv-parse already handles
 * quoting correctly; reusing its output for the width-mode calculation avoids re-implementing
 * (and getting wrong) CSV quote-escaping rules a second time.
 */
export function parseCsv(text: string, delimiter: string): CsvParseResult {
  // relax_column_count lets csv-parse return every row (even ragged ones) instead of
  // throwing on the first mismatch — we want to report every bad row, not stop at the first.
  const records: string[][] = parse(text, {
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
  });

  // Known limitation: a quoted field containing an embedded newline is one CSV record but
  // multiple raw lines, so `rawLines[index]` can misalign with `records[index]` for such
  // files. Row-count-based rejection (the actual TQ-022 mechanism below) is unaffected by
  // this — only the *displayed* raw text for a rejected row could look truncated in that
  // specific edge case. Not solved here; flagging rather than silently accepting a subtly
  // wrong "raw" value.
  const rawLines = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0);

  const expectedColumnCount = modeWidth(records.map((r) => r.length));

  const rows: ParsedRow[] = [];
  const rejected: CsvParseResult["rejected"] = [];

  records.forEach((values, index) => {
    const rowNumber = index + 1;
    const raw = rawLines[index] ?? values.join(delimiter);
    if (values.length !== expectedColumnCount) {
      rejected.push({
        rowNumber,
        raw,
        reason: `Expected ${expectedColumnCount} field(s), found ${values.length}`,
      });
      return;
    }
    rows.push({ rowNumber, values, raw });
  });

  return { rows, rejected };
}

function modeWidth(widths: number[]): number {
  if (widths.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
  let best = widths[0];
  let bestFreq = 0;
  for (const [width, freq] of counts) {
    if (freq > bestFreq) {
      best = width;
      bestFreq = freq;
    }
  }
  return best;
}
