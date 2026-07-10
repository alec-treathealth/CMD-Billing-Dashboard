-- ROLLBACK for 0044_bh_billing_code_intel_rpcs.sql
--
-- Drops the read surfaces added by 0044: the pending-flags view and the
-- get_active_billing_codes function. No tables or data are touched — these are pure
-- read helpers over the 0043 tables.
--
-- ⚠️ Revert/redeploy the app FIRST: the dashboard read routes
-- (app/app/api/code-reference/active, .../pending-flags) call these. Remove/disable
-- those routes before running this, or those reads will error on the missing objects.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/).

drop view if exists code_intel.v_pending_code_change_flags;
drop function if exists code_intel.get_active_billing_codes(text, text, text, date);
