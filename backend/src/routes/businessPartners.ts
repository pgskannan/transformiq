// Business Partner canonical entity API (TQ-028, FR-BP-001). Sprint 3 scope is the schema +
// basic CRUD proving "BP is modeled as first-class; Address/Identifier/Relationship are 1:N
// child records" — entity resolution/dedup (FR-BP-002), normalization (FR-BP-004), and
// reversible merge (FR-BP-008) are later sprints, not attempted here. See
// db/migrations/0010_business_partners.sql for the full schema rationale, including why this
// is deliberately its own entity rather than a column on a future Supplier table (FR-BP-006).
import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { attachTenant } from "../middleware/tenant";
import { requirePermission } from "../middleware/rbac";
import { withTenant } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";
import { recordAuditEvent } from "../lib/audit";

export const businessPartnersRouter = Router();

const BP_TYPES = ["organization", "person", "unknown"] as const;

const createBpSchema = z.object({
  primaryName: z.string().min(1),
  bpType: z.enum(BP_TYPES).optional(),
  sourceSystem: z.string().optional(),
  externalId: z.string().optional(),
});

businessPartnersRouter.post(
  "/v1/projects/:projectId/business-partners",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = createBpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const projectId = req.params.projectId;
    const userId = req.user!.userId;

    const result = await withTenant(tenantId, async (trx) => {
      const project = await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!project) return null;

      const bp = await trx
        .insertInto("business_partners")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          project_id: projectId,
          primary_name: parsed.data.primaryName,
          bp_type: parsed.data.bpType ?? "unknown",
          source_system: parsed.data.sourceSystem ?? null,
          external_id: parsed.data.externalId ?? null,
          created_by_user_id: userId,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        tenantId,
        actorUserId: userId,
        action: "business_partner.created",
        entityType: "BusinessPartner",
        entityId: bp.id,
        newValue: bp,
      });

      return bp;
    });

    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(201).json(result);
  })
);

businessPartnersRouter.get(
  "/v1/projects/:projectId/business-partners",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const businessPartners = await withTenant(tenantId, (trx) =>
      trx
        .selectFrom("business_partners")
        .selectAll()
        .where("project_id", "=", req.params.projectId)
        .orderBy("created_at", "desc")
        .execute()
    );
    res.status(200).json({ businessPartners });
  })
);

businessPartnersRouter.get(
  "/v1/business-partners/:id",
  requireAuth(),
  attachTenant(),
  requirePermission("view"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const id = req.params.id;

    // Fetched as four independent RLS-scoped queries rather than one join — same "simple
    // and readable over clever" tradeoff as routes/profiling.ts's per-dataset loop; BP child
    // record counts are small at this schema's current scale.
    const businessPartner = await withTenant(tenantId, (trx) =>
      trx.selectFrom("business_partners").selectAll().where("id", "=", id).executeTakeFirst()
    );
    if (!businessPartner) {
      res.status(404).json({ error: "Business partner not found" });
      return;
    }

    const [addresses, identifiers, relationships] = await withTenant(tenantId, async (trx) => {
      const addressRows = await trx
        .selectFrom("bp_addresses")
        .selectAll()
        .where("business_partner_id", "=", id)
        .orderBy("created_at", "asc")
        .execute();
      const identifierRows = await trx
        .selectFrom("bp_identifiers")
        .selectAll()
        .where("business_partner_id", "=", id)
        .orderBy("created_at", "asc")
        .execute();
      const relationshipRows = await trx
        .selectFrom("bp_relationships")
        .selectAll()
        .where("business_partner_id", "=", id)
        .orderBy("created_at", "asc")
        .execute();
      return [addressRows, identifierRows, relationshipRows] as const;
    });

    res.status(200).json({ businessPartner, addresses, identifiers, relationships });
  })
);

const createAddressSchema = z.object({
  addressType: z.string().optional(),
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

businessPartnersRouter.post(
  "/v1/business-partners/:id/addresses",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = createAddressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const businessPartnerId = req.params.id;

    const result = await withTenant(tenantId, async (trx) => {
      const bp = await trx
        .selectFrom("business_partners")
        .select("id")
        .where("id", "=", businessPartnerId)
        .executeTakeFirst();
      if (!bp) return null;

      return trx
        .insertInto("bp_addresses")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          business_partner_id: businessPartnerId,
          address_type: parsed.data.addressType ?? "other",
          line1: parsed.data.line1 ?? null,
          line2: parsed.data.line2 ?? null,
          city: parsed.data.city ?? null,
          region: parsed.data.region ?? null,
          postal_code: parsed.data.postalCode ?? null,
          country_code: parsed.data.countryCode ?? null,
          is_primary: parsed.data.isPrimary ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    if (!result) {
      res.status(404).json({ error: "Business partner not found" });
      return;
    }
    res.status(201).json(result);
  })
);

const createIdentifierSchema = z.object({
  identifierType: z.string().min(1),
  identifierValue: z.string().min(1),
  issuingAuthority: z.string().optional(),
});

businessPartnersRouter.post(
  "/v1/business-partners/:id/identifiers",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = createIdentifierSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const businessPartnerId = req.params.id;

    const result = await withTenant(tenantId, async (trx) => {
      const bp = await trx
        .selectFrom("business_partners")
        .select("id")
        .where("id", "=", businessPartnerId)
        .executeTakeFirst();
      if (!bp) return null;

      return trx
        .insertInto("bp_identifiers")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          business_partner_id: businessPartnerId,
          identifier_type: parsed.data.identifierType,
          identifier_value: parsed.data.identifierValue,
          issuing_authority: parsed.data.issuingAuthority ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    if (!result) {
      res.status(404).json({ error: "Business partner not found" });
      return;
    }
    res.status(201).json(result);
  })
);

const createRelationshipSchema = z.object({
  relatedBusinessPartnerId: z.string().min(1),
  relationshipType: z.string().min(1),
  provenance: z.string().optional(),
});

businessPartnersRouter.post(
  "/v1/business-partners/:id/relationships",
  requireAuth(),
  attachTenant(),
  requirePermission("modify"),
  asyncHandler(async (req, res) => {
    const parsed = createRelationshipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId!;
    const businessPartnerId = req.params.id;
    const { relatedBusinessPartnerId, relationshipType, provenance } = parsed.data;

    if (relatedBusinessPartnerId === businessPartnerId) {
      res.status(400).json({ error: "A business partner cannot have a relationship to itself" });
      return;
    }

    const result = await withTenant(tenantId, async (trx) => {
      const [bp, relatedBp] = await Promise.all([
        trx.selectFrom("business_partners").select("id").where("id", "=", businessPartnerId).executeTakeFirst(),
        trx
          .selectFrom("business_partners")
          .select("id")
          .where("id", "=", relatedBusinessPartnerId)
          .executeTakeFirst(),
      ]);
      if (!bp) return { kind: "source_not_found" as const };
      if (!relatedBp) return { kind: "target_not_found" as const };

      const relationship = await trx
        .insertInto("bp_relationships")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          business_partner_id: businessPartnerId,
          related_business_partner_id: relatedBusinessPartnerId,
          relationship_type: relationshipType,
          provenance: provenance ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return { kind: "ok" as const, relationship };
    });

    if (result.kind === "source_not_found") {
      res.status(404).json({ error: "Business partner not found" });
      return;
    }
    if (result.kind === "target_not_found") {
      // 400, not 404: the *path* resource (businessPartnerId) exists — the problem is a bad
      // reference in the request body, which is a client input error, not a missing-resource
      // one on this endpoint's own URL.
      res.status(400).json({ error: "related business partner not found" });
      return;
    }
    res.status(201).json(result.relationship);
  })
);
