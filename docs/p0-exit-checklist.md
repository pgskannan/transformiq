# P0 exit checklist (TQ-020)

P0 exit criteria (AGENTS.md §"Roadmap", SRS §28): **"Foundation tested"** — Security, tenancy,
immutable data, project/dataset model.

Acceptance criteria for TQ-020 itself: *"Transformation Lead + Security/Platform Admin sign off
that P0 exit criteria are met."* This document assembles the evidence for that sign-off; it
does not substitute for it. The sign-off section at the bottom is left blank on purpose — an AI
agent scaffolding this codebase is not the Transformation Lead or Security/Platform Admin the
SRS means, and should not fabricate their approval.

## 1. Security

| Requirement | Evidence | Status |
|---|---|---|
| RBAC (5 roles, permission-gated actions) | `backend/src/middleware/rbac.ts`; `src/__tests__/rbac.test.ts` — VIEWER blocked from create/modify (403), unrecognized role fails closed | ✅ tested |
| Tenant creation is not self-service | `backend/src/routes/tenants.ts` (`requirePlatformAdmin()`); `tenant-isolation.test.ts` — no/wrong key → 403 | ✅ tested |
| No secret in code, committed config, or logs | `.gitignore` (`.env` excluded); CI `secret-scan` job (gitleaks, full history + working tree); `src/__tests__/logging.test.ts` proves the JWT and platform-admin key are redacted from request logs, not merely assumed absent (this was a real bug caught and fixed this sprint — see `docs/security/encryption-checklist.md`) | ✅ tested |
| Encryption in transit / at rest | `docs/security/encryption-checklist.md` | 🔧 documented + IaC-configured, not applied to a live project (no GCP credentials available in any environment this was built in) |
| Append-only audit log | `db/migrations/0004_least_privilege_app_role.sql` (UPDATE/DELETE revoked at the DB grant level); `src/__tests__/audit.test.ts` — proves the **app's own** DB connection gets "permission denied" on UPDATE/DELETE, not just a raw psql session | ✅ tested |

## 2. Tenancy

| Requirement | Evidence | Status |
|---|---|---|
| Row-Level Security on every tenant-scoped table | `db/migrations/0002_enable_rls.sql`, `0003_datasets.sql` (`FORCE ROW LEVEL SECURITY`) | ✅ applied to a real local Postgres instance |
| Cross-tenant reads/writes are impossible, not just forbidden | `tenant-isolation.test.ts` — IDOR checks on `/v1/projects/:id` (GET+PATCH) and dataset endpoints return 404, not 403 (RLS makes the row invisible, no "yes that exists but isn't yours" signal leaked) | ✅ tested |
| Unscoped writes fail even from trusted app code | `tenant-isolation.test.ts` — a raw insert with no `app.tenant_id` set is rejected by Postgres itself (`row-level security` error), proving RLS is a real backstop and not just an app-layer convention | ✅ tested |

## 3. Immutable data

| Requirement | Evidence | Status |
|---|---|---|
| Raw ingested artifacts are never modified after write | `backend/src/lib/objectStorage.ts` — content-addressed by SHA-256, chmod 0o444 | ✅ tested locally, **with an honestly-documented gap**: this sandbox runs as root, which bypasses Unix file permissions entirely. `datasets.test.ts` proves this directly (it doesn't hide it) and documents that real immutability in production comes from GCS bucket versioning + retention lock (`infra/terraform/modules/storage`), not the chmod call. |
| GCS-level immutability enforcement | `infra/terraform/modules/storage/main.tf` — versioning enabled, retention policy set (lock intentionally left `false` until a real retention period is approved per SRS §19) | 🔧 written, not applied (no live bucket) |
| Checksums are independently verifiable | `datasets.test.ts` — computes SHA-256 outside the app and compares against the stored checksum and the actual retrieved bytes | ✅ tested |
| Idempotent re-upload of identical content | `datasets.test.ts` | ✅ tested |

## 4. Project / dataset model

| Requirement | Evidence | Status |
|---|---|---|
| Project CRUD (create/list/get/update), versioned API | `backend/src/routes/projects.ts` — `/v1/projects` POST/GET, `/v1/projects/:id` GET/PATCH, every mutation audit-logged in the same transaction | ✅ tested |
| Dataset / DatasetVersion model with lineage | `db/migrations/0003_datasets.sql` (`parent_version_id` self-FK); `datasets.ts` routes; `datasets.test.ts` — version chain resolves back to source artifact | ✅ tested |
| Project Setup UI (domain, source, target, owner, environment) | `frontend/src/pages/ProjectSetup.tsx`; `ProjectSetup.test.tsx` — submits all fields, owner shown read-only (derived from the signed-in identity, not user-editable — no matching backend support for an arbitrary owner, so the UI doesn't offer it) | ✅ tested (jsdom component test; not tested in a real browser — no browser automation was run against the dev server this sprint) |
| A user can create a project end-to-end through the UI | Manual live E2E: dev server → login → Project Setup form → `POST /v1/projects` → Dashboard lists it. Also proven via the real HTTP API directly (curl) against a live local backend+Postgres, matching what the fixed frontend now sends (tenant creation now requires `x-platform-admin-key`, which `Login.tsx` no longer holds — see `DevBootstrapTenant.tsx`) | ✅ verified against a real running backend; frontend interaction verified via automated component tests, not a live browser session |

## What P0 explicitly does not include (do not read their absence as a gap in this checklist)

- Real OIDC/Identity Platform login (still dev-token stand-in) — tracked as backend TQ-006,
  P1 scope.
- Multipart/CSV file upload with encoding/delimiter detection — dataset ingestion today is a
  JSON+base64 MVP shape proving the storage/versioning plumbing; real upload is TQ-021,
  Sprint 3.
- AI-assisted target field mapping, semantic matching, rule engine — P1 scope (Sprint 5+ per
  the roadmap).
- Per-operator platform-admin credentials (currently one static shared secret) — flagged in
  `docs/security/encryption-checklist.md`, not blocking for the P0 walking-skeleton threat
  model, but should be resolved before onboarding real customers.

## What could not be verified in this environment (be specific, not vague)

- No `terraform apply` has been run against any real GCP project — every 🔧 row above is
  reviewed IaC, not a live-tested configuration. No GCP credentials were available in any
  environment this scaffold was built in.
- No Docker daemon was available — the stack was verified against a natively-installed
  PostgreSQL 16 instead of the `docker-compose.yml` path. `docker-compose.yml` itself has
  been reviewed but not run end-to-end.
- No real browser session (Chrome automation, Playwright, etc.) was run against the Vite dev
  server — frontend behavior is verified via jsdom-based component tests
  (`@testing-library/react` + vitest) and the backend API surface is verified via live HTTP
  calls, but the two have not been exercised together through an actual browser.
- This sandbox runs as root, which bypasses the Unix-permission-based local dev storage
  guard entirely (documented, not hidden, in `datasets.test.ts` and `objectStorage.ts`).

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Transformation Lead | _(pending)_ | | |
| Security / Platform Admin | _(pending)_ | | |

This checklist is evidence for that conversation, not a substitute for it.
