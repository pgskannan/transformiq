# Rebuild + redeploy just the frontend, after the nginx SPA-fallback fix (direct
# navigation/refresh to a client-side route was 404ing - see nginx.conf's comment).

function Stop-OnFailure($stepName) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED at: $stepName (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
  }
}

$PROJECT_ID = "transformiq-transformiq-dev"
$REGION = "us-central1"
$AR_REPO = "transformiq"
$BACKEND_SERVICE = "transformiq-backend-dev"
$FRONTEND_SERVICE = "transformiq-frontend-dev"

$BACKEND_URL = gcloud run services describe $BACKEND_SERVICE --region=$REGION --format="value(status.url)"
Stop-OnFailure "look up backend URL"
Write-Host "Backend URL: $BACKEND_URL"

$FRONTEND_IMAGE = "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/frontend:latest"

$cloudbuildConfig = @'
steps:
  - name: "gcr.io/cloud-builders/docker"
    args: ["build", "--build-arg", "VITE_API_BASE_URL=$_BACKEND_URL", "-t", "$_IMAGE", "."]
images: ["$_IMAGE"]
'@
$cloudbuildConfigPath = Join-Path $env:TEMP "transformiq-frontend-cloudbuild.yaml"
$cloudbuildConfig | Out-File -FilePath $cloudbuildConfigPath -Encoding utf8 -NoNewline

Write-Host "=== Build + push the frontend image ===" -ForegroundColor Cyan
gcloud builds submit --config=$cloudbuildConfigPath `
  --substitutions="_BACKEND_URL=$BACKEND_URL,_IMAGE=$FRONTEND_IMAGE" `
  ./frontend
Stop-OnFailure "build + push frontend image"

Write-Host "=== Deploy the frontend ===" -ForegroundColor Cyan
gcloud run deploy $FRONTEND_SERVICE `
  --image=$FRONTEND_IMAGE `
  --region=$REGION `
  --platform=managed `
  --allow-unauthenticated `
  --port=80
Stop-OnFailure "deploy frontend to Cloud Run"

$FRONTEND_URL = gcloud run services describe $FRONTEND_SERVICE --region=$REGION --format="value(status.url)"
Write-Host ""
Write-Host "=== Done. Frontend: $FRONTEND_URL ===" -ForegroundColor Green
