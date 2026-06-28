-- 0019: CMD Collections Explorer — per-charge-line detail with PHI ENCRYPTED at rest.
--
-- WHY: the Collections Explorer (/dashboard/collections/explorer) previously ran the
-- slow CMD batch report (run → poll → unzip → CSV) LIVE on every page load. This table
-- is its persistent, paginated source of truth: seeded once from local Derek-14-column
-- CSVs (src/collections/cmdExplorerSeed.ts) and kept current by a daily cron that pulls
-- the live CMD report and upserts (src/collections/cmdExplorerCron.ts, Gate 3). The grain
-- is ONE ROW PER CONTENT SNAPSHOT of a charge line (full history): when a charge line's
-- payment fields change between pulls, the new state lands as a new row — older snapshots
-- are never overwritten.
--
-- PHI DISCIPLINE (docs/CLAUDE.md §2): three identifier columns (patient_name, member_id,
-- group_number) are PHI and are stored ENCRYPTED AT REST as libsodium secretbox
-- ciphertext (nonce‖ciphertext bytea), encrypted IN-PROCESS by the app before INSERT
-- (src/collections/phiCrypto.ts, Gate 2). The LIBSODIUM_KEY lives only in the
-- app/ingest environment — NEVER in the database — so a database-only compromise
-- (including a leaked claims_reader credential) cannot recover patient identifiers.
-- claims_reader may SELECT the ciphertext solely to serve the audited per-row reveal,
-- which decrypts in-process and writes claims.log_access; the non-PHI projection
-- (everything except the three bytea columns) is the cached, browser-bound grid.
-- row_fingerprint is a SHA-256 hex over the NORMALIZED PLAINTEXT 14 fields, computed
-- BEFORE encryption — non-reversible, stable across re-pulls (so non-deterministic
-- ciphertext is irrelevant to dedup), and the idempotency key. This project already
-- treats SHA-256 of patient terms as a non-PHI binding token (src/queries/identity.ts).
--
-- Idempotency: IF NOT EXISTS on table/indexes; DROP POLICY IF EXISTS before CREATE
-- POLICY; roles created only-if-absent (never DROP ROLE); REVOKE/GRANT reapplied
-- unconditionally. Safe to re-run. The INGEST is itself idempotent: ON CONFLICT
-- (row_fingerprint) DO NOTHING, so a re-run or an overlapping daily pull inserts only
-- genuinely new snapshots.
--
-- DEPENDENCY: assumes 0003 (claims_reader), 0006 (the `collections` schema), and 0013
-- (the cmd_rollup_writer role) have run.
--
-- ⚠️ PostgREST exposure: the `collections` schema MUST stay OFF Supabase's
-- exposed-schemas list (same posture as the rest of `collections` / `claims`). This
-- table is PHI-bearing even though the identifiers are ciphertext.

-- 1. Roles (privilege-only; reuse existing roles, created only-if-absent). -----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_reader') then
    create role claims_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'cmd_rollup_writer') then
    create role cmd_rollup_writer nologin;
  end if;
end $$;

-- 2. Table -------------------------------------------------------------------
-- Grain: one row per CONTENT SNAPSHOT of a CMD charge line, keyed for dedup on
-- row_fingerprint (SHA-256 over the normalized plaintext 14 fields). The three PHI
-- columns are libsodium ciphertext (nonce‖ciphertext) — never plaintext at rest.
-- group_number is nullable (some rows carry no group number); patient_name and
-- member_id are always present. source_file records the CSV filename (seed) or
-- 'cmd_api' (cron pull).
create table if not exists collections.cmd_explorer_rows (
  id                   bigint generated always as identity primary key,
  charge_date          date not null,
  payment_received     date,
  cpt_code             text not null,
  revenue_code         text,
  facility             text not null,
  patient_name         bytea not null,        -- PHI: libsodium ciphertext (nonce‖ct)
  member_id            bytea not null,        -- PHI: libsodium ciphertext (nonce‖ct)
  group_number         bytea,                 -- PHI: libsodium ciphertext (nonce‖ct), nullable
  charge_amount        numeric(12,2) not null,
  allowed_amount       numeric(12,2),
  insurance_payments   numeric(12,2),
  adjustments          numeric(12,2),
  patient_balance_due  numeric(12,2),
  primary_payer        text,
  source_file          text,
  ingested_at          timestamptz not null default now(),
  row_fingerprint      text not null,
  unique (row_fingerprint)
);

-- 3. Indexes -----------------------------------------------------------------
-- The grid filters/sorts by charge_date, facility, and primary_payer; ingested_at
-- supports freshness/audit lookups. The unique constraint above already indexes
-- row_fingerprint (the dedup lookup), so no separate fingerprint index is needed.
create index if not exists cmd_explorer_charge_date
  on collections.cmd_explorer_rows (charge_date);
create index if not exists cmd_explorer_facility
  on collections.cmd_explorer_rows (facility);
create index if not exists cmd_explorer_primary_payer
  on collections.cmd_explorer_rows (primary_payer);
create index if not exists cmd_explorer_ingested_at
  on collections.cmd_explorer_rows (ingested_at);

-- 4. Grants ------------------------------------------------------------------
-- Strip default/public grants, then grant precisely. claims_reader gets SELECT
-- (it reads non-PHI columns for the grid and the three ciphertext columns only on
-- the audited reveal). cmd_rollup_writer gets INSERT only (seed + daily cron write
-- path). No role gets UPDATE/DELETE — this table is append-only (full-history grain).
-- The identity PK is GENERATED ALWAYS, so an INSERT needs NO sequence privilege
-- (mirrors 0013); hence no sequence grant is required.
revoke all on collections.cmd_explorer_rows
  from public, anon, authenticated, service_role;
grant select on collections.cmd_explorer_rows to claims_reader;
grant insert on collections.cmd_explorer_rows to cmd_rollup_writer;

-- 5. RLS ---------------------------------------------------------------------
-- The GRANTs above are the real privilege boundary; the policies just satisfy RLS
-- for the two roles. claims_reader: SELECT only. cmd_rollup_writer: INSERT only.
-- No UPDATE/DELETE policies (append-only).
alter table collections.cmd_explorer_rows enable row level security;

drop policy if exists cmd_explorer_reader_select on collections.cmd_explorer_rows;
create policy cmd_explorer_reader_select on collections.cmd_explorer_rows
  for select to claims_reader using (true);

drop policy if exists cmd_explorer_writer_insert on collections.cmd_explorer_rows;
create policy cmd_explorer_writer_insert on collections.cmd_explorer_rows
  for insert to cmd_rollup_writer with check (true);
