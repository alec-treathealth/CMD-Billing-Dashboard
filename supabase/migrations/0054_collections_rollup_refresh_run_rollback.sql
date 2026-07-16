-- Rollback 0054 — drop collections.rollup_refresh_run (index + policies drop with the table) and
-- revoke the additive matview SELECT grant to cmd_rollup_writer, restoring the 0050 grant state
-- ({postgres owner, claims_reader SELECT}). Run the app rollback (remove the refresh route/cron)
-- first or together — nothing else references this table.
drop table if exists collections.rollup_refresh_run;
revoke select on collections.cmd_explorer_charge_rollup from cmd_rollup_writer;
