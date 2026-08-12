// Supplier entity API (TQ-037, FR-SUP-001/FR-SUP-002). See
// db/migrations/0012_suppliers.sql for the schema rationale (Supplier is a separate entity
// linked N:1 to BusinessPartner, never a type flag on business_partners).
//
// "Duplicate supplier-to-BP relationships are flagged" (TQ-037 DoD) covers two distinct
// shapes, handled two different ways:
//  - An EXACT duplicate — the same source system handing back the same supplier_number for
//    the same BP twice — is a hard invariant violation, not just a suspicious pattern. It's
//    blocked outright by the DB's own unique constraint (0012's suppliers_bp_source_number_
//    unique) and surfaced as 409 Conflict.
//  - A SOFTER case — this BP already has an active supplier row from the same source system,
//    but with a different (or absent) supplier_number — isn't necessarily wrong (a source
//    system can legitimately reissue a new code), but is worth a steward's attention, so it's
//    flagged in the response rather than blocked.
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { recordAuditEvent } from "../lib/audit";

export const suppliersRouter = Router();

const SUPPLIER_STATUSES = ["active", "inactive", "obsolete"] as const;

const createSupplierSchema = z.object({
  supplierNumber: z.string().optional(),
  sourceSystem: z.string().optional(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
});

/** A Postgres unique_violation on the exact-duplicate constraint from 0012. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

suppliersRouter.post(
  "/v1/business-partners/:id/suppliers",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = createSupplierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const businessPartnerId = req.params.id;
    const userId = req.user!.userId;
    const { supplierNumber, sourceSystem, status } = parsed.data;

    const result = await withTenant(tenantId, async (trx) => {
      const bp = await trx
        .selectFrom("business_partners")
        .select(["id", "project_id"])
        .where("id", "=", businessPartnerId)
        .executeTakeFirst();
      if (!bp) return { kind: "bp_not_found" as const };

      // Soft duplicate check, computed before insert so the warning reflects pre-existing
      // siblings only (not the row we're about to create).
      let duplicateWarning: string | null = null;
      if (sourceSystem) {
        const sibling = await trx
          .selectFrom("suppliers")
          .select("id")
          .where("business_partner_id", "=", businessPartnerId)
          .where("source_system", "=", sourceSystem)
          .executeTakeFirst();
        if (sibling) {
          duplicateWarning = `This BP already has a supplier record from source system "${sourceSystem}" — verify this isn't a duplicate onboarding before treating both as distinct.`;
        }
      }

      let supplier;
      try {
        supplier = await trx
          .insertInto("suppliers")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            project_id: bp.project_id,
            business_partner_id: businessPartnerId,
            supplier_number: supplierNumber ?? null,
            source_system: sourceSystem ?? null,
            status: status ?? "active",
            updated_at: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { kind: "exact_duplicate" as const };
        }
        throw err;
      }

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: userId,
        action: "supplier.created",
        entityType: "Supplier",
        entityId: supplier.id,
        newValue: supplier,
      });

      return { kind: "ok" as const, supplier, duplicateWarning };
    });

    if (result.kind === "bp_not_found") {
      res.status(404).json({ error: "Business partner not found" });
      return;
    }
    if (result.kind === "exact_duplicate") {
      res.status(409).json({
        error:
          "A supplier record with this exact source system and supplier number already exists for this business partner",
      });
      return;
    }
    res.status(201).json({ ...result.supplier, duplicateWarning: result.duplicateWarning });
  })
);

suppliersRouter.get(
  "/v1/business-partners/:id/suppliers",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const businessPartnerId = req.params.id;

    const bp = await withTenant(tenantId, (trx) =>
      trx.selectFrom("business_partners").select("id").where("id", "=", businessPartnerId).executeTakeFirst()
    );
    if (!bp) {
      res.status(404).json({ error: "Business partner not found" });
      return;
    }

    const suppliers = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("suppliers")
        .selectAll()
        .where("business_partner_id", "=", businessPartnerId)
        .orderBy("created_at", "asc")
        .execute()
    );

    // Same soft-duplicate signal as the create path, computed here so a caller listing an
    // existing BP's suppliers sees the flag too, not just at creation time.
    const sourceSystemCounts = new Map<string, number>();
    for (const s of suppliers) {
      if (!s.source_system) continue;
      sourceSystemCounts.set(s.source_system, (sourceSystemCounts.get(s.source_system) ?? 0) + 1);
    }
    const duplicateSourceSystems = [...sourceSystemCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([sourceSystem]) => sourceSystem);

    res.status(200).json({ suppliers, duplicateSourceSystems });
  })
);
