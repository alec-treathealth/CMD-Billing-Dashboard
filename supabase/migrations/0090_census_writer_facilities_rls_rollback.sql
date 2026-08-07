-- ROLLBACK for 0090 — drop the writer's RLS SELECT policy on collections.facilities.
--
-- ⚠ THIS RESTORES THE BUG, not a neutral prior state. Without the policy, cmd_rollup_writer's read
--   of collections.facilities succeeds and returns ZERO ROWS (RLS with no applicable policy is
--   silent — it is not an error), the census sync's careSettings map goes empty again, and the
--   conformance alarm returns to a permanent 23-of-23 over an intact roster.
--
-- Worse than the 0089 rollback, because there is no error to notice: the 42501 guard does not fire
-- on an RLS-filtered read. The zero-rows guard added alongside this migration WILL fire and fail the
-- run loudly, which is the intended behaviour and another reason to prefer fixing forward.
--
-- Roll back only if a security review decides cmd_rollup_writer must not see the roster at all — in
-- which case also remove the care_setting assertion from the sync, rather than leaving an assertion
-- that cannot read its input.
--
-- OWNERSHIP: postgres — no SET ROLE (see the 0090 header).

drop policy if exists collections_writer_select_facilities on collections.facilities;

-- Verification: only the original two policies remain
-- select policyname, roles, cmd from pg_policies
--  where schemaname='collections' and tablename='facilities' order by policyname;
--   -- expect exactly collections_admin_all_facilities and collections_reader_select_facilities
