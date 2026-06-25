-- 0012: CMD payer rollup — non-PHI (payer × facility × month) totals.
--
-- WHY: the Master BXR Chart's "By Payer" view needs per-month payer data that the
-- Google-Sheets-derived matview (claims.mv_payer_gap) lacks for recent 2026 months.
-- CollaborateMD (CMD) is the source of truth. Rather than hit the CMD batch API
-- on every page interaction (slow, credential-bound, one-report-at-a-time), the
-- CMD "Derek History Report" is exported to CSV and ingested here
-- (src/collections/cmdPayerIngest.ts).
--
-- PHI DISCIPLINE (docs/CLAUDE.md §2): the source CSV is PER-CHARGE-LINE and
-- PHI-bearing (patient name / member id / group number). The ingest aggregates to
-- PAYER × FACILITY × MONTH totals IN-PROCESS and writes ONLY this non-PHI rollup.
-- No patient-level row ever lands in the database — this table has no patient
-- identifiers by construction (payer_name, facility_name, service dates, and money
-- sums are all in the §8 summary_stats allowlist). The raw CSV stays out of git
-- (data/ is gitignored) and is never logged.
--
-- Idempotency: IF NOT EXISTS on table/indexes; DROP POLICY IF EXISTS before CREATE
-- POLICY; roles created only-if-absent (never DROP ROLE); REVOKE/GRANT reapplied
-- unconditionally. Safe to re-run. The INGEST is itself idempotent (it refreshes
-- only the (service_year, service_month) buckets present in the file).
--
-- DEPENDENCY: assumes 0003 (claims_reader / claims_admin roles) and 0006 (the
-- `collections` schema) have run.
--
-- ⚠️ PostgREST exposure: the `collections` schema MUST stay OFF Supabase's
-- exposed-schemas list (same posture as the rest of `collections` / `claims`).

-- 1. Roles (privilege-only; reuse the claims roles, created only-if-absent). ----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_reader') then
    create role claims_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'claims_admin') then
    create role claims_admin nologin;
  end if;
end $$;

-- 2. Table -------------------------------------------------------------------
-- Grain: one row per (payer_name, facility_name, service_year, service_month),
-- keyed on the charge's service date ("Charge From Date" in the report). A blank
-- payer/facility is stored as '' (empty string), NOT NULL — keeps the unique key
-- clean for ON CONFLICT and avoids NULLS-NOT-DISTINCT subtleties; the reader maps
-- '' back to a null payer label ('(blank)') for display.
create table if not exists collections.cmd_payer_facility_monthly (
  id                 bigint generated always as identity primary key,
  payer_name         text not null,
  facility_name      text not null,
  service_year       smallint not null,
  service_month      smallint not null,
  total_charge       numeric(14,2) not null default 0,
  total_allowed      numeric(14,2) not null default 0,
  total_paid         numeric(14,2) not null default 0,
  charge_line_count  integer not null default 0,
  ingested_at        timestamptz not null default now(),
  unique (payer_name, facility_name, service_year, service_month),
  constraint cmd_ppfm_month_ck  check (service_month between 1 and 12),
  constraint cmd_ppfm_year_ck   check (service_year between 2000 and 2100),
  constraint cmd_ppfm_payer_len_ck    check (char_length(payer_name) <= 200),
  constraint cmd_ppfm_facility_len_ck check (char_length(facility_name) <= 200),
  constraint cmd_ppfm_count_ck  check (charge_line_count >= 0)
);

-- 3. Index -------------------------------------------------------------------
-- The reader filters by (service_year, service_month) and groups by payer; this
-- covers the lookup. The unique constraint above already indexes the full key.
create index if not exists cmd_ppfm_year_month
  on collections.cmd_payer_facility_monthly (service_year, service_month);

-- 4. Grants ------------------------------------------------------------------
-- Strip default/public grants, then grant precisely. Non-PHI table, so the reader
-- gets SELECT; admin (ingest loader) gets full use + the identity sequence.
revoke all on collections.cmd_payer_facility_monthly
  from public, anon, authenticated, service_role;
grant select on collections.cmd_payer_facility_monthly to claims_reader;
grant all    on collections.cmd_payer_facility_monthly to claims_admin;
grant usage, select on all sequences in schema collections to claims_admin;

-- 5. RLS ---------------------------------------------------------------------
alter table collections.cmd_payer_facility_monthly enable row level security;

drop policy if exists cmd_ppfm_reader_select on collections.cmd_payer_facility_monthly;
create policy cmd_ppfm_reader_select on collections.cmd_payer_facility_monthly
  for select to claims_reader using (true);

drop policy if exists cmd_ppfm_admin_all on collections.cmd_payer_facility_monthly;
create policy cmd_ppfm_admin_all on collections.cmd_payer_facility_monthly
  for all to claims_admin using (true) with check (true);
