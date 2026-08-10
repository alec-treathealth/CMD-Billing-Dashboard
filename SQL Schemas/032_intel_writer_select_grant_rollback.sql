-- 032 ROLLBACK — revoke SELECT on intel.payer_policy_finding from intel_writer
--
-- Restores the exact pre-032 posture: intel_writer back to INSERT + UPDATE only.
--
-- ⚠ WHAT THIS BREAKS, ON PURPOSE: running this re-breaks the payer-intel worker.
--   `UPSERT_FINDING_SQL` needs SELECT for its ON CONFLICT and RETURNING clauses, so
--   every finding write returns 42501 again — and 025's preflight will still report
--   all-green, because it only checks INSERT and UPDATE. Do not run this expecting a
--   degraded-but-working pipeline; it is a full stop on persistence, silently green
--   at the gate. Only roll back if the grant itself is judged wrong.
--
-- NEVER `DROP ROLE intel_writer` here (or anywhere) — per
-- .claude/rules/sql-migrations.md the rollback revokes and leaves the role. Other
-- grants (INSERT, UPDATE) and every RLS policy from 025 are left untouched: the
-- `payer_policy_finding_read_all` policy stays in place, since it is 025's and not
-- 032's to remove.
--
-- IDEMPOTENT: unconditional REVOKE. Re-running is a no-op, not an error.
-- OWNERSHIP: unchanged; runs as the owning role, matching the forward migration.

SET ROLE claims_admin;

REVOKE SELECT ON intel.payer_policy_finding FROM intel_writer;

RESET ROLE;

-- Verification (run manually after rollback):
--
--   select grantee, privilege_type
--     from information_schema.table_privileges
--    where table_schema = 'intel' and table_name = 'payer_policy_finding'
--      and grantee = 'intel_writer'
--    order by privilege_type;
--   -- expect exactly: INSERT, UPDATE   (no SELECT)
