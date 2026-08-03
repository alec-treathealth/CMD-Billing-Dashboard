-- 0075 ROLLBACK — drop vob.sync_run.
--
-- DESTRUCTIVE: this table is the ONLY per-run history for the Monday VOB sync (vob.sync_state keeps
-- just the latest row), so dropping it discards the trend that exists to prove the items() page-limit
-- fix stays fixed. Export first if the history matters:
--   \copy (select * from vob.sync_run order by ran_at) to 'vob_sync_run.csv' csv header
--
-- Safe to run before the ETL is reverted: the insert in etl/vob/vob_cron_sync.py would then fail the
-- run, so revert that commit FIRST, or the sync errors on its next dispatch.

drop policy if exists vob_sync_run_ro on vob.sync_run;
drop policy if exists vob_sync_run_rw on vob.sync_run;

drop table if exists vob.sync_run;
