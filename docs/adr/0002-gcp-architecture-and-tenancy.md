# ADR 0002 — GCP Architecture & Multi-Tenancy Isolation Strategy

Status: Accepted (2026-08-12)
Owner: BE1 (per Sprint 1, TQ-010)
Related backlog: TQ-001, TQ-004, TQ-011, TQ-012

## Context

`TransformIQ_Sprint_Plan.xlsx` (GCP Architecture tab) proposes a GCP service mapping for the
platform, reusing the existing GCP project already provisioned for this account rather than
creating a new one. This ADR ratifies that mapping for Sprint 1 scaffolding purposes and records
the tenant-isolation mechanism, since AGENTS.md (Security Rules, Database Rules) requires strong
tenant isolation and this must be decided before the Tenant/Project schema is written.

## Decision — service mapping (Sprint 1 scope)

| Component | Service | Sprint 1 status |
|---|---|---|
| API compute | Cloud Run | Scaffolded (`backend/Dockerfile`, `backend/cloudbuild.yaml`); not deployed — needs the user's GCP project ID and `gcloud`/CI credentials |
| Primary database | Cloud SQL for PostgreSQL | Scaffolded locally via `docker-compose.yml` (Postgres 16); Terraform module written but not applied (`infra/terraform/modules/cloudsql`) |
| Immutable raw storage | Cloud Storage (bucket versioning + retention lock) | Terraform module written, not applied (`infra/terraform/modules/storage`) |
| Secrets | Secret Manager | Abstraction written (`backend/src/lib/secrets.ts`) — falls back to `.env` locally, calls Secret Manager when `GCP_PROJECT_ID` is set |
| Identity/auth | Identity Platform (OIDC) | Middleware written to verify a JWT with a pluggable issuer/JWKS (`backend/src/middleware/auth.ts`); no real IdP wired up yet — needs the user's Identity Platform / OIDC provider config |
| IaC | Terraform | Skeleton only — **not applied**. Running `terraform apply` requires the user's GCP project ID and credentials in a real (non-sandboxed) environment |
| CI/CD | GitHub Actions (test/lint gate) + Cloud Build (deploy) | Both scaffolded; Cloud Build deploy step is not wired to a live GCP project yet |

**This scaffold is code + IaC, not a deployed system.** Nothing here has touched a real GCP
project. Turning this into a running dev environment requires: (1) the user's GCP project ID,
(2) `gcloud` auth (or a service account key) supplied to CI/Terraform, (3) running
`terraform apply` against `infra/terraform/environments/dev.tfvars`.

## Decision — tenant isolation strategy

Every tenant-scoped table carries a `tenant_id` column (see `backend/prisma/schema.prisma`).
Isolation is enforced at **two layers**, per AGENTS.md §3.1 (RBAC) and §4 (Database Rules):

1. **Postgres Row-Level Security (RLS).** A SQL migration
   (`backend/prisma/migrations/<timestamp>_enable_rls/migration.sql`) enables RLS on every
   tenant-scoped table and adds a policy requiring
   `tenant_id = current_setting('app.tenant_id')::uuid`. Prisma cannot express RLS policies in
   its schema DSL, so this migration is hand-written SQL layered on top of Prisma's generated
   migrations — **never remove or "clean up" this file as if it were generated cruft.**
2. **Application-layer enforcement.** `backend/src/lib/prisma.ts` exposes a `withTenant(tenantId,
   fn)` helper that opens a Prisma interactive transaction, issues `SET LOCAL app.tenant_id =
   $1` as the first statement, and runs the callback inside it. Every route handler that touches
   tenant data must go through `withTenant` — there is no "trusted" code path that bypasses it.
   `backend/src/middleware/tenant.ts` extracts the tenant from the authenticated JWT claim and
   attaches it to `req.tenantId` before any handler runs.

Cross-tenant-leakage testing (TQ-012, Sprint 2) should attempt to read another tenant's rows both
through the API *and* through a raw query that skips `withTenant`, to prove RLS holds even if
application code has a bug — RLS is the backstop, not the only control.

## Consequences

- Every new tenant-scoped Prisma model must be added to the RLS migration's table list — this is
  a manual step Prisma doesn't automate. Add a CI check in Sprint 2 (or earlier) that fails if a
  table with `tenant_id` exists without a matching RLS policy.
- `withTenant` adds a small amount of ceremony to every handler; this is intentional friction so
  "forgot to scope this query" fails loudly (missing tenant context) instead of silently leaking.
