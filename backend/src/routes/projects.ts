// Walking-skeleton project routes — proves the requireAuth → attachTenant → withTenant
// chain works end-to-end (RLS-enforced create + list). This is NOT the full Project CRUD
// API (FR-PROJ-001, TQ-017 in Sprint 2) — no PATCH, no target-pack association, no
// lifecycle status transitions yet. Treat this as groundwork Sprint 2 formalizes.
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";

export const projectsRouter = Router();

const createProjectSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  sourceSystem: z.string().min(1),
  targetSystem: z.string().min(1),
  environment: z.string().default("dev"),
  milestone: z.string().optional(),
});

projectsRouter.post(
  "/v1/projects",
  requireAuth(),
  attachTenant(),
  asyncHandler(async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const ownerUserId = req.user!.userId;

    const project = await withTenant(tenantId, (trx) =>
      trx
        .insertInto("projects")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          name: parsed.data.name,
          domain: parsed.data.domain,
          source_system: parsed.data.sourceSystem,
          target_system: parsed.data.targetSystem,
          owner_user_id: ownerUserId,
          environment: parsed.data.environment,
          milestone: parsed.data.milestone,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    );

    res.status(201).json(project);
  })
);

projectsRouter.get(
  "/v1/projects",
  requireAuth(),
  attachTenant(),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const projects = await withTenant(tenantId, (trx) =>
      trx.selectFrom("projects").selectAll().orderBy("created_at", "desc").execute()
    );
    res.status(200).json({ projects });
  })
);
