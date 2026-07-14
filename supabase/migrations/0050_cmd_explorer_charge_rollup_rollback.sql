-- Rollback for 0050 — drops the refresh function and the charge-grain matview. The base table
-- (cmd_explorer_rows), its grants, and every other read path are untouched; queries pointed at
-- the rollup (the post-0050 cmdExplorerQuery.ts aggregate builders) and the cron's refresh call
-- would fail, so roll the APP back first (or together). The cron treats a failed refresh as
-- non-fatal, so ingest itself keeps working either way. Idempotent.
drop function if exists collections.refresh_cmd_explorer_charge_rollup();
drop materialized view if exists collections.cmd_explorer_charge_rollup;
