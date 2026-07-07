-- ROLLBACK for 0032_daily_collections_resolved_tenant.sql
--
-- Reverts collections.daily_collections_resolved to its pre-0032 (0015) shape: drops the
-- trailing business_entity_id column from the view projection and restores the tenant-blind
-- dedup partition (facility_code, payment_date). CREATE OR REPLACE VIEW CANNOT drop a column,
-- so this is a DROP VIEW + CREATE VIEW. There are no dependents (see 0032 header), so no CASCADE
-- is needed and none is used — a dependent appearing later would make the plain DROP fail loudly
-- rather than cascade-destroy, which is the safe outcome.
--
-- ACTIVE GUARD (the 016/0030 pattern — a comment is not a guard): reverting the partition to
-- (facility_code, payment_date) is only safe while the data is single-tenant. Once any non-BXR
-- row exists, that tenant-blind partition would dedup ACROSS tenants — two tenants sharing a
-- (facility_code, payment_date) collapse to one surviving row, silently HIDING a tenant's money.
-- The rollback therefore RAISES and refuses if any non-BXR daily_collections row exists.
--
-- File placement: supabase/rollbacks/ (NOT supabase/migrations/) so no auto-apply flow can ever
-- run a rollback as a forward migration.
--
-- ORDER NOTE: run this ONLY if Artifact B (app-layer WHERE scoping) is NOT deployed — the scoped
-- readers reference the business_entity_id column this restores away and would error without it.
-- (Roll back the app change first, then this.)

-- 0. Guard: refuse to reintroduce tenant-blind dedup on multi-tenant data ------------------
do $$
declare
  dc_foreign integer;
begin
  select count(*) into dc_foreign
  from collections.daily_collections
  where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

  if dc_foreign > 0 then
    raise exception
      '0032 rollback BLOCKED: % non-BXR daily_collections row(s) present — reverting to the (facility_code, payment_date) partition would dedup across tenants and hide a tenant''s rows',
      dc_foreign;
  end if;
end $$;

-- 1. Restore the pre-0032 (0015) view VERBATIM (no business_entity_id; tenant-blind partition) --
drop view if exists collections.daily_collections_resolved;

create view collections.daily_collections_resolved
  with (security_invoker = true) as
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount
  from (
    select
      facility_code, payment_date, checks_amount, eft_amount, gross_amount,
      row_number() over (
        partition by facility_code, payment_date
        order by
          gross_amount desc,                                          -- most-complete record wins
          case when source_tag = 'deposit_sheet' then 0 else 1 end,   -- equal -> prefer the live Sheet
          id                                                          -- deterministic tiebreak
      ) as rn
    from collections.daily_collections
    where facility_code is not null
  ) ranked
  where rn = 1
  union all
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount
  from collections.daily_collections
  where facility_code is null;

-- 2. Reapply grants (identical to 0015) ---------------------------------------------------
revoke all on collections.daily_collections_resolved from public, anon, authenticated, service_role;
grant select on collections.daily_collections_resolved to claims_reader;
grant select on collections.daily_collections_resolved to claims_admin;

-- 3. Verification (run manually after rollback) -------------------------------------------
-- select string_agg(attname, ', ' order by attnum) from pg_attribute
--   where attrelid='collections.daily_collections_resolved'::regclass and attnum>0 and not attisdropped;
--   → facility_code, payment_date, checks_amount, eft_amount, gross_amount   (no business_entity_id)
