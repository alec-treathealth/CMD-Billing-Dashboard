-- 0080 ROLLBACK — remove collections.cmd_explorer_filter_options and restore the 0059
-- refresh function body (rollup only).
--
-- ORDER MATTERS: the function must stop referencing the matview BEFORE the matview drops,
-- otherwise the hourly cron 500s in the gap. Both steps run in one transaction under
-- apply_migration, so the gap never exists on the normal path.
--
-- NOTE: the app-code rewrite that reads this matview (buildCmdPayerOptionsQuery /
-- buildCmdFacilityOptionsQuery) must be reverted in the same deploy window, or the filter
-- dropdowns 500 on the missing relation.

-- 1. Restore the 0059 function body (refreshes only the charge rollup) --------
create or replace function collections.refresh_cmd_explorer_charge_rollup()
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  refresh materialized view concurrently collections.cmd_explorer_charge_rollup;
end;
$$;

revoke all on function collections.refresh_cmd_explorer_charge_rollup() from public;
grant execute on function collections.refresh_cmd_explorer_charge_rollup() to cmd_rollup_writer;

-- 2. Drop the matview (its unique index goes with it) --------------------------
drop materialized view if exists collections.cmd_explorer_filter_options;
