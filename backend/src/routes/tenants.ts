// Tenant bootstrap endpoint. Creating a tenant happens outside any existing tenant's RLS
// scope by definition (see ADR 0002: the tenants table itself carries no RLS policy) and
// outside any tenant-scoped role for the same reason — see requirePlatformAdmin() in
// src/middleware/rbac.ts. Sprint 1 left this endpoint open with no auth at all; Sprint 2
// (TQ-011) closes that gap.
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { requirePlatformAdmin } from "../middleware/rbac";
import { recordPlatformAuditEvent } from "../lib/audit";

export const tenantsRouter = Router();

const createTenantSchema = z.object({
  name: z.string().min(1),
});

tenantsRouter.post(
  "/v1/tenants",
  requirePlatformAdmin(),
  asyncHandler(async (req, res) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const id = randomUUID();
    const tenant = await db
      .insertInto("tenants")
      .values({ id, name: parsed.data.name, updated_at: new Date() })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Tenant creation predates any tenant-scoped connection, so this uses the platform
    // variant, which opens its own withTenant() scoped to the tenant just created.
    await recordPlatformAuditEvent(id, {
      action: "tenant.created",
      entityType: "Tenant",
      entityId: id,
      newValue: { name: parsed.data.name },
    });

    res.status(201).json(tenant);
  })
);
