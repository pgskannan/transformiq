# ADR 0001 — Backend/Frontend Tech Stack

Status: Accepted (2026-08-12)
Owner: BE1 (per Sprint 1, TQ-010)
Related backlog: TQ-003, TQ-004, TQ-006, TQ-008

## Context

`AGENTS.md` (generated from the SRS) explicitly flags that the SRS specifies behavior and
contracts, not a language/framework/database product, and instructs Sprint 1 to settle this via
an ADR before feature work depends on it (see `AGENTS.md`, "Stack note").

## Decision

- **Backend:** Node.js + TypeScript, **Express** (not NestJS). Express was chosen over NestJS for
  Sprint 1 to minimize framework ceremony while the team is still validating the domain model —
  fewer decorators/DI magic, faster to read for a small squad, and nothing in the SRS requires
  NestJS's heavier module system. This is revisitable: if the module count grows past what plain
  Express routers can keep organized, migrating to NestJS is a contained backend-only change.
- **Database access:** **Kysely** (type-safe SQL query builder) + `pg` (node-postgres), **not
  Prisma**. Prisma was the original candidate but was rejected specifically because its CLI
  (`generate`, `migrate dev`, even `validate`) requires downloading a native query-engine binary
  from `binaries.prisma.sh` at build/generate time. That download was blocked in the sandboxed
  environment this scaffold was built and verified in, and the same class of restriction is
  plausible in a locked-down enterprise CI/CD pipeline (consistent with this project's own
  VPC-SC / tenant-isolation security posture — see ADR 0002). Kysely has no native-binary
  dependency: migrations are hand-written/plain SQL, and row types are generated from the live
  database schema via `kysely-codegen`, which only runs SQL introspection queries — pure
  JavaScript, no binary download, works identically in any network posture. This was verified
  end-to-end against a real local Postgres 16 instance while building this scaffold (see
  README "Verification" section) — not just asserted.
- **Frontend:** **React + Vite + TypeScript**. Vite over Next.js for Sprint 1 because the app is
  API-driven (talks to the Express backend), not content/SEO-driven — no server-rendering
  requirement yet. Revisit if a marketing/public-facing surface is added later.
- **Validation:** `zod` for request/response schema validation on the backend.
- **Testing:** `jest` (backend), `vitest` + `@testing-library/react` (frontend).
- **Logging:** `pino` (structured JSON logs, Cloud Logging-friendly).
- **Package manager:** `npm` (no strong reason to require pnpm/yarn; revisit if monorepo tooling
  needs change — see open question below).

## Consequences

- Every service (backend, and later independently-scaled workers per AGENTS.md §1.5/§6) is a
  Node/TypeScript Cloud Run service using the same base image pattern (see `backend/Dockerfile`).
- Prisma's migration files become the single source of truth for schema changes — do not
  hand-edit tables outside a Prisma migration except for the Postgres RLS policies, which Prisma
  cannot express natively (see ADR 0002).
- This is a monorepo (`backend/`, `frontend/`, `infra/`) for Sprint 1. Revisit if independent
  service scaling (AGENTS.md §6, Deployment Rules) needs separate repos/CI pipelines per service.

## Open questions for the team

- Source control host (GitHub assumed for the CI config in this scaffold — confirm).
- Whether to adopt a monorepo tool (Turborepo/Nx) once more services are added.
- NestJS reconsideration once the module count grows.
