-- ROLLBACK for 0046_user_grid_views.sql
--
-- Drops the three write functions and the claims.user_grid_views table (its grants, RLS policies,
-- constraints, and the partial unique index go with the table). No data loss of source truth — this
-- table holds only per-user UI preferences (saved column layouts); dropping it reverts the explorer
-- to the session-only column order (today's DEFAULT_ORDER) for everyone. No effect on any other data.
--
-- NO GUARD needed: single-owner, non-tenant, non-PHI preference data with no downstream dependency.
--
-- ⚠️ Revert/redeploy the app FIRST: listGridViews / saveGridView / setDefaultGridView / deleteGridView
-- reference this table + functions, so a deploy still calling them will error once they're gone.
-- Revert the code, then run this.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow can ever run
-- a rollback as if it were a forward migration.

grant claims_admin to postgres;

drop function if exists claims.save_grid_view(uuid, text, jsonb, boolean);
drop function if exists claims.set_default_grid_view(uuid, text);
drop function if exists claims.delete_grid_view(uuid, text);
drop table if exists claims.user_grid_views;

revoke claims_admin from postgres;
