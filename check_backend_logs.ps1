# Pulls full log entries (raw JSON) for the specific failed revision, so nothing gets lost to
# a field-name mismatch (the app logs structured JSON via pino - "msg", not "message").
$PROJECT_ID = "transformiq-transformiq-dev"
$SERVICE = "transformiq-backend-dev"

# Finds the most recent revision automatically - no need to hand-copy the revision name from
# the earlier error output.
$REVISION = gcloud run revisions list --service=$SERVICE --region=us-central1 --project=$PROJECT_ID --sort-by="~metadata.creationTimestamp" --limit=1 --format="value(metadata.name)"
Write-Host "Fetching logs for revision: $REVISION" -ForegroundColor Cyan

gcloud logging read `
  "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE AND resource.labels.revision_name=$REVISION" `
  --project=$PROJECT_ID `
  --limit=100 `
  --order=asc `
  --format=json | Out-File -FilePath "$env:TEMP\backend_crash_logs.json" -Encoding utf8

Get-Content "$env:TEMP\backend_crash_logs.json"
