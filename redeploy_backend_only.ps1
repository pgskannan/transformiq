# Redeploy-only (no rebuild - image already pushed successfully). Drops --no-cpu-throttling:
# the previous attempt with it stalled 8+ minutes in Cloud Run's own provisioning step with
# zero application logs (the container process never even started) - a platform-side
# scheduling issue with that flag, not anything in our code. Not essential for a small demo
# CSV anyway (the setImmediate-deferred ingestion job is tiny and finishes well within the
# original request's own CPU window), so simplest fix is to just not ask for it.

function Stop-OnFailure($stepName) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED at: $stepName (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
  }
}

$PROJECT_ID = "transformiq-transformiq-dev"
$REGION = "us-central1"
$INSTANCE = "transformiq-db"
$DB_NAME = "transformiq"
$AR_REPO = "transformiq"
$SERVICE = "transformiq-backend-dev"
$IMAGE = "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/backend:latest"
$RAW_DATA_BUCKET = "$($PROJECT_ID)-raw-data"
$DB_APP_PASSWORD = "transformiq_dev_only"

Write-Host "=== Deploy to Cloud Run (no rebuild - reusing the already-pushed image) ===" -ForegroundColor Cyan
$CONNECTION_NAME = "$($PROJECT_ID):$($REGION):$($INSTANCE)"
gcloud run deploy $SERVICE --image=$IMAGE --region=$REGION --platform=managed --allow-unauthenticated --add-cloudsql-instances=$CONNECTION_NAME --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,RAW_DATA_BUCKET=$RAW_DATA_BUCKET,NODE_ENV=development,DEV_JWT_SECRET=change-me-not-for-real-prod,PLATFORM_ADMIN_API_KEY=change-me-not-for-real-prod,DATABASE_URL=postgresql://transformiq_app:$($DB_APP_PASSWORD)@/$($DB_NAME)?host=/cloudsql/$($CONNECTION_NAME)"
Stop-OnFailure "deploy to Cloud Run"

Write-Host ""
Write-Host "=== Done. Try uploading a dataset again. ===" -ForegroundColor Green
