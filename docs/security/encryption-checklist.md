# Encryption checklist (TQ-016)

Status legend: ✅ verified in this scaffold · 🔧 configured in IaC, not yet applied to a real
project · 📋 documented policy/decision, nothing to "run" · ⏳ deferred, tracked explicitly

No GCP project has been available in any environment this scaffold has been built or tested
in (see ADR 0001/0002 and the READMEs). Everything below that touches a real GCP resource is
therefore **written and reviewed, not exercised against a live service** — marked 🔧, not ✅.
Don't read a 🔧 row as "done"; read it as "the config exists and was reviewed, first real
`terraform apply` is the actual verification."

## Encryption at rest

| Data | Mechanism | Status | Notes |
|---|---|---|---|
| Cloud SQL (Postgres) | Google-managed encryption, on by default for every Cloud SQL instance | 🔧 | No config needed — this is automatic, not something `infra/terraform/modules/cloudsql` opts into. CMEK (customer-managed key) is available as an upgrade via `encryption_key_name` if a compliance review calls for it; deliberately not defaulted on (adds Cloud KMS availability coupling + key-rotation operational burden nobody has asked for yet). |
| GCS (raw dataset storage) | Google-managed encryption, on by default for every bucket/object | 🔧 | Same as Cloud SQL — automatic. `infra/terraform/modules/storage` doesn't need to (and doesn't) configure this explicitly. CMEK is again an available upgrade, not applied. |
| Local dev storage (`.data/raw/`) | None — plain filesystem | ✅ (honestly, not a ✅ for security) | Dev/test only, never used when `GCP_PROJECT_ID` is set (see `objectStorage.ts`). Do not treat local dev storage as representative of production encryption posture. |
| Secrets (JWT signing material, DB passwords, platform admin key) | Secret Manager (Google-managed encryption at rest) in GCP; plain `.env` (gitignored, never committed — verified by the `secret-scan` CI job) locally | 🔧 for GCP path, ✅ for local path | `backend/src/lib/secrets.ts` — see also the "Secrets" section below. |

## Encryption in transit

| Path | Mechanism | Status | Notes |
|---|---|---|---|
| Browser ↔ backend (Cloud Run) | TLS terminated by Cloud Run's managed load balancer; Cloud Run does not accept plaintext HTTP on its public endpoint | 🔧 | Nothing for this repo to configure — Cloud Run's default ingress is TLS-only. Local dev is plain HTTP (`http://localhost:8080`), which is correct for a loopback-only connection and is not a production analogue. |
| Backend ↔ Cloud SQL | TLS, and as of this sprint, **enforced** rather than optional | 🔧 | `infra/terraform/modules/cloudsql/main.tf` now sets `ip_configuration.ssl_mode = "ENCRYPTED_ONLY"` (added this sprint — it was previously unset, which is a real gap this checklist caught). `DATABASE_URL`/`MIGRATIONS_DATABASE_URL` must include `sslmode=require` (or stronger) once pointed at a real instance or the server refuses the connection outright rather than silently downgrading. Local dev Postgres (no TLS) is a loopback connection, not a production analogue. |
| Backend ↔ GCS / Secret Manager / Vertex AI | TLS via the official `@google-cloud/*` client libraries, which do not offer a plaintext transport option | ✅ | Not something this codebase could get wrong even if it tried — no plaintext code path exists in the client libraries themselves. |
| Backend ↔ GCS bucket policy | `uniform_bucket_level_access = true` (already present, Sprint 1) | 🔧 | Prevents ACL-based bypass of IAM; doesn't independently affect transport encryption, listed here because it's the same "don't let an unencrypted/unauthenticated path exist" review. |

## Secrets

| Item | Status | Notes |
|---|---|---|
| No secret ever committed to git | ✅ | `.env` is gitignored (verified — see `.gitignore` and `git ls-files \| grep env`, only `.env.example` files with placeholder values are tracked); CI's new `secret-scan` job (TQ-019) runs `gitleaks` against full git history AND the working tree on every push/PR, gating merge. Ran clean against this repo while building this checklist. |
| Secrets never logged | ✅ (fixed this sprint, not assumed) | `pino-http`'s **default** request serializer logs raw request headers — verified directly against `pino-std-serializers`, which showed the JWT (`Authorization`) and the platform-admin shared secret (`x-platform-admin-key`) would land in every access log line unredacted. Fixed with a `redact` config in `app.ts`; `src/__tests__/logging.test.ts` captures real stdout output from a live request and asserts the secret values never appear (and that the `[redacted]` marker does, so the test can't pass by the headers simply not being logged at all). |
| Secret rotation story | 📋 | Not yet implemented — Secret Manager supports versioning (`getSecret()` reads `.../versions/latest`), so rotation is *possible* without a code change, but there's no automated rotation job. Tracked as a gap, not silently assumed solved. |
| Platform admin key (`PLATFORM_ADMIN_API_KEY`) | 📋 | Currently a single static shared secret (TQ-011). Adequate for the P0 walking skeleton's threat model (internal platform operators only, never reachable from customer-facing frontend code — see `frontend/.env.example`'s comment on `VITE_DEV_PLATFORM_ADMIN_KEY`), but a real production rollout should replace this with per-operator credentials + audit trail before onboarding real customers. Flagged, not fixed, in this sprint. |

## What this checklist deliberately does not cover

- **VPC Service Controls** — explicitly called out as a later hardening step in
  `infra/terraform/modules/network/main.tf`'s header comment, not silently assumed covered by
  the private-IP Cloud SQL config that _is_ here.
- **Field-level encryption of specific PII columns** — the SRS does not currently call for
  this beyond standard at-rest/in-transit coverage; revisit if a future security review
  requires it for specific Business Partner/Supplier fields.
- **Penetration testing / external security audit** — out of scope for a sprint-level
  engineering checklist; call out separately to the Security/Platform Admin stakeholders
  named in the P0 exit checklist (`docs/security/p0-exit-checklist.md`).
