// Configurable ingestion size/row limits (TQ-023's "configurable size/row limits"). Env-var
// driven so ops can tune them per environment without a code change; sane defaults so local
// dev/test doesn't need to set anything.
export function getMaxFileSizeBytes(): number {
  const raw = process.env.INGESTION_MAX_FILE_SIZE_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50 * 1024 * 1024; // 50 MB default
}

export function getMaxRows(): number {
  const raw = process.env.INGESTION_MAX_ROWS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200_000; // default ceiling
}
