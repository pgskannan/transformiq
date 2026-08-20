# TransformIQ — All Things Agentic Hackathon Submission Checklist

Deadline: **August 31, 2026, 5:00pm PDT** (8:00pm ET).

## Mandatory technical requirements — status

| Requirement | Status |
|---|---|
| Gemini 3.5 or newer (Gemini API or Vertex AI) | ✅ Real — `gemini-3.6-flash` via `backend/src/lib/vertexAI.ts` |
| A Google Agent Framework (ADK / GenAI SDK / Antigravity SDK / GenKit) | ✅ Real — Genkit + `@genkit-ai/google-genai` |
| At least one Google Cloud service | ✅ Cloud Run (deploy) + Secret Manager (already-wired dependency) |

## Repo access — action needed from you

- [ ] `github.com/pgskannan/transformiq` is currently **private** (confirmed: anonymous clone
  fails with "terminal prompts disabled"). Devpost requires the repo be shareable with
  **testing@devpost.com** and **cloudhackathons@google.com** — add both as collaborators, or
  make the repo public before submitting.
- [ ] Push the Sprint 5 commit (the changes delivered this session, already written to your
  local working tree at `C:\TransformIQ\SRS\transformiq`) — run:
  ```
  cd C:\TransformIQ\SRS\transformiq
  git add -A
  git commit -m "Sprint 5 hackathon slice: real Gemini/Genkit AI-assisted semantic type resolution"
  git push
  ```

## Devpost "What to Submit" — status

| Item | Status |
|---|---|
| Project category | ✅ **The Taskmaster** |
| Hosted project URL | ⚠️ Deploy the backend to Cloud Run (README "Google Cloud deployment" section has the exact commands) — you'll need to run this yourself, my sandbox can't reach Google Cloud endpoints |
| Text description (features/tech/data sources/learnings) | ✅ Drafted — `devpost_submission_description.md` |
| GitHub repo link, shareable with the two addresses above | ⚠️ Repo exists, needs sharing (see above) |
| Step-by-step README with setup instructions | ✅ Updated — local dev, Gemini setup, Cloud Run deploy, all in README.md |
| System architecture diagram | ✅ `docs/architecture-diagram.png`, also embedded in README |
| ~4-min demo video (problem, value prop, live demo, GCP proof) | ⚠️ Script/storyboard ready — `demo_video_script.md` — you'll need to record screen + narration yourself |

## Optional bonus points

- [ ] A blog post / podcast / video about the build (not started — lower priority than the
  mandatory items above given the timeline)
- [ ] A social post with **#AllThingsAgenticHackathon**
- [ ] Gemma / Veo / Lyria integration (not in scope for this slice — would be genuinely
  additional work, not something to bolt on superficially just for bonus points)

## Before you submit — sanity checks

- [ ] Run `cd backend && npm run lint && npx tsc --noEmit && npm test && npm run build` for
  real, against a real local Postgres (not just my sandbox's mocked-test pass) — confirms the
  Sprint 5 changes hold up in your actual dev environment.
- [ ] Deploy to Cloud Run and click through the live Data Profile screen yourself once, with a
  test CSV that has a genuinely ambiguous column, before recording the demo video — confirms
  the real Gemini call works end-to-end outside my sandbox (which cannot reach any Google
  endpoint to verify this directly).
- [ ] Re-read `devpost_submission_description.md` and cut anything that reads as overclaiming
  — the whole point of this platform's governance model is not overclaiming, keep the
  submission text held to the same standard.
