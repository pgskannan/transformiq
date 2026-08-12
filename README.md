# TransformIQ

AI-assisted procurement-data transformation platform (Business Partner + Supplier, Direct +
Indirect Procurement, SAP S/4HANA + SAP Ariba). See `AGENTS.md` / `CLAUDE.md` for the full
operating manual (architecture, business rules, security rules, database rules, testing
rules, deployment rules, do-not-do rules) — read that before making non-trivial changes.

This repo is the **Sprint 1 scaffold** from `TransformIQ_Sprint_Plan.xlsx` (TQ-001 through
TQ-010, plus the TQ-079 Vertex AI spike). It covers project foundation only: no procurement
domain features yet (those start Sprint 3+).

## What's actually verified vs. what's still ahead

This scaffold was built and verified in a sandboxed environment with **no real GCP project
and no internet access to Prisma's binary CDN** (see `docs/adr/0001-tech-stack.md`). What
that means concretely:

**Verified for real, in this repo, right now:**
- Backend builds (`tsc`), lints (`eslint`), and passes its full test suite against a **real
  local Postgres 16** — including a live end-to-end HTTP test that proves Row-Level Security
  actually blocks cross-tenant reads and rejects unscoped writes (not mocked).
- Frontend builds (`vite build`), lints, and passes its test suite (`vitest`).
- The migration runner (`db/migrate.ts`) applies `db/migrations/*.sql` to a blank database
  from scratch.
- `kysely-codegen` generates real TypeScript types by introspecting that live database.
- The backend and frontend actually run (`npm run dev` in each) and talk to each other —
  create a tenant, get a dev token, create a project, list it back, confirm a second tenant
  sees nothing, confirm no-token requests get 401.

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

## Repo layout

```
backend/     Express + TypeScript API (Kysely + Postgres, JWT auth, RLS-enforced tenancy)
frontend/    React + Vite + TypeScript (login → dashboard walking skeleton)
infra/terraform/   IaC for Cloud Run, Cloud SQL, GCS, Artifact Registry, VPC (not applied)
docs/adr/    Architecture decision records (start here for the "why")
.github/workflows/ci.yml   Lint + typecheck + test + build, both apps
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

Open http://localhost:5173, sign in (creates a tenant + dev token — see "Known gaps" below),
and you'll land on the Project Dashboard.

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

## Known gaps (intentional — Sprint 1 scope, not bugs)

- **Tenant creation is wide open.** `POST /v1/tenants` has no auth on it at all. This is
  deliberate so the walking skeleton is testable end-to-end today, but it is a real gap —
  Sprint 2's RBAC work (TQ-011) must close this before any real deployment.
- **Login is a dev-token stand-in**, not real SSO. Backend TQ-006 laid the OIDC-verification
  code path but nothing issues a real token yet.
- **Audit events have no dedicated least-privilege DB role yet** — the append-only guarantee
  (FR-AUD-001) is only structurally enforced once Sprint 2 (TQ-015) introduces a
  `transformiq_app` role with UPDATE/DELETE revoked on `audit_events`. See the comment at the
  bottom of `backend/db/migrations/0002_enable_rls.sql`.
- **RBAC is a single `role` enum column**, not the full view/modify/approve/export/admin
  separation AGENTS.md requires — that's Sprint 2, TQ-011.
- **No Project CRUD beyond create/list** — no PATCH, no target-pack association, no lifecycle
  status transitions. Full Project/Dataset CRUD is Sprint 2, TQ-017.

## Where this fits in the bigger plan

See `TransformIQ_Sprint_Plan.xlsx` for the full 9-sprint backlog (Sprint 1 → this repo;
Sprints 2–8 → RBAC, ingestion, entity resolution, AI recommendations, review workflow,
simulation, remediation, rollback, cost governance; Sprint 9 → lightweight Target Mapping
groundwork). See `AGENTS.md` for the rules every change in this repo should follow.
