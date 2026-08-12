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

## Addendum (Sprint 4): entity resolution matching engine — exact + fuzzy, no GCP dependency (TQ-030–032)

Sprint 4's goal ("resolve duplicate Business Partners and Suppliers with deterministic +
fuzzy matching, with guardrails against unauthorized merges") is deliverable entirely on
Postgres — the Sprint 5 sheet is what actually introduces Vertex AI semantic matching
(TQ-039/040), not Sprint 4. This was checked explicitly against the sprint plan before
starting, per the user's standing instruction to defer any GCP project creation until it's
genuinely required. Nothing in this addendum touches `lib/vertexAI.ts` or any GCP service.

`db/migrations/0011_entity_resolution.sql` enables the `pg_trgm` extension and adds
`entity_matches`, a project-scoped table representing one candidate duplicate pair. Two
design points worth recording:

- **Canonical pair ordering, not a directed edge.** A duplicate-candidate relationship is
  inherently symmetric — "A might be a duplicate of B" is the same fact as "B might be a
  duplicate of A" — unlike `bp_relationships` (TQ-028, directed: "A is a subsidiary of B" is
  a different fact from the reverse). Storing it as a directed edge would mean either two
  rows per pair (which could disagree with each other) or an arbitrary directionality with no
  meaning. Instead a CHECK constraint enforces
  `business_partner_id < candidate_business_partner_id`, and a UNIQUE constraint on the pair
  means exactly one row represents the relationship, however it was discovered.
- **"Merge" here records a decision, not an action.** `entity_matches.decision` can become
  `merge`, but nothing in this migration, `lib/matching/`, or `routes/entityMatches.ts`
  mutates a `business_partners` row as a result. Actually rewriting foreign keys and
  collapsing two BP records into one is TQ-062 ("Remediation execution engine"), confirmed
  against the Sprint 7 sheet before writing a line of Sprint 4 code — building that now would
  be scope creep past what Sprint 4's DoDs ask for, and would mean an irreversible data
  mutation with no remediation/rollback machinery (that's literally what Sprint 7 builds)
  sitting behind it. `decision = 'merge'` is a recorded, audited, human decision that a later
  sprint's execution engine will act on.

`lib/matching/engine.ts` implements two independent detectors, merged by
`findAllMatchCandidates()`:

- **Exact matching (TQ-031, FR-DUP-001).** Groups `bp_identifiers` rows by
  `${identifier_type}::${identifierMatchKey(value)}` in application code (not SQL) — this
  needed the same normalization TQ-036 (below) already defines for matching, and doing the
  grouping in TypeScript kept that logic in one place rather than reimplementing key
  normalization as a SQL expression. Any group with ≥2 distinct Business Partners generates
  all pairwise candidates with `identifier_exact` evidence.
- **Fuzzy matching (TQ-032, FR-DUP-002).** A real Postgres `pg_trgm` query (raw SQL via
  Kysely's `sql` tag — this doesn't map onto the query builder because of the `%`
  similarity operator — following the one existing raw-SQL precedent in `lib/db.ts`'s
  `set_config` call) comparing `upper(primary_name)` trigram similarity between BP pairs,
  plus a same-shaped comparison over each BP's primary (or first) address line. The
  similarity threshold, `FUZZY_NAME_SIMILARITY_THRESHOLD = 0.5`, is set via `SET LOCAL
  pg_trgm.similarity_threshold` inside the transaction (`SET LOCAL`, not bare `SET`, so it
  never leaks into a pooled connection reused by an unrelated request) and is **not a
  guess** — it was chosen by running representative test-name pairs directly through a live
  `psql` session against real data before writing the query:

  | Pair | `similarity()` | Expected |
  |---|---|---|
  | "Acme Corp" / "Acme Corporation" | 0.5 | duplicate |
  | "Globex Corp" / "Globex Corporation" | 0.55 | duplicate |
  | "Wayne Enterprises" / "Wayne Enterprizes" | 0.714 | duplicate |
  | "Acme Corp" / "Ajax Corp" | 0.428 | not a duplicate |
  | "Stark Industries" / "Umbrella Corp" | 0 | not a duplicate |

  0.5 is the lowest threshold that includes every true positive above while excluding every
  true negative — a threshold picked from measured data, not intuition.
- **Exact evidence wins ties.** `findAllMatchCandidates()` inserts fuzzy results into a
  `Map` keyed by canonical pair first, then exact results second — `Map.set()` overwrite
  semantics mean a pair found by both detectors ends up with `identifier_exact` evidence
  (and its 1.0 confidence, see the addendum below), which is the more certain of the two.

**TQ-030 (golden dataset regression harness).** Rather than a separate CI job or fixture
pipeline, the golden dataset is a fixture array embedded directly in
`lib/matching/__tests__/golden.test.ts`, run through the existing `npm test` (already
CI-gated). It seeds nine Business Partners (three true-positive pairs across the three
confidence bands the empirical table above establishes, four true-negative pairs) via the
real HTTP API, runs `/entity-matches/run`, and asserts every positive pair is found with the
correct detection method and every negative pair is absent. This is deliberately an
integration test against live Postgres, not a mocked unit test — the whole point of a golden
dataset is to catch a regression in the *real* matching behavior, including the SQL query
itself, not just the TypeScript wrapping it.

## Addendum (Sprint 4): confidence/evidence model (TQ-033, FR-DUP-003)

`lib/matching/confidence.ts` turns a list of typed match signals into a single confidence
score, favoring corroboration over any single signal:

- An `identifier_exact` signal always yields confidence `1.0`, regardless of what else is
  present — a shared, normalized tax ID / registration number / etc. is treated as
  definitive on its own.
- With both `name_similarity` and `address_similarity` signals present, confidence is a
  weighted blend (`0.65 × name + 0.35 × address`) — name similarity carries more weight
  because it's the primary human-facing identity signal, but a correlated address
  meaningfully raises confidence in a name-only-similar pair, which is exactly the
  "corroborating evidence" behavior AGENTS.md §2.4 calls for.
- A single signal alone (name only, or address only) is discounted (×0.85 for name-only,
  ×0.7 for address-only) rather than passed through at full trigram similarity — reflects
  that one un-corroborated signal is weaker evidence than the same signal alongside another.
- Output is clamped to `[0, 1]` and rounded to four decimals for stable, comparable stored
  values. `lib/matching/__tests__/confidence.test.ts` has 7 unit tests covering this
  behavior directly, including the exact-overrides-everything case and the zero-signal edge
  case.

This directly implements AGENTS.md §2.4's confidence bands (95–100% / 75–94% / <75%) and,
just as importantly, Do-Not-Do Rule #4 ("never treat confidence score alone as
authorization") — confidence is stored and displayed, but the merge guardrail below checks
role/permission, never `confidence >= <some number>`.

## Addendum (Sprint 4): four-state decision workflow + unauthorized-merge guardrail (TQ-034/035, FR-DUP-004–006)

`routes/entityMatches.ts` exposes the full decision surface:

- `POST /v1/projects/:projectId/entity-matches/run` — runs both detectors and upserts
  results via `INSERT ... ON CONFLICT (business_partner_id, candidate_business_partner_id)
  DO UPDATE ... WHERE entity_matches.decision = 'needs_review'`. The `WHERE` clause on the
  conflict action is the important part: re-running the matcher (e.g. after new BPs are
  ingested) refreshes evidence/confidence for still-undecided pairs, but a pair a human has
  already decided (`merge` / `keep_separate` / `reject`) is never silently overwritten by a
  later run. Proven directly in `entityMatches.test.ts` by deciding a pair, re-running, and
  asserting the decision survived.
- `GET .../entity-matches` (list, optional `?decision=` filter) and
  `GET /v1/entity-matches/:id` (full side-by-side detail, joining each BP's addresses,
  identifiers, and linked Suppliers) back the frontend's list + compare views.
- `PATCH /v1/entity-matches/:id/decision` accepts exactly the four states AGENTS.md §2.5
  defines (`needs_review`, `merge`, `keep_separate`, `reject`) and 400s on anything else.

**The guardrail (TQ-035, Do-Not-Do Rule #3 — "never perform an automatic entity merge...
without authorization").** The route requires the base `modify` permission via the existing
RBAC middleware, then adds one more inline check specific to this endpoint:
`if (decision === "merge" && !roleHasPermission(req.user!.role, "approve"))` → 403, with a
message that names the actual rule being enforced ("AGENTS.md Do-Not-Do #3") rather than a
generic "forbidden," and writes an `entity_match.merge_denied` audit event before returning.
A non-merge decision only needs `modify`. This is deliberately asymmetric — recording
"needs review" or "reject" is reversible bookkeeping; recording "merge" is the trigger a
future TQ-062 execution run acts on, so it alone needs the higher `approve` permission.

Proven with three layered tests in `entityMatches.test.ts`'s "Unauthorized-auto-merge
guardrail" describe block: an unauthenticated request gets 401; a STEWARD (has `modify`, not
`approve`) attempting `merge` gets 403 **and** the denial audit event is verified by a direct
`withTenant` query against `audit_events`, not just the HTTP response — because there's no
Audit Explorer UI/endpoint yet (that's TQ-071, Sprint 8) to check it any other way; a VIEWER
(no `modify` at all) is blocked from recording *any* decision, not just merge.

## Addendum (Sprint 4): normalization is match-time only, not a stored/auto-applied transform (TQ-036, FR-BP-004)

`lib/matching/normalize.ts` provides `nameMatchKey`, `addressMatchKey`, and
`identifierMatchKey` — uppercasing, punctuation-stripping, legal-suffix-stripping (Inc/Corp/
LLC/Ltd/etc.), and whitespace/separator-collapsing functions used only inside the matching
engine's exact-match grouping and (implicitly, via `upper()` in the fuzzy query) similarity
comparison.

Two scoping notes worth being explicit about, since the alternative reading of FR-BP-004 is
plausible:

- **This file *is* the canonical-format decision for now.** FR-BP-004 gestures at a real
  "data dictionary" of canonical formats a customer would define — no such artifact exists
  yet in this project (no customer data dictionary has been provided), so the suffix/format
  rules here are a reasonable, documented starting point, not a placeholder waiting on a
  config file that doesn't exist. If/when a real data dictionary shows up, this file is
  where it plugs in.
- **Normalization output is never persisted back to `business_partners` rows or applied
  automatically.** It's computed on demand, purely for matching/blocking. Silently rewriting
  a steward-entered BP name to a normalized form would be a real, undiscussed data mutation
  with no decision/audit trail behind it — exactly the kind of unauthorized change
  AGENTS.md's Do-Not-Do rules exist to prevent, even though this specific rule is written
  about merges rather than field edits. `lib/matching/__tests__/normalize.test.ts` (11 unit
  tests) proves the collapsing behavior on messy variants and non-collapsing on genuinely
  different values, without touching any stored data.

## Addendum (Sprint 4): Supplier entity + two-tier duplicate detection (TQ-037, FR-SUP-001/002)

`db/migrations/0012_suppliers.sql` adds `suppliers`, referencing `business_partners.id` —
consistent with ADR 0002's Sprint 3 addendum decision that Supplier is a procurement-context
*role* a BP plays, not a separate kind of entity. The FK is `ON DELETE RESTRICT`, unlike
every other child table in this schema (`bp_addresses` etc. are `CASCADE`) — deliberately
different, because Business Partner rows are never deleted anywhere in this codebase, and a
Supplier record silently losing its BP link would be a real data-integrity problem worth
stopping the operation on rather than quietly cascading away.

FR-SUP-002's DoD ("duplicate supplier-to-BP relationships are flagged") is ambiguous between
"block a true duplicate" and "warn about a suspicious-but-maybe-legitimate one," so
`routes/suppliers.ts` implements both, at two different strengths:

- **Hard block.** A `UNIQUE (business_partner_id, source_system, supplier_number)`
  constraint makes a true duplicate (same BP, same source system, same supplier number)
  impossible to insert — the route catches Postgres's `23505` unique-violation code and
  returns 409, not a 500.
- **Soft flag.** A BP that already has a Supplier record from the *same source system* but a
  *different or absent* supplier number is not blocked — that's a plausible legitimate case
  (e.g. a second supplier number issued for the same BP in the same ERP) — but the create
  and list responses include a `duplicateWarning` / `duplicateSourceSystems` field so a
  steward sees it and can investigate, rather than either silently allowing it or wrongly
  rejecting it.

`suppliers.test.ts` (5 tests) covers N:1 linkage, 404 on a missing BP, the 409 hard block,
allowing the same supplier number across two different source systems (not a duplicate), and
the soft-flag path surfacing `duplicateSourceSystems` correctly.

## Addendum (Sprint 4): BP/Supplier Resolution frontend screen (TQ-038)

`frontend/src/pages/EntityResolution.tsx` follows the same authenticated-page structure
established by `DataProfile.tsx` (TQ-029) — a `useAuth`-gated page, data loaded via the
`api` object in `lib/api.ts`, one `formatX`/`xColor` helper pair for confidence display. The
literal DoD is "a steward can review a match candidate pair side-by-side and record a
decision," and the page delivers exactly that: a "Run matching" trigger, a list of candidate
pairs with method/confidence/current decision, a click-through side-by-side comparison
(`BpSideCard`, showing each side's name/type/source/primary address/identifiers, and its
linked Supplier "roles" — TQ-037's entity model surfaced here) plus the raw evidence signal
list, and all four decision buttons per pair.

One deliberate UX choice: `handleDecide`'s error handling surfaces the *backend's own* 403
message from the TQ-035 guardrail (via `ApiError`, not swallowed into a generic "failed"
banner) — a steward attempting a merge they're not authorized for should see *why*
(cites AGENTS.md Do-Not-Do #3 by name, same message the backend test asserts on), not just
that something went wrong. Verified via 4 `@testing-library/react` tests
(`EntityResolution.test.tsx`): list + select + compare (including the Supplier-roles and
evidence-signal assertions), record-a-decision-and-reflect-in-list, the guardrail-denial
message surfacing verbatim, and the empty-state + "Run matching" affordance. Same caveat as
every other frontend screen in this project so far: verified via jsdom component tests
against a mocked API, **not** an actual browser click-through — no live browser automation
session has been available in this environment at any point, Sprint 1 through Sprint 4 (see
README "Known gaps").

## Addendum (Sprint 4): indexing & threshold tuning, honestly scoped to a 300-row fixture (TQ-082)

`db/migrations/0011_entity_resolution.sql` adds a GIN trigram index on
`upper(business_partners.primary_name)` — an *expression* index, matching the exact
`upper(...)` expression the fuzzy-match query uses (a plain-column trigram index would not
accelerate a query comparing the uppercased form, and case differences would spuriously
lower similarity scores if the comparison weren't normalized this way in the first place).

`lib/matching/__tests__/performance.test.ts` seeds 300 Business Partners directly via
`withTenant` (bulk Kysely insert, not one-BP-per-HTTP-call, to isolate query timing from
unrelated request overhead) using a name generator deliberately designed to avoid one
accidental giant near-duplicate cluster (an early version's modulo arithmetic collapsed onto
a single repeated suffix across all 300 rows — caught by an implausibly high match count,
fixed by widening the word/suffix combination space to 200 unique combinations across 300
rows), runs `findFuzzyMatchCandidates` 20 times, and asserts p95 latency stays under a 500ms
budget. Measured p95 on this fixture: **~178ms**.

**Honest limitation, not overclaimed:** a direct `EXPLAIN (ANALYZE, BUFFERS)` run against the
same seeded data (as the `transformiq_app` role with `app.tenant_id` set, so RLS doesn't
just filter everything to zero rows and produce a misleadingly empty plan) shows Postgres's
planner choosing a bitmap/nested-loop scan over the table rather than actually using the new
GIN trgm index at this row count — entirely reasonable, since 300 rows is well within the
range where a sequential/bitmap scan beats an index scan, and not something this addendum is
going to spin as "the index is working" when the query plan says otherwise. The index is
correctly built and available for when this table has enough rows for the planner to prefer
it; it is not proven here to be *load-bearing* at 300 rows. Cloud SQL-scale verification (a
real customer-sized `business_partners` table, real Cloud SQL instance sizing/IOPS) is
explicitly out of scope for this sandbox — no Cloud SQL project has been available at any
point in this project (see README "Known gaps") — and is flagged as real future verification
work, not silently assumed to generalize from this fixture.
