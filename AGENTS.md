# TransformIQ — AI Operating Manual

Source of truth: `TransformIQ_Procurement_Business_Partner_Direct_Indirect_S4HANA_Ariba_SRS_v2.0.docx`
(Status: Product Baseline — For Review, Version 2.0, Dated August 11, 2026)

This document governs how any AI coding agent (Claude, or any other model/tool) works in the
TransformIQ codebase. It translates the SRS into operating rules. Requirement IDs (`FR-XXX-NNN`)
are cited throughout so every rule is traceable back to the SRS. When this manual and the SRS
disagree, treat it as a documentation bug — flag it, don't silently pick one.

TransformIQ is an AI-assisted enterprise procurement-data transformation platform. Its first
product domain is Direct and Indirect Procurement, with **Business Partner** and **Supplier** as
first-class master-data objects and **SAP S/4HANA** and **SAP Ariba** as the initial target
ecosystems. Core promise: **Detect → Explain → Recommend → Approve → Remediate → Validate → Prove.**

It is explicitly **not** a generic CSV cleaner and **not** an Ariba-only tool. Keep procurement
concepts (BP, Supplier, Material, Category, Contract, Source of Supply) architecturally separate
from target-system concepts (S/4HANA fields, Ariba fields) so the platform can add target
ecosystems later without a rewrite.

> **Stack note:** The SRS specifies behavior and contracts, not a language/framework/database
> product. Section 30 ("Decisions Required Before Build Freeze") leaves deployment model, AI
> provider(s), and pilot scope open. If this repo does not yet contain an established stack
> convention, do not silently pick one — ask, or check for a more specific `AGENTS.md`/README in
> the subdirectory you're working in before introducing a new framework, ORM, or infra pattern.

---

## 1. Architecture

### 1.1 Conceptual data model

Business Partner is a first-class object. **Supplier is a related procurement role/entity, not a
synonym for Business Partner** — never collapse the two in code, schema, or UI copy.

| Object | Purpose | Typical relationships |
|---|---|---|
| Business Partner | Real-world organization/person identity and shared party attributes | 1:N addresses, identifiers, relationships, supplier roles |
| Supplier | Procurement/vendor representation associated with a Business Partner | BP → Supplier; purchasing organizations; company-code/configured financial data |
| Material/Product | Direct or indirect item/service being procured | Supplier, plant, category, UOM, source of supply, contracts |
| Category/Commodity | Procurement classification | Material/service/supplier/spend relationships |
| Plant/Location | Operational procurement location | Supplier, material, purchasing data |
| Purchasing Organization/Group | Procurement organizational context | Supplier, material, contracts, purchasing activity |
| Contract | Commercial agreement | Supplier/BP, materials/categories, organizations, terms |
| Source of Supply | Supplier-material/location sourcing relationship | Supplier, material, plant, purchasing organization |
| Target Representation | How a source entity/value is represented in S/4HANA/Ariba | Source-to-target mappings and validations |

### 1.2 End-to-end pipeline

Every dataset moves through this sequence. Build modules/services around these stage boundaries
rather than inventing parallel pipelines:

1. **Project Setup** — domain, source systems, target ecosystem, owners, target packs.
2. **Data Acquisition** — ingest while preserving immutable raw data.
3. **Profiling** — schema, semantic types, quality issues, relationships.
4. **Entity Resolution** — resolve BP/Supplier identities and duplicates.
5. **Standardization** — normalize names, addresses, identifiers, codes, formats.
6. **Procurement Intelligence** — classify materials, categories, commodities, procurement attributes.
7. **Target Mapping** — map legacy values to target reference values/structures.
8. **Rule Validation** — run deterministic business and target rules.
9. **AI Analysis** — resolve semantic ambiguity, propose remediation.
10. **Cluster Review** — group equivalent recommendations for bulk steward decisions.
11. **Simulation** — preview impact before execution.
12. **Remediation** — execute approved, versioned changes.
13. **Validation** — re-profile and validate against the target readiness pack.
14. **Rollback** — undo a full run/batch if required.
15. **Sign-off** — obtain business and functional readiness approval.
16. **Export/Integration** — produce target-compatible data and exception output.
17. **Prove** — retain complete lineage and evidence.

### 1.3 Logical data model & relationships

| Entity | Relationships |
|---|---|
| Tenant | 1:N Project, User, Policy |
| Project | 1:N DatasetVersion, Rule, TargetPack, RemediationRun, ApprovalTask |
| Dataset | 1:N DatasetVersion |
| DatasetVersion | 1:N DataQualityIssue, AIRecommendation, ValidationResult |
| BusinessPartner | 1:N SourceBPRecord, Address, Identifier, Relationship; 1:N SupplierRole |
| Supplier | N:1 BusinessPartner; N:N PurchasingOrganization/Plant where configured |
| Material | N:N Supplier; N:N Plant; N:1 Category/Commodity |
| Category/Commodity | 1:N classification relationships |
| Contract | N:1 Supplier/BP; N:N Material/Category where configured |
| SourceOfSupply | Supplier + Material + Plant/Purchasing context |
| EntityMatch | Links candidate BP/Supplier/Material entities with evidence |
| AIRecommendation | N:1 Issue; N:1 ModelVersion; optional RemediationAction |
| RemediationRun | 1:N RemediationBatch; 1:N RemediationAction |
| ApprovalTask | N:1 Recommendation/Cluster/ReadinessDecision |
| TargetPack | 1:N ValidationRule/Crosswalk/RelationshipRule |
| ValidationResult | N:1 DatasetVersion + TargetPack |
| AuditEvent | Links project/dataset/batch/record/user/rule/model as applicable |

### 1.4 Target Readiness Pack architecture

A **Target Readiness Pack** is a versioned configuration package populated from the customer's
approved target design, migration templates, reference values, and business rules. **Never assume
one universal S/4HANA or Ariba configuration** — every target rule, mandatory field, and reference
value must be sourced from a pack, not hard-coded.

| Component | Purpose |
|---|---|
| Schema Metadata | Target fields, data types, lengths, constraints |
| Requiredness | Mandatory/optional attributes |
| Reference Data | Approved target values |
| Crosswalks | Legacy-to-target mappings |
| Business Rules | Customer/domain transformation rules |
| Relationship Rules | BP-Supplier, Supplier-Material, Supplier-Plant, and other required relationships |
| Blocking Rules | Conditions that prevent readiness approval |
| Transformation Rules | Formatting, derivation, conditional logic |
| Export Contract | Expected target load/output structure |
| Version | Traceable release used for validation |

A Target Readiness Pack is versioned **independently of datasets** (FR-TGT-005, FR-S4-007,
FR-ARB-005). Never let a dataset implicitly re-target itself to a newer pack version — the
association is explicit and tracked.

### 1.5 API & events

- All endpoints are explicitly versioned (`/v1/...`); paths in the SRS are illustrative, not
  literal contracts to copy verbatim, but **the versioning discipline is mandatory** (FR-EXP-004).
- Representative surface: project/dataset CRUD, profiling jobs, issues, recommendations +
  decisions, remediation runs (+ rollback), simulations, validation runs, readiness queries.
- Event-driven integration: emit `job.completed`, `job.failed`, `approval.required`,
  `readiness.changed` (and equivalents) so orchestration/downstream systems don't have to poll.
- A connector framework is expected for future SAP/Ariba/database/API integrations (FR-ING-005,
  FR-EXP-006) — design ingestion/export as pluggable connectors, not a single hard-coded path.

### 1.6 AI routing architecture

Route every AI-assisted decision through cost-ascending tiers: **deterministic rule → algorithm/
embedding → LLM**, always picking the least expensive method that can resolve the case
(FR-AI-004). Reserve LLM calls for genuine semantic ambiguity in normalization, entity resolution,
classification, and mapping (FR-AI-001).

---

## 2. Business Rules

### 2.1 Entity rules

- Business Partner and Supplier are modeled and reasoned about separately at all times (FR-BP-001,
  FR-SUP-001). Distinguish organization vs. person where source data supports it (FR-BP-003).
- Resolve whether multiple supplier records represent the same Business Partner or legitimately
  different entities — do not assume 1:1 (SRS §5).
- Maintain BP and Supplier identifier crosswalks and provenance for every relationship
  (FR-BP-005, FR-BP-007, FR-SUP-006).

### 2.2 Direct vs. Indirect procurement scope

Direct and Indirect Procurement are **distinct domains that share the same transformation
engine** (Release 1.0 DoD). Do not fork the core engine per domain; differentiate via
configuration/taxonomy, not duplicated pipelines.

- Direct: material/product master data, UOM & conversion rules, supplier-material and
  supplier-plant/source-of-supply relationships, manufacturer/part data, lead time/MOQ where
  available (FR-DIR-001..009).
- Indirect: category/commodity classification (UNSPSC/eCl@ss/customer taxonomy where configured),
  service description normalization, contracts, cost-center/account-assignment where in scope,
  buying-channel/policy validation (FR-IND-001..007).

### 2.3 Rule classification & versioning

- Rules must support required, allowed-value, range, conditional, and relational types
  (FR-RULE-001), and be versioned and effective-dated (FR-RULE-002).
- Severity is always one of: **Blocking Error, Error, Warning, Informational** (FR-RULE-003). Do
  not introduce ad hoc severities.
- Rule packs are scoped by Direct, Indirect, BP, and Supplier (FR-RULE-004).
- **Deterministic mandatory rules override AI suggestions where policy requires** (FR-RULE-005) —
  never let an AI recommendation silently bypass a blocking deterministic rule.
- New/changed rules must be testable against samples before full execution (FR-RULE-006).

### 2.4 Confidence policy

| Confidence | Default action |
|---|---|
| 95–100% | Candidate for auto-remediation **only** when the action is explicitly low-risk and policy-authorized |
| 75–94% | Human review; cluster review preferred |
| <75% | Exception / manual investigation |

**Confidence is not authorization.** Risk class, target impact, and business policy must also be
evaluated before any automated action is taken (SRS §14). Never wire a code path that treats a
confidence score alone as sufficient to auto-apply a change.

### 2.5 Entity resolution decision states

Matching decisions are one of exactly: **Merge, Keep Separate, Reject, Needs Review**
(FR-DUP-005). Every match must carry confidence and evidence (FR-DUP-004), and match history must
be reversible (FR-DUP-008). Automatic merges must be blocked unless explicitly authorized
(FR-DUP-006 — see Do-Not-Do Rules).

### 2.6 Human review workflow

- Steward decisions are one of: **Accept, Reject, Edit, Defer, Escalate** (FR-APR-002), individually
  or via cluster/bulk approval (FR-APR-003).
- Every review item must display source value, proposed value, evidence, confidence, the
  triggering rule, and target impact (FR-APR-004).
- Every decision records approver, timestamp, decision, and comments (FR-APR-005) — this is audit
  data, not optional UI state.

### 2.7 Target readiness rules

- Target readiness is calculated **separately from generic data quality** (FR-TGT-006) and must
  **never** be inferred from generic quality alone (FR-TGT-007). Surface BP readiness, Supplier
  readiness, Direct readiness, Indirect readiness, S/4HANA readiness, and Ariba readiness as
  distinct figures (FR-VAL-003).
- Blocking issues must prevent final readiness approval — no override path that skips this check
  (FR-VAL-005, Release 1.0 DoD).

### 2.8 Remediation & rollback rules

- Remediation recommendations are versioned (FR-REM-001) and materially equivalent
  recommendations are grouped into clusters with a full record-level preview before approval
  (FR-REM-002, FR-REM-003).
- Individual record override must remain possible even after a cluster decision (FR-REM-004).
- Policy-based auto-remediation is allowed **only** for approved low-risk actions (FR-REM-005).
- Every remediation run/batch gets immutable IDs (FR-REM-006) and must be fully rollback-able
  (FR-REM-007). Show projected readiness impact before execution (FR-REM-008).

---

## 3. Security Rules

### 3.1 Tenancy & access

- Strong tenant/project authorization and data isolation is mandatory; concurrent jobs across
  tenants must never leak data (SRS §19, §21 Concurrency).
- RBAC must separate viewing, modifying, approving, exporting, and administering as distinct
  permissions — do not collapse these into one "admin" flag.

### 3.2 Encryption & secrets

- Data is encrypted in transit and at rest, no exceptions.
- Secrets are managed (vault/secret-manager pattern); **no credentials in data or config files**,
  ever — this includes AI provider keys, DB credentials, and connector auth.

### 3.3 Sensitive data classification

| Class | Examples | Default AI handling |
|---|---|---|
| Public | Public reference values | Permitted |
| Internal | Normal operational data | Policy controlled |
| Confidential | Commercial terms, supplier commercial information | Minimize/mask where possible |
| Restricted | Personal identifiers, banking/tax identifiers, regulated data | Default mask/redact before external AI; explicit policy required for any exception |

Classify fields before they can reach an AI provider. Restricted data defaults to masked/redacted
— an explicit, auditable policy exception is required to relax that, not a code-level shortcut.

### 3.4 AI privacy

- Any external AI processing (i.e., calls to a third-party model provider) requires policy
  authorization (SRS §19). Do not add a new AI provider or call path without checking this policy
  gate exists and is enforced.
- Provider/model in use must be configurable and recorded for every material AI decision
  (FR-AI-003, SRS §13 Provider).

### 3.5 Audit of privileged actions

Privileged and material actions must be audited (SRS §19 Audit) — this includes rule changes,
target pack changes, remediation approvals, rollbacks, merges, and admin/config changes. See
Database Rules §4.2 for the audit event contract.

### 3.6 Deployment security posture

- Default deployment is SaaS multi-tenant; dedicated/private enterprise deployment is supported;
  on-prem/private architecture is reserved for customers where it's appropriate — don't assume
  every customer gets on-prem by default.
- Support configurable data residency.
- Treat security certifications as a roadmap item: **make no certification claim before the
  underlying control is actually complete and verified** (SRS §19 Security Roadmap).

---

## 4. Database Rules

### 4.1 Immutability & versioning

- **Raw ingested data is immutable.** Never mutate or overwrite the original source artifact
  (FR-PROJ-002, FR-PROJ-003, SRS §21 Data Integrity).
- All working data lives in **versioned working datasets**, layered on top of immutable raw data.
  Working versions must be reversible.
- Preserve exact source artifacts as evidence — this is a compliance requirement, not a
  nice-to-have cache.

### 4.2 Lineage, provenance & audit events

- Maintain dataset lineage from source artifact to target output (FR-PROJ-006).
- Every audit event captures: old value, new value, action, actor, timestamp, rule/model version,
  and approval reference (FR-AUD-002). Audit events themselves are immutable (FR-AUD-001) — no
  update/delete path on an audit log table.
- Provide field-level provenance: every target value must be traceable back to its source value,
  decision, and evidence (FR-AUD-005, FR-VAL/Release 1.0 DoD).
- Track AI model/provider/prompt/configuration version alongside every AI-influenced change
  (FR-AUD-004, FR-AI-003).

### 4.3 Reference data & crosswalks

- Canonical reference values are versioned (FR-REF-001); legacy-to-target crosswalks support
  1:1 and N:1 mappings (FR-REF-002, FR-REF-003).
- Reference values and mappings are **effective-dated** (FR-REF-006) — a schema without a
  valid-from/valid-to (or equivalent) concept on reference/crosswalk tables is incomplete.
- Unresolved mappings must be identifiable before readiness approval can proceed (FR-REF-005).

### 4.4 Rollback

- Support rollback at record, batch, and project level (FR-PROJ-007, FR-REM-007). Any schema or
  storage design that can't cleanly reconstruct a prior state for a given run/batch ID is not
  acceptable — design for reversibility up front, don't bolt it on later.
- Full remediation-run rollback must be tested at representative scale, not just unit-tested on
  toy data (SRS §21 Rollback).

### 4.5 Relationships

Follow the logical data model in §1.3 for foreign-key/relationship design. In particular:
BusinessPartner and Supplier are separate entities linked N:1 (Supplier → BusinessPartner), not a
single table with a type flag; Material relates N:N to Supplier and Plant, N:1 to
Category/Commodity.

---

## 5. Testing Rules

| Layer | Required coverage |
|---|---|
| Unit | Profiling, normalization, matching, rules, scoring, policies |
| Integration | Dataset lifecycle, AI providers, target packs, audit, export |
| Regression | Golden BP/Supplier/Material datasets with known-expected results |
| AI Evaluation | Precision/recall for matching; classification accuracy; mapping acceptance; recommendation acceptance |
| Confidence | Measure calibration and the high-confidence error rate specifically (not just aggregate accuracy) |
| Security | Tenant isolation, RBAC, masking, and AI data-exfiltration scenarios |
| Performance | Volume, concurrency, latency, cost, and rollback |
| Target Validation | Test against approved S/4HANA and Ariba target configurations, not synthetic/placeholder configs |

Additional rules:

- Maintain golden datasets for BP/Supplier/Material with known-correct outcomes; regression-test
  matching and classification changes against them before merge.
- Any change to matching, rules, or target-pack logic should include a before/after readiness
  impact check where feasible — this mirrors the product's own Simulation requirement (FR-SIM-001)
  and should be a habit in dev/test too.
- Rollback correctness is a first-class test target, not an afterthought — test it at a
  representative data scale, not just a handful of rows (SRS §21).
- New AI-assisted features need an evaluation harness (precision/recall/acceptance rate) before
  they ship, not just a demo.

---

## 6. Deployment Rules

- **Explicit API versioning is mandatory** for every endpoint (FR-EXP-004, SRS §22). Don't ship an
  unversioned route.
- Target Readiness Packs are versioned **independently** from datasets and from each other
  (FR-TGT-005, FR-S4-007, FR-ARB-005) — deployments must be able to pin/roll a pack version without
  touching dataset state.
- Deployment tiers: SaaS multi-tenant (default), dedicated/private enterprise, and on-prem/private
  (reserved for appropriate customers) — confirm which tier a change targets before assuming
  infra defaults (SRS §19).
- Data residency must be configurable per deployment — don't hard-code a region.
- Independent scaling for profiling, matching, AI, and validation workers is expected (SRS §21
  Scalability) — avoid architecture that couples these into one monolithic scaling unit.
- Observability is a deployment requirement, not optional: throughput, queue depth, latency,
  failures, AI calls, and AI cost must be observable per SRS §21.
- Respect the roadmap gating below when sequencing work — don't build P1D/P1E (accelerator) logic
  as a substitute for unfinished P0/P1 foundations:

| Phase | Focus | Exit criteria |
|---|---|---|
| P0 Foundation | Security, tenancy, immutable data, project/dataset model | Foundation tested |
| P1 Procurement Core | BP, Supplier, profiling, standardization, matching, rules, AI recommendations | End-to-end supplier/BP pilot |
| P1A Review & Safety | Clusters, simulation, rollback, audit, cost governance | Governed remediation proven |
| P1B Direct Procurement | Material, supplier-material, plant/source relationships | Direct procurement pilot |
| P1C Indirect Procurement | Category, commodity, service, contract, account-assignment intelligence | Indirect procurement pilot |
| P1D S/4HANA Accelerator | BP/Supplier/Material target readiness | Approved S/4 target validation |
| P1E Ariba Accelerator | Supplier/procurement target readiness | Approved Ariba target validation |
| P2 Integration | Connectors, APIs, events, reconciliation | Enterprise integration pilot |
| P3 Expansion | Additional targets/domains | Second target/domain validated |

---

## 7. Do-Not-Do Rules

These are hard constraints. If a task seems to require breaking one of these, stop and raise it
rather than proceeding.

1. **Never let AI silently modify source/raw data** (FR-AI-007). Raw data is immutable by design
   (§4.1) — AI output is always a recommendation until approved.
2. **Never infer target readiness from generic data quality alone** (FR-TGT-007). They are
   distinct, separately computed figures.
3. **Never perform an automatic entity merge (BP, Supplier, or Material) without authorization.**
   Unauthorized automatic merges must be actively prevented (FR-DUP-006); merges are one of
   Merge/Keep Separate/Reject/Needs Review, decided with evidence.
4. **Never treat confidence score alone as authorization** to auto-apply a change (§2.4). Risk
   class and policy must also gate the action.
5. **Never assume a single universal S/4HANA or Ariba configuration.** Every target rule,
   mandatory field, and reference value comes from a versioned, customer-approved Target
   Readiness Pack (§1.4) — don't hard-code SAP field behavior from general SAP knowledge in place
   of the pack.
6. **Never bypass a Blocking deterministic rule with an AI recommendation** (FR-RULE-005,
   FR-VAL-005). Blocking issues must prevent final readiness approval with no silent override.
7. **Never collapse Business Partner and Supplier into one entity/table/concept.** They are
   related but distinct (§1.1, §2.1).
8. **Never ship an unversioned API endpoint or an untracked change to a Target Readiness Pack**
   (§6). Both must be explicitly versioned.
9. **Never put credentials, API keys, or provider secrets in data files, config committed to the
   repo, or logs** (§3.2).
10. **Never send Restricted-classified data (personal identifiers, banking/tax IDs, regulated
    data) to an external AI provider without policy-authorized masking/redaction** (§3.3, §3.4).
11. **Never build a feature that replaces or bypasses SAP S/4HANA, SAP Ariba, MDM, or the
    customer's ERP** — TransformIQ prepares and validates data for those systems; it does not
    replace them (SRS §9.2 Non-Goals).
12. **Never build TransformIQ as a general-purpose ETL platform or a generic CSV cleaner** — scope
    is procurement-domain-aware transformation with entity resolution and target-readiness
    validation, not generic pipe-and-filter ETL (SRS §1, §9.2).
13. **Never claim guaranteed target-system acceptance** without customer-approved target
    configuration in place, and never claim a security certification before it is actually
    complete (SRS §9.2, §19).
14. **Never autonomously change production master data without explicit authorization** (SRS
    §9.2). Automation always terminates in an auditable approval, not a direct write to
    production target systems.
15. **Never delete or mutate an audit event.** Audit events are append-only/immutable (§4.2,
    FR-AUD-001).
16. **Never let a rollback be partial or silent.** Rollback of a run/batch must be complete and
    itself produce audit evidence — don't leave orphaned remediated records behind.
17. **Never route a straightforward, cheap (deterministic/algorithmic) decision through an LLM**
    just because it's available — follow the cost-ascending routing order in §1.6 (FR-AI-004).

---

## 8. Quick-Reference: Success Metrics & Definition of Done

Use these as acceptance criteria when a task claims to be "done":

- BP Resolution Precision and Supplier Duplicate Precision: >95% target on high-confidence
  matches (validate against golden datasets, §5).
- AI Acceptance Rate: >80% target for mature domains (validate during pilot).
- Target Validation Pass: 100% of exported records pass blocking target checks.
- Audit Completeness: 100% of material changes have complete evidence.
- Manual Review Reduction: >50% pilot target vs. baseline manual effort.

Release 1.0 is not "done" unless, among other things: BP and Supplier are first-class entities
with governed relationship handling; Direct and Indirect Procurement share one transformation
engine; raw datasets are immutable and working versions reversible; remediation runs/batches are
rollback-able; blocking target issues actually prevent final approval; and security, privacy, and
tenant isolation pass their defined acceptance tests (SRS §29).

---

## Appendix — Glossary

| Term | Definition |
|---|---|
| Business Partner | Canonical representation of a real-world organization/person in the transformation model |
| Supplier | Procurement representation/role associated with a Business Partner |
| Target Readiness | Fitness against the selected target-system configuration |
| Target Readiness Pack | Versioned target schema, rules, references, mappings, and relationship validations |
| Canonical Entity | Governed representation of a real-world entity |
| Recommendation | AI/rule-proposed action, not necessarily approved |
| Remediation | Approved/applied change to a working dataset |
| Cluster | Group of materially equivalent recommendations for collective review |
| Blocking Issue | Condition preventing readiness approval |
| Evidence | Data/metadata supporting a recommendation or decision |
| Provenance | Traceable relationship from target value back to source, transformation, and approval |

---

*Generated from SRS v2.0 (Aug 11, 2026, Product Baseline). If the SRS is revised, regenerate this
manual rather than hand-patching it out of sync.*
