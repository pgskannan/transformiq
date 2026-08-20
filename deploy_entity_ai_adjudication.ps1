# Ship the entity-match-adjudication AI feature (Sprint 5 continuation): migrates the new
# entity_matches.ai_* columns onto the live Cloud SQL database, then rebuilds + redeploys both
# the backend (aiAdjudicator.ts, migration 0014, updated entityMatches.ts route, and the
# already-verified queue.ts fix) and the frontend (EntityResolution.tsx's AI badge, api.ts's
# new types). Run this from C:\TransformIQ\SRS\transformiq in PowerShell.
#
# Same Stop-OnFailure convention as the other deploy scripts in this repo - if it stops
# partway, fix that one thing and re-run. The migration step is idempotent (db/migrate.ts
# tracks applied filenames in _migrations and skips ones already run), so re-running this
# script after a partial failure will not try to re-apply 0014 a second time.

function Stop-OnFailure($stepName) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED at: $stepName (exit code $LASTEXITCODE). Fix this and re-run the script." -ForegroundColor Red
    exit 1
  }
}

$PROJECT_ID = "transformiq-transformiq-dev"
$REGION = "us-central1"
$INSTANCE = "transformiq-db"
$DB_NAME = "transformiq"
$AR_REPO = "transformiq"
$BACKEND_SERVICE = "transformiq-backend-dev"
$FRONTEND_SERVICE = "transformiq-frontend-dev"
$BACKEND_IMAGE = "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/backend:latest"
$FRONTEND_IMAGE = "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/frontend:latest"
$RAW_DATA_BUCKET = "$($PROJECT_ID)-raw-data"
$DB_APP_PASSWORD = "transformiq_dev_only"

Write-Host "=== 1. Temporarily open the Cloud SQL network for the migration ===" -ForegroundColor Cyan
gcloud sql instances patch $INSTANCE --authorized-networks="0.0.0.0/0" --quiet
Stop-OnFailure "open Cloud SQL network for migration"

$INSTANCE_IP = (gcloud sql instances describe $INSTANCE --format="value(ipAddresses[0].ipAddress)")
Stop-OnFailure "look up instance IP"
Write-Host "Cloud SQL public IP: $INSTANCE_IP"

Write-Host "=== 2. Run migration 0014 (entity_matches.ai_* columns) ===" -ForegroundColor Cyan
$PG_ROOT_PASSWORD = Read-Host "Enter the Postgres root password you saved from the original deploy"
Push-Location backend
npm install
Stop-OnFailure "npm install"
$env:MIGRATIONS_DATABASE_URL = "postgresql://postgres:{0}@{1}:5432/{2}" -f $PG_ROOT_PASSWORD, $INSTANCE_IP, $DB_NAME
Write-Host "Connecting to: postgresql://postgres:***REDACTED***@$($INSTANCE_IP):5432/$($DB_NAME)"
npm run db:migrate
$migrateExitCode = $LASTEXITCODE
Pop-Location
if ($migrateExitCode -ne 0) {
  Write-Host "FAILED at: run migration 0014 (exit code $migrateExitCode)." -ForegroundColor Red
  exit 1
}

Write-Host "=== 3. Lock the Cloud SQL instance back down ===" -ForegroundColor Cyan
gcloud sql instances patch $INSTANCE --clear-authorized-networks --quiet
Stop-OnFailure "lock down Cloud SQL network"

Write-Host "=== 4. Build + push the backend image (aiAdjudicator.ts, entityMatches.ts, queue.ts) ===" -ForegroundColor Cyan
gcloud builds submit --tag=$BACKEND_IMAGE ./backend
Stop-OnFailure "build + push backend image"

Write-Host "=== 5. Deploy the backend ===" -ForegroundColor Cyan
# --no-cpu-throttling deliberately omitted - it caused an 8+ minute Cloud Run provisioning
# stall in an earlier deploy of this same service, and isn't needed at this demo's job sizes
# (see redeploy_backend_only.ps1's header comment for the full story).
$CONNECTION_NAME = "$($PROJECT_ID):$($REGION):$($INSTANCE)"
gcloud run deploy $BACKEND_SERVICE --image=$BACKEND_IMAGE --region=$REGION --platform=managed --allow-unauthenticated --add-cloudsql-instances=$CONNECTION_NAME --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,RAW_DATA_BUCKET=$RAW_DATA_BUCKET,NODE_ENV=development,DEV_JWT_SECRET=change-me-not-for-real-prod,PLATFORM_ADMIN_API_KEY=change-me-not-for-real-prod,DATABASE_URL=postgresql://transformiq_app:$($DB_APP_PASSWORD)@/$($DB_NAME)?host=/cloudsql/$($CONNECTION_NAME)"
Stop-OnFailure "deploy backend to Cloud Run"

$BACKEND_URL = gcloud run services describe $BACKEND_SERVICE --region=$REGION --format="value(status.url)"
Stop-OnFailure "look up backend URL"
Write-Host "Backend URL: $BACKEND_URL"

Write-Host "=== 6. Build + push the frontend image (EntityResolution.tsx's AI badge, api.ts types) ===" -ForegroundColor Cyan
$cloudbuildConfig = @'
steps:
  - name: "gcr.io/cloud-builders/docker"
    args: ["build", "--build-arg", "VITE_API_BASE_URL=$_BACKEND_URL", "-t", "$_IMAGE", "."]
images: ["$_IMAGE"]
'@
$cloudbuildConfigPath = Join-Path $env:TEMP "transformiq-frontend-cloudbuild.yaml"
$cloudbuildConfig | Out-File -FilePath $cloudbuildConfigPath -Encoding utf8 -NoNewline

gcloud builds submit --config=$cloudbuildConfigPath `
  --substitutions="_BACKEND_URL=$BACKEND_URL,_IMAGE=$FRONTEND_IMAGE" `
  ./frontend
Stop-OnFailure "build + push frontend image"

Write-Host "=== 7. Deploy the frontend ===" -ForegroundColor Cyan
gcloud run deploy $FRONTEND_SERVICE `
  --image=$FRONTEND_IMAGE `
  --region=$REGION `
  --platform=managed `
  --allow-unauthenticated `
  --port=80
Stop-OnFailure "deploy frontend to Cloud Run"

$FRONTEND_URL = gcloud run services describe $FRONTEND_SERVICE --region=$REGION --format="value(status.url)"

Write-Host ""
Write-Host "=== Done. ===" -ForegroundColor Green
Write-Host "Backend:  $BACKEND_URL"
Write-Host "Frontend: $FRONTEND_URL"
Write-Host ""
Write-Host "Next: seed two near-duplicate Business Partners (e.g. 'Acme Corp' / 'Acme Corporation'," -ForegroundColor Cyan
Write-Host "same address) via the frontend or the API, open BP/Supplier Resolution, click 'Run" -ForegroundColor Cyan
Write-Host "matching', and confirm the purple AI recommendation badge appears on the ambiguous" -ForegroundColor Cyan
Write-Host "candidate pair." -ForegroundColor Cyan
