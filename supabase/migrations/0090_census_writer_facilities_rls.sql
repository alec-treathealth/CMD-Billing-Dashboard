-- 0090 — RLS SELECT policy on collections.facilities for cmd_rollup_writer.
--
-- WHY: 0089 granted the writer SELECT on this table and the census conformance alarm STILL reported
--   23 of 23. Proved by running the sync manually against prod after 0089 was applied: the gap
--   persisted, and the new 42501 guard did NOT fire — so the read was not being refused, it was
--   SUCCEEDING AND RETURNING ZERO ROWS.
--
--   collections.facilities has RLS ENABLED with exactly two policies (measured 2026-08-06):
--     collections_admin_all_facilities   -> {claims_admin}  ALL     using (true)
--     collections_reader_select_facilities -> {claims_reader} SELECT using (true)
--   cmd_rollup_writer matches neither, and rolbypassrls = false for it. Under RLS a role with no
--   applicable policy sees an EMPTY TABLE — not an error. So the GRANT satisfied the privilege check
--   and RLS then filtered every row away, silently.
--
-- THE LESSON WORTH KEEPING: a table GRANT and an RLS policy are two independent gates, and only the
--   first one fails loudly. Everything downstream of this read treated "zero rows" as "no
--   care_setting on file", which is why the alarm read 23/23 over a roster that is completely intact.
--
-- WHY MY OWN VERIFICATION MISSED IT: every check behind 0089 ran through the Supabase MCP, which
--   connects as `postgres` — and postgres has rolbypassrls = TRUE. Verifying a per-role visibility
--   problem as a role that bypasses RLS cannot detect it, by construction. To check another role's
--   visibility, query as that role or read pg_policies directly; has_table_privilege() answers the
--   GRANT question ONLY and says nothing about RLS.
--
-- SHAPE: deliberately identical to collections_reader_select_facilities — SELECT, using (true). The
--   facilities table is entity-less reference data (see the tenancy note in 0079), so there is no
--   tenant predicate to enforce here; `true` is the honest qualifier rather than a placeholder.
--   SELECT only: the writer must never mutate the roster, and 0089 granted it no write privilege, so
--   an ALL policy would be both wider than needed and unusable.
--
-- ALTERNATIVE REJECTED: granting BYPASSRLS to cmd_rollup_writer. That would silently widen the role
--   across EVERY RLS-protected table in the cluster — including the tenant-scoped collections tables
--   whose RLS is the enforcement layer that migration 0033 exists to provide. A per-table policy is
--   the least-privilege answer; a role attribute is not.
--
-- PHI: none. Facility-grain reference data (code, name, acronym, care_setting).
--
-- OWNERSHIP: postgres owns collections.facilities, and CREATE POLICY requires table ownership.
--   apply_migration runs as postgres, so the plain statement works. NO `SET ROLE claims_admin` — in
--   this plane that downgrades the applying role and fails 42501 (0084/0085, 2026-08-05).
--
-- DEPENDENCY: 0089 (the GRANT). A policy without the table privilege still yields 42501; both gates
--   must pass. Apply 0089 first — it already is.
--
-- IDEMPOTENT: DROP POLICY IF EXISTS before CREATE — otherwise a re-run raises 42710 (see
--   .claude/rules/sql-migrations.md).
--
-- Rollback: 0090_census_writer_facilities_rls_rollback.sql

drop policy if exists collections_writer_select_facilities on collections.facilities;

create policy collections_writer_select_facilities
  on collections.facilities
  for select
  to cmd_rollup_writer
  using (true);

-- ── Verification (run manually after apply) ─────────────────────────────────────────────────────
--
-- 1. the policy exists and is SELECT-only for the writer
-- select policyname, roles, cmd, qual from pg_policies
--  where schemaname='collections' and tablename='facilities' order by policyname;
--   -- expect three rows; the new one is collections_writer_select_facilities / {cmd_rollup_writer}
--   -- / SELECT / true
--
-- 2. ⚠ DO NOT verify this as `postgres` — it has rolbypassrls and will pass regardless, which is the
--    exact blind spot that let 0089 ship as a complete fix. Verify by RUNNING THE SYNC:
--      node --env-file=.env --import tsx scripts/run-qualify-census.ts
--    and confirming the per-facility conformance lines no longer say
--    "no care_setting on the roster row".
--
-- 3. after the next :22 run, the alarm reports the REAL gaps
-- select id, status, conformance_gap_boards, error_label
--   from collections.qualify_census_run order by id desc limit 1;
--   -- expect conformance_gap_boards to fall 23 -> ~6 (the value-empty Total Auth Days / Next UR
--   -- Date outpatient boards, which are a genuine and actionable OP data-coverage gap).
--   -- Still 23 => the policy did not take. 0 => the assertion stopped asserting: a REGRESSION.
