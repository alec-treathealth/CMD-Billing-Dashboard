-- ROLLBACK for 0031_collections_tenant_unique_keys.sql
--
-- Restores the pre-0031 identity keys: collections_daily_bucket WITHOUT
-- business_entity_id, and cmd_payer_facility_monthly's original
-- (payer_name, facility_name, service_year, service_month) UNIQUE constraint.
--
-- ACTIVE GUARD: with a second tenant's rows present, the NARROWER keys can be violated
-- (two tenants, same facility/day or payer×facility×month) — the restore would either
-- fail mid-DDL or, worse, force manual row deletion. This rollback therefore RAISES if
-- any non-BXR row exists in either table; separate the tenants deliberately first.
--
-- ⚠️ CODE COUPLING: pre-B writer code column-list-targets the OLD bucket, and B writer
-- code is targetless (works with both shapes) — so this rollback is SAFE under B code,
-- but re-deploying PRE-B code additionally requires this rollback to have run first.
-- File placement: supabase/rollbacks/ (never auto-applied as a forward migration).

-- 0. Guard --------------------------------------------------------------------------------
do $$
declare
  dc_foreign   integer;
  cpfm_foreign integer;
begin
  select count(*) into dc_foreign
  from collections.daily_collections
  where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

  select count(*) into cpfm_foreign
  from collections.cmd_payer_facility_monthly
  where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

  if dc_foreign > 0 or cpfm_foreign > 0 then
    raise exception
      '0031 rollback BLOCKED: non-BXR rows exist (daily_collections=%, cmd_payer_facility_monthly=%) — the narrower pre-0031 unique keys could be violated cross-tenant',
      dc_foreign, cpfm_foreign;
  end if;
end $$;

-- 1. daily_collections: restore the pre-0031 bucket (postgres-owned, plain DDL) -----------
drop index if exists collections.collections_daily_bucket;
create unique index collections_daily_bucket
  on collections.daily_collections
    (facility_code, source_group_code, payment_date, source_tag)
  nulls not distinct;

-- 2. cmd_payer_facility_monthly: restore the original UNIQUE constraint -------------------
set role claims_admin;
alter table collections.cmd_payer_facility_monthly
  drop constraint if exists cmd_ppfm_beid_payer_facility_month_key;
alter table collections.cmd_payer_facility_monthly
  add constraint cmd_payer_facility_monthly_payer_name_facility_name_service_key
    unique (payer_name, facility_name, service_year, service_month);
reset role;

-- 3. Verification -------------------------------------------------------------------------
-- select indexdef from pg_indexes where schemaname='collections'
--   and indexname='collections_daily_bucket';
--   → (facility_code, source_group_code, payment_date, source_tag) NULLS NOT DISTINCT.
