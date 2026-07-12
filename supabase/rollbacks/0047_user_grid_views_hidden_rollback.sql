-- ROLLBACK for 0047_user_grid_views_hidden.sql
--
-- Reverts to the 0046 shape (columns-only, membership = visibility). Drops the 5-arg save_grid_view
-- overload and the hidden_columns column + its check. The original 4-arg save_grid_view was KEPT by
-- 0047 (zero-downtime overload strategy), so it is left in place — no need to recreate it here.
--
-- ⚠️ Revert/redeploy the app FIRST: the new code calls the 5-arg save_grid_view and reads
-- hidden_columns, so a deploy still calling them will error once they're gone. Revert the code (back
-- to the 4-arg saveGridView + no hidden reads), then run this.
--
-- DATA: hidden_columns holds only per-user UI preference (which saved-view columns are hidden).
-- Dropping it reverts every saved view to "all its stored columns visible" (0046 semantics). The
-- stored `columns` arrays are untouched. No source-of-truth or tenant data is affected.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow can ever run
-- a rollback as if it were a forward migration.

grant claims_admin to postgres;

drop function if exists claims.save_grid_view(uuid, text, jsonb, jsonb, boolean);

alter table claims.user_grid_views drop constraint if exists user_grid_views_hidden_arr_ck;
alter table claims.user_grid_views drop column if exists hidden_columns;

revoke claims_admin from postgres;
