-- 0031: fold business_entity_id into the collections identity keys —
--       collections_daily_bucket (daily_collections) + the cmd_payer_facility_monthly
--       UNIQUE constraint become tenant-leading. Also grants cmd_rollup_writer the SELECT
--       on cmd_payer_facility_monthly that its tenant/month-scoped DELETE requires (§2).
--
-- ══════════════════════════════════════════════════════════════════════════════════════
-- MIGRATION-B ERA (the writer-GUC bundle; A = 0030, C = the later enforcement flip).
--
-- ⚠️ ORDERING REQUIREMENT — CODE FIRST, THEN THIS FILE. The pre-B writer code targets the
-- old bucket by column list ("on conflict (facility_code, source_group_code, payment_date,
-- source_tag)"), and a column-list ON CONFLICT must match a unique index EXACTLY — so
-- applying this refold under OLD code errors the next cron run. The B writer code is
-- shape-agnostic (targetless ON CONFLICT DO NOTHING for daily_collections; cpfm's writer
-- has no ON CONFLICT at all), so once the B deploy is live this refold is safe in either
-- direction. Apply ONLY after the B code deploy is confirmed live.
--
-- WHY the fold: the identity of a daily bucket / rollup bucket must include the tenant.
-- Without it, two tenants sharing a facility_code/payer×facility×month would collide in
-- the unique key — the second tenant's row would be silently dropped by DO NOTHING (or
-- error on plain INSERT): cross-tenant data loss. Disjoint vocabularies are believed true
-- but are NOT the isolation mechanism.
--
-- WHY tenant-LEADING: S2 convention (composite indexes lead with business_entity_id) —
-- the reader/writer predicates always carry the tenant, so leading with it keeps every
-- scan tenant-pruned.
--
-- Uniqueness-safety: both tables are single-tenant (all BXR) at apply time — verified by
-- 0030's guards + apply-time verification (single BXR group on both tables). Widening a
-- unique key (adding a column) can never introduce a violation on existing rows.
--
-- Idempotent: DO blocks check the live shape (does the key already contain
-- business_entity_id?) and skip if the fold has already happened. Ownership: daily_
-- collections is postgres-owned (plain DDL); cmd_payer_facility_monthly is claims_admin-
-- owned (SET ROLE claims_admin). Tables are small (~2.9k / ~2.2k rows) — index rebuilds
-- are sub-second; plain (non-CONCURRENT) DDL inside the apply transaction is fine.
--
-- Rollback: supabase/rollbacks/0031_collections_tenant_unique_keys_rollback.sql (guarded:
-- restoring the narrower keys with two tenants present could itself violate uniqueness —
-- the rollback RAISES if any non-BXR row exists).
-- ══════════════════════════════════════════════════════════════════════════════════════

-- 1. daily_collections: collections_daily_bucket → tenant-leading -------------------------
do $$
declare
  has_beid boolean;
begin
  -- Has the fold already happened? Match the EXACT target shape, not just "some index named
  -- collections_daily_bucket somewhere mentions business_entity_id": pin the index's schema AND
  -- its table (collections.daily_collections), require it to be UNIQUE, and require
  -- business_entity_id to be the LEADING key column (indkey[0]). A looser probe could false-positive
  -- on an unrelated same-named index and skip the real fold.
  select exists (
    select 1
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace icn on icn.oid = ic.relnamespace
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace tcn on tcn.oid = tc.relnamespace
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where icn.nspname = 'collections'
      and ic.relname = 'collections_daily_bucket'
      and tcn.nspname = 'collections'
      and tc.relname = 'daily_collections'
      and i.indisunique
      and a.attname = 'business_entity_id'
  ) into has_beid;

  if has_beid then
    raise notice '0031: collections_daily_bucket already tenant-leading — skipping';
  else
    drop index if exists collections.collections_daily_bucket;
    create unique index collections_daily_bucket
      on collections.daily_collections
        (business_entity_id, facility_code, source_group_code, payment_date, source_tag)
      nulls not distinct;
  end if;
end $$;

comment on index collections.collections_daily_bucket is
  'Tenant-leading daily identity (0031): one row per (tenant, facility, lineage, day, source). NULLS NOT DISTINCT so the NULL source_group_code of CMD rows still dedups. Writers use targetless ON CONFLICT DO NOTHING (shape-agnostic, migration-B code).';

-- 2. cmd_payer_facility_monthly: UNIQUE constraint → tenant-leading -----------------------
set role claims_admin;

do $$
declare
  has_beid boolean;
begin
  -- Same discipline as the daily probe: pin the schema and require a UNIQUE constraint on
  -- collections.cmd_payer_facility_monthly whose LEADING column (conkey[1], 1-based) is
  -- business_entity_id — the exact post-fold shape, not merely "a unique key that contains it".
  select exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = con.conkey[1]
    where n.nspname = 'collections'
      and c.relname = 'cmd_payer_facility_monthly'
      and con.contype = 'u'
      and a.attname = 'business_entity_id'
  ) into has_beid;

  if has_beid then
    raise notice '0031: cmd_payer_facility_monthly unique key already tenant-leading — skipping';
  else
    alter table collections.cmd_payer_facility_monthly
      drop constraint if exists cmd_payer_facility_monthly_payer_name_facility_name_service_key;
    alter table collections.cmd_payer_facility_monthly
      add constraint cmd_ppfm_beid_payer_facility_month_key
        unique (business_entity_id, payer_name, facility_name, service_year, service_month);
  end if;
end $$;

-- Grant cmd_rollup_writer SELECT on cpfm. Postgres requires SELECT privilege on any column
-- referenced in a DELETE's WHERE clause, and writeRollup (cmdPayerIngest.ts) deletes month
-- buckets scoped by business_entity_id + (service_year, service_month). Migration 0013 granted
-- this role only INSERT + DELETE, so the payer-refresh cron (which writes as cmd_rollup_writer)
-- would fail 42501 the moment it runs. Latent today only because /api/cron/refresh-cmd-payer is
-- not yet scheduled — but B's "payer refresh green" verification exercises exactly this path.
-- Run as claims_admin (the table owner) — this block is already under `set role claims_admin`.
grant select on collections.cmd_payer_facility_monthly to cmd_rollup_writer;

reset role;

-- 3. Verification (run manually after apply) ----------------------------------------------
-- select indexdef from pg_indexes where schemaname='collections'
--   and indexname='collections_daily_bucket';
--   → leads with business_entity_id, UNIQUE, NULLS NOT DISTINCT.
-- select conname from pg_constraint con join pg_class c on c.oid=con.conrelid
--   where c.relname='cmd_payer_facility_monthly' and con.contype='u';
--   → cmd_ppfm_beid_payer_facility_month_key (the old *_service_key gone).
-- Then: verify the NEXT REAL BXR cron run is green (charge insert + daily replace + payer
-- refresh) before migration C is even drafted.
