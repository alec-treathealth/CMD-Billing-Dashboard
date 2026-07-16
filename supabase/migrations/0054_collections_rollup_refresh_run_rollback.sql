-- Rollback 0054 — drop collections.rollup_refresh_run (index + policies drop with the table) and
-- revoke the additive matview SELECT grant to cmd_rollup_writer, restoring the 0050 grant state
-- ({postgres owner, claims_reader SELECT}). Run the app rollback (remove the refresh route/cron)
-- first or together — nothing else references this table.
drop table if exists collections.rollup_refresh_run;
-- ASSUMES 0054 is the SOLE grantor of this matview SELECT to cmd_rollup_writer: this revokes it outright, so if later work also came to depend on the grant, rolling back 0054 strips it and breaks that work too — re-grant explicitly if so.
revoke select on collections.cmd_explorer_charge_rollup from cmd_rollup_writer;
