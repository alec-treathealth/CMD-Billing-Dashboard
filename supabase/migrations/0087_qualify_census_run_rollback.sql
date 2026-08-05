-- 0087 rollback — drop the qualify-census run-log.
--
-- ⚠ CODE ORDER: revert or feature-gate src/collections/qualifyCensusRun.ts (and the
--   /api/cron/qualify-census route's call to runQualifyCensusSyncLogged) BEFORE running this.
--   The logger is written to fail SOFT — a missing table is caught and the sync still runs — so a
--   rollback ahead of the code revert degrades to console-only logging rather than breaking the
--   cron. That is by design, but it silently restores the invisible-failure posture 0087 fixed.
-- ⚠ DATA LOSS: the entire run history is destroyed. It is observability data, not business data —
--   nothing reads it but a human — so this is recoverable in the sense that new rows accrue from
--   the next run onward. Export first if a post-incident timeline matters:
--     select * from collections.qualify_census_run order by started_at desc;

drop table if exists collections.qualify_census_run;
