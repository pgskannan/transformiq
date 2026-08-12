// Audit logging (TQ-015, FR-AUD-001/002). Every material/privileged action must produce an
// immutable audit_events row with old/new value, actor, timestamp, and (where applicable)
// rule/model version and approval reference.
//
// Two entry points:
//  - recordAuditEvent(trx, event): call this from WITHIN an existing withTenant() transaction
//    so the audit write is atomic with the mutation it's describing (if one fails, both roll
//    back). This is the one almost every route should use.
//  - recordPlatformAuditEvent(tenantId, event): for the rare platform-level action (e.g.
//    tenant creation) that happens outside any existing tenant-scoped transaction. Opens its
//    own withTenant() scoped to the new/target tenant.
//
// Append-only is enforced at the database level, not just here — see
// db/migrations/0003_least_privilege_app_role.sql, which revokes UPDATE/DELETE on
// audit_events from the runtime application role.

import { randomUUID } from "crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../db/types";
import { withTenant } from "./db";

export interface AuditEventInput {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  ruleVersion?: string | null;
  modelVersion?: string | null;
  approvalRef?: string | null;
}

export async function recordAuditEvent(trx: Kysely<DB>, event: AuditEventInput): Promise<void> {
  await trx
    .insertInto("audit_events")
    .values({
      id: randomUUID(),
      tenant_id: event.tenantId,
      actor_user_id: event.actorUserId ?? null,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId,
      old_value: event.oldValue !== undefined ? JSON.stringify(event.oldValue) : null,
      new_value: event.newValue !== undefined ? JSON.stringify(event.newValue) : null,
      rule_version: event.ruleVersion ?? null,
      model_version: event.modelVersion ?? null,
      approval_ref: event.approvalRef ?? null,
    })
    .execute();
}

export async function recordPlatformAuditEvent(
  tenantId: string,
  event: Omit<AuditEventInput, "tenantId">
): Promise<void> {
  await withTenant(tenantId, (trx) => recordAuditEvent(trx, { ...event, tenantId }));
}
