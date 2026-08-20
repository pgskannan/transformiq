# TransformIQ — ~4-Minute Demo Video Script

Devpost requires: problem, value proposition, live demo, Google Cloud proof. Target length:
3:45–4:00. Record screen + your own narration (I can't record video/audio directly — this is
the shot list and talking points to record against).

---

## 0:00–0:35 — The problem (voiceover + slides or the whitepaper's problem page)

**Say:**
"Industry research puts data migration as the cause of roughly 83% of ERP and SAP migration
projects running over budget or behind schedule — not the application logic, the data itself.
When a company moves from SAP ECC to S/4HANA or Ariba, someone has to clean, de-duplicate, and
map every Business Partner, Supplier, and Material record by hand — usually in spreadsheets,
usually under deadline pressure, usually with no audit trail if something goes wrong."

**Show:** Whitepaper page 2 (Executive Summary + Problem) or a simple title card with the 83%
stat and its source note.

## 0:35–1:10 — The value proposition (voiceover over the architecture diagram)

**Say:**
"TransformIQ automates the tedious classification and matching work with AI, but never lets AI
act alone. Every AI suggestion is a recommendation a human reviews — never a silent write to
production master data. For this hackathon, we built a real, working Gemini-powered feature
into the existing four-sprint platform: AI-assisted semantic type resolution, using Google's
Genkit agent framework, deployed on Cloud Run."

**Show:** `docs/architecture-diagram.png` — pan/zoom from Client Layer down through the
purple AI Layer, calling out Genkit + Gemini + the governance sidebar.

## 1:10–2:50 — Live demo (screen recording, narrated)

1. **(1:10–1:25)** Show the Project Dashboard, open a project with an already-ingested CSV
   that has at least one intentionally ambiguous column (e.g. a tax-ID-shaped column with a
   generic header like `ref_code_2`).
2. **(1:25–1:45)** Open **Data Profile**. Point out the quality scores and the normal
   `semantic_type` column working as before (deterministic — e.g. `email`, `currency_amount`
   resolved instantly, no AI involved — say explicitly "most columns never touch the AI call
   at all, that's deliberate").
3. **(1:45–2:15)** Scroll to the ambiguous column. Point at the empty `semantic_type` cell,
   then the purple **"✨ AI suggests: tax_id (87% confidence)"** badge underneath it. Hover to
   show the tooltip with Gemini's reasoning and the model version string.
   **Say:** "This is Gemini's suggestion, not a decision — it's stored in a completely
   separate column from the governed semantic_type field, and a steward has to confirm it
   before anything downstream treats it as fact."
4. **(2:15–2:35)** Open a terminal / DB client and show the raw `field_profiles` row — point
   at `ai_semantic_type`, `ai_confidence`, `ai_reasoning`, `ai_model_version` sitting next to
   the still-null `semantic_type`. Then show the corresponding `audit_events` row with
   `model_version = 'gemini-3.6-flash'`.
   **Say:** "Every AI-influenced value is traceable back to exactly which model produced it —
   that's not a nice-to-have, it's a hard requirement in our own operating rules."
5. **(2:35–2:50)** Quickly show `resolveAmbiguousSemanticType`'s privacy behavior: open
   `aiResolver.ts` briefly, point at `shapesForAI()` and the comment explaining raw values
   never reach Gemini — or just narrate it over the code.

## 2:50–3:25 — Google Cloud proof (screen recording)

1. Show the Google Cloud Console: Cloud Run service `transformiq-backend-dev` running, green
   healthy status.
2. Show Secret Manager: the `GEMINI_API_KEY` secret, redacted value, showing it's referenced
   by the Cloud Run service's env config (not hard-coded anywhere).
3. Optionally: `gcloud run services describe transformiq-backend-dev` in a terminal, or the
   Cloud Build history showing the `cloudbuild.yaml` run that produced the current revision.

**Say:** "This isn't a mockup — the backend that just served that AI suggestion is running on
Cloud Run right now, with the Gemini key pulled from Secret Manager at request time, never
committed to the repo."

## 3:25–3:55 — Close (voiceover)

**Say:**
"TransformIQ's AI layer is small and deliberately scoped — it earns the word 'agentic' by
respecting seventeen hard governance rules we wrote down before we wrote the integration, not
by doing more than that. The same pattern — Genkit, structured output, an audit trail, a human
in the loop — is what we're extending next into target-field mapping and semantic entity
matching. Thanks for watching."

**Show:** GitHub repo README open, scrolled to the "AI-assisted semantic type resolution"
section, then a closing card with the repo URL and category (The Taskmaster).

---

## Recording checklist

- [ ] Screen resolution at least 1920×1080, browser zoom at a level where the AI badge/text is
      legible on a phone-sized Devpost embed.
- [ ] Have a CSV ready with at least one genuinely ambiguous column *before* recording — test
      it once beforehand so the AI call doesn't fail live (network hiccup, quota) mid-take.
- [ ] Mute notifications; close unrelated tabs.
- [ ] Keep the whole take under 4:00 — Devpost's stated max, not a soft target.
- [ ] Upload to YouTube/Vimeo unlisted (not private) so judges can access it without a login.
