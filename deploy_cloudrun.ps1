# TransformIQ backend -> Cloud Run deploy (the real backend, not the earlier static demo).
# Run this in PowerShell from C:\TransformIQ\SRS\transformiq. Requires the gcloud CLI + Node/
# npm + being logged in (`gcloud auth login` if needed).
#
# Each step checks $LASTEXITCODE after external commands (gcloud/npm exit codes are NOT
# caught by $ErrorActionPreference="Stop" - that only applies to PowerShell's own errors) and
# stops with a clear message if a step fails, instead of cascading into the next step on
# broken state. If it stops partway, fix that one thing and re-run the whole script - steps
# that already succeeded (API enablement, instance/database/repo creation) detect that and
# skip themselves rather than erroring "already exists".

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
$SERVICE = "transformiq-backend-dev"
$IMAGE = "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/backend:latest"

Write-Host "=== 0. Set project ===" -ForegroundColor Cyan
gcloud config set project $PROJECT_ID
Stop-OnFailure "set project"

Write-Host "=== 1. Enable required APIs (retry this step alone if you hit a 429/quota error) ===" -ForegroundColor Cyan
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com
Stop-OnFailure "enable APIs"

Write-Host "=== 2. Create Cloud SQL Postgres 16 instance (~5-10 min, be patient) ===" -ForegroundColor Cyan
$instanceExists = gcloud sql instances describe $INSTANCE --format="value(name)" 2>$null
if ($instanceExists) {
  Write-Host "Instance already exists, skipping creation." -ForegroundColor Yellow
  $PG_ROOT_PASSWORD = Read-Host "Enter the Postgres root password you saved from the earlier attempt"
} else {
  $PG_ROOT_PASSWORD = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | % {[char]$_})
  Write-Host "Generated Postgres root password (SAVE THIS somewhere safe): $PG_ROOT_PASSWORD" -ForegroundColor Yellow

  # --edition=ENTERPRISE forces the older/cheaper edition that supports small shared-core
  # tiers like db-f1-micro - this project's account-level default is ENTERPRISE_PLUS, which
  # only accepts its own (larger, pricier) db-perf-optimized-* tier names.
  gcloud sql instances create $INSTANCE --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro --region=$REGION --root-password=$PG_ROOT_PASSWORD
  Stop-OnFailure "create Cloud SQL instance"
}

Write-Host "=== 2b. Temporarily open the Cloud SQL network for migrations ===" -ForegroundColor Cyan
# Runs every time (not just on first create) - a prior run's step 4c always locks the network
# back down at the end, so a later re-run (e.g. instance already existed, skipping step 2's
# create branch) would otherwise try to connect to a closed instance and hang until
# ETIMEDOUT. Idempotent either way - locked back down again right after migrations (step 4c).
gcloud sql instances patch $INSTANCE --authorized-networks="0.0.0.0/0" --quiet
Stop-OnFailure "open Cloud SQL network for migrations"

Write-Host "=== 3. Create the transformiq database ===" -ForegroundColor Cyan
$dbExists = gcloud sql databases describe $DB_NAME --instance=$INSTANCE --format="value(name)" 2>$null
if (-not $dbExists) {
  gcloud sql databases create $DB_NAME --instance=$INSTANCE
  Stop-OnFailure "create database"
}

$INSTANCE_IP = (gcloud sql instances describe $INSTANCE --format="value(ipAddresses[0].ipAddress)")
Stop-OnFailure "look up instance IP"
Write-Host "Cloud SQL public IP: $INSTANCE_IP"

Write-Host "=== 4a. Install backend dependencies ===" -ForegroundColor Cyan
Push-Location backend
npm install
Stop-OnFailure "npm install"

Write-Host "=== 4b. Run migrations (bootstraps the least-privilege transformiq_app role too) ===" -ForegroundColor Cyan
$env:MIGRATIONS_DATABASE_URL = "postgresql://postgres:{0}@{1}:5432/{2}" -f $PG_ROOT_PASSWORD, $INSTANCE_IP, $DB_NAME
Write-Host "Connecting to: postgresql://postgres:***REDACTED***@$($INSTANCE_IP):5432/$($DB_NAME)"
npm run db:migrate
$migrateExitCode = $LASTEXITCODE
Pop-Location
if ($migrateExitCode -ne 0) {
  Write-Host "FAILED at: run migrations (exit code $migrateExitCode)." -ForegroundColor Red
  exit 1
}

Write-Host "=== 4c. Lock the Cloud SQL instance back down (remove the temporary open network) ===" -ForegroundColor Cyan
gcloud sql instances patch $INSTANCE --clear-authorized-networks --quiet
Stop-OnFailure "lock down Cloud SQL network"

Write-Host "=== 5. Store the Gemini key in Secret Manager (never in code/config - AGENTS.md Do-Not-Do #9) ===" -ForegroundColor Cyan
$secretExists = gcloud secrets describe GEMINI_API_KEY --format="value(name)" 2>$null
$GEMINI_KEY = Read-Host "Paste your Gemini API key (from https://aistudio.google.com/apikey)"
if (-not $secretExists) { $GEMINI_KEY | gcloud secrets create GEMINI_API_KEY --data-file=- }
else { $GEMINI_KEY | gcloud secrets versions add GEMINI_API_KEY --data-file=- }
Stop-OnFailure "store Gemini key"

# transformiq_app's password is the fixed local-dev value from migration 0004 (see that
# file's header comment) - fine for this hackathon demo, passed as a Cloud Run env var
# (never committed to the repo) rather than hard-coded in source. Rotate via Secret Manager
# before any deployment beyond this demo.
$DB_APP_PASSWORD = "transformiq_dev_only"

Write-Host "=== 6. Create the Artifact Registry repo (first run only) ===" -ForegroundColor Cyan
$repoExists = gcloud artifacts repositories describe $AR_REPO --location=$REGION --format="value(name)" 2>$null
if (-not $repoExists) {
  gcloud artifacts repositories create $AR_REPO --repository-format=docker --location=$REGION
  Stop-OnFailure "create Artifact Registry repo"
}

Write-Host "=== 7. Build + push the backend image (source-based Cloud Build) ===" -ForegroundColor Cyan
gcloud builds submit --tag=$IMAGE ./backend
Stop-OnFailure "build + push image"

Write-Host "=== 7b. Grant Cloud Run's default service account access to the Gemini secret ===" -ForegroundColor Cyan
# Cloud Run revisions run as PROJECT_NUMBER-compute@developer.gserviceaccount.com by default -
# it has no access to any secret until explicitly granted. Idempotent (safe to re-run;
# add-iam-policy-binding no-ops if the binding already exists).
$PROJECT_NUMBER = (gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
Stop-OnFailure "look up project number"
$RUNTIME_SA = "$($PROJECT_NUMBER)-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
Stop-OnFailure "grant Secret Manager access"

Write-Host "=== 7c. Create the raw-file GCS bucket (lib/objectStorage.ts requires RAW_DATA_BUCKET whenever GCP_PROJECT_ID is set) ===" -ForegroundColor Cyan
# Ingestion writes every uploaded file here immutably (AGENTS.md 4.1) before parsing - without
# this, the backend 500s on the very first CSV upload. Idempotent (bucket create/IAM grant
# both no-op if they already exist).
$RAW_DATA_BUCKET = "$($PROJECT_ID)-raw-data"
$bucketExists = gcloud storage buckets describe "gs://$RAW_DATA_BUCKET" --format="value(name)" 2>$null
if (-not $bucketExists) {
  gcloud storage buckets create "gs://$RAW_DATA_BUCKET" --location=$REGION --uniform-bucket-level-access
  Stop-OnFailure "create raw-data GCS bucket"
}
gcloud storage buckets add-iam-policy-binding "gs://$RAW_DATA_BUCKET" --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin"
Stop-OnFailure "grant GCS bucket access"

Write-Host "=== 8. Deploy to Cloud Run, wired to Cloud SQL via the unix-socket connector ===" -ForegroundColor Cyan
$CONNECTION_NAME = "$($PROJECT_ID):$($REGION):$($INSTANCE)"
# PORT is a Cloud Run-reserved env var name (it's injected automatically to match
# --port/the container's listen port) - setting it via --set-env-vars is rejected outright.
# NOTE on background work: the ingestion job runs in-process via setImmediate
# (lib/jobs/queue.ts's LocalAsyncJobQueue - see that file's header comment for why, given
# there's no deployed Pub/Sub consumer). Cloud Run's default CPU throttling *can* starve
# background work once a response is flushed, and --no-cpu-throttling avoids that - but it was
# tried here and hit an 8+ minute platform-side provisioning stall with zero application logs
# (a Cloud Run scheduling issue, not anything in this codebase), so it's deliberately left off.
# Fine for a demo-sized dataset (the job finishes within the original request's own CPU
# window); revisit only if background jobs are observed stalling on a larger real dataset.
gcloud run deploy $SERVICE --image=$IMAGE --region=$REGION --platform=managed --allow-unauthenticated --add-cloudsql-instances=$CONNECTION_NAME --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,RAW_DATA_BUCKET=$RAW_DATA_BUCKET,NODE_ENV=production,DEV_JWT_SECRET=change-me-not-for-real-prod,PLATFORM_ADMIN_API_KEY=change-me-not-for-real-prod,DATABASE_URL=postgresql://transformiq_app:$($DB_APP_PASSWORD)@/$($DB_NAME)?host=/cloudsql/$($CONNECTION_NAME)"
Stop-OnFailure "deploy to Cloud Run"

Write-Host "=== Done. Backend service URL: ===" -ForegroundColor Green
$SERVICE_URL = gcloud run services describe $SERVICE --region=$REGION --format="value(status.url)"
Write-Host $SERVICE_URL

Write-Host ""
Write-Host "Next: run .\deploy_cloudrun_part2.ps1 to fix login and deploy the frontend." -ForegroundColor Cyan
