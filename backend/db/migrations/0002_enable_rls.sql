-- Row-Level Security for tenant isolation. See docs/adr/0002-gcp-architecture-and-tenancy.md.
--
-- Every tenant-scoped table gets RLS enabled + a policy that only allows rows where
-- tenant_id matches the current session's app.tenant_id setting. The application sets that
-- setting per-request via backend/src/lib/prisma.ts:withTenant() using `SET LOCAL`.
--
-- audit_events is included here for read isolation, but additionally gets REVOKE'd
-- UPDATE/DELETE from the app role below — audit events must be append-only (FR-AUD-001).

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;

-- Force RLS even for the table owner role (Prisma's migrating role is often the owner;
-- without FORCE, an owner role bypasses RLS by default, which would defeat the point of a
-- cross-tenant-leakage test run as that role).
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "policies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_users ON "users"
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_projects ON "projects"
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_policies ON "policies"
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_audit_events ON "audit_events"
  USING (tenant_id = current_setting('app.tenant_id', true));

-- tenants itself is not tenant-scoped (it IS the tenant), so no RLS policy here — access to
-- it is controlled entirely at the application/RBAC layer.

-- Append-only audit log (FR-AUD-001): the application's runtime DB role must never be able
-- to UPDATE or DELETE audit_events, even if application code has a bug. Sprint 2 (TQ-015)
-- introduces a dedicated least-privilege "transformiq_app" role; until then, this statement
-- is a no-op placeholder documenting the requirement — see README "Known gaps" section.
-- REVOKE UPDATE, DELETE ON "audit_events" FROM transformiq_app;
