# One-off fix: create the GCS bucket the backend needs for immutable raw-file storage
# (lib/objectStorage.ts requires RAW_DATA_BUCKET whenever GCP_PROJECT_ID is set - this was
# missed in the original deploy_cloudrun.ps1, now folded into that script as step 7c for any
# future fresh deploy). Run this once now to unblock the current live deployment; no need to
# re-run the full deploy_cloudrun.ps1 script.

function Stop-OnFailure($stepName) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED at: $stepName (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
  }
}

$PROJECT_ID = "transformiq-transformiq-dev"
$REGION = "us-central1"
$SERVICE = "transformiq-backend-dev"
$RAW_DATA_BUCKET = "$($PROJECT_ID)-raw-data"

Write-Host "=== Create the raw-data GCS bucket ===" -ForegroundColor Cyan
$bucketExists = gcloud storage buckets describe "gs://$RAW_DATA_BUCKET" --format="value(name)" 2>$null
if (-not $bucketExists) {
  gcloud storage buckets create "gs://$RAW_DATA_BUCKET" --location=$REGION --uniform-bucket-level-access
  Stop-OnFailure "create raw-data GCS bucket"
} else {
  Write-Host "Bucket already exists, skipping creation." -ForegroundColor Yellow
}

Write-Host "=== Grant the backend's runtime service account access to it ===" -ForegroundColor Cyan
$PROJECT_NUMBER = (gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
Stop-OnFailure "look up project number"
$RUNTIME_SA = "$($PROJECT_NUMBER)-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$RAW_DATA_BUCKET" --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin"
Stop-OnFailure "grant GCS bucket access"

Write-Host "=== Point the backend Cloud Run service at the bucket ===" -ForegroundColor Cyan
gcloud run services update $SERVICE --region=$REGION --update-env-vars="RAW_DATA_BUCKET=$RAW_DATA_BUCKET"
Stop-OnFailure "update Cloud Run service"

Write-Host ""
Write-Host "=== Done - CSV ingestion should work now. Try uploading a dataset again. ===" -ForegroundColor Green
