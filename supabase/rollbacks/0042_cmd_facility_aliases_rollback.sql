-- ROLLBACK for 0042_cmd_facility_aliases.sql (applied to prod as 0039_cmd_facility_aliases,
-- then renumbered to 0042 — see the forward migration's header note).
--
-- Drops the collections.cmd_facility_aliases crosswalk in full (table + its grants + policies go
-- with it). No data loss of source truth: the table is a derived label→code map; care_setting and
-- facility identity live in collections.facilities (untouched). After rollback the facility filter's
-- care-setting grouping reverts to exact-name matching only — the 12 BXR texts fall back to "Other"
-- (the pre-0039 behavior), which is degraded but not broken (they stay individually selectable).
--
-- ⚠️ Revert/redeploy the app query FIRST: buildCmdFacilityOptionsQuery LEFT JOINs this table, so a
-- deploy still referencing it will error once the table is gone. Revert the code, then run this.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow can run a
-- rollback as if it were a forward migration.

drop table if exists collections.cmd_facility_aliases;
