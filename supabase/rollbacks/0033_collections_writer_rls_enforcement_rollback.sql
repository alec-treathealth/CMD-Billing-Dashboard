-- ROLLBACK for 0033_collections_writer_rls_enforcement.sql
--
-- Restores the pre-0033 PERMISSIVE writer policies (USING true / WITH CHECK true) on the three
-- collections tables — i.e. undoes the enforcement flip, returning to the migration-B state where
-- the writer's tenant safety rests solely on app-layer stamping (no RLS backstop). Reader and admin
-- policies are untouched (0033 never changed them).
--
-- ACTIVE GUARD (the 016/0030 pattern — a comment is not a guard): loosening the writer back to
-- permissive is only safe while the data is single-tenant. Once any non-BXR (Indigo) row exists,
-- removing the GUC WITH CHECK/USING means a buggy or mis-scoped writer could once again INSERT or
-- DELETE across tenants — silently corrupting live multi-tenant data. The rollback therefore RAISES
-- and refuses if any non-BXR row exists in the three tables.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow can ever run
-- a rollback as a forward migration.

-- 0. Guard: refuse to remove multi-tenant write protection on multi-tenant data. -----------------
do $$
declare
  n_foreign integer;
begin
  select
    (select count(*) from collections.cmd_explorer_rows          where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
  + (select count(*) from collections.daily_collections          where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
  + (select count(*) from collections.cmd_payer_facility_monthly where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
    into n_foreign;
  if n_foreign > 0 then
    raise exception
      '0033 rollback BLOCKED: % non-BXR row(s) present — loosening the writer to permissive would drop cross-tenant write protection on live multi-tenant data',
      n_foreign;
  end if;
end $$;

-- 1. cmd_explorer_rows (postgres-owned) → permissive writer INSERT + SELECT. ---------------------
drop policy if exists cmd_explorer_writer_insert on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_insert on collections.cmd_explorer_rows
  for insert to cmd_rollup_writer with check (true);

drop policy if exists cmd_explorer_writer_select on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_select on collections.cmd_explorer_rows
  for select to cmd_rollup_writer using (true);

-- 2. daily_collections (postgres-owned) → permissive writer INSERT + DELETE + SELECT. ------------
drop policy if exists cmd_daily_writer_insert on collections.daily_collections;
create policy cmd_daily_writer_insert on collections.daily_collections
  for insert to cmd_rollup_writer with check (true);

drop policy if exists cmd_daily_writer_delete on collections.daily_collections;
create policy cmd_daily_writer_delete on collections.daily_collections
  for delete to cmd_rollup_writer using (true);

drop policy if exists cmd_daily_writer_select on collections.daily_collections;
create policy cmd_daily_writer_select on collections.daily_collections
  for select to cmd_rollup_writer using (true);

-- 3. cmd_payer_facility_monthly (claims_admin-owned) → permissive writer ALL. --------------------
set role claims_admin;

drop policy if exists cmd_ppfm_writer_write on collections.cmd_payer_facility_monthly;
create policy cmd_ppfm_writer_write on collections.cmd_payer_facility_monthly
  for all to cmd_rollup_writer using (true) with check (true);

reset role;

-- 4. Verification (run manually after rollback) -------------------------------------------------
-- select c.relname, pol.polname, pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
--        pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
--   from pg_policy pol join pg_class c on c.oid=pol.polrelid join pg_namespace n on n.oid=c.relnamespace
--   where n.nspname='collections' and c.relname in ('cmd_explorer_rows','daily_collections','cmd_payer_facility_monthly')
--     and 'cmd_rollup_writer' = any (select r.rolname from pg_roles r where r.oid = any(pol.polroles));
--   → all writer policies back to true / true.
