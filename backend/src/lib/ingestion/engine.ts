// Ingestion engine (TQ-021/TQ-022): pure "buffer in, structured result out" logic, with no
// DB/HTTP dependency of its own — routes/ingestion.ts is the only place that wires this to
// Postgres and object storage. Kept separate so the detection/parsing logic is unit-testable
// without spinning up a request or a transaction.
import iconv from "iconv-lite";
import { detectDelimiter, detectEncoding, detectHasHeader, majorityType, type ColumnType } from "./detect";
import { parseCsv } from "./parseCsv";
import { parseXlsx } from "./parseXlsx";

export type SourceFormat = "csv" | "xlsx";

export interface ColumnProfile {
  name: string;
  inferredType: ColumnType;
}

export interface RejectedRow {
  rowNumber: number;
  raw: string;
  reason: string;
}

export interface IngestResult {
  format: SourceFormat;
  encoding: string | null; // null for xlsx — it's a binary container format, no text encoding to detect
  delimiter: string | null; // null for xlsx
  hasHeader: boolean;
  columns: ColumnProfile[];
  dataRows: string[][]; // header row excluded
  rejected: RejectedRow[];
}

/** Filename-extension based; content-sniffing (e.g. XLSX's zip magic bytes) is future work
 *  if a mismatched-extension upload turns out to be a real problem in practice. */
export function detectFormat(filename: string): SourceFormat {
  const lower = filename.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls") ? "xlsx" : "csv";
}

export async function ingestFile(filename: string, buffer: Buffer): Promise<IngestResult> {
  const format = detectFormat(filename);
  return format === "xlsx" ? ingestXlsx(buffer) : ingestCsv(buffer);
}

async function ingestXlsx(buffer: Buffer): Promise<IngestResult> {
  const { rows } = await parseXlsx(buffer);
  if (rows.length === 0) {
    return emptyResult("xlsx", null, null);
  }
  return buildResult("xlsx", null, null, rows, []);
}

function ingestCsv(buffer: Buffer): IngestResult {
  const encoding = detectEncoding(buffer);
  const text = decodeBuffer(buffer, encoding);
  const delimiter = detectDelimiter(text);

  const { rows, rejected } = parseCsv(text, delimiter);
  if (rows.length === 0) {
    return { ...emptyResult("csv", encoding, delimiter), rejected };
  }
  return buildResult("csv", encoding, delimiter, rows.map((r) => r.values), rejected);
}

function buildResult(
  format: SourceFormat,
  encoding: string | null,
  delimiter: string | null,
  rows: string[][],
  rejected: RejectedRow[]
): IngestResult {
  const hasHeader = detectHasHeader(rows);
  const headerRow = hasHeader ? rows[0] : rows[0].map((_, i) => `column_${i + 1}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const columns: ColumnProfile[] = headerRow.map((rawName, i) => ({
    name: rawName?.trim() || `column_${i + 1}`,
    inferredType: majorityType(dataRows.map((r) => r[i] ?? "")),
  }));

  return { format, encoding, delimiter, hasHeader, columns, dataRows, rejected };
}

function emptyResult(format: SourceFormat, encoding: string | null, delimiter: string | null): IngestResult {
  return { format, encoding, delimiter, hasHeader: false, columns: [], dataRows: [], rejected: [] };
}

/**
 * iconv-lite doesn't recognize every label chardet can emit (chardet returns names like
 * "UTF-8", "ISO-8859-1", "windows-1252", "ASCII", all of which iconv-lite does support; but
 * an unrecognized/unusual result should degrade to UTF-8 rather than throw and fail the
 * whole ingestion run over an encoding-detection edge case).
 */
function decodeBuffer(buffer: Buffer, encoding: string): string {
  const normalized = encoding.toUpperCase();
  if (normalized === "UTF-8" || normalized === "ASCII" || !iconv.encodingExists(encoding)) {
    return buffer.toString("utf8");
  }
  return iconv.decode(buffer, encoding);
}
