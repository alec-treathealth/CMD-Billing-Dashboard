-- ROLLBACK for 0038_cmd_explorer_pct_columns.sql
--
-- Removes exactly what 0038 added: the two GENERATED STORED columns pct_allowed and pct_paid on
-- collections.cmd_explorer_rows. No data loss of source truth — these columns are fully derived
-- from charge_amount / allowed_amount / insurance_payments and are recomputed the instant 0038 is
-- re-applied. No grants, policies, or indexes were added by 0038, so none are reverted here.
--
-- NO GUARD NEEDED (contrast 0030/0031): these are derived, non-key, non-tenant columns. Dropping
-- them destroys no tenant attribution and no uniqueness — unlike business_entity_id, a derived
-- ratio carries no information not already in its source columns. Dropping is a pure table rewrite.
--
-- ⚠️ Any application code that SELECTs pct_allowed / pct_paid (CMD_EXPLORER_SELECT, the grid, the
-- sort allowlist) must be reverted/redeployed BEFORE this runs, or those reads will error on the
-- missing columns. Revert the app first, then run this.
--
-- ⚠️ LOCK / REWRITE: DROP COLUMN on a STORED generated column rewrites the table and holds ACCESS
-- EXCLUSIVE for the duration (~625k rows). Run outside the :30 cron window.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow can ever
-- run a rollback as if it were a forward migration.

alter table collections.cmd_explorer_rows
  drop column if exists pct_allowed,
  drop column if exists pct_paid;
