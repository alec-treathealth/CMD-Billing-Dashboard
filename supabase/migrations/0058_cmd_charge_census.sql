-- 0058 — collections.cmd_charge_census + collections.cmd_census_run (Qualify v2 feed series, artifact ① of 3; DDL only).
--
-- WHY (two-feed architecture, Option (b) — settled in recon): a payment-received-anchored feed
-- structurally CANNOT contain a never-paid charge (no posting date ⇒ never in a payment-received
-- window), so the existing collections.cmd_explorer_rows (append-only payment-EVENT log) cannot supply
-- the unpaid denominator Qualify v2's openCount needs. cmd_charge_census is the SOURCE-OF-TRUTH FOR
-- CHARGE EXISTENCE (Feed 2 = trailing-90d charge census, ALL payment states), joined to the payment-event
-- log on charge_id. cmd_census_run is its durable run-log (mirrors 0054 rollup_refresh_run's style).
-- Both are INERT until the ingest (artifact ②) writes them — ① is DDL only.
--
-- ┌─ THE DELIBERATE ASYMMETRY (do NOT "fix" census to match cmd_explorer_rows) ─────────────────────┐
-- │ cmd_explorer_rows : append-only · ON CONFLICT (row_fingerprint) DO NOTHING · NO UPDATE grant.     │
-- │ cmd_charge_census : UPSERT grain · UNIQUE (business_entity_id, charge_id) · INSERT + UPDATE grant. │
-- │ Census tracks the LATEST existence state of each charge (first_seen_at / last_seen_at): a re-pull  │
-- │ that re-sees a charge UPDATEs last_seen_at. This is the mechanism, deliberately opposite the log.  │
-- └────────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- PHI DISCIPLINE (byte-for-byte 0019/0036): patient_name/member_id/group_number are libsodium secretbox
-- ciphertext (nonce‖ct) bytea, encrypted in-process before INSERT; LIBSODIUM_KEY lives only in the
-- app/ingest env, never the DB. No plaintext PHI column, ever. The three blind indexes (keyed HMAC,
-- 0036) let PHI-entitled users search by member id / alpha prefix / group number without decryption.
--
-- ⚠ FOUR DEVIATIONS FROM THE ① BUILD SPEC — surfaced, not silently resolved (see the build report):
--   (1) The *_bidx columns are TEXT + NULLABLE, NOT `bytea NOT NULL`. The 0036 blind indexes on
--       cmd_explorer_rows are lowercase-hex TEXT (HMAC-SHA256, 64 chars) and NULLABLE (NULL when
--       INDEX_HMAC_KEY is unset or the source value is blank — "search degrades gracefully"). Matching
--       0036 EXACTLY is what makes member-search UX identical across payments and census (the spec's own
--       stated goal); `bytea NOT NULL` would both mistype the column and crash ingest whenever the HMAC
--       key is unset (e.g. local dev per docs — INDEX_HMAC_KEY in app/.env.local).
--   (2) The *_bidx indexes are PLAIN btree, mirroring 0036 exactly (0036's indexes are NOT partial). The
--       spec said "partial-where-not-null, mirroring 0036" — 0036 is plain; equality lookups are served
--       identically either way, so we mirror 0036's actual shape.
--   (3) RLS is ENABLE, not FORCE. The established collections posture (0033:26, 0054:83-85) is ENABLE:
--       the enforced writer role (cmd_rollup_writer, non-owner, no BYPASSRLS) is subject to RLS while the
--       postgres owner bypasses it regardless — so FORCE is unnecessary and would subject the owner/apply
--       path to the policies with no admin carve-out defined. Match precedent; do not diverge silently.
--   (4) The READER policy is PERMISSIVE (USING true), NOT GUC-scoped. This is the answer to the recon's
--       cross-tenant-read question: Qualify reads cross-tenant as claims_reader with the GUC UNSET,
--       scoping app-side via `business_entity_id = any($ent::uuid[])` (qualifyQuery.ts). A GUC-scoped
--       reader policy would return ZERO/single-tenant rows to a cross-tenant surface — the exact trap
--       0033:15-17 documents. The GUC scoping applies to WRITES only. This mirrors cmd_explorer_rows
--       post-0033 EXACTLY (reader USING(true) + app-side WHERE; writer GUC-scoped).
--
-- OWNERSHIP: created postgres-owned directly (collections.* sibling tables cmd_explorer_rows /
-- daily_collections / rollup_refresh_run are postgres-owned — plain DDL as the apply role, no SET ROLE;
-- the 0054 pattern, not 0053's claims_admin-owned path).
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY; roles
-- created only-if-absent (never DROP ROLE); grants reapplied unconditionally. Safe to re-run.
-- DEPENDENCY: 0006 (collections schema), 0003/0019 (claims_reader, cmd_rollup_writer), the withTenant
-- GUC path (set_config('app.business_entity_id', <tenant>, true)) being LIVE (0031/0033).
-- Rollback: 0058_cmd_charge_census_rollback.sql.

-- 1. Roles (privilege-only; reuse existing roles, created only-if-absent — mirror 0019). -----------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_reader') then
    create role claims_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'cmd_rollup_writer') then
    create role cmd_rollup_writer nologin;
  end if;
end $$;

-- 2. cmd_charge_census — the charge-EXISTENCE source of truth (the openCount denominator). ----------
-- Grain: ONE row per (business_entity_id, charge_id), UPSERTed. business_entity_id NOT NULL, stamped
-- explicitly per tenant at ingest (the DEFAULT-BXR safety net of 0028 is deliberately NOT copied — the
-- GUC-scoped writer policy already rejects a mis-stamped row fail-closed). numeric(12,2) mirrors 0019.
create table if not exists collections.cmd_charge_census (
  id                     bigint generated always as identity primary key,
  business_entity_id     uuid not null,
  charge_id              text not null,
  -- PHI trio — libsodium ciphertext (nonce‖ct) bytea, 0019 pattern. member_id + group_number NULLABLE
  -- (deviation from 0019, where member_id is NOT NULL — Alec, Gate 2): census is the openCount
  -- DENOMINATOR and Feed 2 can carry no-member/self-pay charges; NOT NULL would DROP them and undercount.
  -- Consistent with the already-nullable *_bidx columns (deviation 1) — no bidx index change is needed.
  patient_name           bytea not null,
  member_id              bytea,
  group_number           bytea,
  -- Blind indexes — keyed HMAC hex TEXT, NULLABLE (0036 shape; see DEVIATION (1)). Search, never PHI.
  member_id_bidx         text,
  member_id_prefix_bidx  text,
  group_number_bidx      text,
  -- Charge dimensions (all nullable — Feed 2 is a census; not every field is guaranteed present).
  charge_date            date,
  charge_entered_date    date,
  charge_to_date         date,
  facility               text,
  cpt_code               text,
  revenue_code           text,
  charge_amount          numeric(12,2),
  primary_payer          text,
  claim_status_raw       text,
  claim_status_category  text,          -- normalized in TS (normalizeStatus); deliberately NO SQL enum.
  -- Census lifecycle.
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  -- UNENFORCED soft reference to cmd_census_run.id — NO foreign key BY DESIGN: an FK would take a lock
  -- on cmd_census_run on every census upsert (the hot path) and couple the two tables' write ordering.
  -- Soft references are the established collections/staging pattern (0030:44-46).
  last_run_id            bigint,
  unique (business_entity_id, charge_id)          -- the upsert grain (the ON CONFLICT target in ②)
);

-- 3. Indexes. The UNIQUE constraint above already indexes (business_entity_id, charge_id) — the upsert
-- lookup — so no separate grain index is needed.
-- Window filtering: Qualify's openCount scans a tenant slice by recency.
create index if not exists cmd_charge_census_entity_last_seen
  on collections.cmd_charge_census (business_entity_id, last_seen_at);
-- Blind-index lookups — PLAIN btree, mirroring 0036 on cmd_explorer_rows (identical member-search UX;
-- see DEVIATION (2)).
create index if not exists cmd_charge_census_member_id_bidx
  on collections.cmd_charge_census (member_id_bidx);
create index if not exists cmd_charge_census_member_id_prefix_bidx
  on collections.cmd_charge_census (member_id_prefix_bidx);
create index if not exists cmd_charge_census_group_number_bidx
  on collections.cmd_charge_census (group_number_bidx);

-- 4. Grants (least privilege). UPSERT grain → writer needs INSERT + UPDATE (the asymmetry vs
-- cmd_explorer_rows' INSERT-only — this table is NOT append-only). NO DELETE, NO TRUNCATE to anyone.
revoke all on collections.cmd_charge_census
  from public, anon, authenticated, service_role, cmd_rollup_writer;
grant select, insert, update on collections.cmd_charge_census to cmd_rollup_writer;
grant select                 on collections.cmd_charge_census to claims_reader;

-- IDENTITY column: a non-owner writer needs USAGE on the backing sequence to insert (mirror 0054).
do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('collections.cmd_charge_census', 'id');
  if seq is not null then
    execute format('grant usage, select on sequence %s to cmd_rollup_writer', seq);
  end if;
end $$;

-- 5. RLS — ENABLE (not FORCE; DEVIATION (3)). Reader PERMISSIVE (cross-tenant Qualify read; DEVIATION
-- (4)); writer GUC-scoped (defense-in-depth beneath the app-layer per-tenant stamping — the 0033 pattern).
alter table collections.cmd_charge_census enable row level security;

-- READER: permissive — Qualify reads cross-tenant (business_entity_id = any($ent), GUC UNSET). A
-- GUC-scoped read here would blank the cross-tenant surface (0033:15-17). Mirrors cmd_explorer_rows.
drop policy if exists cmd_census_reader_select on collections.cmd_charge_census;
create policy cmd_census_reader_select on collections.cmd_charge_census
  for select to claims_reader using (true);

-- WRITER: GUC-scoped INSERT + UPDATE (the upsert) + SELECT. Canonical 1-arg current_setting → RAISES
-- (fail-closed, loud) if the GUC is unset, so a write outside withTenant cannot slip through unscoped
-- (the 0033 form, proven across ~12 staging/core isolation policies).
drop policy if exists cmd_census_writer_insert on collections.cmd_charge_census;
create policy cmd_census_writer_insert on collections.cmd_charge_census
  for insert to cmd_rollup_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_census_writer_update on collections.cmd_charge_census;
create policy cmd_census_writer_update on collections.cmd_charge_census
  for update to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_census_writer_select on collections.cmd_charge_census;
create policy cmd_census_writer_select on collections.cmd_charge_census
  for select to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- 6. cmd_census_run — durable per-CUSTOMER-pull run-log (mirrors 0054 rollup_refresh_run's shape/style).
-- Per-CUSTOMER-pull (not per-tenant-invocation) so the wall-clock-budget-skip/catch-up pattern can tell
-- completed customers from pending ones (customer_id NULLABLE → a tenant-level summary row stays
-- expressible for ② if wanted). started_at/finished_at NULLABLE start-then-update signal (0054): a hard
-- timeout that kills the function before the UPDATE leaves finished_at NULL — the "started, never
-- finished" failure signal; nothing swallowed.
create table if not exists collections.cmd_census_run (
  id                 bigint generated always as identity primary key,
  business_entity_id uuid not null,        -- tenant attribution AND the writer RLS boundary (GUC-scoped — see RLS note)
  customer_id        text,                 -- per-CUSTOMER-pull; NULL for a tenant-level summary row
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,          -- NULL until the pull completes (or was killed → failure signal)
  rows_seen          integer,
  rows_new           integer,
  rows_refreshed     integer,
  status             text,
  error_label        text                  -- LABEL ONLY — never payloads/URLs/PHI/filter criteria
);

-- Health check + catch-up: newest first, and per-tenant "which customers finished this invocation".
create index if not exists cmd_census_run_started_idx
  on collections.cmd_census_run (started_at desc);
create index if not exists cmd_census_run_entity_started_idx
  on collections.cmd_census_run (business_entity_id, started_at desc);

-- Grants: writer INSERT/UPDATE/SELECT (start-row then update-in-place); reader SELECT (ops surface).
-- No DELETE (append/update-only log). Mirror 0054.
revoke all on collections.cmd_census_run
  from public, anon, authenticated, service_role, cmd_rollup_writer;
grant select, insert, update on collections.cmd_census_run to cmd_rollup_writer;
grant select                 on collections.cmd_census_run to claims_reader;

do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('collections.cmd_census_run', 'id');
  if seq is not null then
    execute format('grant usage, select on sequence %s to cmd_rollup_writer', seq);
  end if;
end $$;

-- RLS: ENABLE. Reader PERMISSIVE (an ops surface reads all tenants' run rows with the GUC unset).
-- WRITER policies are GUC-SCOPED (Alec, Gate 2 decision — diverges from 0054's permissive untenanted
-- log): cmd_census_run carries business_entity_id NOT NULL and is tenant-attributed, so its writer
-- policies enforce the tenant GUC for defense-in-depth consistency with the tenant-DATA tables (0033).
--   ⚠ ② CONSTRAINT (consequence of GUC-scoping): ② MUST write EVERY run row — INCLUDING the "start
--   row" — INSIDE withTenant (set_config('app.business_entity_id', <tenant>, true)). A run row written
--   with the GUC unset RAISES (fail-closed; 1-arg current_setting) rather than inserting unscoped.
-- Owner (postgres) bypasses RLS regardless; cmd_rollup_writer (non-owner) needs these policies.
alter table collections.cmd_census_run enable row level security;

drop policy if exists cmd_census_run_reader_select on collections.cmd_census_run;
create policy cmd_census_run_reader_select on collections.cmd_census_run
  for select to claims_reader using (true);

drop policy if exists cmd_census_run_writer_select on collections.cmd_census_run;
create policy cmd_census_run_writer_select on collections.cmd_census_run
  for select to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_census_run_writer_insert on collections.cmd_census_run;
create policy cmd_census_run_writer_insert on collections.cmd_census_run
  for insert to cmd_rollup_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists cmd_census_run_writer_update on collections.cmd_census_run;
create policy cmd_census_run_writer_update on collections.cmd_census_run
  for update to cmd_rollup_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);
