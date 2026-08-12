-- Least-privilege runtime role (TQ-015). Closes the gap called out in Sprint 1's README:
-- "the append-only guarantee is only structurally enforced once a dedicated app role exists
-- with UPDATE/DELETE revoked on audit_events." Application code (DATABASE_URL) should
-- connect as this role from here on, not as the migration-running owner role.
--
-- DEV-ONLY PASSWORD: the password set below is a fixed local-dev value, matching the
-- existing "transformiq_dev_only" convention in docker-compose.yml. For any real deployment
-- (Cloud SQL), create this role's credentials via Secret Manager instead — see
-- src/lib/secrets.ts and ADR 0002 — and rotate it outside version control. Never rely on
-- this literal password past local dev.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'transformiq_app') THEN
    CREATE ROLE transformiq_app LOGIN PASSWORD 'transformiq_dev_only';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE transformiq TO transformiq_app;
GRANT USAGE ON SCHEMA public TO transformiq_app;

-- Full CRUD on tenant-scoped operational tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, projects, policies, datasets, dataset_versions
  TO transformiq_app;

-- Append-only on audit_events: SELECT + INSERT, explicitly NOT UPDATE/DELETE. This is the
-- structural enforcement of FR-AUD-001 — even a full SQL injection that gets arbitrary
-- query execution as this role still cannot alter or erase an audit trail.
GRANT SELECT, INSERT ON audit_events TO transformiq_app;
REVOKE UPDATE, DELETE ON audit_events FROM transformiq_app;

-- Any future table created by a migration run as the owner role should default to the same
-- posture (full CRUD) unless a later migration carves out another append-only exception like
-- audit_events above.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO transformiq_app;

-- Sequences aren't used (all PKs are app-generated UUIDs via crypto.randomUUID()), so no
-- sequence grants are needed. If a future migration adds a SERIAL/IDENTITY column, add
-- "GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO transformiq_app" alongside it.
