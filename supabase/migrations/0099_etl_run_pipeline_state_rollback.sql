-- Rollback for 0099_etl_run_pipeline_state.sql.
--
-- SAFE TO RUN: nothing outside the pipeline reads these three tables. The five existing cron routes
-- keep working with them dropped — every etl_run write is best-effort and fail-soft on 42P01
-- (undefined_table) precisely so that this rollback, and the window before the migration is applied,
-- cannot take down the production ingest path. See src/collections/etlRun.ts.
--
-- WHAT IT COSTS: every measured stage duration collected so far. That is the entire point of the
-- table, and it is not recoverable from anywhere else — the two explorer stages have no other run
-- log. Export before dropping if the numbers still matter:
--
--   \copy (select * from collections.etl_run) to 'etl_run_backup.csv' csv header
--
-- WHAT IT DOES NOT TOUCH: collections.cmd_census_run and collections.rollup_refresh_run. 0099 never
-- migrated or modified them — they are still written by their own stages, and their history is
-- unaffected either way.
--
-- DISABLE THE PIPELINE FIRST if it was ever enabled: set ETL_PIPELINE_ENABLED=0 (or remove it) and
-- redeploy BEFORE running this. A tick that finds pipeline_state missing fails the tick — loudly,
-- which is correct, but there is no reason to take that failure on purpose.

drop table if exists collections.pipeline_lock;
drop table if exists collections.pipeline_state;
drop table if exists collections.etl_run;

-- Policies and the etl_run_stage_started_idx index are dropped with their tables; no separate
-- statements needed. Grants live on the objects and go with them too.
