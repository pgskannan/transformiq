// Anomaly detection engine v1 (TQ-025, FR-PROF-002): "Detect nulls, malformed values,
// outliers and suspicious patterns." Pure "columns + rows in, anomaly list out" logic — same
// separation and same inputs as lib/profiling/engine.ts's profileColumns() (both are run
// from the same re-parsed dataset in lib/jobs/profilingJob.ts, but kept as two modules
// because they answer two different questions: profiling scores a column in aggregate,
// anomaly detection cites specific, actionable row/column instances a user can go fix).
//
// Four categories, each with a deliberately narrow, testable definition:
//
//  - null:              a blank cell in a column that is otherwise mostly complete
//                        (>= NULL_ANOMALY_COMPLETENESS_THRESHOLD non-null elsewhere). A
//                        column that's 90% empty isn't "anomalous" when the 10th row is also
//                        empty — that's just the column's normal shape, already visible via
//                        FR-PROF-001's completeness score. A blank in an otherwise-95%-full
//                        column is the surprising, worth-a-citation case.
//  - malformed_value:   a non-empty value that doesn't classify (via the same
//                        lib/ingestion/detect.ts classifyValue() majority-type inference
//                        already uses) as the column's own inferred type. Per-instance
//                        version of FR-PROF-001's validity dimension.
//  - outlier:           for integer/decimal columns only, a numeric value outside Tukey's
//                        IQR fences (Q1 - 1.5*IQR, Q3 + 1.5*IQR) — the standard robust
//                        outlier convention, chosen over a mean/stdev z-score test because
//                        it doesn't assume a normal distribution and isn't dominated by the
//                        very outliers it's trying to detect.
//  - suspicious_pattern: three distinct sub-checks land in this bucket rather than each
//                        getting their own DB-level type, because all three answer the same
//                        underlying question ("does this look like real data?") rather than
//                        "is this the right type" (malformed_value) or "is this numerically
//                        extreme" (outlier):
//                          1. sentinel placeholders ("N/A", "NULL", "TBD", "-", etc.) typed
//                             into a cell instead of leaving it blank — these often pass a
//                             loose type check (a "string" column happily accepts "N/A") so
//                             malformed_value alone would miss them entirely.
//                          2. a value whose structural "shape" (digit/letter-run pattern,
//                             reusing lib/profiling/engine.ts's shape()) breaks from the
//                             column's dominant shape — the per-instance version of
//                             FR-PROF-001's consistency dimension.
//                          3. an exact duplicate row (every column matches a prior row) —
//                             dataset-level, not column-level, hence column_name "*".
import { classifyValue, type ColumnType } from "../ingestion/detect";
import { shape } from "../profiling/engine";

export type AnomalyType = "null" | "malformed_value" | "outlier" | "suspicious_pattern";

export interface Anomaly {
  /** 1-based, over data rows only (header excluded) — matches dataRows indexing everywhere
   *  else in this codebase (lib/ingestion/parseCsv.ts's ParsedRow, etc). */
  rowNumber: number;
  /** "*" for row-scoped anomalies (e.g. exact-duplicate-row) that don't belong to one column. */
  columnName: string;
  anomalyType: AnomalyType;
  value: string | null;
  detail: string;
}

export interface AnomalyColumn {
  name: string;
  inferredType: ColumnType;
}

const NULL_ANOMALY_COMPLETENESS_THRESHOLD = 0.8;
// Common stand-ins for "I don't have this value" typed as text instead of left blank.
// Lowercase, pre-trimmed comparison keys.
const SENTINEL_VALUES = new Set([
  "n/a",
  "na",
  "null",
  "none",
  "unknown",
  "tbd",
  "-",
  "--",
  "???",
  "#n/a",
]);
const OUTLIER_IQR_MULTIPLIER = 1.5; // Tukey's fences — the standard convention.
// Below this many numeric samples, quartiles aren't a meaningful signal — a 3-value column
// would flag its own min or max as an "outlier" almost by construction.
const MIN_SAMPLES_FOR_OUTLIER_DETECTION = 4;
// Below this many non-empty samples, "the dominant shape" is too easily any single value —
// same reasoning as the outlier minimum above.
const MIN_SAMPLES_FOR_SHAPE_DETECTION = 4;
// A shape has to actually be *dominant*, not just plural, before deviations from it count as
// anomalies — a column split 50/50 between two legitimate formats isn't "inconsistent", it's
// just multi-format, and flagging every row would be pure noise.
const SHAPE_DOMINANCE_THRESHOLD = 0.6;

export function detectAnomalies(columns: AnomalyColumn[], dataRows: string[][]): Anomaly[] {
  const anomalies: Anomaly[] = [];

  columns.forEach((col, colIndex) => {
    const rawValues = dataRows.map((row) => row[colIndex] ?? "");
    detectNullAndTypeAnomalies(col, rawValues, anomalies);
    if (col.inferredType === "integer" || col.inferredType === "decimal") {
      detectOutliers(col, rawValues, anomalies);
    }
    detectShapeBreaks(col, rawValues, anomalies);
  });

  detectDuplicateRows(dataRows, anomalies);

  return anomalies;
}

function detectNullAndTypeAnomalies(col: AnomalyColumn, rawValues: string[], out: Anomaly[]): void {
  const nonNullCount = rawValues.filter((v) => v.trim() !== "").length;
  const completeness = rawValues.length === 0 ? 1 : nonNullCount / rawValues.length;

  rawValues.forEach((raw, idx) => {
    const rowNumber = idx + 1;
    const trimmed = raw.trim();

    if (trimmed === "") {
      if (completeness >= NULL_ANOMALY_COMPLETENESS_THRESHOLD && completeness < 1) {
        out.push({
          rowNumber,
          columnName: col.name,
          anomalyType: "null",
          value: null,
          detail: `Column "${col.name}" is ${Math.round(completeness * 100)}% complete elsewhere; this row's blank value stands out.`,
        });
      }
      return; // nothing else meaningful to check on an empty value
    }

    if (SENTINEL_VALUES.has(trimmed.toLowerCase())) {
      out.push({
        rowNumber,
        columnName: col.name,
        anomalyType: "suspicious_pattern",
        value: raw,
        detail: `Value "${trimmed}" looks like a placeholder for missing data rather than a real value.`,
      });
    }

    if (classifyValue(trimmed) !== col.inferredType) {
      out.push({
        rowNumber,
        columnName: col.name,
        anomalyType: "malformed_value",
        value: raw,
        detail: `Value "${trimmed}" does not match this column's inferred type ("${col.inferredType}").`,
      });
    }
  });
}

function detectOutliers(col: AnomalyColumn, rawValues: string[], out: Anomaly[]): void {
  const numeric: Array<{ rowNumber: number; value: number }> = [];
  rawValues.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const n = Number(trimmed);
    if (Number.isFinite(n)) numeric.push({ rowNumber: idx + 1, value: n });
  });
  if (numeric.length < MIN_SAMPLES_FOR_OUTLIER_DETECTION) return;

  const sortedValues = numeric.map((n) => n.value).sort((a, b) => a - b);
  const q1 = quantile(sortedValues, 0.25);
  const q3 = quantile(sortedValues, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return; // no spread — every value is (effectively) identical, nothing to flag

  const lowerFence = q1 - OUTLIER_IQR_MULTIPLIER * iqr;
  const upperFence = q3 + OUTLIER_IQR_MULTIPLIER * iqr;

  for (const { rowNumber, value } of numeric) {
    if (value < lowerFence || value > upperFence) {
      out.push({
        rowNumber,
        columnName: col.name,
        anomalyType: "outlier",
        value: String(value),
        detail: `Value ${value} falls outside this column's typical range [${lowerFence.toFixed(2)}, ${upperFence.toFixed(2)}] (Tukey IQR fences).`,
      });
    }
  }
}

function detectShapeBreaks(col: AnomalyColumn, rawValues: string[], out: Anomaly[]): void {
  const nonEmpty = rawValues
    .map((raw, idx) => ({ rowNumber: idx + 1, trimmed: raw.trim() }))
    .filter((v) => v.trimmed !== "");
  if (nonEmpty.length < MIN_SAMPLES_FOR_SHAPE_DETECTION) return;

  const shapeCounts = new Map<string, number>();
  for (const { trimmed } of nonEmpty) {
    const s = shape(trimmed);
    shapeCounts.set(s, (shapeCounts.get(s) ?? 0) + 1);
  }
  let dominantShape = "";
  let dominantCount = 0;
  for (const [s, count] of shapeCounts) {
    if (count > dominantCount) {
      dominantShape = s;
      dominantCount = count;
    }
  }
  const dominance = dominantCount / nonEmpty.length;
  if (dominance < SHAPE_DOMINANCE_THRESHOLD || dominance >= 1) return; // not dominant enough, or no deviations exist at all

  for (const { rowNumber, trimmed } of nonEmpty) {
    const s = shape(trimmed);
    if (s !== dominantShape) {
      out.push({
        rowNumber,
        columnName: col.name,
        anomalyType: "suspicious_pattern",
        value: trimmed,
        detail: `Value's format ("${s}") breaks from this column's dominant pattern ("${dominantShape}").`,
      });
    }
  }
}

function detectDuplicateRows(dataRows: string[][], out: Anomaly[]): void {
  const firstSeenAtRow = new Map<string, number>();
  dataRows.forEach((row, idx) => {
    const rowNumber = idx + 1;
    // Joined with the U+0001 control character, not "," or "|" — a real delimiter
    // character can appear inside a field's own value, which would let two genuinely-
    // different rows (e.g. ["1", "23"] and ["12", "3"]) collide onto the same signature
    // under naive concatenation. U+0001 realistically never appears in a procurement export.
    const signature = row.join("\u0001");
    const firstRow = firstSeenAtRow.get(signature);
    if (firstRow !== undefined) {
      out.push({
        rowNumber,
        columnName: "*",
        anomalyType: "suspicious_pattern",
        value: null,
        detail: `This row is an exact duplicate of row ${firstRow}.`,
      });
    } else {
      firstSeenAtRow.set(signature, rowNumber);
    }
  });
}

function quantile(sortedAscending: number[], q: number): number {
  const pos = (sortedAscending.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAscending[base + 1];
  if (next !== undefined) {
    return sortedAscending[base] + rest * (next - sortedAscending[base]);
  }
  return sortedAscending[base];
}
