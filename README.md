# TransformIQ

AI-assisted procurement-data transformation platform (Business Partner + Supplier, Direct +
Indirect Procurement, SAP S/4HANA + SAP Ariba). See `AGENTS.md` / `CLAUDE.md` for the full
operating manual (architecture, business rules, security rules, database rules, testing
rules, deployment rules, do-not-do rules) — read that before making non-trivial changes.

This repo covers **Sprint 1 + Sprint 2** from `TransformIQ_Sprint_Plan.xlsx` (TQ-001–TQ-010,
TQ-079, and TQ-011–TQ-020) — the full **P0 "Foundation" phase** (exit criteria: "Foundation
tested" — security, tenancy, immutable data, project/dataset model). See
`docs/p0-exit-checklist.md` for the evidence behind that claim, mapped item by item. No
procurement domain features yet (those start Sprint 3+).

## What's actually verified vs. what's still ahead

This scaffold was built and verified in a sandboxed environment with **no real GCP project
and no internet access to Prisma's binary CDN** (see `docs/adr/0001-tech-stack.md`). What
that means concretely:

**Verified for real, in this repo, right now:**
- Backend builds (`tsc`), lints (`eslint`), and passes its full test suite (6 suites, 15
  tests) against a **real local Postgres 16**, running as the actual least-privilege
  `transformiq_app` role the production app would use — not a superuser connection that
  could mask a missing GRANT.
- Row-Level Security actually blocks cross-tenant reads/writes: live HTTP tests prove
  cross-tenant `GET`/`PATCH` on projects and datasets return 404 (RLS makes the row
  invisible, not just forbidden), and that an unscoped raw insert is rejected by Postgres
  itself, not just app-layer convention.
- RBAC actually blocks insufficient-permission actions: a VIEWER gets 403 on create/modify;
  an unrecognized role fails closed.
- The audit log is append-only at the database grant level, proven against the **app's own**
  Kysely connection (not just a raw psql session) — UPDATE/DELETE both fail with "permission
  denied."
- Raw dataset storage is content-addressed, checksum-verified, and versioned with lineage;
  the local chmod-based immutability guard's real limitation (root bypasses Unix file
  permissions) was found and proven directly, not hidden.
- Secrets never reach the logs: `pino-http`'s default header logging would have leaked the
  JWT and the platform-admin key — found by direct inspection, fixed, and now covered by a
  test that captures real stdout output.
- CI runs a `secret-scan` job (`gitleaks`, full git history + working tree) on every
  push/PR, gating merge — ran clean against this repo's actual history while building it.
- Frontend builds (`vite build`), lints, and passes its test suite (`vitest`), including the
  Project Setup form (TQ-018) submitting all fields and the dev-only tenant-bootstrap page
  being fully absent from the production bundle (verified by grepping the built output).
- The migration runner (`db/migrate.ts`) applies `db/migrations/*.sql` to a blank database
  from scratch, using a schema-owner connection separate from the app's least-privilege role.
- `kysely-codegen` generates real TypeScript types by introspecting that live database.
- The backend and frontend both actually run (`npm run dev` in each). The full user flow
  (bootstrap a tenant → sign in → create a project → see it listed → confirm a second tenant
  sees nothing) was verified two ways: the exact HTTP sequence the frontend now sends was
  driven directly via curl against a live backend + Postgres, and the frontend's own logic
  was verified via `@testing-library/react` component tests. **Not yet verified: an actual
  browser session clicking through the running dev server** — no browser automation was run
  this sprint. Do a manual click-through before treating the UI as demo-ready.

**Written but NOT verified against a real GCP project (no credentials were available):**
- `infra/terraform/*` — HCL syntax was checked with `terraform-config-inspect` (no
  diagnostics), but `terraform validate`/`plan`/`apply` have never been run. **Do not assume
  this applies cleanly the first time** — review it like a first draft, not a tested module.
- `backend/cloudbuild.yaml` — deploy step is unwired (placeholder `_GCP_PROJECT_ID`).
- Identity Platform / real OIDC login — `src/middleware/auth.ts` supports it, but only the
  dev-token path has ever actually been exercised.
- Secret Manager — `src/lib/secrets.ts` falls back to `.env` locally; the Secret Manager
  branch has never run against a real project.
- Vertex AI — `src/lib/vertexAI.ts` is a typed stub; both functions throw until Sprint 4/5
  wire them up for real (TQ-032/TQ-039/TQ-040).
- GCS object storage (`GcsObjectStorage` in `src/lib/objectStorage.ts`) — implemented and
  code-reviewed, never run against a real bucket.
- Cloud SQL `ssl_mode = "ENCRYPTED_ONLY"` and the GCS bucket versioning/retention-lock config
  — written into `infra/terraform/`, never applied. See `docs/security/encryption-checklist.md`.

## Repo layout

```
backend/     Express + TypeScript API (Kysely + Postgres, JWT auth, RBAC, RLS-enforced tenancy)
frontend/    React + Vite + TypeScript (login → project setup → dashboard)
infra/terraform/   IaC for Cloud Run, Cloud SQL, GCS, Artifact Registry, VPC (not applied)
docs/adr/    Architecture decision records (start here for the "why")
docs/security/encryption-checklist.md   TQ-016 at-rest/in-transit encryption checklist
docs/p0-exit-checklist.md   TQ-020 P0 exit evidence + sign-off (pending real stakeholders)
.github/workflows/ci.yml   Lint + typecheck + test + build (both apps) + secret-scan gate
AGENTS.md / CLAUDE.md      The operating manual this whole project is built against
```

## Local development

Requires Node 22+, Docker (or a local Postgres 16), and npm.

```bash
# 1. Start Postgres
docker compose up -d postgres
# (or point DATABASE_URL in backend/.env at any local Postgres 16 instance)

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run db:migrate     # applies db/migrations/*.sql
npm run db:codegen     # regenerates db/types.ts from the live schema (run after any migration)
npm run dev             # http://localhost:8080

# 3. Frontend (separate terminal)
cd frontend
cp .env.example .env
npm install
npm run dev             # http://localhost:5173
```

Open http://localhost:5173. If you don't have a tenant ID yet, follow the "Bootstrap a demo
tenant" link on the login page (dev builds only — reads `VITE_DEV_PLATFORM_ADMIN_KEY` from
`frontend/.env`, which must match backend `.env`'s `PLATFORM_ADMIN_API_KEY`). Sign in with
that tenant ID to get a dev token and land on the Project Dashboard, then use "New project"
to create one through the real Project Setup form.

### Running everything with Docker Compose instead

```bash
docker compose up --build
```

> Note: `docker-compose.yml` was written but not exercised in the environment this scaffold
> was built in (no Docker daemon was available there — see "What's actually verified"
> above). Everything it wires together (Postgres 16, the backend, the frontend) was verified
> individually and via the same Node processes running directly against a local Postgres
> instance; the compose file itself just packages that into one command. Try it and open an
> issue/fix it forward if the ports or health-check timing need adjustment on your machine.

## Verification

```bash
# Backend
cd backend && npm run lint && npx tsc --noEmit && npm test && npm run build

# Frontend
cd frontend && npm run lint && npx tsc --noEmit && npm test && npm run build
```

Both are also run automatically in `.github/workflows/ci.yml` on every push/PR (backend spins
up a real Postgres service container to run its tests against, same as local dev).

## Why Kysely instead of Prisma

Short version: Prisma's CLI needs to download a native query-engine binary from
`binaries.prisma.sh`, which isn't guaranteed to be reachable in every build/CI environment
(it wasn't in the one this scaffold was built in). Kysely + `pg` has no such dependency —
migrations are plain SQL, types are generated from a live database via pure-JS introspection.
Full reasoning in `docs/adr/0001-tech-stack.md`.

## Known gaps (intentional — P0 scope closes here; these are Sprint 3+ or explicitly deferred)

Sprint 1's gap list (open tenant creation, single-role RBAC, no least-privilege audit role, no
PATCH/GET-by-id, no dataset model) is **closed as of Sprint 2** — see `docs/p0-exit-checklist.md`
for the evidence. What's still genuinely open, going into Sprint 3+:

- **Login is still a dev-token stand-in**, not real SSO. Backend TQ-006 laid the
  OIDC-verification code path but nothing issues a real token yet.
- **Dataset ingestion is a JSON+base64 MVP shape**, not real file upload — no multipart, no
  encoding/delimiter/header detection. Proves the immutable-storage + versioning plumbing
  end to end; real upload is TQ-021, Sprint 3.
- **No target-pack association or lifecycle status transitions on projects** beyond a
  free-text `status` field — follows the target-pack model (Sprint 9+ per the roadmap).
- **Platform admin key is one static shared secret**, not per-operator credentials with an
  audit trail. Adequate for the current threat model (internal-only, never reachable from
  customer-facing frontend code); flagged in `docs/security/encryption-checklist.md` as
  something to fix before onboarding real customers.
- **No real GCP verification for anything infra-related** (Terraform, GCS, Cloud SQL TLS
  enforcement, Secret Manager, Vertex AI) — no GCP credentials have been available in any
  environment this scaffold has been built in. Everything there is reviewed IaC/code, not a
  tested deployment. See `docs/p0-exit-checklist.md`'s "What could not be verified" section.
- **No live browser session has driven the frontend** — verified via jsdom component tests
  and a curl-driven backend E2E that mirrors what the frontend sends, not an actual click-
  through in Chrome/Playwright.
- **VPC Service Controls, CMEK, secret rotation, field-level PII encryption** — explicitly
  out of scope for this checklist, tracked as later hardening rather than silently assumed
  covered. See `docs/security/encryption-checklist.md`'s "does not cover" section.

## Where this fits in the bigger plan

See `TransformIQ_Sprint_Plan.xlsx` for the full 9-sprint backlog (Sprints 1–2 → this repo,
the P0 Foundation phase; Sprints 3–8 → ingestion, entity resolution, AI recommendations,
review workflow, simulation, remediation, rollback, cost governance; Sprint 9 → lightweight
Target Mapping groundwork). See `AGENTS.md` for the rules every change in this repo should
follow.
