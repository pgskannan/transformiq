# TransformIQ — Devpost Submission Text

*(Draft for the "Project Story" / description field. Copy/paste and trim to fit Devpost's
field, tighten anywhere it reads long.)*

## Category

**The Taskmaster** — autonomous workflow automation beyond chatbots.

## Tagline

TransformIQ turns the highest-risk, most manual part of an SAP ECC → S/4HANA/Ariba migration
— cleaning and mapping legacy procurement master data — into a governed, AI-assisted pipeline
with a human always in the loop, not a chatbot bolted onto a spreadsheet.

## Inspiration

Industry-cited estimates put data migration as the cause of roughly 83% of ERP/SAP migration
projects running over budget or schedule — not the application logic, the *data*. Existing
tools either automate too aggressively (silently "fixing" master data with no audit trail) or
don't automate at all (manual spreadsheet mapping by a consultant, one column at a time). We
wanted a platform where AI does the tedious classification and matching work, but every AI
output is a recommendation a human reviews and approves — never a silent write to production
master data.

## What it does

TransformIQ ingests legacy procurement data (Business Partner, Supplier, Material, Category,
Contract records — CSV/XLSX today, connector framework designed for direct source-system
integration later), profiles it across five real quality dimensions, resolves duplicate
entities with a confidence/evidence model, and validates it against a customer-approved
S/4HANA/Ariba target configuration before anything is considered "migration ready." Every
step produces an immutable, append-only audit trail: what changed, who approved it, which
rule or AI model produced the recommendation.

For this hackathon we built and shipped a real, working slice of the platform's AI layer: when
the deterministic semantic-type classifier can't confidently tell what a column represents
(is this a tax ID? an email? a phone number?), the profiling pipeline now calls **Gemini
3.6 Flash through Genkit** (a Google Agent Framework) for a second opinion — surfaced in the
UI as a clearly labeled, unapplied suggestion with a confidence score and reasoning, never
silently written over the deterministic result. No raw personal, tax, or banking data is ever
sent to the model — only a structural "shape" of the sample values (letters/digits
generalized, punctuation kept) plus the column name, enough signal to classify the pattern
without exposing real values.

## How we built it

- **Backend:** Node/TypeScript, Express, Postgres 16 (Kysely, not an ORM with a native-binary
  dependency), row-level security per tenant, an append-only audit-event table.
- **AI layer (new):** Genkit + `@genkit-ai/google-genai`'s `googleAI` plugin, calling Gemini
  via the public Gemini API with a Zod-validated structured output schema — a malformed or
  hallucinated response degrades to "no suggestion," never a bad write.
- **Google Cloud:** Cloud Run hosts the backend; Secret Manager holds the Gemini API key
  (never in code or config); Terraform defines Cloud SQL, GCS, Pub/Sub, and Artifact Registry
  for the rest of the platform's infrastructure.
- **Frontend:** React, with a Data Profile screen that surfaces the AI suggestion as a
  distinct, hover-explainable badge next to (never inside) the governed field.
- **Governance, built in from Sprint 1, not bolted on for the hackathon:** an
  `AGENTS.md` operating manual encodes 17 hard "Do-Not-Do" rules (never let AI silently modify
  raw data, never treat confidence as authorization, never auto-merge entities, never bypass a
  blocking validation rule, etc.) that both human and AI contributors are held to — the Gemini
  integration was built to satisfy every one of them, not around them.

## Challenges we ran into

Getting real second-opinion value out of an LLM call *without* becoming the thing we didn't
want to build — a system where "the AI said so" quietly becomes authoritative. The confidence-
policy and audit-trail work (tracking exactly which model/version produced every suggestion,
keeping it in a separate column from the governed value) took longer than the API call itself.
We also didn't have a real GCP project with billing available for most of development, so the
integration was built and tested end-to-end against Gemini's API-key auth path and a fully
mocked test suite first, with the Cloud Run deployment validated separately once real GCP
access was available.

## Accomplishments we're proud of

A four-sprint foundation (real Postgres-backed ingestion, profiling, entity resolution with a
confidence model and an unauthorized-auto-merge guardrail, 150+ passing tests) that the AI
feature had to *fit into* rather than get built around — and a governance model rigorous
enough that "should this be auto-applied?" already had a documented, defensible answer before
we wrote a line of the Gemini integration.

## What we learned

That the hard part of "agentic" enterprise software isn't calling the model — it's deciding,
in writing, before you call it, exactly what the model is and isn't allowed to influence.

## What's next

Extending the same AI-assisted, human-reviewed pattern to target-field mapping suggestions
(Mapping Studio) and semantic entity matching for genuinely dissimilar-looking duplicate
names — both scoped in the existing roadmap, both designed to reuse this same Genkit/Gemini
integration point rather than a new one.

## Built with

TypeScript, Node.js, Express, React, PostgreSQL 16, Kysely, Genkit, Gemini API
(gemini-3.6-flash), Google Cloud Run, Google Secret Manager, Terraform, Docker, Jest, Vitest,
Zod.

## Try it

- GitHub repo: https://github.com/pgskannan/transformiq *(needs to be shared with
  testing@devpost.com and cloudhackathons@google.com — see submission checklist)*
- Live demo (standalone synthetic-data walkthrough): the Cloud Run URL from the earlier
  migration-readiness demo, or the newly deployed backend once you've run the Cloud Run
  deploy steps in the README.
