-- ROLLBACK for 0088 — drop collections.qualify_facility_census.los_sample.
--
-- ⚠ ROLL THE CODE BACK FIRST. buildQualifyCensusReadQuery (src/collections/qualifyCensus.ts)
--   PROJECTS los_sample, and loadQualifyCensusAuth types it. Dropping the column while the deployed
--   code still selects it makes every Qualify read fail with 42703 (undefined column) — which
--   surfaces as "Couldn't load the book overview" on /qualify, the same user-visible symptom as a
--   dead Server Action. Order: revert the code deploy, confirm the deploy is live, then run this.
--
-- Dropping los_sample loses only the stored sample COUNT. No average is lost (avg_los_days is a
-- separate column) and the next hourly :22 sync recomputes everything from monday regardless, so
-- this is recoverable in one cron tick once 0088 is re-applied.
--
-- OWNERSHIP: postgres — no SET ROLE (see the 0088 header).

alter table collections.qualify_facility_census
  drop column if exists los_sample;

-- verification: the column is gone and auth_sample is untouched
-- select column_name from information_schema.columns
--  where table_schema = 'collections' and table_name = 'qualify_facility_census'
--    and column_name in ('auth_sample', 'los_sample');
--   -- expect exactly one row: auth_sample
