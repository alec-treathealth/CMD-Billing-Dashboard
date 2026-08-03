-- 025 rollback — drop the intel schema and its three tables
--
-- WHY: reverse 025_payer_policy_intel.sql.
-- PHI DISCIPLINE: no PHI in these objects, so nothing sensitive is exposed or
--   destroyed. But the findings ARE research output that cost real API spend to
--   produce (~$14 per nine-key batch), and they are not reconstructible from any
--   other table — the source pages rot. Export before running this if the data
--   matters. See the export query in section 0.
-- OWNERSHIP: runs as claims_admin, the owner of every object dropped.
-- IDEMPOTENT: DROP ... IF EXISTS throughout; the role is REVOKEd but never
--   dropped, so re-running is safe and cannot orphan grants elsewhere.
-- DEPENDENCY: none.

SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- 0. Export first (run manually BEFORE the drops if the findings matter)
-- ---------------------------------------------------------------------------
--   \copy (SELECT * FROM intel.payer_policy_finding)   TO 'ppf.csv'  CSV HEADER
--   \copy (SELECT * FROM intel.payer_policy_run)       TO 'ppr.csv'  CSV HEADER
--   \copy (SELECT * FROM intel.payer_policy_run_check) TO 'pprc.csv' CSV HEADER

-- ---------------------------------------------------------------------------
-- 1. Revoke before dropping, so the role is left clean
-- ---------------------------------------------------------------------------
-- Guarded: the schema may already be gone if this is a re-run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'intel')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intel_writer') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA intel FROM intel_writer';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA intel FROM intel_writer';
    EXECUTE 'REVOKE USAGE ON SCHEMA intel FROM intel_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'intel') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA intel FROM claims_reader';
    EXECUTE 'REVOKE USAGE ON SCHEMA intel FROM claims_reader';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables — child first, then parents
-- ---------------------------------------------------------------------------
-- Policies and indexes drop with their tables; no separate DROP POLICY needed.

DROP TABLE IF EXISTS intel.payer_policy_run_check;
DROP TABLE IF EXISTS intel.payer_policy_finding;
DROP TABLE IF EXISTS intel.payer_policy_run;

-- ---------------------------------------------------------------------------
-- 3. Schema
-- ---------------------------------------------------------------------------
-- RESTRICT, not CASCADE: if something unexpected still lives in intel, fail loudly
-- rather than silently destroying it.

DROP SCHEMA IF EXISTS intel RESTRICT;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. intel_writer is deliberately NOT dropped
-- ---------------------------------------------------------------------------
-- Standing repo rule: never DROP ROLE in a migration. The role is now grantless
-- and harmless. Drop it by hand, out of band, only after confirming no other
-- object or environment references it:
--   SELECT n.nspname, c.relname FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE has_table_privilege('intel_writer', c.oid, 'INSERT');

-- ---------------------------------------------------------------------------
-- 5. Verification (run manually after apply)
-- ---------------------------------------------------------------------------
-- Expect 0 rows:
--   SELECT nspname FROM pg_namespace WHERE nspname = 'intel';
-- Expect 1 row, and zero privileges anywhere:
--   SELECT rolname FROM pg_roles WHERE rolname = 'intel_writer';
--   SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'intel_writer';
