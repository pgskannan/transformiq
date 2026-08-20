// Entity resolution decision API (TQ-034/035, FR-DUP-005/FR-DUP-006). Runs the matching
// engine (lib/matching/engine.ts) on demand, lists/reads candidate matches, and lets a
// steward record one of exactly four decisions — with a hard guardrail on "merge" (see
// AGENTS.md Do-Not-Do #3 and the module-level comment on the PATCH route below).
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission, roleHasPermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { recordAuditEvent } from "../lib/audit";
import { findAllMatchCandidates, type MatchCandidate } from "../lib/matching/engine";
import {
  isAmbiguousFuzzyMatch,
  resolveAmbiguousMatch,
  type BusinessPartnerAISummary,
} from "../lib/matching/aiAdjudicator";
import type { Kysely } from "kysely";
import type { DB } from "../../db/types";

export const entityMatchesRouter = Router();

const DECISIONS = ["needs_review", "merge", "keep_separate", "reject"] as const;

// Loads the fields lib/matching/aiAdjudicator.ts is allowed to see (primary name + city/
// region/postal/country of the primary address — see that file's header comment on why the
// street line and everything else is deliberately excluded) for a batch of Business Partner
// ids in one query, avoiding an N+1 per candidate pair.
async function loadAISummaries(
  trx: Kysely<DB>,
  businessPartnerIds: string[]
): Promise<Map<string, BusinessPartnerAISummary>> {
  const summaries = new Map<string, BusinessPartnerAISummary>();
  if (businessPartnerIds.length === 0) return summaries;

  const names = await trx
    .selectFrom("business_partners")
    .select(["id", "primary_name"])
    .where("id", "in", businessPartnerIds)
    .execute();

  const addresses = await trx
    .selectFrom("bp_addresses")
    .select(["business_partner_id", "city", "region", "postal_code", "country_code", "is_primary", "created_at"])
    .where("business_partner_id", "in", businessPartnerIds)
    .execute();

  // Same "primary first, then earliest" tie-break as engine.ts's primary_address CTE.
  const bestAddressByBp = new Map<string, (typeof addresses)[number]>();
  for (const addr of addresses) {
    const existing = bestAddressByBp.get(addr.business_partner_id);
    if (!existing) {
      bestAddressByBp.set(addr.business_partner_id, addr);
      continue;
    }
    const existingRank = existing.is_primary ? 0 : 1;
    const addrRank = addr.is_primary ? 0 : 1;
    if (addrRank < existingRank) bestAddressByBp.set(addr.business_partner_id, addr);
  }

  for (const row of names) {
    const addr = bestAddressByBp.get(row.id);
    summaries.set(row.id, {
      primaryName: row.primary_name,
      city: addr?.city ?? null,
      region: addr?.region ?? null,
      postalCode: addr?.postal_code ?? null,
      countryCode: addr?.country_code ?? null,
    });
  }
  return summaries;
}

entityMatchesRouter.post(
  "/v1/projects/:projectId/entity-matches/run",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const projectId = req.params.projectId;

    const result = await withTenant(tenantId, async (trx) => {
      const project = await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!project) return null;

      const candidates = await findAllMatchCandidates(trx, tenantId, projectId);

      // Skip already-decided pairs BEFORE doing any AI work for them, not just before the
      // final write — same cost-ascending spirit as only calling the AI resolver for genuinely
      // ambiguous cases (AGENTS.md §1.6): a pair a steward already decided gets no Gemini call
      // on a re-run, matching the ON CONFLICT ... WHERE guard's existing "never touch a
      // decided pair" rule below.
      const existingDecisions = await trx
        .selectFrom("entity_matches")
        .select(["business_partner_id", "candidate_business_partner_id", "decision"])
        .where("project_id", "=", projectId)
        .execute();
      const decisionByPair = new Map(
        existingDecisions.map((r) => [`${r.business_partner_id}::${r.candidate_business_partner_id}`, r.decision])
      );
      const pending = candidates.filter((c) => {
        const existing = decisionByPair.get(`${c.businessPartnerId}::${c.candidateBusinessPartnerId}`);
        return existing === undefined || existing === "needs_review";
      });
      const skippedAlreadyDecided = candidates.length - pending.length;

      // TQ-039/040's sibling slice: deterministic detectors first (lib/matching/engine.ts),
      // then — only for fuzzy candidates in aiAdjudicator.ts's ambiguous confidence band — a
      // Gemini-assisted second opinion. Most candidates (every exact match, and any fuzzy
      // match already confident) never reach the AI call at all.
      const bpIds = [...new Set(pending.flatMap((c) => [c.businessPartnerId, c.candidateBusinessPartnerId]))];
      const aiSummaries = await loadAISummaries(trx, bpIds);

      let aiAdjudicationCount = 0;
      let aiModelVersion: string | null = null;
      const adjudications = new Map<MatchCandidate, Awaited<ReturnType<typeof resolveAmbiguousMatch>>>();
      await Promise.all(
        pending.filter(isAmbiguousFuzzyMatch).map(async (candidate) => {
          const a = aiSummaries.get(candidate.businessPartnerId);
          const b = aiSummaries.get(candidate.candidateBusinessPartnerId);
          if (!a || !b) return; // shouldn't happen (FK-backed ids), but never crash the run over it
          const adjudication = await resolveAmbiguousMatch(candidate, a, b);
          if (adjudication) {
            aiAdjudicationCount += 1;
            aiModelVersion = adjudication.modelVersion;
          }
          adjudications.set(candidate, adjudication);
        })
      );

      let upserted = 0; // newly inserted OR refreshed while still needs_review
      for (const candidate of pending) {
        const adjudication = adjudications.get(candidate) ?? null;
        // ON CONFLICT ... WHERE decision = 'needs_review': a re-run refreshes evidence/
        // confidence for undecided pairs, but never overwrites a steward's prior Merge/Keep
        // Separate/Reject decision — a second detection pass finding the same pair again
        // must not silently erase a human decision (FR-DUP-005's whole point is that
        // decision, once recorded, sticks until a human changes it).
        await trx
          .insertInto("entity_matches")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            project_id: projectId,
            entity_type: "business_partner",
            business_partner_id: candidate.businessPartnerId,
            candidate_business_partner_id: candidate.candidateBusinessPartnerId,
            match_method: candidate.matchMethod,
            confidence: candidate.confidence,
            evidence: JSON.stringify(candidate.evidence),
            // AI columns (migration 0014) are deliberately separate from `decision` — a
            // recommendation for a steward to review, never auto-applied (AGENTS.md
            // Do-Not-Do rules #1, #3, #4).
            ai_recommendation: adjudication?.recommendation ?? null,
            ai_confidence: adjudication?.confidence ?? null,
            ai_reasoning: adjudication?.reasoning ?? null,
            ai_model_version: adjudication?.modelVersion ?? null,
            updated_at: new Date(),
          })
          .onConflict((oc) =>
            oc
              .columns(["business_partner_id", "candidate_business_partner_id"])
              .doUpdateSet({
                match_method: candidate.matchMethod,
                confidence: candidate.confidence,
                evidence: JSON.stringify(candidate.evidence),
                ai_recommendation: adjudication?.recommendation ?? null,
                ai_confidence: adjudication?.confidence ?? null,
                ai_reasoning: adjudication?.reasoning ?? null,
                ai_model_version: adjudication?.modelVersion ?? null,
                updated_at: new Date(),
              })
              .where("entity_matches.decision", "=", "needs_review")
          )
          .returning("id")
          .executeTakeFirst();
        upserted += 1;
        // Note: a concurrent request could in principle decide this exact pair between the
        // SELECT above and this INSERT, in which case the WHERE guard silently no-ops the
        // UPDATE half — `upserted` would then be one higher than rows actually changed. Left
        // as-is (not distinguished with `.returning("id")` presence-checking, unlike a bare
        // insert) because that race is narrow and the guard itself is what actually matters
        // for correctness: a decided pair's decision can never be silently overwritten,
        // whether or not this counter is off by one in that split-second case.
      }

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: req.user!.userId,
        action: "entity_match.run",
        entityType: "Project",
        entityId: projectId,
        newValue: { candidatesFound: candidates.length, aiAdjudicationCount },
        modelVersion: aiModelVersion,
      });

      return { candidatesFound: candidates.length, newOrRefreshed: upserted, skippedAlreadyDecided };
    });

    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(200).json(result);
  })
);

entityMatchesRouter.get(
  "/v1/projects/:projectId/entity-matches",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const projectId = req.params.projectId;
    const decisionFilter = req.query.decision;

    if (decisionFilter !== undefined && !DECISIONS.includes(decisionFilter as (typeof DECISIONS)[number])) {
      res.status(400).json({ error: `decision must be one of: ${DECISIONS.join(", ")}` });
      return;
    }

    const matches = await withTenant(tenantId, async (trx) => {
      let query = trx
        .selectFrom("entity_matches as em")
        .innerJoin("business_partners as bp", "bp.id", "em.business_partner_id")
        .innerJoin("business_partners as cbp", "cbp.id", "em.candidate_business_partner_id")
        .select([
          "em.id",
          "em.match_method",
          "em.confidence",
          "em.evidence",
          "em.decision",
          "em.decided_by_user_id",
          "em.decided_at",
          "em.created_at",
          "em.business_partner_id",
          "bp.primary_name as business_partner_name",
          "em.candidate_business_partner_id",
          "cbp.primary_name as candidate_business_partner_name",
          // AI adjudication (migration 0014) — see lib/matching/aiAdjudicator.ts. Non-null
          // only for fuzzy candidates that landed in the ambiguous confidence band.
          "em.ai_recommendation",
          "em.ai_confidence",
          "em.ai_reasoning",
          "em.ai_model_version",
        ])
        .where("em.project_id", "=", projectId)
        .orderBy("em.confidence", "desc");
      if (decisionFilter !== undefined) {
        query = query.where("em.decision", "=", decisionFilter as string);
      }
      return query.execute();
    });

    res.status(200).json({ matches });
  })
);

entityMatchesRouter.get(
  "/v1/entity-matches/:id",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const id = req.params.id;

    const match = await withTenant(tenantId, (trx) =>
      trx.selectFrom("entity_matches").selectAll().where("id", "=", id).executeTakeFirst()
    );
    if (!match) {
      res.status(404).json({ error: "Entity match not found" });
      return;
    }

    // Both sides' full context — including linked Supplier "roles" (TQ-037/TQ-038) — so a
    // steward can compare the two candidates without a second round trip per side.
    const [businessPartner, candidateBusinessPartner] = await withTenant(tenantId, async (trx) => {
      async function loadSide(businessPartnerId: string) {
        const bp = await trx
          .selectFrom("business_partners")
          .selectAll()
          .where("id", "=", businessPartnerId)
          .executeTakeFirstOrThrow();
        const [addresses, identifiers, suppliers] = await Promise.all([
          trx.selectFrom("bp_addresses").selectAll().where("business_partner_id", "=", businessPartnerId).execute(),
          trx.selectFrom("bp_identifiers").selectAll().where("business_partner_id", "=", businessPartnerId).execute(),
          trx.selectFrom("suppliers").selectAll().where("business_partner_id", "=", businessPartnerId).execute(),
        ]);
        return { ...bp, addresses, identifiers, suppliers };
      }
      return Promise.all([loadSide(match.business_partner_id), loadSide(match.candidate_business_partner_id)]);
    });

    res.status(200).json({ match, businessPartner, candidateBusinessPartner });
  })
);

const decisionSchema = z.object({ decision: z.enum(DECISIONS) });

// FR-DUP-006 / AGENTS.md Do-Not-Do #3: "Never perform an automatic entity merge (BP,
// Supplier, or Material) without authorization." Every write on this API already requires an
// authenticated actor (requireAuth()) with at least "modify" permission — there is no
// unauthenticated or fully automatic path to this handler at all, which is the first half of
// the guardrail. The second half, specific to this route: recording a MERGE decision (as
// opposed to keep_separate/reject/needs_review) additionally requires "approve" permission,
// not just "modify". This is deliberately stricter than the other three decisions — per
// AGENTS.md §2.4, confidence alone is never authorization (Do-Not-Do #4), and a merge is the
// one decision state that will eventually feed real data mutation once TQ-062's remediation
// engine executes it (Sprint 7) — gating it at the higher permission tier now means that
// door is closed by default from the moment this decision exists, not retrofitted later.
// A STEWARD (view+modify, no approve) attempting to record "merge" is rejected with 403 AND
// the attempt is written to the immutable audit log — not just an app-log warning — so a
// denied merge attempt is itself real, queryable evidence, consistent with AGENTS.md §3.5
// ("privileged and material actions must be audited").
entityMatchesRouter.patch(
  "/v1/entity-matches/:id/decision",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const id = req.params.id;
    const userId = req.user!.userId;
    const { decision } = parsed.data;

    if (decision === "merge" && !roleHasPermission(req.user!.role, "approve")) {
      await withTenant(tenantId, (trx) =>
        recordAuditEvent(trx, {
          tenantId,
          actorUserId: userId,
          action: "entity_match.merge_denied",
          entityType: "EntityMatch",
          entityId: id,
          newValue: { attemptedDecision: "merge", role: req.user!.role },
        })
      );
      res.status(403).json({
        error: `Role "${req.user!.role}" cannot record a "merge" decision — this requires "approve" permission (AGENTS.md Do-Not-Do #3: no unauthorized automatic merges).`,
      });
      return;
    }

    const result = await withTenant(tenantId, async (trx) => {
      const existing = await trx
        .selectFrom("entity_matches")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!existing) return null;

      const updated = await trx
        .updateTable("entity_matches")
        .set({
          decision,
          decided_by_user_id: userId,
          decided_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: userId,
        action: "entity_match.decision_recorded",
        entityType: "EntityMatch",
        entityId: id,
        oldValue: { decision: existing.decision },
        newValue: { decision },
      });

      return updated;
    });

    if (!result) {
      res.status(404).json({ error: "Entity match not found" });
      return;
    }
    res.status(200).json(result);
  })
);
