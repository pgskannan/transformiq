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

**Corrected (Sprint 2):** this section originally described a Prisma-based implementation
(`backend/prisma/schema.prisma`, `backend/src/lib/prisma.ts`) that was never actually built —
ADR 0001 rejected Prisma in favor of Kysely before any Sprint 1 code was written, and this
file simply wasn't updated to match at the time. Corrected to describe what's actually in the
repo, found while writing the TQ-023 addendum below and cross-checking file paths that no
longer existed.

Every tenant-scoped table carries a `tenant_id` column (see `backend/db/migrations/0001_init.sql`
and later migrations that add tables). Isolation is enforced at **two layers**, per AGENTS.md
§3.1 (RBAC) and §4 (Database Rules):

1. **Postgres Row-Level Security (RLS).** `backend/db/migrations/0002_enable_rls.sql` enables
   RLS on every tenant-scoped table from `0001_init.sql`, and every migration that adds a new
   tenant-scoped table (`0003_datasets.sql`, `0005_ingestion.sql`, ...) enables RLS on it in the
   same migration file rather than a separate "add RLS" step — there's no ORM schema-vs-RLS
   split to keep in sync since nothing here is ORM-generated (see ADR 0001's addendum). Every
   policy requires `tenant_id = current_setting('app.tenant_id', true)`.
2. **Application-layer enforcement.** `backend/src/lib/db.ts` exposes a `withTenant(tenantId,
   fn)` helper that opens a Kysely transaction, issues `select set_config('app.tenant_id', $1,
   true)` as the first statement, and runs the callback inside it. Every route handler that
   touches tenant data must go through `withTenant` — there is no "trusted" code path that
   bypasses it. `backend/src/middleware/tenant.ts` extracts the tenant from the authenticated
   JWT claim and attaches it to `req.tenantId` before any handler runs.

Cross-tenant-leakage testing (TQ-012, Sprint 1/2) attempts to read another tenant's rows both
through the API (IDOR-style: known ID, wrong tenant — see `src/__tests__/tenant-isolation.test.ts`
and `ingestion.test.ts`) *and* through a raw query that skips `withTenant` entirely (proving
Postgres itself, not app-layer convention, rejects the unscoped write) — RLS is the backstop,
not the only control.

## Consequences

- Every new tenant-scoped table must add its own RLS policy in the same migration that creates
  it — there's no automated check for this yet (a CI gate for "table has tenant_id but no RLS
  policy" is still a real gap, not yet built despite being flagged as a Sprint 2 candidate here
  originally).
- `withTenant` adds a small amount of ceremony to every handler; this is intentional friction so
  "forgot to scope this query" fails loudly (missing tenant context) instead of silently leaking.

## Addendum (Sprint 3): async ingestion jobs (TQ-023)

TQ-023 calls for Pub/Sub + Cloud Run Jobs for async file ingestion, added to the service
mapping table above. Actual Sprint 3 status:

- `backend/src/lib/jobs/queue.ts` implements the same "local fallback / real GCP backend
  behind one interface" pattern as `secrets.ts` and `objectStorage.ts`: `LocalAsyncJobQueue`
  (used whenever `GCP_PROJECT_ID` is unset — defers work via `setImmediate` so the HTTP
  request returns before the job runs, verified directly in
  `src/lib/jobs/__tests__/queue.test.ts` and `src/__tests__/ingestion.test.ts`) and
  `PubSubJobQueue` (publishes a message when `GCP_PROJECT_ID` is set).
- **Only the publish side of Pub/Sub is implemented.** There is no Cloud Run Jobs
  execution or Pub/Sub push-subscription consumer in this repo that would actually process a
  published message in a real deployment — building one that's never been exercised against a
  real topic (no GCP project available) would overstate what's actually done here. This is a
  real, tracked gap (see README "Known gaps"), not an oversight being glossed over.
- Job payloads are deliberately plain serializable data (ingestion run ID, tenant ID, an object
  storage ref, etc.) — never a closure or live DB handle — specifically because a real Pub/Sub
  message can't carry either of those. The local backend doesn't require this discipline
  (same process, same memory) but keeping it anyway is what makes swapping in the real Pub/Sub
  backend later a config change instead of a rewrite.

## Addendum (Sprint 3): job chaining and transaction-commit visibility (TQ-024)

TQ-024's profiling job (`backend/src/lib/jobs/profilingJob.ts`) is auto-enqueued right after a
successful ingestion job, from `backend/src/lib/jobs/ingestionJob.ts`. The first draft of that
chaining call enqueued the profiling job *from inside* the ingestion job's `withTenant(...)`
transaction callback. That is a real bug, caught before it shipped: `LocalAsyncJobQueue`
defers the handler via `setImmediate`, and Node's event-loop phase ordering does not guarantee
that callback runs only after the enclosing transaction's `COMMIT` has become visible to a
separate DB connection — the profiling job opens its own `withTenant()` transaction to read
`dataset_versions`, on a different connection than the ingestion job's. A profiling job that
runs a beat too early could fail to find the version it was told to profile, or (worse, on a
different isolation level) see a half-committed state.

The fix: the ingestion job's transaction callback now returns a small result value instead of
enqueueing anything itself; `getJobQueue().enqueue(PROFILING_JOB_TYPE, ...)` is called *after*
`await withTenant(...)` resolves, i.e. only once the ingestion transaction has actually
committed. This is the general rule this repo now follows for any job-chaining: never enqueue
a follow-up job from inside the transaction whose commit the follow-up job depends on being
able to see.

## Addendum (Sprint 3): anomaly detection shares the profiling job, not its own (TQ-025)

TQ-025 (FR-PROF-002, anomaly detection) does *not* get its own job type/queue entry the way
ingestion and profiling do. `lib/anomalies/engine.ts`'s `detectAnomalies()` is called directly
from inside `lib/jobs/profilingJob.ts`, right alongside `profileColumns()`, over the exact
same re-parsed `ingested.columns`/`ingested.dataRows` profiling already produced.

This is a deliberate exception to the "one job type per concern" pattern established for
ingestion -> profiling, not an oversight: splitting anomaly detection into its own job would
mean a *second* re-read-and-re-parse of the same immutable raw artifact for no benefit —
`detectAnomalies()` is pure, synchronous, in-memory logic with no I/O of its own, so there's
no latency reason to isolate it the way ingestion (slow, unvalidated file parsing) and
profiling (a job the auto-chain fix above cares about not extending an open transaction for)
are isolated from the request/each other. If a future sprint makes anomaly detection
independently expensive (e.g. an AI-assisted "suspicious pattern" pass), that's the moment to
reconsider — not now, on the actual cost of what TQ-025 v1 does.

`dataset_anomalies` (`0009_anomalies.sql`) follows the same "tied to dataset_version_id,
delete-then-reinsert on re-profiling, no accumulated history" lifecycle as `dataset_profiles`
— see that migration's comment for the same immutable-raw-bytes rationale.

## Addendum (Sprint 3): semantic type inference is heuristics-only, no live AI path (TQ-026)

FR-PROF-003 ("infer semantic field types") and this SRS's stated operating principle
("deterministic controls govern; AI handles semantic ambiguity") both point at a two-signal
design: fast deterministic heuristics for the clear cases, an embeddings/LLM-assisted pass
(backed by the Vertex AI stub, `backend/src/lib/vertexAI.ts`) for whatever the heuristics
leave ambiguous or unclassified. `lib/semantics/engine.ts` ships only the first half.

This is the same category of gap as the Pub/Sub consumer above, for the same reason: there is
no live Vertex AI project reachable from this sandbox, so an "AI-assisted" code path would be
untested against a real model and would overstate what's actually been verified. Rather than
stub out a fake AI call or skip semantic inference for this sprint, TQ-026 ships the
deterministic half on its own — a real, working feature (26/26 on the golden fixture set,
comfortably over the ≥90% DoD bar; see `lib/semantics/__tests__/engine.test.ts`) — with the
AI-assisted second pass tracked as what's still missing, not silently assumed covered.
Columns the heuristics can't classify get `semantic_type = null`, not a guess.

## Addendum (Sprint 3): project quality score scope vs. the DoD's remediation wording (TQ-027)

FR-PROF-004's DoD is "quality score recomputes correctly after a fixture is remediated," but
remediation — the feature that lets a user fix a flagged issue in place — is a much later
sprint item, not built yet. TQ-027 was not blocked on it. "Remediated" is interpreted
pragmatically as *any* change to a dataset's underlying data that produces a new, cleaner
dataset_version, which is exactly how this system already represents "the data changed" (see
the immutable-raw-per-version model earlier in this ADR). `src/__tests__/qualityScore.test.ts`
proves the real claim this scoping still has to deliver on: a second, cleaner version of the
same dataset scores higher than the dirty one it replaces, the project-level rollup reflects
that new version (not a stale one, not an average of both), and re-profiling an unchanged
version reproduces an identical score (deterministic recomputation, not just "a different
number each time"). When real remediation ships, this rollup is still the correct one — it
was built against "a dataset_version's data differs from a prior one," not against the
remediation UI specifically.

The project-level rollup itself (`lib/profiling/projectQualityScore.ts`,
GET `/v1/projects/:projectId/quality-score`) averages each dataset's *latest* profiled
version, excluding any dataset with no profile yet from the average rather than counting it
as a 0 — an unprofiled dataset is a "don't know yet" state, not a "measured as bad" one.

## Addendum (Sprint 3): Business Partner is a canonical entity, not a Supplier alias (TQ-028)

FR-BP-001 asks for a canonical Business Partner (BP) entity model. The deliberate design
choice here is that `business_partners` is never collapsed with the Supplier entity FR-BP-006
introduces later — a supplier is a procurement-context *role* a BP plays (this BP sells to
us), not a different kind of thing. Modeling them as one table with a "type" flag would work
today but would break the moment a BP needs to be both a supplier and something else (a
customer, an internal cost-center proxy) simultaneously, which the SRS's broader Business
Partner + Supplier language implies is a real case. `business_partners` stays entity-only:
identity, name, status, source-system provenance. Supplier-specific attributes (payment
terms, approval status, spend category) attach to a future `suppliers` row that references a
`business_partners.id`, not the other way around.

Three 1:N child tables — `bp_addresses`, `bp_identifiers`, `bp_relationships` — each FK
CASCADE back to their parent BP, all project-scoped and RLS-enabled the same as every other
tenant-owned table in this schema. `bp_relationships` is a **directed edge**
(`business_partner_id` → `related_business_partner_id`), not a symmetric/bidirectional
structure, with a CHECK constraint preventing a BP from relating to itself. A directed edge
is the more honest model — "Acme is a subsidiary of Globex" is not the same fact as "Globex
is a subsidiary of Acme," and collapsing that into a single undirected edge would lose which
direction the relationship actually runs. Symmetric relationships (e.g. "affiliated with")
are representable as two directed rows if a caller needs that; the schema doesn't force it.

`src/__tests__/businessPartners.test.ts` proves the full CRUD surface against real Postgres,
including creating a BP, attaching an address/identifier/relationship to it, fetching the BP
back with all three child collections populated, and the two relationship-creation guard
rails: a 400 on a self-referential relationship, and a distinct 400 ("related business
partner not found") when the *target* BP doesn't exist — separate from the 404 that already
covers the *source* BP not existing, since those are different failure facts for a caller to
handle differently.

## Addendum (Sprint 3): Data Profile screen ships field-level scores, not relationship discovery (TQ-029)

TQ-029's backlog title mentions "relationship discovery" alongside field-level quality
scores, but those are two different features. Relationship *discovery* — automatically
inferring that two Business Partners are related, or that a column in one dataset maps to a
column in another — is entity-resolution work that doesn't exist yet (TQ-028 only added
*manual* relationship creation via the API, addendum above). The literal DoD wording this
screen is built and tested against is narrower and already fully deliverable with what TQ-024
through TQ-028 shipped: "a steward can view field-level quality scores and inferred types for
an ingested dataset." `frontend/src/pages/DataProfile.tsx` delivers exactly that — per-field
completeness/validity/conformity/consistency/uniqueness/quality scores, inferred and semantic
types, flagged anomalies, and a manual re-profile trigger for a dataset's latest version — and
explicitly does not claim relationship discovery, which stays open in the README's "Known
gaps" list rather than being silently implied by the ticket title.

Verified via `@testing-library/react` component tests against a mocked API (three cases: a
profiled dataset with fields/anomalies rendering correctly, an unprofiled version offering a
"Profile now" action, and a project with no datasets yet showing an empty state) and a
successful production build with the page's route registered. Consistent with this repo's
established honesty about sandbox limits, this was **not** verified via an actual browser
click-through — no live browser automation session has been available in this environment at
any point in the project, Sprint 1 through Sprint 3 (see README "Known gaps").
