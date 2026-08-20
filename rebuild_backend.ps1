# Rebuild + redeploy just the backend after the queue.ts fix (job queue was routing to a
# never-deployed Pub/Sub consumer whenever GCP_PROJECT_ID was set, stranding every ingestion
# at "queued" forever - see that file's updated header comment). No DB/secret/bucket work
# needed here, all of that is already done - just a fresh image + a redeploy with
# --no-cpu-throttling so the in-process background job actually gets CPU after the HTTP
# response is sent.

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

Write-Host "=== Build + push the backend image ===" -ForegroundColor Cyan
gcloud builds submit --tag=$IMAGE ./backend
Stop-OnFailure "build + push image"

Write-Host "=== Deploy to Cloud Run ===" -ForegroundColor Cyan
$CONNECTION_NAME = "$($PROJECT_ID):$($REGION):$($INSTANCE)"
gcloud run deploy $SERVICE --image=$IMAGE --region=$REGION --platform=managed --allow-unauthenticated --no-cpu-throttling --add-cloudsql-instances=$CONNECTION_NAME --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,RAW_DATA_BUCKET=$RAW_DATA_BUCKET,NODE_ENV=development,DEV_JWT_SECRET=change-me-not-for-real-prod,PLATFORM_ADMIN_API_KEY=change-me-not-for-real-prod,DATABASE_URL=postgresql://transformiq_app:$($DB_APP_PASSWORD)@/$($DB_NAME)?host=/cloudsql/$($CONNECTION_NAME)"
Stop-OnFailure "deploy to Cloud Run"

Write-Host ""
Write-Host "=== Done. Ingestion should complete properly now - try uploading a dataset. ===" -ForegroundColor Green
