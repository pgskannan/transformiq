-- Async ingestion job model (TQ-023). The ingestion_runs.status CHECK constraint needs a
-- new "queued" state: the POST route now creates the run and returns immediately, before the
-- actual parse/persist work has even started (see src/lib/jobs and routes/ingestion.ts) —
-- "processing" now means the deferred job has picked it up, not that the HTTP request is
-- still open.

ALTER TABLE "ingestion_runs" DROP CONSTRAINT "ingestion_runs_status_check";
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_status_check"
  CHECK ("status" IN ('queued', 'processing', 'completed', 'failed'));

ALTER TABLE "ingestion_runs" ALTER COLUMN "status" SET DEFAULT 'queued';
