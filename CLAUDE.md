# CLAUDE.md

This file is Claude's entry point for working in the TransformIQ codebase. The full operating
manual — Architecture, Business Rules, Security Rules, Database Rules, Testing Rules, Deployment
Rules, and Do-Not-Do Rules — lives in `AGENTS.md` so it stays in one place for every AI tool
working in this repo. Read it before making non-trivial changes.

@AGENTS.md

## Claude-specific notes

- Treat every rule in `AGENTS.md` §7 ("Do-Not-Do Rules") as a hard stop, not a style preference —
  if a task seems to require crossing one, pause and raise it instead of proceeding.
- This manual was generated from the SRS (`TransformIQ_Procurement_Business_Partner_Direct_
  Indirect_S4HANA_Ariba_SRS_v2.0.docx`, v2.0, Aug 11 2026, Product Baseline — For Review). The SRS
  itself is the ultimate source of truth; if a task's needs conflict with something written here,
  say so rather than silently resolving the conflict.
- The SRS deliberately leaves language/framework/database choices open (see §30, "Decisions
  Required Before Build Freeze," in the SRS). Do not introduce a new core dependency, ORM, or
  infra pattern without checking existing repo conventions first — and if none exist yet, flag
  the decision rather than picking one unilaterally.
- When implementing anything touching Business Partner/Supplier merges, target readiness
  calculation, remediation execution, or rollback, re-read the relevant Business Rules and
  Do-Not-Do sections immediately before writing code — these are the areas with the highest
  blast radius if gotten wrong (see AGENTS.md §7, items 1–6, 11, 14–16).
