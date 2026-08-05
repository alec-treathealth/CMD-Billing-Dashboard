-- 0084 rollback — drop collections.cmd_explorer_rows.pull_facility_code.
--
-- ⚠ ORDER: 0086 (cmd_facility_resolution) reads this column. Roll back 0086 first, or this DROP
--   fails on the matview dependency (Postgres will refuse; there is no CASCADE here on purpose).
-- ⚠ DATA LOSS: any provenance stamped since the code deploy is dropped and CANNOT be rebuilt for
--   rows whose content is already in the table (ON CONFLICT DO NOTHING means a re-pull will not
--   restamp them). Only future first-seen rows would regain provenance after a re-apply.
-- ⚠ CODE ORDER: revert the Phase-2 ingest code BEFORE running this, or the hourly cron 500s on
--   the missing column.

-- No SET ROLE: postgres owns this table (measured 2026-08-05; see 0084 OWNERSHIP).
alter table collections.cmd_explorer_rows
  drop column if exists pull_facility_code;
