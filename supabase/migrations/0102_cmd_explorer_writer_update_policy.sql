-- 0102_cmd_explorer_writer_update_policy.sql
--
-- WHY: 0101 granted `update (employer_name)` on collections.cmd_explorer_rows to
-- cmd_rollup_writer so the one-shot employer backfill could fill 650,719 existing rows. That grant
-- is INERT. Measured live immediately after applying 0101 (2026-08-15):
--
--   · RLS is ENABLED on collections.cmd_explorer_rows (relrowsecurity = true)
--   · cmd_rollup_writer has rolbypassrls = FALSE
--   · the table carries exactly THREE policies — cmd_explorer_writer_insert (INSERT),
--     cmd_explorer_writer_select (SELECT), cmd_explorer_reader_select (SELECT).
--     THERE IS NO UPDATE POLICY.
--
-- Under RLS, a role with no applicable policy for a command does not get an error — it matches
-- ZERO ROWS. So the backfill would have run to completion, reported "0 rows updated", and looked
-- exactly like the normalization mismatch its own dry-run documentation warns about. The real
-- cause would have been a missing policy, and the search would have started in the wrong place.
--
-- This is the 0089/0090 incident repeating: 0089 granted SELECT on collections.facilities and the
-- census conformance alarm still read `23 of 23`, because the writer matched no RLS policy and the
-- filtered-empty read raised nothing. 0090 added the policy. `.claude/rules/sql-migrations.md`
-- states the rule this migration exists to satisfy: **a GRANT is only half the gate.**
--
-- ⚠ WHY THIS IS 0102 AND NOT AN EDIT TO 0101: 0101 is APPLIED LIVE. Applied migrations are never
-- edited in place — the ledger and the deployed schema would disagree with the file.
--
-- PHI DISCIPLINE: no PHI. This grants no new column reach — 0101's column-scoped
-- `update (employer_name)` still bounds WHAT may be written; this bounds WHICH ROWS. Verified at
-- apply: the writer still cannot UPDATE charge_amount, row_fingerprint, or any encrypted PHI column.
--
-- OWNERSHIP: collections plane is owned by `postgres`. Do NOT add `set role claims_admin` — it
-- downgrades the applying role to non-owner and fails 42501 (0084/0085 both hit this).
--
-- IDEMPOTENT: DROP POLICY IF EXISTS before CREATE (a bare CREATE raises 42710 on re-run).
--
-- DEPENDENCY: 0101 (the employer_name column and its column-scoped UPDATE grant).
-- Rollback: 0102_cmd_explorer_writer_update_policy_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. The UPDATE policy
-- ---------------------------------------------------------------------------
-- Shape MIRRORS the existing cmd_explorer_writer_insert policy exactly — the same
-- transaction-local GUC that withTenant() sets — so the tenant boundary is enforced identically on
-- every write path rather than by two different rules that can drift.
--
-- BOTH clauses are required and they do different jobs:
--   · USING      — which existing rows this role may see as update candidates. Without it the
--                  backfill matches nothing (the bug this migration fixes).
--   · WITH CHECK — what a row is allowed to BECOME. Without it the writer could move a row to a
--                  DIFFERENT tenant by rewriting business_entity_id. The column-scoped grant from
--                  0101 already makes that impossible today (employer_name is the only writable
--                  column), but the two protections are independent and the grant could later be
--                  widened by someone who never reads this file.
drop policy if exists cmd_explorer_writer_update on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_update on collections.cmd_explorer_rows
  for update
  to cmd_rollup_writer
  using (business_entity_id = (current_setting('app.business_entity_id'::text))::uuid)
  with check (business_entity_id = (current_setting('app.business_entity_id'::text))::uuid);

-- ---------------------------------------------------------------------------
-- 2. Verification (run manually after apply)
-- ---------------------------------------------------------------------------
-- ⚠ THE ROW-VISIBILITY HALF CANNOT BE VERIFIED AS `postgres` — it has rolbypassrls = true, so it
-- sees every row regardless of policy and is blind to this entire class by construction. Check the
-- CATALOG, and confirm the real behaviour from the backfill's own dry-run/commit counts.
--
-- select policyname, cmd, roles::text from pg_policies
--  where schemaname='collections' and tablename='cmd_explorer_rows' order by cmd, policyname;
--   -> expect FOUR policies now, including cmd_explorer_writer_update (UPDATE, {cmd_rollup_writer})
--
-- -- the column bound from 0101 must be UNCHANGED by this migration:
-- select has_column_privilege('cmd_rollup_writer','collections.cmd_explorer_rows','employer_name','UPDATE')     as must_be_true,
--        has_column_privilege('cmd_rollup_writer','collections.cmd_explorer_rows','row_fingerprint','UPDATE')   as must_be_false,
--        has_column_privilege('cmd_rollup_writer','collections.cmd_explorer_rows','charge_amount','UPDATE')     as must_be_false,
--        has_column_privilege('cmd_rollup_writer','collections.cmd_explorer_rows','patient_name','UPDATE')      as must_be_false;
