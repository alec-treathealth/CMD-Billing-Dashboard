-- 0006: Phase 6 — Collections Reports → new `collections` schema.
--
-- Migrates the Google Drive "Collections Reports" folder (owner
-- catherine@bxrconsulting.com) into project dbpabchpvipipkzkogta as a dedicated
-- `collections` schema, mirroring the Phase 1–2 claims compliance pattern
-- EXACTLY: a verbatim raw landing table the reader cannot see, typed shape
-- tables, RLS on everything, two least-privilege roles (reused, never
-- reinvented), and PHI confined to columns that the UI masks.
--
-- DEPENDENCY: this migration assumes 0003 has run — it relies on the `claims`
-- schema's roles (claims_reader / claims_admin) and on pg_trgm having been moved
-- INTO the `claims` schema by 0003. The trigram indexes below therefore
-- reference the opclass as `claims.gin_trgm_ops` (this migration runs as
-- `postgres`, whose search_path does not include `claims`, so the opclass must
-- be schema-qualified or CREATE INDEX fails to resolve it).
--
-- PHI lives in collections.payment_lines (patient_name/last/first, member_id_*)
-- and collections.negotiation_worklist (client_name). Same handling as claims
-- PHI: never logged, never in an LLM prompt, never in summary_stats, masked in
-- the UI, reachable only via the authenticated PHI path.
--
-- ⚠️ PostgREST exposure: the `collections` schema MUST NOT be added to Supabase's
-- exposed-schemas list (Settings → API → "Exposed schemas"). New schemas are
-- unexposed by default; this is a call-out to keep it that way, exactly like
-- `claims`, so PHI is never reachable over the REST API.
--
-- Idempotency: IF NOT EXISTS on schema/tables/indexes; DROP POLICY IF EXISTS
-- before CREATE POLICY; roles created only-if-absent (never DROP ROLE — that
-- would destroy the out-of-band LOGIN credential); every REVOKE/GRANT reapplied
-- unconditionally. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- Facility model (IMPORTANT — group codes are NOT facilities):
--   * collections.facilities holds ONLY real facilities. Row-level facility_code
--     (on the typed tables) is a REAL facility code or NULL when not safely
--     inferable from the row data — it is NEVER a workbook group code.
--   * The two-facility workbooks ("Treat and FRCA", "LSMH and DMH") carry their
--     workbook identity as source_group_code (TREAT_FRCA / LSMH_DMH) on the raw +
--     typed rows (lineage only). A group row is resolved to a real facility_code
--     when the row data identifies the entity (e.g. the Treat state); otherwise
--     facility_code stays NULL. We do NOT invent TREAT_FRCA / LSMH_DMH facilities.
--   * The LARGE typed tables carry facility_code as the row-level key and NO name/
--     account_number column — join to collections.facilities when a display name
--     or account number is needed.
--
--   Real facilities seeded into collections.facilities (facility_code -> name #acct):
--     Single-facility sheets:
--       CAMH -> CA MENTAL HEALTH (California Mental Health)  (#10027973)
--       TBH  -> TENNESSEE BEHAVIORAL HEALTH       (#10029105)
--       PCMH -> PACIFIC COAST MENTAL HEALTH LLC   (#10030471)
--       LAMH -> LOS ANGELES MENTAL HEALTH         (#10033690)
--       NASH -> NASHVILLE MENTAL HEALTH LLC       (#10030911)
--       KWC  -> KENTUCKY WELLNESS CENTER          (#10034908)
--     Real facilities inside the two group workbooks (assigned per-row when the
--     row identifies the entity):
--       FRCA     -> FIRST RESPONDERS OF CALIFORNIA LLC  (#10032340)   [Treat and FRCA]
--       LSMH     -> LONESTAR MENTAL HEALTH LLC          (#10031977)   [LSMH and DMH]
--       DMH      -> DALLAS MENTAL HEALTH LLC            (#10033950)   [LSMH and DMH]
--       TREAT_CA -> TREAT MENTAL HEALTH CALIFORNIA      (#10030101)   [Treat and FRCA]
--       TREAT_NV -> TREAT MENTAL HEALTH NEVADA          (#10034671)
--       TREAT_TN -> TREAT MENTAL HEALTH TENNESSEE       (#10029905)
--       TREAT_TX -> TREAT MENTAL HEALTH TEXAS           (#10029722)
--       TREAT_WA -> TREAT MENTAL HEALTH WASHINGTON LLC  (#10031212)
--
--   Workbook group codes (lineage only — NOT facilities, NOT seeded):
--       TREAT_FRCA  = "Treat and FRCA Collections 2026"
--       LSMH_DMH    = "LSMH and DMH Collections 2026"
--
--   Other accounts (preserved for future mapping; NOT in Phase 6 primary sheets):
--     BILLING SERVICE ACCOUNT (#10030472), LONESTAR/LOS ANGELES/etc. above,
--     TEEN MENTAL HEALTH TEXAS (#10035166), TELEHEALTH MH (#10034666),
--     WELLNESS RECOVERY CENTER LLC (#10033951).
-- ---------------------------------------------------------------------------

-- 1. Schema -----------------------------------------------------------------
create schema if not exists collections;

-- 2. Roles (privilege-only; reuse the claims roles, LOGIN + password out of band).
--    Created only-if-absent so a standalone re-run can't error; 0003 normally
--    created them already. Never DROP ROLE.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_reader') then
    create role claims_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'claims_admin') then
    create role claims_admin nologin;
  end if;
end $$;

-- 3. Tables ------------------------------------------------------------------

-- 3a. Verbatim raw landing (reader has NO access). One row per source sheet row.
--     Idempotency identity = (source_file_id, source_tab, source_row_num).
create table if not exists collections.collections_raw (
  id              bigint generated always as identity primary key,
  source_file_id  text not null,
  source_tab      text not null,
  source_row_num  integer not null,
  shape           text not null,          -- daily | payment_line | rollup | negotiation
  source_group_code text,                  -- workbook group code (TREAT_FRCA / LSMH_DMH) or NULL; lineage only
  facility_code   text,                    -- resolved REAL facility code, or NULL/UNKNOWN; NEVER a group code
  ingested_at     timestamptz not null default now(),
  raw             jsonb not null,
  unique (source_file_id, source_tab, source_row_num),
  -- Refinement: constrain shape (defense in depth, mirrors query_log.function_name).
  constraint collections_raw_shape_ck check (
    shape in ('daily', 'payment_line', 'rollup', 'negotiation')
  )
);

-- 3b. SHAPE A — non-PHI daily roll-ups. gross = checks + eft (validated, Finding G).
--     facility_code is a REAL facility code or NULL (group-workbook dailies usually
--     report a combined total that can't be assigned to one real facility, so they
--     carry source_group_code and a NULL facility_code). The daily "bucket" is one
--     row per (facility_code, source_group_code, payment_date) — see the unique
--     index in section 4 (NULLS NOT DISTINCT so a group workbook's NULL-facility
--     dailies still dedupe). A second distinct raw row hitting the same bucket is a
--     data-quality collision the ingest routes to the failed report, never a crash.
--     Join to collections.facilities for a display name when facility_code is set.
create table if not exists collections.daily_collections (
  id                bigint generated always as identity primary key,
  collections_raw_id bigint not null references collections.collections_raw(id),
  facility_code     text,                  -- REAL facility code or NULL; join to facilities for name
  source_group_code text,                  -- TREAT_FRCA / LSMH_DMH or NULL; lineage only
  payment_date      date not null,
  checks_amount     numeric(14,2) not null default 0,
  eft_amount        numeric(14,2) not null default 0,
  gross_amount      numeric(14,2) not null default 0,
  created_at        timestamptz not null default now(),
  -- Refinement: one typed row per raw row (DB-enforced idempotency).
  unique (collections_raw_id)
);

-- 3c. SHAPE B — PHI payment/remittance lines. Columns mapped BY HEADER NAME.
--     service_date NULL when the file has no "Charge From Date" column (Finding A).
--     recon_ok / paid_gt_allowed are SOFT FLAGS the ingest computes — they NEVER
--     gate row acceptance (Finding D).
create table if not exists collections.payment_lines (
  id                bigint generated always as identity primary key,
  collections_raw_id bigint not null references collections.collections_raw(id),
  facility_code     text,                 -- REAL facility code or NULL; join to facilities for name
  source_group_code text,                 -- TREAT_FRCA / LSMH_DMH or NULL; lineage only
  service_date      date,                 -- "Charge From Date" (NULL when absent)
  payment_date      date,                 -- "Charge Primary Payment Date"
  cpt_code          text,                 -- "Charge CPT Code"
  revenue_code      text,                 -- "CPT Default Rev Code"
  patient_name      text,                 -- PHI: "Patient Full Name" (LAST, FIRST), verbatim
  patient_last      text,                 -- PHI: split on FIRST comma
  patient_first     text,                 -- PHI
  member_id_raw     text,                 -- PHI: "Claim Primary Member ID", verbatim
  member_id_norm    text,                 -- PHI: trim/upper/strip-internal-ws/strip-leading '-'
  group_number      text,                 -- "Primary Group Number"
  charge_amount     numeric(12,2),        -- "Charge/Debit Amount"
  allowed_amount    numeric(12,2),        -- "Payment Allowed Amount"
  insurance_paid    numeric(12,2),        -- "Charge Insurance Payments"
  adjustment        numeric(12,2),        -- "Charge Total Adjustments w/o Transfers"
  balance_due_pt    numeric(12,2),        -- "Charge Balance Due Pat"
  payer_name        text,                 -- "Charge Primary Payer Name"
  recon_ok          boolean,              -- soft: |allowed + adjustment - charge| <= 0.05
  paid_gt_allowed   boolean,              -- soft: insurance_paid > allowed_amount
  collection_rate   numeric(6,4) generated always as (
    case when allowed_amount is not null and allowed_amount <> 0
         then insurance_paid / allowed_amount end
  ) stored,
  created_at        timestamptz not null default now(),
  -- Refinement: one typed row per raw row (DB-enforced idempotency). NO unique on
  -- business columns — repeated identical billing lines are legitimate.
  unique (collections_raw_id)
);

-- 3d. SHAPE D — negotiation / TPP worklist. Small, self-contained, has its OWN
--     Facility column. client_name is PHI ("First Last", verbatim, NOT split).
create table if not exists collections.negotiation_worklist (
  id                bigint generated always as identity primary key,
  collections_raw_id bigint not null references collections.collections_raw(id),
  facility_code     text,                 -- from the row's own Facility column (REAL code or NULL)
  source_group_code text,                 -- TREAT_FRCA / LSMH_DMH or NULL; lineage only
  client_name       text,                 -- PHI: "First Last", verbatim, do NOT split
  insurance         text,
  alpha_prefix      text,
  homeplan_state    text,
  billed_amount     numeric(12,2),
  allowed_amount    numeric(12,2),
  negotiated_pct    numeric(6,4),         -- strip '%', /100 when '%' present, else as-is
  tpp               text,                 -- Zelis / Multiplan
  created_at        timestamptz not null default now(),
  -- Refinement: one typed row per raw row (DB-enforced idempotency).
  unique (collections_raw_id)
);

-- 3e. SHAPE C — Report-for-Kelly billed/allowed rollups: land verbatim only.
create table if not exists collections.rollup_snapshots (
  id                bigint generated always as identity primary key,
  collections_raw_id bigint not null references collections.collections_raw(id),
  source_file_id    text not null,
  grain             text,                 -- 'facility' | 'payer'
  raw               jsonb not null,
  created_at        timestamptz not null default now(),
  -- Refinement: one typed row per raw row (DB-enforced idempotency).
  unique (collections_raw_id)
);

-- 3f. Reference table — REAL facilities only (no workbook group codes). facility_code
--     is the row-level key used by the typed tables; join here when a display name /
--     account number is needed. The typed tables do NOT FK to this table: negotiation
--     rows derive facility_code from their own free-form Facility column, and group
--     workbook rows may be NULL when the entity can't be inferred — neither should
--     break ingest with an FK violation.
create table if not exists collections.facilities (
  facility_code     text primary key,
  facility_name     text not null,
  account_number    text,
  notes             text
);

-- Idempotent seed (Phase 6 REAL facility map). Re-run refreshes name/account but
-- preserves any manually-added notes. Group codes (TREAT_FRCA, LSMH_DMH) are NOT
-- facilities and are deliberately absent.
insert into collections.facilities (facility_code, facility_name, account_number)
values
  ('CAMH',     'CA MENTAL HEALTH',                 '10027973'),
  ('TBH',      'TENNESSEE BEHAVIORAL HEALTH',      '10029105'),
  ('PCMH',     'PACIFIC COAST MENTAL HEALTH LLC',  '10030471'),
  ('LAMH',     'LOS ANGELES MENTAL HEALTH',        '10033690'),
  ('NASH',     'NASHVILLE MENTAL HEALTH LLC',      '10030911'),
  ('KWC',      'KENTUCKY WELLNESS CENTER',         '10034908'),
  ('FRCA',     'FIRST RESPONDERS OF CALIFORNIA LLC', '10032340'),
  ('LSMH',     'LONESTAR MENTAL HEALTH LLC',       '10031977'),
  ('DMH',      'DALLAS MENTAL HEALTH LLC',         '10033950'),
  ('TREAT_CA', 'TREAT MENTAL HEALTH CALIFORNIA',   '10030101'),
  ('TREAT_NV', 'TREAT MENTAL HEALTH NEVADA',       '10034671'),
  ('TREAT_TN', 'TREAT MENTAL HEALTH TENNESSEE',    '10029905'),
  ('TREAT_TX', 'TREAT MENTAL HEALTH TEXAS',        '10029722'),
  ('TREAT_WA', 'TREAT MENTAL HEALTH WASHINGTON LLC', '10031212')
on conflict (facility_code) do update set
  facility_name  = excluded.facility_name,
  account_number = excluded.account_number;

-- 4. Indexes -----------------------------------------------------------------
-- Trigram opclass is in the `claims` schema (0003 moved pg_trgm) → qualify it.
create index if not exists collections_pl_patient_trgm
  on collections.payment_lines using gin (patient_name claims.gin_trgm_ops);
create index if not exists collections_pl_payer_trgm
  on collections.payment_lines using gin (payer_name claims.gin_trgm_ops);

-- Cash velocity / days-to-pay, member lookup, facility×payer slices.
create index if not exists collections_pl_payment_date
  on collections.payment_lines (payment_date);
create index if not exists collections_pl_service_date
  on collections.payment_lines (service_date);
create index if not exists collections_pl_member_norm
  on collections.payment_lines (member_id_norm);
create index if not exists collections_pl_facility_payer
  on collections.payment_lines (facility_code, payer_name);

-- daily_collections bucket: one row per (facility_code, source_group_code,
-- payment_date). NULLS NOT DISTINCT (PG15+) so a group workbook's NULL-facility
-- dailies still dedupe on (source_group_code, payment_date). facility_code leads
-- the index, so it also serves (facility_code, payment_date) range lookups.
create unique index if not exists collections_daily_bucket
  on collections.daily_collections (facility_code, source_group_code, payment_date)
  nulls not distinct;

create index if not exists collections_nw_tpp
  on collections.negotiation_worklist (tpp);
create index if not exists collections_nw_facility
  on collections.negotiation_worklist (facility_code);

-- 5. Grants ------------------------------------------------------------------
-- Strip any default/public-facing grants, then grant precisely. REVOKE is
-- idempotent. claims_reader gets NO rights on collections_raw (verbatim PHI
-- source cells) — same posture as claims_raw.
revoke all on collections.collections_raw      from public, anon, authenticated, service_role, claims_reader;
revoke all on collections.daily_collections    from public, anon, authenticated, service_role;
revoke all on collections.payment_lines        from public, anon, authenticated, service_role;
revoke all on collections.negotiation_worklist from public, anon, authenticated, service_role;
revoke all on collections.rollup_snapshots     from public, anon, authenticated, service_role;
revoke all on collections.facilities           from public, anon, authenticated, service_role;

-- Reader: USAGE on the schema + SELECT on the four typed tables + the reference
-- map (non-PHI).
grant usage on schema collections to claims_reader;
grant select on collections.daily_collections    to claims_reader;
grant select on collections.payment_lines        to claims_reader;
grant select on collections.negotiation_worklist to claims_reader;
grant select on collections.rollup_snapshots     to claims_reader;
grant select on collections.facilities           to claims_reader;

-- Admin (loader): full use of the schema + all tables + sequences.
grant usage, create on schema collections to claims_admin;
grant all on collections.collections_raw      to claims_admin;
grant all on collections.daily_collections    to claims_admin;
grant all on collections.payment_lines        to claims_admin;
grant all on collections.negotiation_worklist to claims_admin;
grant all on collections.rollup_snapshots     to claims_admin;
grant all on collections.facilities           to claims_admin;
grant usage, select on all sequences in schema collections to claims_admin;

-- 6. RLS ---------------------------------------------------------------------
alter table collections.collections_raw      enable row level security;
alter table collections.daily_collections    enable row level security;
alter table collections.payment_lines        enable row level security;
alter table collections.negotiation_worklist enable row level security;
alter table collections.rollup_snapshots     enable row level security;
alter table collections.facilities           enable row level security;

-- Reader: permissive SELECT on the four typed tables + the reference map
-- (NONE on collections_raw).
drop policy if exists collections_reader_select_daily on collections.daily_collections;
create policy collections_reader_select_daily on collections.daily_collections
  for select to claims_reader using (true);

drop policy if exists collections_reader_select_payment on collections.payment_lines;
create policy collections_reader_select_payment on collections.payment_lines
  for select to claims_reader using (true);

drop policy if exists collections_reader_select_negotiation on collections.negotiation_worklist;
create policy collections_reader_select_negotiation on collections.negotiation_worklist
  for select to claims_reader using (true);

drop policy if exists collections_reader_select_rollup on collections.rollup_snapshots;
create policy collections_reader_select_rollup on collections.rollup_snapshots
  for select to claims_reader using (true);

drop policy if exists collections_reader_select_facilities on collections.facilities;
create policy collections_reader_select_facilities on collections.facilities
  for select to claims_reader using (true);

-- Admin: permissive ALL on every table (loader path).
drop policy if exists collections_admin_all_raw on collections.collections_raw;
create policy collections_admin_all_raw on collections.collections_raw
  for all to claims_admin using (true) with check (true);

drop policy if exists collections_admin_all_daily on collections.daily_collections;
create policy collections_admin_all_daily on collections.daily_collections
  for all to claims_admin using (true) with check (true);

drop policy if exists collections_admin_all_payment on collections.payment_lines;
create policy collections_admin_all_payment on collections.payment_lines
  for all to claims_admin using (true) with check (true);

drop policy if exists collections_admin_all_negotiation on collections.negotiation_worklist;
create policy collections_admin_all_negotiation on collections.negotiation_worklist
  for all to claims_admin using (true) with check (true);

drop policy if exists collections_admin_all_rollup on collections.rollup_snapshots;
create policy collections_admin_all_rollup on collections.rollup_snapshots
  for all to claims_admin using (true) with check (true);

drop policy if exists collections_admin_all_facilities on collections.facilities;
create policy collections_admin_all_facilities on collections.facilities
  for all to claims_admin using (true) with check (true);
