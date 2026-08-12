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
import { findAllMatchCandidates } from "../lib/matching/engine";

export const entityMatchesRouter = Router();

const DECISIONS = ["needs_review", "merge", "keep_separate", "reject"] as const;

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

      let upserted = 0; // newly inserted OR refreshed while still needs_review
      let skippedAlreadyDecided = 0;
      for (const candidate of candidates) {
        // ON CONFLICT ... WHERE decision = 'needs_review': a re-run refreshes evidence/
        // confidence for undecided pairs, but never overwrites a steward's prior Merge/Keep
        // Separate/Reject decision — a second detection pass finding the same pair again
        // must not silently erase a human decision (FR-DUP-005's whole point is that
        // decision, once recorded, sticks until a human changes it).
        const row = await trx
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
            updated_at: new Date(),
          })
          .onConflict((oc) =>
            oc
              .columns(["business_partner_id", "candidate_business_partner_id"])
              .doUpdateSet({
                match_method: candidate.matchMethod,
                confidence: candidate.confidence,
                evidence: JSON.stringify(candidate.evidence),
                updated_at: new Date(),
              })
              .where("entity_matches.decision", "=", "needs_review")
          )
          .returning("id")
          .executeTakeFirst();
        if (row) {
          upserted += 1;
        } else {
          skippedAlreadyDecided += 1; // conflicted but the WHERE guard skipped the update (already decided)
        }
      }

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: req.user!.userId,
        action: "entity_match.run",
        entityType: "Project",
        entityId: projectId,
        newValue: { candidatesFound: candidates.length },
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
