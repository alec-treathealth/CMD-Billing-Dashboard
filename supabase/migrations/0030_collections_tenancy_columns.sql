-- 0030: business_entity_id on collections.daily_collections + cmd_payer_facility_monthly,
--       plus tenant-leading composite indexes on all three collections dashboard tables.
--
-- ══════════════════════════════════════════════════════════════════════════════════════
-- MIGRATION A of the A → B → C collections-tenancy sequence (ADR reopened 2026-07-06;
-- docs/CLAUDE.md §18 amendment + docs/veris-data-notes.md "ADR REOPENED: collections
-- tenancy"). THIS MIGRATION IS SCHEMA-ONLY — IT CHANGES NO POLICY AND NO WRITER BEHAVIOR:
--   A (this file) — columns + BXR backfill + in-migration guards + tenant-leading indexes.
--                   Every existing RLS policy stays permissive (USING(true)/WITH CHECK(true)).
--                   The live BXR cron keeps writing exactly as before (its INSERT column
--                   lists omit business_entity_id → the BXR DEFAULT applies).
--   B (separate)  — the cron writer sets the app.business_entity_id GUC per tenant
--                   (transaction-local set_config), BXR for the existing cron. Deploys and
--                   a REAL BXR cron run must be verified green before C.
--   C (separate)  — the enforcement flip: writer policies become
--                   business_entity_id = current_setting('app.business_entity_id')::uuid.
--                   Applied ONLY after B is live-verified. Never collapse A/B/C.
--
-- WHY: Indigo onboarding onto the collections plane. cmd_explorer_rows already has the
-- column (0028, live, all rows BXR). daily_collections and cmd_payer_facility_monthly do
-- not; they must carry per-row tenancy BEFORE any Indigo collections ingest exists, or
-- BXR/Indigo would commingle irrecoverably (§7 guardrail conditions being built, not bypassed).
--
-- BACKFILL SAFETY (BXR-by-construction, then PROVEN at apply time): the only writers to
-- these two tables are the BXR-only cron (cmd_rollup_writer: CMD_EXPLORER_CUSTOMERS =
-- BXR_CUSTOMERS) and the frozen workbook CLI (claims_admin, BXR workbooks) — Indigo has
-- never been ingested here (live counts: Indigo = 0 everywhere on the collections plane).
-- ADD COLUMN with a NON-VOLATILE constant default is metadata-only in PG11+ and stamps
-- every existing row atomically. The DO-block guards then assert the result (0 NULL,
-- 0 non-BXR) — definitive because the apply path (postgres) has BYPASSRLS — and
-- daily_collections additionally proves provenance BEFORE tagging: every row's source_tag
-- must be in the known BXR-only set ('workbook','cmd'); an unknown tag RAISES (unknown
-- provenance must never be silently tagged BXR). cmd_payer_facility_monthly has no
-- source_tag; its provenance rests on the writer census above (recorded in the notes).
--
-- ON PURPOSE — NOT done here (do not "fix" these in this file):
--   • collections_daily_bucket (the UNIQUE identity index on daily_collections) is NOT
--     recreated with business_entity_id: BOTH live INSERT paths target it via
--     "on conflict (facility_code, source_group_code, payment_date, source_tag)"
--     (src/collections/db.ts:85,164) — a column-list ON CONFLICT must match a unique
--     index EXACTLY, so refolding the index here would error the next cron run.
--     The fold ships WITH the writer change in B (index + ON CONFLICT lists move together).
--   • No RLS/policy changes (that is C, after B is live-verified).
--   • No FK to collections.business_entities: the 0027 registry is committed but NOT
--     applied live; the column stays a soft reference exactly like 0028's (and like the
--     pre-FK staging.* pattern). Reconciling 0027 is a separate deliberate step.
--
-- OWNERSHIP (live census 2026-07-06): daily_collections + cmd_explorer_rows are owned by
-- postgres (plain DDL as the apply role); cmd_payer_facility_monthly is owned by
-- claims_admin → its DDL runs under SET ROLE claims_admin (the standing SET-capable
-- membership; the proven apply pattern on this cluster) with RESET ROLE after.
--
-- INDEXES: plain CREATE INDEX (not CONCURRENTLY — the apply path is transactional and
-- these tables are small: daily_collections ~10^3, cpfm ~10^3, cmd_explorer_rows ~1.4×10^5;
-- sub-second locks). The cmd_explorer_rows index matches the explorer's default keyset
-- order (payment_received DESC NULLS LAST, id DESC) behind the mandatory tenant filter.
--
-- Idempotent: column adds + guards live in conditional DO blocks (a re-run after Indigo
-- data exists skips the add AND the all-BXR guard — which would then be false by design);
-- CREATE INDEX IF NOT EXISTS; comments reapplied unconditionally.
--
-- Rollback: supabase/rollbacks/0030_collections_tenancy_columns_rollback.sql (guarded —
-- refuses to drop tenancy attribution once any non-BXR row exists).
-- ══════════════════════════════════════════════════════════════════════════════════════

-- 1. daily_collections: provenance guard → add column → backfill guard --------------------
do $$
declare
  col_exists boolean;
  bad_tag    integer;
  n_null     integer;
  n_foreign  integer;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'collections'
      and table_name   = 'daily_collections'
      and column_name  = 'business_entity_id'
  ) into col_exists;

  if col_exists then
    raise notice '0030: daily_collections.business_entity_id already exists — skipping add + guards';
  else
    -- Provenance guard BEFORE tagging: every existing row must come from a known
    -- BXR-only source. An unknown source_tag means unknown tenant provenance — RAISE
    -- rather than silently stamping it BXR.
    select count(*) into bad_tag
    from collections.daily_collections
    where source_tag not in ('workbook', 'cmd');
    if bad_tag > 0 then
      raise exception '0030: % daily_collections row(s) carry an unexpected source_tag — unknown provenance; resolve before tagging BXR', bad_tag;
    end if;

    alter table collections.daily_collections
      add column business_entity_id uuid not null
        default 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';  -- BXR Consulting (CMD account 475729)

    -- Post-add guard (definitive: apply path has BYPASSRLS): 0 NULLs, 0 non-BXR.
    select count(*) filter (where business_entity_id is null),
           count(*) filter (where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
      into n_null, n_foreign
    from collections.daily_collections;
    if n_null > 0 or n_foreign > 0 then
      raise exception '0030: daily_collections backfill guard FAILED (null=%, non-BXR=%)', n_null, n_foreign;
    end if;
  end if;
end $$;

comment on column collections.daily_collections.business_entity_id is
  'Tenant owner (BXR/Indigo). DEFAULT BXR so the BXR-only cron (INSERT lists omit this column) auto-tags BXR with no code change; Indigo ingest sets it explicitly. Soft ref to the tenant registry (no FK — matches 0028). NOT yet in collections_daily_bucket: the fold ships with the writer-GUC change (migration-B era) because both live ON CONFLICT targets must move with the index.';

-- 2. cmd_payer_facility_monthly (owner: claims_admin) → add column → backfill guard -------
set role claims_admin;

do $$
declare
  col_exists boolean;
  n_null     integer;
  n_foreign  integer;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'collections'
      and table_name   = 'cmd_payer_facility_monthly'
      and column_name  = 'business_entity_id'
  ) into col_exists;

  if col_exists then
    raise notice '0030: cmd_payer_facility_monthly.business_entity_id already exists — skipping add + guards';
  else
    -- Provenance: no source_tag on this table; BXR-by-construction rests on the writer
    -- census (only the BXR-only cmdPayerRefresh path has ever written it — header note).
    alter table collections.cmd_payer_facility_monthly
      add column business_entity_id uuid not null
        default 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';  -- BXR Consulting (CMD account 475729)

    select count(*) filter (where business_entity_id is null),
           count(*) filter (where business_entity_id <> 'af504ab6-3dcd-4aa4-a93c-27bc58de4088')
      into n_null, n_foreign
    from collections.cmd_payer_facility_monthly;
    if n_null > 0 or n_foreign > 0 then
      raise exception '0030: cmd_payer_facility_monthly backfill guard FAILED (null=%, non-BXR=%)', n_null, n_foreign;
    end if;
  end if;
end $$;

comment on column collections.cmd_payer_facility_monthly.business_entity_id is
  'Tenant owner (BXR/Indigo). DEFAULT BXR (BXR-only writer omits the column); Indigo ingest sets it explicitly. Soft ref to the tenant registry (no FK — matches 0028). The (payer_name, facility_name, service_year, service_month) UNIQUE key gains the tenant column with the writer-GUC change (migration-B era), same coordinated-move rule as daily_collections.';

-- Tenant-leading composite index (cpfm) — created while still claims_admin (owner).
create index if not exists idx_cmd_ppfm_beid_year_month
  on collections.cmd_payer_facility_monthly (business_entity_id, service_year, service_month);

reset role;

-- 3. Tenant-leading composite indexes (postgres-owned tables) -----------------------------
-- daily_collections: the resolved-view readers scan by date window; tenant leads.
create index if not exists idx_daily_collections_beid_date
  on collections.daily_collections (business_entity_id, payment_date);

-- cmd_explorer_rows: 0028 deferred this "until a second tenant's rows exist" — that is now
-- imminent (Indigo load). Matches the explorer grid's default keyset order exactly
-- (WHERE business_entity_id = ANY(...) ORDER BY payment_received DESC NULLS LAST, id DESC).
create index if not exists idx_cmd_explorer_beid_payment_received
  on collections.cmd_explorer_rows (business_entity_id, payment_received desc nulls last, id desc);

-- 4. Verification (run manually after apply) ----------------------------------------------
-- select business_entity_id, count(*) from collections.daily_collections        group by 1;
-- select business_entity_id, count(*) from collections.cmd_payer_facility_monthly group by 1;
--   → each exactly ONE group: af504ab6-3dcd-4aa4-a93c-27bc58de4088 (BXR) = full row count.
-- select indexname from pg_indexes where schemaname='collections'
--   and indexname in ('idx_daily_collections_beid_date','idx_cmd_ppfm_beid_year_month',
--                     'idx_cmd_explorer_beid_payment_received');
--   → 3 rows.
-- select polname, polcmd from pg_policy p join pg_class c on c.oid = p.polrelid
--   where c.relname in ('daily_collections','cmd_payer_facility_monthly','cmd_explorer_rows');
--   → UNCHANGED from the pre-apply census (11 policies, all permissive) — A changes no policy.
