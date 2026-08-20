# TransformIQ

AI-assisted procurement-data transformation platform (Business Partner + Supplier, Direct +
Indirect Procurement, SAP S/4HANA + SAP Ariba). See `AGENTS.md` / `CLAUDE.md` for the full
operating manual (architecture, business rules, security rules, database rules, testing
rules, deployment rules, do-not-do rules) — read that before making non-trivial changes.

This repo covers **Sprint 1 + Sprint 2 + Sprint 3 + Sprint 4** from
`TransformIQ_Sprint_Plan.xlsx` (TQ-001–TQ-010, TQ-079, TQ-011–TQ-020, TQ-021–TQ-029, and
TQ-030–TQ-038 + TQ-082) — the full **P0 "Foundation" phase**, the first slice of
procurement-data transformation (real file ingestion, async job processing, data profiling,
anomaly detection, semantic type inference, quality scoring, the Business Partner canonical
entity model), and now **entity resolution**: deterministic + fuzzy duplicate matching for
Business Partners, a confidence/evidence model, a four-state decision workflow with an
unauthorized-auto-merge guardrail, BP field normalization, the Supplier entity model, and a
frontend screen for reviewing and deciding candidate matches. See `docs/p0-exit-checklist.md`
for the P0 evidence (Sprint 1+2, mapped item by item) and the per-feature ADR addendums in
`docs/adr/0002-gcp-architecture-and-tenancy.md` for the Sprint 3 and Sprint 4 design
decisions and their documented scope tradeoffs.

Plus a **Sprint 5 slice (TQ-039/040)**, built for the
[All Things Agentic Hackathon](https://allthingsagentichackathon.devpost.com/): two real,
working AI features, both named explicitly in AGENTS.md §1.6/FR-AI-001's scope
("normalization, entity resolution, classification, and mapping"), same architecture and
governance pattern applied to two different judgment calls.

- **AI-assisted semantic type resolution** ("classification"). When the deterministic
  heuristics engine (`lib/semantics/engine.ts`) genuinely can't classify a column, the
  profiling job now calls Gemini — via [Genkit](https://genkit.dev), a Google Agent
  Framework — for a second-pass suggestion, surfaced in the Data Profile screen as a
  clearly-labeled, unapplied recommendation a steward reviews. See
  `docs/adr/0003-gemini-genkit-integration.md` for the full design rationale and
  "AI-assisted semantic type resolution" below for how to run it.
- **AI-assisted entity match adjudication** ("entity resolution"). When the deterministic
  fuzzy matcher (`lib/matching/engine.ts`, pg_trgm name/address similarity) finds a candidate
  duplicate Business Partner pair whose confidence lands in a genuinely ambiguous band, the
  match-detection run now calls the same Gemini/Genkit integration for a second opinion —
  `merge` / `keep_separate` / `uncertain` plus reasoning — surfaced in the BP/Supplier
  Resolution screen as a separate, unapplied recommendation next to (never inside) the
  governed `decision` field. See `docs/adr/0003-gemini-genkit-integration.md`'s addendum and
  "AI-assisted entity match adjudication" below.

## What's actually verified vs. what's still ahead

This scaffold was built and verified in a sandboxed environment with **no real GCP project
and no internet access to Prisma's binary CDN** (see `docs/adr/0001-tech-stack.md`). What
that means concretely:

**Verified for real, in this repo, right now:**
- Backend builds (`tsc`), lints (`eslint`), and passes its full test suite (**25 suites, 157
  tests**, plus a Sprint 5 continuation adding `lib/matching/__tests__/aiAdjudicator.test.ts`
  — 11 more mocked unit tests, same "mock the one construction point" pattern as
  `aiResolver.test.ts` — for **26 suites, 168 tests**) against a **real local Postgres 16**,
  running as the actual least-privilege `transformiq_app` role the production app would use —
  not a superuser connection that could mask a missing GRANT. The new suite was verified with
  `npx jest` (passes standalone, mocked, no DB needed) plus `tsc`/`eslint` clean in this
  sandbox; re-run the full suite against a live Postgres before treating it as re-verified
  end to end, same "what's actually verified" discipline this README already holds itself to.
- Real CSV and XLSX ingestion (TQ-021/TQ-022): multipart file upload, character-encoding
  detection, delimiter sniffing, header-row detection, per-column type inference, and
  rejected-row diagnostics — all against real parsed files, not a JSON+base64 stand-in.
- Ingestion and profiling run as genuine async background jobs (TQ-023), not inline
  request-handler work. This sprint's headline bug fix: a transaction-commit-visibility race
  where the follow-up profiling job was originally enqueued *inside* the ingestion
  transaction callback and could start reading a row the outer transaction hadn't actually
  committed yet — fixed by enqueueing only after `await withTenant(...)` resolves, with the
  event-loop-phase-ordering reasoning documented inline in `lib/jobs/ingestionJob.ts` and as
  an ADR addendum.
- The profiling engine (TQ-024, FR-PROF-001) computes five real quality dimensions
  (completeness, validity, conformity, consistency, uniqueness) per field and an overall
  quality score per dataset version, re-verified end to end through real Postgres and a live
  running server, not just unit-tested in isolation.
- Anomaly detection (TQ-025, FR-PROF-002) flags all four required categories — null,
  malformed value, statistical outlier (Tukey IQR fences), and suspicious pattern (sentinel
  placeholders, shape-breaks, duplicate rows) — proven with a fixture seeding one instance of
  each type and asserting all four are caught, both at the unit level and via live curl.
- Semantic field type inference (TQ-026, FR-PROF-003) is a deterministic heuristics engine
  (value-pattern + column-name signals) scoring **100% accuracy on a 26-case golden fixture
  set**, comfortably clearing the ≥90% DoD bar. The AI/embeddings-assisted second pass the
  SRS describes for ambiguous columns is real, honestly-scoped future work — see "Known gaps"
  below, not silently skipped or faked.
- Project-level quality score rollups (TQ-027, FR-PROF-004) average only *profiled* datasets'
  *latest* version scores — an unprofiled dataset is correctly excluded from the average
  rather than counted as a zero. Proven by ingesting a deliberately dirty CSV then a cleaner
  CSV as two versions of the same dataset and asserting the score moves correctly.
- The Business Partner canonical entity schema and CRUD API (TQ-028, FR-BP-001) — a
  project-scoped `business_partners` table plus three real 1:N child tables (addresses,
  identifiers, relationships) — proven via automated tests and a live curl walkthrough
  creating a full parent/child hierarchy with nested GET response verification. Deliberately
  kept separate from the not-yet-built Supplier entity (FR-BP-006): a supplier is a
  procurement-context role a BP plays, not the BP itself.
- The Data Profile frontend screen (TQ-029) — a steward can view field-level quality scores,
  inferred types, and semantic types for an ingested dataset, plus its flagged anomalies and a
  manual re-profile trigger. Satisfies the literal DoD wording; automated relationship
  *discovery* is explicitly out of scope here (see "Known gaps").
- Entity resolution matching (TQ-030–032, FR-DUP-001/002) — deterministic exact matching on
  normalized identifiers plus real Postgres `pg_trgm` fuzzy name/address matching, with the
  `0.5` similarity threshold chosen from **measured** trigram scores against representative
  test-name pairs (run directly through `psql`), not guessed. Proven via a golden fixture
  regression test (TQ-030) seeding known duplicate and non-duplicate Business Partner pairs
  through the real HTTP API and asserting the matcher gets every one right.
- A confidence/evidence model (TQ-033, FR-DUP-003) — exact identifier matches score 1.0;
  corroborating name + address similarity signals blend to a higher score than either alone;
  a single uncorroborated signal is discounted. 7 unit tests cover the formula directly.
- The full four-state decision workflow (TQ-034, FR-DUP-004/005) —
  `needs_review`/`merge`/`keep_separate`/`reject` — including the "never overwrite a human's
  prior decision on re-run" upsert semantics, proven with a dedicated regression test. Merge
  decisions here are **recorded, not executed** — no Business Partner row is ever mutated by
  this sprint's code; actually collapsing two BP records is TQ-062 (Sprint 7), confirmed
  against the sprint plan before scoping this sprint's work.
- The unauthorized-auto-merge guardrail (TQ-035, FR-DUP-006, AGENTS.md Do-Not-Do #3) — a
  `merge` decision requires `approve` permission, not just `modify`; denial is proven by
  three layered tests (unauthenticated 401, STEWARD-denied-with-persisted-audit-event
  verified by direct DB query since no Audit Explorer exists yet, VIEWER-denied) plus the
  frontend surfacing the backend's own denial message rather than a generic error. The new
  Gemini-assisted `ai_recommendation` (below) does not touch this guardrail at all — it is a
  suggestion stored in separate columns, never a candidate value for `decision` itself, so a
  `merge` still requires the same human + `approve` permission regardless of what the AI
  suggested.
- **AI-assisted entity match adjudication** (Sprint 5 hackathon slice, TQ-039/040's sibling
  slice, `lib/matching/aiAdjudicator.ts`, migration `0014_ai_entity_match_adjudication.sql`)
  — for fuzzy candidates whose confidence lands in `[0.5, 0.9)` (genuinely ambiguous —
  outside that band the deterministic score is already either too weak to act on or already
  strong enough that a second opinion adds little), the match-detection run now calls Gemini
  for a `merge` / `keep_separate` / `uncertain` recommendation plus reasoning, stored in new
  `ai_recommendation`/`ai_confidence`/`ai_reasoning`/`ai_model_version` columns — never
  written to `decision`. 11 mocked unit tests (`lib/matching/__tests__/aiAdjudicator.test.ts`)
  cover the confidence-band boundary logic, structured-output parsing, degradation to `null`
  on an unconfigured key or a schema-validation failure, and a privacy-shaped assertion that
  the prompt carries primary name/city/region/postal/country but never a street address line
  or an identifier-shaped value. See "AI-assisted entity match adjudication" below for how to
  run it, and `docs/adr/0003-gemini-genkit-integration.md`'s addendum for the design
  rationale (including why this module sends real name/location text, unlike semantic type
  resolution's shape-only approach).
- BP field normalization (TQ-036, FR-BP-004) — a pure, unit-tested function library
  (11 tests) used only at match time, explicitly never auto-applied to stored BP records;
  the "no real customer data dictionary exists yet" gap is documented rather than assumed.
- The Supplier entity model + BP linkage (TQ-037, FR-SUP-001/002) — a project-scoped
  `suppliers` table with a two-tier duplicate design: a real DB unique constraint hard-blocks
  true duplicates (409), while a same-source-system/different-number case is soft-flagged
  with a `duplicateWarning` rather than blocked. 5 tests cover both tiers plus the N:1
  BP linkage and 404 handling.
- The BP/Supplier Resolution frontend screen (TQ-038) — a steward can review a match
  candidate pair side-by-side (including each side's linked Supplier "roles") and record a
  decision, with the guardrail's own permission-denied message surfaced verbatim on a
  blocked merge attempt. 4 component tests cover list/compare, deciding, the guardrail
  denial message, and the empty state.
- Indexing & threshold tuning (TQ-082) — a GIN trigram *expression* index matching the
  fuzzy-match query's `upper(...)` normalization, with a measured p95 latency of **~178ms**
  against a 300-row fixture (500ms budget). Honestly documented: at this row count Postgres's
  planner doesn't actually choose the new index (verified via `EXPLAIN ANALYZE`) — real
  Cloud SQL-scale verification remains open, not silently assumed to generalize.
- Every new table this sprint (`dataset_anomalies`, `business_partners`, `bp_addresses`,
  `bp_identifiers`, `bp_relationships`, `entity_matches`, `suppliers`) has Row-Level Security
  enabled and was checked against the least-privilege `transformiq_app` role's grants, the
  same pattern established in Sprint 2.
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
- Frontend builds (`vite build`), lints, and passes its test suite (`vitest`, **5 test files,
  12 tests**), including the Project Setup form (TQ-018) submitting all fields, the Data
  Profile screen (TQ-029) rendering field-level scores/types/anomalies from a mocked API and
  offering a "Profile now" action for an unprofiled version, the Entity Resolution screen
  (TQ-038) covering compare/decide/guardrail-denial/empty-state, and the dev-only
  tenant-bootstrap page being fully absent from the production bundle (verified by grepping
  the built output).
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
- Vertex AI — `src/lib/vertexAI.ts` was a typed stub whose functions always threw; Sprint 5
  wires `generate()` up for real (TQ-039/TQ-040), and it is now the single shared call point
  for **two** features: semantic type resolution (`lib/semantics/aiResolver.ts`) and entity
  match adjudication (`lib/matching/aiAdjudicator.ts`). `embed()` remains unused/unwired — no
  feature in this repo needs embeddings yet. Semantic type inference's deterministic pass
  (TQ-026) and entity resolution's deterministic/fuzzy matching (TQ-032, Sprint 4) both still
  ship as the primary, AI-free engines they always were — confirmed against the sprint plan
  that Gemini is only ever a second-pass opinion on what those engines already flagged as
  ambiguous, never a replacement for them — see "Known gaps".
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

## AI-assisted semantic type resolution (Gemini + Genkit)

Optional locally, real when configured — see `docs/adr/0003-gemini-genkit-integration.md` for
the full design rationale.

```bash
# Get a free key: https://aistudio.google.com/apikey
echo "GEMINI_API_KEY=your-key-here" >> backend/.env
```

That's it — no other setup. Ingest a CSV with a column the deterministic heuristics engine
(`lib/semantics/engine.ts`) can't classify (e.g. a tax ID column with an unusual header name),
profile it, and open the Data Profile screen: a purple "✨ AI suggests: ..." badge appears
under that field's semantic type with a confidence score, and the model's reasoning + version
on hover. Without a key, profiling still works exactly as before — the AI call is additive,
never load-bearing (see `lib/semantics/aiResolver.ts`'s header comment).

## AI-assisted entity match adjudication (Gemini + Genkit)

Same `GEMINI_API_KEY` setup as above — no separate configuration. This is the second of the
two AI features named in AGENTS.md §1.6/FR-AI-001's scope ("entity resolution," alongside
"classification" above), same architecture and privacy posture applied to a different
judgment call. See `docs/adr/0003-gemini-genkit-integration.md`'s addendum for the full
design rationale.

Seed two Business Partners whose names/locations are similar-but-not-identical enough to land
in the deterministic fuzzy matcher's ambiguous confidence band (e.g. `"Acme Corp"` and
`"Acme Corporation"` at the same city/postal code — a legal-suffix variant, not an exact
string match), then run matching from the BP/Supplier Resolution screen ("Run matching"). A
candidate pair whose blended confidence lands in `[0.5, 0.9)` now also carries a purple
"✨ AI suggests: Merge (NN% confidence)" badge next to the deterministic evidence signals,
plus the model's reasoning in an "AI second opinion" section when you open the pair's detail
view. Hover the badge for the model version. This is a recommendation only — `decision` is
still set exclusively via a steward's own PATCH action (still gated by the existing
merge-requires-`approve` guardrail, unchanged by this feature); nothing here writes
`decision` or auto-merges anything (AGENTS.md Do-Not-Do rules #1/#3/#4).

Unlike semantic type resolution's structural "shape" abstraction, this module does send the
actual primary name and city/region/postal/country of each side to Gemini — judging "is this
the same real-world company" genuinely needs the text, and Business Partner name/location is
Confidential commercial information (AGENTS.md §3.3), not the harder Restricted class that
applies to personal/tax/banking data. It still deliberately never sends the street address
line, tax IDs, or Supplier banking/contact fields — none of that is needed for the judgment,
so none of it is sent. Without a key, or for any pair outside the ambiguous band, matching
still works exactly as before — the AI call is additive, never load-bearing (see
`lib/matching/aiAdjudicator.ts`'s header comment).

## Google Cloud deployment (Cloud Run)

The backend has always shipped with a `Dockerfile` and `cloudbuild.yaml` (Sprint 1) but was
never deployed against a real GCP project until this hackathon submission. To deploy:

```bash
# One-time setup
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# Store the Gemini API key in Secret Manager (never in code/config — AGENTS.md Do-Not-Do #9)
echo -n "your-gemini-api-key" | gcloud secrets create GEMINI_API_KEY --data-file=-

# Build + deploy
cd backend
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_GCP_PROJECT_ID=YOUR_PROJECT_ID,_REGION=us-central1,_AR_REPO=transformiq,_ENVIRONMENT=dev

# Grant the Cloud Run service account access to the secret, then set it as an env var:
gcloud run services update transformiq-backend-dev \
  --region=us-central1 \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --set-env-vars=GCP_PROJECT_ID=YOUR_PROJECT_ID
```

`lib/secrets.ts` automatically switches from `.env` to Secret Manager once `GCP_PROJECT_ID` is
set — no code change needed between local dev and this deployment.

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

## Known gaps (intentional — Sprint 4 scope closes here; these are Sprint 5+ or explicitly deferred)

Sprint 1's gap list (open tenant creation, single-role RBAC, no least-privilege audit role, no
PATCH/GET-by-id, no dataset model) is **closed as of Sprint 2**, Sprint 2's ingestion gap
(JSON+base64 MVP, no real file upload) is **closed as of Sprint 3** (TQ-021/TQ-022), and
Sprint 3's "Business Partner relationship discovery doesn't exist yet" gap is **substantially
addressed as of Sprint 4** — TQ-028's manual relationships and TQ-030–035's automated
duplicate-candidate discovery are different features (one records that two BPs are related,
the other detects that two BP *records* might be the same BP), but automated discovery of
*something* now exists — see `docs/p0-exit-checklist.md` for the Sprint 1+2 evidence. What's
still genuinely open, going into Sprint 5+:

- **A "merge" decision is recorded, never executed.** TQ-034/035 (Sprint 4) let a steward
  decide two Business Partner records are duplicates, but no code in this repo actually
  rewrites foreign keys or collapses the two rows — that's TQ-062 ("Remediation execution
  engine"), Sprint 7 scope, confirmed against the sprint plan before Sprint 4 was scoped.
  A `merge`-decided pair sits recorded and audited, waiting on that later engine.
- ~~Entity resolution fuzzy matching is still Postgres `pg_trgm`-only, no AI-assisted second
  opinion~~ — **partially closed by the Sprint 5 hackathon slice.** Be precise about what
  changed and what didn't: the Sprint 5 slice added `lib/matching/aiAdjudicator.ts`, which
  gives a Gemini-assisted `merge`/`keep_separate`/`uncertain` recommendation for candidate
  pairs the deterministic `pg_trgm` fuzzy matcher *already found* and scored into the
  ambiguous confidence band — it is a second opinion on an existing candidate, not a new
  discovery mechanism. **Still genuinely open:** Sprint 4's fuzzy matcher only ever surfaces
  pairs with meaningful trigram (textual) overlap; it will not catch, and the Sprint 5 AI
  adjudicator will never even see, a genuinely different-looking name that's semantically the
  same entity with no textual overlap to compare (e.g. a DBA name bearing no resemblance to
  the legal name) — that specific candidate-*discovery* gap is unchanged by this slice, real
  future work, not silently closed. Left here, struck through, so the history of this gap
  being opened and partially closed stays visible rather than silently rewritten.
- **Entity resolution scope is Business Partners only.** TQ-037 added the Supplier entity
  and BP linkage, but there is no separate Supplier-to-Supplier fuzzy/exact matching pass —
  a duplicate Supplier record under the *same* BP is caught by the hard-block/soft-flag logic
  in `routes/suppliers.ts`; a duplicate BP (and therefore its Suppliers) is caught by the
  entity-matching engine. Material entity resolution (mentioned in AGENTS.md's Do-Not-Do
  Rule #3 alongside BP/Supplier) is not built — no Material entity model exists in this repo
  yet.

- **Login is still a dev-token stand-in**, not real SSO. Backend TQ-006 laid the
  OIDC-verification code path but nothing issues a real token yet.
- **Ingestion jobs run in-process, not via a real message queue.** `lib/jobs/queue.ts` is an
  in-memory job queue (`setImmediate`-driven) that proved out the async job *model* — the
  transaction-commit-visibility ordering, job status tracking, and the TQ-024/025/026
  ride-along design — but the SRS's target architecture is a Pub/Sub-backed consumer for
  real horizontal scaling and crash-durability. Swapping the queue implementation is
  Sprint 4+ scope; the job-handler interface was written to make that swap isolated to
  `lib/jobs/queue.ts` itself.
- ~~Semantic type inference (TQ-026) is heuristics-only, not AI-assisted~~ — **closed by the
  Sprint 5 hackathon slice.** The deterministic engine (100% on its golden fixture set) still
  runs first and governs for every column it can classify; genuinely ambiguous columns now get
  a real Gemini-assisted second-pass suggestion (see "AI-assisted semantic type resolution"
  below). Left here, struck through, so the history of this gap being opened and closed stays
  visible rather than silently deleted.
- **Business Partner relationship *discovery* doesn't exist yet.** TQ-028 built manual
  relationship creation (`POST /v1/business-partners/:id/relationships`) — a steward or an
  upstream process can record that two BPs are related, but nothing infers those
  relationships automatically. Automated discovery is entity-resolution work, later-sprint
  scope per the roadmap.
- **Several read endpoints use N+1 query patterns** (`GET /v1/business-partners/:id`'s four
  independent per-entity queries; the project quality-score endpoint's one profile lookup per
  dataset) — documented inline as intentional simplicity tradeoffs at current scale, not
  something masked or hidden. Worth revisiting if/when dataset or BP counts per
  project/tenant grow large enough for it to matter.
- **No target-pack association or lifecycle status transitions on projects** beyond a
  free-text `status` field — follows the target-pack model (Sprint 9+ per the roadmap).
- **Platform admin key is one static shared secret**, not per-operator credentials with an
  audit trail. Adequate for the current threat model (internal-only, never reachable from
  customer-facing frontend code); flagged in `docs/security/encryption-checklist.md` as
  something to fix before onboarding real customers.
- **No real GCP verification for the Terraform-defined infra** (GCS, Cloud SQL TLS
  enforcement, Secret Manager, Pub/Sub) — still true as of this Sprint 5 slice for everything
  except the new Gemini call itself (which uses API-key auth, not GCP-project-scoped infra —
  see `docs/adr/0003-gemini-genkit-integration.md`) and the Cloud Run deployment covered
  below. Terraform/GCS/Cloud SQL/Pub/Sub remain reviewed IaC/code, not a tested deployment.
  See `docs/p0-exit-checklist.md`'s "What could not be verified" section.
- **No live browser session has driven the frontend** — verified via jsdom component tests
  and a curl-driven backend E2E that mirrors what the frontend sends, not an actual click-
  through in Chrome/Playwright. Still true this sprint for the new Data Profile screen too.
- **VPC Service Controls, CMEK, secret rotation, field-level PII encryption** — explicitly
  out of scope for this checklist, tracked as later hardening rather than silently assumed
  covered. See `docs/security/encryption-checklist.md`'s "does not cover" section.

## Where this fits in the bigger plan

See `TransformIQ_Sprint_Plan.xlsx` for the full 9-sprint backlog (Sprints 1–4 → this repo,
P0 Foundation plus first-slice ingestion/profiling/BP-entity work and deterministic/fuzzy
entity resolution; Sprint 5 → AI-assisted semantic matching + recommendations (the first
sprint that actually needs a GCP project); Sprints 6–8 → review workflow, simulation,
remediation/merge execution, rollback, cost governance; Sprint 9 → lightweight Target Mapping
groundwork). See `AGENTS.md` for the rules every change in this repo should follow.
