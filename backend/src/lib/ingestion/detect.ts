// Detection heuristics for CSV/XLSX ingestion (TQ-021, FR-ING-001/002). Kept as pure
// functions with no I/O so they're trivially unit-testable against fixture strings/buffers,
// independent of the multipart/DB plumbing in routes/ingestion.ts.
import chardet from "chardet";

export type ColumnType = "integer" | "decimal" | "boolean" | "date" | "string";

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Detects the text encoding of a raw upload. Returns an iconv-lite-compatible encoding name,
 * defaulting to "UTF-8" when detection is inconclusive (empty/very short buffers, or a
 * charset chardet doesn't recognize) rather than throwing — an ingestion connector that
 * fails closed on every edge case a real user's export tool produces isn't useful.
 */
export function detectEncoding(buffer: Buffer): string {
  if (buffer.length === 0) return "UTF-8";
  const detected = chardet.detect(buffer);
  return detected ?? "UTF-8";
}

/**
 * Detects the field delimiter by trying each candidate against the first several lines and
 * scoring for consistency (same field count across lines) — a real CSV export is delimiter-
 * consistent line to line; noise (commas inside unquoted free-text fields, for example) is
 * not. Falls back to "," (the overwhelmingly common default) if no candidate is consistent.
 */
export function detectDelimiter(sampleText: string): string {
  const lines = sampleText
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 20);

  if (lines.length === 0) return ",";

  let best = { delimiter: ",", score: -1 };

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => line.split(delimiter).length);
    const modeCount = mostCommon(counts);
    const consistency = counts.filter((c) => c === modeCount).length / counts.length;
    // Only a real signal if it actually splits into more than one field — a delimiter that
    // never appears yields a constant field count of 1, which would otherwise look
    // "perfectly consistent" and win by accident.
    if (modeCount <= 1) continue;
    const score = consistency * modeCount;
    if (score > best.score) {
      best = { delimiter, score };
    }
  }

  return best.score > 0 ? best.delimiter : ",";
}

function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Decides whether the first parsed row is a header row versus data, by comparing each
 * column's type profile in row 1 against the same column's type profile in the data sample.
 * A header cell (e.g. "supplier_id") reads as `string` while the data below it reads as
 * `integer`/`date`/etc — that mismatch, summed across columns, is the signal. Defaults to
 * `true` (assume header present) when the evidence is inconclusive, since that's the
 * overwhelmingly common real-world case for procurement exports and the safer default for
 * column naming (an accidentally-dropped header row is far more disruptive downstream than
 * an accidentally-kept one, which just becomes a slightly odd-looking first data row).
 */
export function detectHasHeader(rows: string[][]): boolean {
  if (rows.length < 2) return true;
  const [firstRow, ...dataRows] = rows;
  const sample = dataRows.slice(0, 20);

  let columnsFavoringHeader = 0;
  let columnsWithSignal = 0;

  for (let col = 0; col < firstRow.length; col++) {
    const dataValues = sample.map((r) => r[col]).filter((v): v is string => v != null && v !== "");
    if (dataValues.length === 0) continue;

    const dataType = majorityType(dataValues);
    if (dataType === "string") continue; // no useful signal from this column

    columnsWithSignal++;
    const headerCellType = classifyValue(firstRow[col] ?? "");
    if (headerCellType !== dataType) columnsFavoringHeader++;
  }

  if (columnsWithSignal === 0) return true; // no numeric/date columns to compare — default true
  return columnsFavoringHeader / columnsWithSignal >= 0.5;
}

const BOOLEAN_VALUES = new Set(["true", "false", "yes", "no", "y", "n"]);
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?\d+\.\d+$/;
// Deliberately conservative: ISO-ish (yyyy-mm-dd) and common slash formats only. A looser
// date regex starts misclassifying plain numeric IDs and free text as dates.
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}\/\d{1,2}\/\d{4}$/;

/** Exported for lib/profiling/engine.ts (TQ-024's validity dimension is literally "does this
 *  value classify as the column's inferred type" — reusing this avoids a second, possibly
 *  drifting implementation of what "looks like an integer/date/etc" means). */
export function classifyValue(raw: string): ColumnType {
  const value = raw.trim();
  if (value === "") return "string";
  const lower = value.toLowerCase();
  if (BOOLEAN_VALUES.has(lower)) return "boolean";
  if (INTEGER_RE.test(value)) return "integer";
  if (DECIMAL_RE.test(value)) return "decimal";
  if (DATE_RE.test(value)) return "date";
  return "string";
}

/** Majority-vote column type inference (TQ-021's "column types" half of detection). */
export function majorityType(values: string[]): ColumnType {
  const nonEmpty = values.map((v) => v?.trim()).filter((v): v is string => !!v);
  if (nonEmpty.length === 0) return "string";

  const counts: Record<ColumnType, number> = {
    integer: 0,
    decimal: 0,
    boolean: 0,
    date: 0,
    string: 0,
  };
  for (const value of nonEmpty) counts[classifyValue(value)]++;

  let best: ColumnType = "string";
  let bestCount = -1;
  for (const type of Object.keys(counts) as ColumnType[]) {
    if (counts[type] > bestCount) {
      best = type;
      bestCount = counts[type];
    }
  }
  // Require an actual majority, not just a plurality — a column that's half numeric IDs and
  // half free-text notes is more honestly reported as `string` than a coin-flip type.
  return bestCount / nonEmpty.length > 0.5 ? best : "string";
}
