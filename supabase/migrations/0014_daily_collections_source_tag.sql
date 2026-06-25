-- 0014: daily_collections source_tag + resolved view — zero-wipe re-source of the
-- daily deposit series from the consolidated 2026 deposit Sheet (IP/OP tabs).
--
-- WHY: the By-Facility ("By Location") chart reads collections.daily_collections
-- (deposits; gross = checks + EFT). Its values stopped at 2026-06-12 because the
-- legacy per-facility/group workbooks were the source. The consolidated deposit
-- Sheet carries the SAME metric, verified gross = checks + EFT, current through
-- 2026-06-24, plus Dallas (DMH) which the legacy series never had. A read-only diff
-- proved the Sheet is a near-perfect SUPERSET of prod (1815/1902 buckets agree,
-- 0 buckets only-in-prod except one CAMH 2026-01-30 $3,600 check). To honor "switch
-- the source of record WITHOUT wiping history", we COEXIST both sources by lineage
-- and let the reader prefer the Sheet for display — the legacy rows are never
-- deleted (the CAMH 01-30 check is preserved).
--
-- WHAT:
--   1. add source_tag ('workbook' = legacy ingest, 'deposit_sheet' = the new Sheet);
--      existing rows backfill to 'workbook' via the column DEFAULT (no rewrite needed).
--   2. rebuild the bucket unique index to include source_tag so the two sources
--      coexist for the same (facility, group, day) without colliding.
--   3. a resolved VIEW that dedups per (facility_code, payment_date): deposit_sheet
--      wins where both exist; workbook surfaces only where the Sheet has no row for
--      that facility-day. NULL-facility (group-code-lineage) rows pass through
--      unchanged. The three daily readers select from this view so nothing
--      double-counts. security_invoker so the base-table RLS applies as the
--      querying role (claims_reader), exactly as a direct table read would.
--
-- PHI: none. daily_collections is non-PHI (Shape A: facility/date/checks/eft/gross).
-- The view exposes NO source_group_code and NO source_tag — only the aggregate cols.
--
-- §7 lineage lock: deposit_sheet rows carry source_group_code = NULL (every Sheet
-- block is a real facility); TREAT_FRCA / LSMH_DMH remain source_group_code only,
-- untouched here.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS; constraint guarded by a catalog check;
-- DROP INDEX IF EXISTS before CREATE UNIQUE INDEX IF NOT EXISTS; CREATE OR REPLACE
-- VIEW; REVOKE/GRANT reapplied unconditionally. Safe to re-run.
--
-- DEPENDENCY: assumes 0006 (the collections schema, daily_collections, the
-- collections_daily_bucket index, claims_reader/claims_admin) has run.
--
-- ⚠️ PostgREST exposure: the `collections` schema MUST stay OFF Supabase's
-- exposed-schemas list (same posture as the rest of collections / claims).

-- 1. source_tag column (existing rows -> 'workbook' via DEFAULT). --------------
alter table collections.daily_collections
  add column if not exists source_tag text not null default 'workbook';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'daily_collections_source_tag_ck') then
    alter table collections.daily_collections
      add constraint daily_collections_source_tag_ck
      check (source_tag in ('workbook', 'deposit_sheet'));
  end if;
end $$;

-- 2. Rebuild the bucket unique index to include source_tag. -------------------
-- Old: (facility_code, source_group_code, payment_date) NULLS NOT DISTINCT.
-- New: + source_tag, so a 'workbook' row and a 'deposit_sheet' row for the same
-- (facility, group, day) coexist (the reader picks one for display).
drop index if exists collections.collections_daily_bucket;
create unique index if not exists collections_daily_bucket
  on collections.daily_collections (facility_code, source_group_code, payment_date, source_tag)
  nulls not distinct;

-- 3. Resolved view — display precedence (deposit_sheet > workbook per facility-day).
create or replace view collections.daily_collections_resolved
  with (security_invoker = true) as
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount
  from (
    select
      facility_code, payment_date, checks_amount, eft_amount, gross_amount,
      row_number() over (
        partition by facility_code, payment_date
        order by case when source_tag = 'deposit_sheet' then 0 else 1 end, id
      ) as rn
    from collections.daily_collections
    where facility_code is not null
  ) ranked
  where rn = 1
  union all
  -- NULL-facility (group-code-only lineage) rows are not deduped: keep all.
  select facility_code, payment_date, checks_amount, eft_amount, gross_amount
  from collections.daily_collections
  where facility_code is null;

-- 4. Grants — non-PHI; reader gets SELECT on the view (mirrors the base table). --
revoke all on collections.daily_collections_resolved from public, anon, authenticated, service_role;
grant select on collections.daily_collections_resolved to claims_reader;
grant select on collections.daily_collections_resolved to claims_admin;
