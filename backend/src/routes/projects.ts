// Project CRUD API v1 (FR-PROJ-001, TQ-017). Still no target-pack association or lifecycle
// status transition rules beyond a free-text status field — those follow later target-pack
// work (Sprint 9+). What's here: create, list, get-by-id, and update, all RLS-enforced and
// RBAC-gated, each mutation recorded as an audit event in the same transaction.
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { recordAuditEvent } from "../lib/audit";

export const projectsRouter = Router();

const createProjectSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  sourceSystem: z.string().min(1),
  targetSystem: z.string().min(1),
  environment: z.string().default("dev"),
  milestone: z.string().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  milestone: z.string().nullable().optional(),
  status: z.string().min(1).optional(),
});

projectsRouter.post(
  "/v1/projects",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const ownerUserId = req.user!.userId;
    const id = randomUUID();

    const project = await withTenant(tenantId, async (trx) => {
      const created = await trx
        .insertInto("projects")
        .values({
          id,
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
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: req.user!.userId,
        action: "project.created",
        entityType: "Project",
        entityId: id,
        newValue: created,
      });

      return created;
    });

    res.status(201).json(project);
  })
);

projectsRouter.get(
  "/v1/projects",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const projects = await withTenant(tenantId, (trx) =>
      trx.selectFrom("projects").selectAll().orderBy("created_at", "desc").execute()
    );
    res.status(200).json({ projects });
  })
);

projectsRouter.get(
  "/v1/projects/:id",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    // Scoped through withTenant()/RLS — a project ID belonging to another tenant simply
    // does not exist from this connection's point of view. This is the property the
    // cross-tenant IDOR test in src/__tests__/tenant-isolation.test.ts exercises directly.
    const project = await withTenant(tenantId, (trx) =>
      trx.selectFrom("projects").selectAll().where("id", "=", req.params.id).executeTakeFirst()
    );
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(200).json(project);
  })
);

projectsRouter.patch(
  "/v1/projects/:id",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    const tenantId = req.tenantId!;

    const result = await withTenant(tenantId, async (trx) => {
      const before = await trx
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!before) return null;

      const after = await trx
        .updateTable("projects")
        .set({ ...parsed.data, updated_at: new Date() })
        .where("id", "=", req.params.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: req.user!.userId,
        action: "project.updated",
        entityType: "Project",
        entityId: req.params.id,
        oldValue: before,
        newValue: after,
      });

      return after;
    });

    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(200).json(result);
  })
);
