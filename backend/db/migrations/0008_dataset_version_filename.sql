-- Small addition needed by the profiling engine (TQ-024): re-profiling a dataset_version
-- means re-reading its immutable raw artifact and re-running ingestFile(filename, bytes) —
-- and ingestFile() needs a filename to tell CSV from XLSX (lib/ingestion/engine.ts's
-- detectFormat() is extension-based). dataset_versions didn't carry the original filename
-- before this; both creation paths (routes/datasets.ts's JSON+base64 upload and
-- routes/ingestion.ts's real file upload) already know it at insert time.
ALTER TABLE "dataset_versions" ADD COLUMN "source_filename" TEXT;
