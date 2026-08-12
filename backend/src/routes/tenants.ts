// Tenant bootstrap endpoint. Creating a tenant happens outside any existing tenant's RLS
// scope by definition (see ADR 0002: the tenants table itself carries no RLS policy).
// Sprint 2 (TQ-011, RBAC) must lock this down to a platform-admin-only operation before any
// real deployment — Sprint 1 leaves it open so the walking skeleton is testable end-to-end.
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";

export const tenantsRouter = Router();

const createTenantSchema = z.object({
  name: z.string().min(1),
});

tenantsRouter.post(
  "/v1/tenants",
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

    res.status(201).json(tenant);
  })
);
