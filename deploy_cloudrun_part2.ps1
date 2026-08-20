# Part 2: get the FULL demo working on live Cloud Run URLs (no local frontend needed).
# Run this AFTER deploy_cloudrun.ps1 has finished successfully, from
# C:\TransformIQ\SRS\transformiq in PowerShell.
#
# Two things part 1 didn't cover:
#  1. The backend's dev-token login endpoint (the only login mechanism that exists  -  there's
#     no real OIDC provider configured) is hard-disabled whenever NODE_ENV=production
#     (backend/src/routes/auth.ts  -  deliberately, so a real deployment can never fall back to
#     it). Part 1 set NODE_ENV=production, which is the *correct* default but means nobody
#     can log in. For THIS hackathon demo deployment specifically  -  synthetic data, no real
#     customers  -  we relax that to NODE_ENV=development so the dev-token path stays live.
#     This is a demo-only exception, not something to carry into a real deployment.
#  2. Deploying the frontend as a static site to its own Cloud Run service, pointed at the
#     backend's URL, plus creating one demo tenant via the platform-admin endpoint (the
#     browser-based "bootstrap a demo tenant" convenience page only exists in local dev
#     builds by design  -  this does the same thing via one curl-equivalent call instead).
#
# Same pattern as part 1: every gcloud/npm call is checked against $LASTEXITCODE explicitly
# (PowerShell's $ErrorActionPreference="Stop" does NOT catch native-program exit codes), so a
# failure stops the script with a clear message instead of cascading into the next step.

function Stop-OnFailure($stepName) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED at: $stepName (exit code $LASTEXITCODE). Fix this and re-run the script." -ForegroundColor Red
    exit 1
  }
}

$PROJECT_ID = "transformiq-transformiq-dev"
$REGION = "us-central1"
$AR_REPO = "transformiq"
$BACKEND_SERVICE = "transformiq-backend-dev"
$FRONTEND_SERVICE = "transformiq-frontend-dev"
$PLATFORM_ADMIN_KEY = "change-me-not-for-real-prod"  # must match part 1's --set-env-vars value

Write-Host "=== 1. Relax backend NODE_ENV for this demo (see header comment) ===" -ForegroundColor Cyan
gcloud run services update $BACKEND_SERVICE --region=$REGION --update-env-vars="NODE_ENV=development"
Stop-OnFailure "relax backend NODE_ENV"

$BACKEND_URL = gcloud run services describe $BACKEND_SERVICE --region=$REGION --format="value(status.url)"
Stop-OnFailure "look up backend URL"
Write-Host "Backend URL: $BACKEND_URL"

Write-Host "=== 2. Build the frontend image, pointed at the live backend ===" -ForegroundColor Cyan
$FRONTEND_IMAGE = "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/frontend:latest"

# Single-quoted here-string: $_BACKEND_URL / $_IMAGE below must stay LITERAL text for Cloud
# Build's own substitution engine to fill in via --substitutions, not be expanded by
# PowerShell right now.
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

Write-Host "=== 3. Deploy the frontend (nginx listens on port 80, tell Cloud Run) ===" -ForegroundColor Cyan
gcloud run deploy $FRONTEND_SERVICE `
  --image=$FRONTEND_IMAGE `
  --region=$REGION `
  --platform=managed `
  --allow-unauthenticated `
  --port=80
Stop-OnFailure "deploy frontend to Cloud Run"

$FRONTEND_URL = gcloud run services describe $FRONTEND_SERVICE --region=$REGION --format="value(status.url)"
Stop-OnFailure "look up frontend URL"
Write-Host "Frontend URL: $FRONTEND_URL" -ForegroundColor Green

Write-Host "=== 4. Create one demo tenant via the platform-admin endpoint ===" -ForegroundColor Cyan
try {
  $tenantResponse = Invoke-RestMethod -Method Post -Uri "$BACKEND_URL/v1/tenants" `
    -Headers @{ "x-platform-admin-key" = $PLATFORM_ADMIN_KEY; "Content-Type" = "application/json" } `
    -Body '{"name":"Acme Procurement (Hackathon Demo)"}'
} catch {
  Write-Host "FAILED at: create demo tenant - $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor Red }
  exit 1
}
Write-Host "Tenant created  -  ID (use this to sign in on the Login page): $($tenantResponse.id)" -ForegroundColor Yellow

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Frontend: $FRONTEND_URL"
Write-Host "Tenant ID for login: $($tenantResponse.id)"
Write-Host "Sign in with any email + role (e.g. STEWARD) and that tenant ID."
