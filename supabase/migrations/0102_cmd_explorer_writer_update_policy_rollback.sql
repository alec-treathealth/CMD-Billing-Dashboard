-- 0102_cmd_explorer_writer_update_policy_rollback.sql — reverses 0102. Apply as `postgres`.
--
-- Dropping this policy returns collections.cmd_explorer_rows to the state 0101 left it in: the
-- writer keeps its column-scoped `update (employer_name)` grant, but RLS matches no rows for
-- UPDATE, so every write silently affects ZERO rows.
--
-- ⚠ THAT FAILURE IS SILENT. It raises nothing and returns success. If the employer backfill is
-- ever re-run after this rollback it will report "0 rows updated" and read as a data problem
-- rather than a permissions one. Do not run this while a backfill is pending.
--
-- Safe to run once the one-shot backfill has completed and been verified — at that point the
-- hourly cron does NOT need UPDATE (it is INSERT ... ON CONFLICT DO NOTHING and never updates), so
-- dropping both this policy and 0101's grant removes standing write privilege with no live caller.
-- Revoke the grant too if you take that path:
--   revoke update (employer_name) on collections.cmd_explorer_rows from cmd_rollup_writer;

drop policy if exists cmd_explorer_writer_update on collections.cmd_explorer_rows;
