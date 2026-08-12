// Profiling engine v1 (TQ-024, FR-PROF-001). Pure "columns + rows in, dimension scores out"
// logic — no DB/HTTP dependency, same separation as lib/ingestion/engine.ts. Operates on the
// same `dataRows`/`columns` shape lib/ingestion/engine.ts already produces, so profiling a
// dataset version is: re-read the immutable raw artifact, re-run ingestFile(), pass the
// result straight into profileColumns() — see lib/jobs/profilingJob.ts for that wiring.
//
// Five dimensions per FR-PROF-001. Definitions (all in [0, 1], all "higher is better" except
// uniqueness which is purely descriptive — see below):
//  - completeness: fraction of rows with a non-empty value in this column.
//  - validity:     fraction of non-empty values that classify as the column's own inferred
//                   type at all (reuses lib/ingestion/detect.ts's classifyValue — the same
//                   loose rules majority-vote type inference already uses).
//  - conformity:   fraction of non-empty values that match a *strict* canonical form for that
//                   type (stricter than validity — e.g. "true"/"false" only for boolean, not
//                   "yes"/"y"; ISO yyyy-mm-dd only for date, not the looser mm/dd/yyyy
//                   validity also accepts). A value can't conform without first being valid —
//                   conformity is always <= validity for the same column.
//  - consistency:  fraction of non-empty values sharing the column's single most common
//                   "shape" (digit runs -> D, letter runs -> A, punctuation kept as-is — e.g.
//                   "2024-01-15" and "2023-11-30" share the shape "D-D-D"). A column mixing
//                   date formats, or mixing "USD 100" with "100.00", scores lower here.
//  - uniqueness:   distinct non-empty values / total non-empty values. Stored per field as a
//                   diagnostic (useful for spotting candidate identifier columns), but
//                   DELIBERATELY NOT included in quality_score: uniqueness isn't inherently
//                   "good" for every column (a "country" column being 90% duplicate values is
//                   completely normal, not a defect) — folding it into a composite score
//                   would only be correct for columns known to be identifiers/keys, and
//                   there's no declared-key concept yet (candidate for when TQ-028's entity
//                   schema, or a later "primary key candidate" flag, exists).
//
// quality_score (per field) = mean(completeness, validity, conformity, consistency).
import { classifyValue, type ColumnType } from "../ingestion/detect";

export interface FieldProfile {
  columnName: string;
  inferredType: ColumnType;
  rowCount: number;
  nullCount: number;
  distinctCount: number;
  completeness: number;
  uniqueness: number;
  validity: number;
  conformity: number;
  consistency: number;
  qualityScore: number;
}

export interface DatasetProfileResult {
  rowCount: number;
  columnCount: number;
  overallQualityScore: number;
  fields: FieldProfile[];
}

export interface ProfileableColumn {
  name: string;
  inferredType: ColumnType;
}

export function profileColumns(columns: ProfileableColumn[], dataRows: string[][]): DatasetProfileResult {
  const rowCount = dataRows.length;
  const fields = columns.map((col, index) =>
    profileColumn(
      col.name,
      col.inferredType,
      dataRows.map((row) => row[index] ?? ""),
      rowCount
    )
  );
  const overallQualityScore = fields.length === 0 ? 1 : average(fields.map((f) => f.qualityScore));
  return { rowCount, columnCount: columns.length, overallQualityScore, fields };
}

function profileColumn(
  columnName: string,
  inferredType: ColumnType,
  rawValues: string[],
  rowCount: number
): FieldProfile {
  const nonNullRaw = rawValues.filter((v) => (v ?? "").trim() !== "");
  const nonNullTrimmed = nonNullRaw.map((v) => v.trim());
  const nullCount = rowCount - nonNullRaw.length;
  const distinctCount = new Set(nonNullTrimmed).size;

  const completeness = rowCount === 0 ? 1 : nonNullRaw.length / rowCount;
  const uniqueness = nonNullRaw.length === 0 ? 0 : distinctCount / nonNullRaw.length;

  const validFlags = nonNullRaw.map((raw) => classifyValue(raw.trim()) === inferredType);
  const validity = nonNullRaw.length === 0 ? 1 : countTrue(validFlags) / nonNullRaw.length;

  const conformFlags = nonNullRaw.map(
    (raw, i) => validFlags[i] && conformsStrictly(raw, inferredType)
  );
  const conformity = nonNullRaw.length === 0 ? 1 : countTrue(conformFlags) / nonNullRaw.length;

  const consistency = shapeConsistency(nonNullTrimmed);

  const qualityScore = average([completeness, validity, conformity, consistency]);

  return {
    columnName,
    inferredType,
    rowCount,
    nullCount,
    distinctCount,
    completeness,
    uniqueness,
    validity,
    conformity,
    consistency,
    qualityScore,
  };
}

const STRICT_INTEGER_RE = /^-?[1-9]\d*$|^0$/; // no leading zeros (except "0" itself)
const STRICT_DECIMAL_RE = /^-?\d+\.\d{2}$/; // exactly 2 decimal places (currency convention)
const STRICT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // ISO date only — no time component, no slash format
const STRICT_BOOLEAN_VALUES = new Set(["true", "false"]); // not "yes"/"no"/"y"/"n"

function conformsStrictly(raw: string, type: ColumnType): boolean {
  const value = raw.trim();
  switch (type) {
    case "integer":
      return STRICT_INTEGER_RE.test(value);
    case "decimal":
      return STRICT_DECIMAL_RE.test(value);
    case "date":
      return STRICT_DATE_RE.test(value);
    case "boolean":
      return STRICT_BOOLEAN_VALUES.has(value.toLowerCase());
    case "string":
      // Conformant free text: no leading/trailing whitespace on the raw value (a real
      // ragged-export artifact), and not just whitespace-that-trims-to-content-but-had-
      // internal issues — kept intentionally simple, this is the one check that's cheap and
      // unambiguous without inventing string-format rules the SRS doesn't specify.
      return raw === value;
  }
}

/** Exported for lib/anomalies/engine.ts (TQ-025's "suspicious pattern" shape-break check
 *  reuses the exact same digit/letter-run abstraction consistency scoring uses, rather than
 *  a second, possibly-drifting definition of "shape"). */
export function shape(value: string): string {
  return value.replace(/\d+/g, "D").replace(/[A-Za-z]+/g, "A");
}

function shapeConsistency(trimmedValues: string[]): number {
  if (trimmedValues.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const v of trimmedValues) {
    const s = shape(v);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let maxCount = 0;
  for (const c of counts.values()) if (c > maxCount) maxCount = c;
  return maxCount / trimmedValues.length;
}

function countTrue(flags: boolean[]): number {
  return flags.reduce((n, f) => n + (f ? 1 : 0), 0);
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
