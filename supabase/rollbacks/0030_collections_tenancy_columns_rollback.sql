-- ROLLBACK for 0030_collections_tenancy_columns.sql
--
-- Removes exactly what 0030 added: the business_entity_id columns on
-- collections.daily_collections + collections.cmd_payer_facility_monthly, and the three
-- tenant-leading indexes. It does NOT touch cmd_explorer_rows.business_entity_id (that is
-- 0028's, live before 0030) and does NOT touch any policy (0030 changed none).
--
-- ACTIVE GUARD (the 016 pattern — a comment is not a guard): if EITHER table already
-- contains a non-BXR row, rolling back would DESTROY tenant attribution on live
-- multi-tenant data (re-adding the column later would stamp everything BXR again,
-- silently mis-tagging Indigo rows). The rollback therefore RAISES and refuses; separate
-- the tenants first (or accept explicit data loss by deleting the non-BXR rows
-- deliberately) before re-running.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow
-- can ever run a rollback as if it were a forward migration.

-- 0a. Guard: 0031 must be rolled back FIRST -----------------------------------------------
-- 0031 folds business_entity_id INTO collections_daily_bucket and the cmd_payer_facility_monthly
-- UNIQUE key. If those folded keys are still present, the `drop column business_entity_id` below
-- would SILENTLY CASCADE-drop them, destroying the tenant-leading uniqueness (and, for the daily
-- bucket, its dedup entirely). Refuse: run supabase/rollbacks/0031_*_rollback.sql first (it
-- restores the narrower keys), then re-run this file.
do $$
declare
  daily_folded boolean;
  cpfm_folded  boolean;
begin
  select exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace icn on icn.oid = ic.relnamespace
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where icn.nspname = 'collections'
      and ic.relname = 'collections_daily_bucket'
      and a.attname = 'business_entity_id'
  ) into daily_folded;

  select exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any (con.conkey)
    where n.nspname = 'collections'
      and c.relname = 'cmd_payer_facility_monthly'
      and con.contype = 'u'
      and a.attname = 'business_entity_id'
  ) into cpfm_folded;

  if daily_folded or cpfm_folded then
    raise exception
      '0030 rollback BLOCKED: 0031 folded keys still present (daily=%, cpfm=%) — run the 0031 rollback FIRST, then re-run this',
      daily_folded, cpfm_folded;
  end if;
end $$;

-- 0b. Guard: refuse to destroy multi-tenant attribution -----------------------------------
do $$
declare
  dc_foreign   integer := 0;
  cpfm_foreign integer := 0;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='collections' and table_name='daily_collections'
      and column_name='business_entity_id'
  ) then
    execute $q$select count(*) from collections.daily_collections
                where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'$q$
      into dc_foreign;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='collections' and table_name='cmd_payer_facility_monthly'
      and column_name='business_entity_id'
  ) then
    execute $q$select count(*) from collections.cmd_payer_facility_monthly
                where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'$q$
      into cpfm_foreign;
  end if;

  if dc_foreign > 0 or cpfm_foreign > 0 then
    raise exception
      '0030 rollback BLOCKED: non-BXR rows exist (daily_collections=%, cmd_payer_facility_monthly=%) — dropping business_entity_id would destroy tenant attribution',
      dc_foreign, cpfm_foreign;
  end if;
end $$;

-- 1. Indexes ------------------------------------------------------------------------------
-- cmd_explorer_rows + daily_collections are postgres-owned (plain drop as the apply role).
drop index if exists collections.idx_cmd_explorer_beid_payment_received;
drop index if exists collections.idx_daily_collections_beid_date;

-- cmd_payer_facility_monthly is claims_admin-owned.
set role claims_admin;
drop index if exists collections.idx_cmd_ppfm_beid_year_month;

-- 2. Columns ------------------------------------------------------------------------------
alter table collections.cmd_payer_facility_monthly
  drop column if exists business_entity_id;
reset role;

alter table collections.daily_collections
  drop column if exists business_entity_id;

-- 3. Verification (run manually after rollback) -------------------------------------------
-- select column_name from information_schema.columns
--   where table_schema='collections' and column_name='business_entity_id';
--   → exactly ONE row: cmd_explorer_rows (0028's column, untouched).
-- select indexname from pg_indexes where schemaname='collections' and indexname like 'idx_%beid%';
--   → 0 rows.
