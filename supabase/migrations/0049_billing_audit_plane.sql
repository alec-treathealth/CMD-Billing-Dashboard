-- 0049: Billing Audit plane — claims.audit_row / billing_code_decision / payer_alias /
--       facility_alias / flag_rule / flag + the claims_audit_writer role.
--
-- WHY: moves the billing team's IP/OP claim-audit workflow (CMD batch reports + the
-- "JT Master Issues" Google Sheet) into the app: two operator work surfaces
-- (/billing-audit IP AUDIT | OP AUDIT) and a rules-computed FLAG QUEUE replacing the
-- manual "Claims Issues" sheet. UI label is "Billing Audit"; the Postgres namespace
-- stays `claims.*` (pre-existing schema — claims.app_user lives here). Nothing here
-- claims the "Claims" UI label (reserved for the future Veris claims surface, S10).
--
-- ⚠️ NOT APPLIED until Alec's HOLD go-ahead. Rollback: 0049_billing_audit_plane_rollback.sql.
-- Idempotent-forward: IF NOT EXISTS on tables/indexes/columns, DROP POLICY IF EXISTS
-- before CREATE POLICY, role created only-if-absent (never DROP ROLE), grants re-asserted
-- unconditionally. Safe to re-run.
--
-- RULINGS ENCODED HERE (Alec, 2026-07-13):
--   * Upsert = OPTION B: row_fingerprint hashes STABLE-IDENTITY fields only; volatile
--     status fields update via ON CONFLICT DO UPDATE in the ingest (field list below).
--     One row per charge line forever; a status flip can never re-insert a row or
--     re-open a resolved flag.
--   * Writer = NEW least-privilege `claims_audit_writer` NOLOGIN role (0045 pattern).
--     The production-critical cmd_rollup_writer is untouched.
--   * Decision matrix: canonical tab = "Billing Codes - EH"; JT col O is read ONLY for
--     stopped_on. Sub-cohort columns (alpha_prefix, loc) carry EH's ZGP/NON-ZGP and
--     DTX/RTC splits.
--   * Report topology = roster loop (per-customer, collections-cron pattern) — ingest
--     concern; schema is per-row tenant-tagged either way.
--
-- DELIBERATE DELTAS from the session brief (verified against live patterns in Phase 0):
--   * Blind-index columns are TEXT (hex HMAC), not bytea — matching the LIVE 0036/0037
--     construction (src/collections/blindIndex.ts stores hex text).
--   * row_fingerprint is TEXT (sha-256 hex), not bytea — matching cmd_explorer_rows (0019).
--   * member_id_pfx3_bidx added (brief had only patient_name pfx3): the EH matrix's
--     ZGP/NON-ZGP rules key on the member-id alpha prefix.
--   * claim_frequency + modifier_2 added: the OP report (39-col projection) carries
--     Claim Frequency and Charge Modifier 2; nullable, absent on IP rows.
--
-- PHI DISCIPLINE (docs/CLAUDE.md §2): patient name / DOB / member id are libsodium
-- ciphertext bytea (nonce‖ct), encrypted in-process BEFORE insert; searchable only via
-- keyed-HMAC blind indexes. flag.detail is PHI-FREE evidence only (enforced in the flag
-- engine; commented on the column). No plaintext PHI column exists in this plane.
--
-- TENANCY (invariant): every table except the global flag_rule carries
-- business_entity_id uuid NOT NULL FK → core.business_entity ON DELETE RESTRICT;
-- composite indexes lead with it. READS are app-layer scoped (R1 ruling: every reader
-- includes the tenant WHERE; permissive SELECT policies below). WRITES are GUC-enforced
-- (0033 C-flip pattern): 1-arg current_setting('app.business_entity_id') RAISES when the
-- GUC is unset — fail-closed and loud.
--
-- NAMESPACE NOTE: claims.payer_alias is DISTINCT from ref.payer_alias (Veris's global
-- payer normalization). This one is tenant-scoped audit-plane carrier matching
-- (sheet carrier_text → report payer_name match rules with precedence). Not a duplicate.
--
-- SEEDS: flag_rule rows are seeded here (global, tenant-less). payer_alias /
-- facility_alias seed rows deliberately land with the Phase-2 sync artifact, once the
-- carrier list is verified against REAL report payer names (the Phase-0 alias proposal
-- used the cmd_explorer_rows vocabulary as a proxy).
--
-- Flag RESOLUTION write path (acknowledge/resolve/dismiss from the UI) is NOT in this
-- migration: proposed as a claims_admin-owned SECURITY DEFINER function (0026 pattern,
-- EXECUTE to claims_reader) landing with the Phase-4 UI artifact. claims_audit_writer's
-- UPDATE grant on claims.flag serves the ENGINE (upsert + auto-context), not user actions.

-- MIXED-MODE APPLY (live-verified 2026-07-13): schema `claims` is OWNED BY postgres with
-- claims_admin holding plain USAGE+CREATE (no grant option) — so role creation and the
-- schema-level USAGE grant run AS POSTGRES (the apply role), while every object is born
-- owned by claims_admin via SET ROLE (standing posture; claims.app_user precedent).
-- Schema `core` IS owned by claims_admin, so its grants live inside the SET ROLE block.
--
-- ⚠️ APPLY-TIME OPERATOR STEP (2026-07-13, recorded for provenance): the standing
-- SET-capable membership this file's `SET ROLE claims_admin` depends on
-- (`GRANT claims_admin TO postgres WITH SET TRUE`, S2 posture) was found REVOKED live
-- (platform-side membership collapse left one supabase_admin-grantor row with
-- set_option=false); the first apply failed 42501 and rolled back whole. Alec restored
-- it MANUALLY in the Supabase SQL editor before the successful apply. Deliberately an
-- operator step, NOT a migration statement: role-membership posture is cluster-level
-- state, and tooling correctly refuses to self-elevate without explicit authorization.
-- Forensics + standing watch item: docs/veris-data-notes.md → "Billing Audit S2
-- (Phase 1 apply) — apply-path SET grant found REVOKED".

-- As postgres: the role must exist before any policy below names it, and only the
-- schema owner can grant USAGE on claims.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_audit_writer') then
    create role claims_audit_writer nologin;
  end if;
end $$;
grant usage on schema claims to claims_audit_writer;

-- Born-owned from here (standing apply-path posture: postgres holds SET-capable claims_admin).
set role claims_admin;

-- ---------------------------------------------------------------------------
-- claims.audit_row — flat charge-line grain mirroring the CMD audit reports.
-- ---------------------------------------------------------------------------
-- OPTION B fingerprint (LOCKED — the authoritative field order + normalization live in
-- src/billingAudit/auditRowMap.ts, same discipline as cmdExplorerSeed.ts):
--   sha256 hex over STABLE-IDENTITY fields:
--     audit_scope · cmd_claim_id · cmd_patient_id · charge_from_date · charge_to_date ·
--     stmt_from_date · stmt_to_date · admission_date · cpt_code · rev_code ·
--     modifier_1 · modifier_2 · units · type_of_bill · charge_amount_cents
--   (PHI-free by construction: cmd_claim_id + cmd_patient_id pin identity, so no
--   patient field is needed in the hash.)
-- VOLATILE fields — updated by the ingest's ON CONFLICT (business_entity_id,
-- row_fingerprint) DO UPDATE, never part of the hash:
--     claim_type, claim_frequency, office_name, office_id, provider_name,
--     billing_provider_id, payer_name, auth_number, charge_status_raw,
--     status_category, status_payer, principal_diag, diagnoses, last_fu_note,
--     source_report_id, ingested_at
--   (PHI enc/bidx columns are written on first insert and re-asserted on update —
--   ciphertext is nonce-fresh each run; the bidx values are deterministic.)
create table if not exists claims.audit_row (
  id                    bigint generated always as identity primary key,
  business_entity_id    uuid not null references core.business_entity (id) on delete restrict,
  -- Set by WHICH report fed the row (IP vs OP report id), never inferred from the data.
  audit_scope           text not null check (audit_scope in ('IP', 'OP')),
  cmd_claim_id          text not null,
  cmd_patient_id        text not null,
  claim_type            text,
  claim_frequency       text,                 -- OP report only (39-col projection)
  office_name           text,
  office_id             text,
  provider_name         text,
  billing_provider_id   text,
  patient_name_enc      bytea not null,       -- PHI: libsodium ciphertext (nonce‖ct)
  patient_name_bidx     text not null,        -- keyed-HMAC hex (0036 construction)
  patient_name_pfx3_bidx text,                -- keyed-HMAC hex of first-3-chars prefix
  patient_dob_enc       bytea,                -- PHI: libsodium ciphertext (nonce‖ct)
  member_id_enc         bytea,                -- PHI: libsodium ciphertext (nonce‖ct)
  member_id_bidx        text,                 -- keyed-HMAC hex (0036 construction)
  member_id_pfx3_bidx   text,                 -- keyed-HMAC hex; ZGP alpha-prefix rules
  charge_from_date      date not null,
  charge_to_date        date,
  stmt_from_date        date,
  stmt_to_date          date,
  admission_date        date,
  cpt_code              text,
  rev_code              text,
  modifier_1            text,
  modifier_2            text,                 -- OP report only
  units                 numeric,
  type_of_bill          text,
  charge_amount_cents   bigint not null default 0,  -- parsed to cents at ingest, never float
  payer_name            text,
  auth_number           text,
  charge_status_raw     text,
  status_category       text not null check (status_category in
    ('PAID', 'BALANCE_DUE_PATIENT', 'AT_PAYER', 'APPROVED_HIGHER',
     'NEEDS_RENEGOTIATING', 'ON_HOLD', 'OTHER')),
  status_payer          text,                 -- extracted from 'CLAIM AT <X>'
  principal_diag        text,
  diagnoses             jsonb not null default '[]'::jsonb,  -- [{code,poa,desc,pos}] — PHI-free codes
  last_fu_note          text,
  row_fingerprint       text not null,        -- sha-256 hex over the LOCKED stable-identity fields
  source_report_id      text not null,
  ingested_at           timestamptz not null default now(),
  unique (business_entity_id, row_fingerprint)
);

create index if not exists audit_row_scope_date_idx
  on claims.audit_row (business_entity_id, audit_scope, charge_from_date desc);
create index if not exists audit_row_status_date_idx
  on claims.audit_row (business_entity_id, status_category, charge_from_date desc);
create index if not exists audit_row_payer_idx
  on claims.audit_row (business_entity_id, payer_name);
create index if not exists audit_row_cpt_rev_idx
  on claims.audit_row (business_entity_id, cpt_code, rev_code);
create index if not exists audit_row_patient_bidx_idx
  on claims.audit_row (business_entity_id, patient_name_bidx);
create index if not exists audit_row_patient_pfx3_idx
  on claims.audit_row (business_entity_id, patient_name_pfx3_bidx);
create index if not exists audit_row_member_bidx_idx
  on claims.audit_row (business_entity_id, member_id_bidx);
create index if not exists audit_row_member_pfx3_idx
  on claims.audit_row (business_entity_id, member_id_pfx3_bidx);
create index if not exists audit_row_diagnoses_gin
  on claims.audit_row using gin (diagnoses jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- claims.billing_code_decision — the Sheets-synced matrix (facility × carrier
-- [× sub-cohort] → finalized codes + bundling rules + stop dates).
-- Canonical source tab: "Billing Codes - EH"; stopped_on comes from JT col O only.
-- Rows that disappear from the sheet are marked stopped, never deleted (fail-soft sync).
-- ---------------------------------------------------------------------------
create table if not exists claims.billing_code_decision (
  id                    bigint generated always as identity primary key,
  business_entity_id    uuid not null references core.business_entity (id) on delete restrict,
  facility_code         text not null,        -- CAMH, KWC, … (claims.facility_alias resolves)
  carrier_text          text not null,        -- verbatim from the sheet block header
  alpha_prefix          text,                 -- EH sub-cohort: member-id alpha prefix (e.g. ZGP); null = all
  loc                   text,                 -- EH sub-cohort: level of care (e.g. DTX, RTC); null = all
  hcpcs                 text,                 -- null on rules-only rows ("HCPCS/REV" placeholders)
  rev_code              text,
  rules_text            text,
  dos_bundle_min        int,
  dos_bundle_max        int,
  tob_pattern           text,
  drg                   text,
  finalized_on          date,
  stopped_on            date,                 -- from JT col O ("06/21 (H0017)" → date part)
  stopped_code          text,                 -- the parenthesized code from the JT stop annotation
  active                boolean generated always as (stopped_on is null) stored,
  source_tab            text not null,
  source_row            int,
  sheet_sync_hash       text,
  synced_at             timestamptz not null default now()
);

-- Expression unique index (coalesced nullables) — the sync's ON CONFLICT target.
create unique index if not exists billing_code_decision_identity_uq
  on claims.billing_code_decision (
    business_entity_id, facility_code, carrier_text,
    coalesce(alpha_prefix, ''), coalesce(loc, ''),
    coalesce(hcpcs, ''), coalesce(rev_code, '')
  );
create index if not exists billing_code_decision_active_idx
  on claims.billing_code_decision (business_entity_id, facility_code, active);

-- ---------------------------------------------------------------------------
-- claims.payer_alias — sheet carrier_text → report payer_name match rules.
-- Explicit precedence; most-specific (lowest number) wins; unmatched claims get NO
-- decision applied and are counted in sync output. Seeded in Phase 2 (see header).
-- ---------------------------------------------------------------------------
create table if not exists claims.payer_alias (
  id                    bigint generated always as identity primary key,
  business_entity_id    uuid not null references core.business_entity (id) on delete restrict,
  alias_text            text not null,        -- the sheet's carrier wording, verbatim
  match_kind            text not null check (match_kind in ('exact', 'like', 'regex')),
  match_value           text not null,
  precedence            int not null,
  unique (business_entity_id, alias_text)
);

-- ---------------------------------------------------------------------------
-- claims.facility_alias — facility_code (CAMH, KWC, …) → the audit report's
-- Office Name / Office ID. Seeded in Phase 2 from verified report values.
-- ---------------------------------------------------------------------------
create table if not exists claims.facility_alias (
  id                    bigint generated always as identity primary key,
  business_entity_id    uuid not null references core.business_entity (id) on delete restrict,
  facility_code         text not null,
  office_name           text,
  office_id             text,
  unique (business_entity_id, facility_code)
);

-- ---------------------------------------------------------------------------
-- claims.flag_rule — GLOBAL rule seed (deliberately tenant-less; params tunable live).
-- ---------------------------------------------------------------------------
create table if not exists claims.flag_rule (
  id          smallint primary key,
  code        text not null unique,
  description text not null,
  severity    text not null check (severity in ('critical', 'warning', 'info')),
  scope       text not null check (scope in ('IP', 'OP', 'BOTH')),
  params      jsonb not null default '{}'::jsonb,
  enabled     boolean not null default true
);

-- Seed (idempotent; DO NOTHING so live param tuning is never clobbered by a re-run).
-- ZERO_PAID_AGED ships DISABLED: the audit report has no paid column — the
-- cmd_explorer_rows-join question is an explicit Phase-3 HOLD item, not silently invented.
insert into claims.flag_rule (id, code, description, severity, scope, params, enabled) values
  (1, 'MISSING_AUTH',            'Auth # blank and payer is not self-pay',                          'critical', 'BOTH', '{}'::jsonb,           true),
  (2, 'CODE_DECISION_MISMATCH',  'Billed CPT/rev contradicts the active billing-code decision',     'critical', 'BOTH', '{}'::jsonb,           true),
  (3, 'STOPPED_CODE_STILL_BILLED','Charge dated after the decision stop date still uses the code',  'critical', 'BOTH', '{}'::jsonb,           true),
  (4, 'STALE_AT_PAYER',          'AT_PAYER older than params.days',                                 'warning',  'BOTH', '{"days": 30}'::jsonb, true),
  (5, 'ZERO_PAID_AGED',          'Aged with zero paid (needs paid-amount join — Phase-3 HOLD)',     'warning',  'BOTH', '{"days": 30}'::jsonb, false),
  (6, 'ON_HOLD_AGED',            'ON_HOLD older than params.days',                                  'warning',  'BOTH', '{"days": 7}'::jsonb,  true),
  (7, 'NEEDS_RENEGOTIATING',     'Status passthrough as queue item',                                'info',     'BOTH', '{}'::jsonb,           true),
  (8, 'MISSING_POA',             'Institutional diagnosis missing POA indicator',                   'info',     'IP',   '{}'::jsonb,           true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- claims.flag — computed exceptions. UNIQUE (audit_row_id, rule_id): re-ingest never
-- duplicates and never reopens resolved/dismissed flags (the engine upserts DO NOTHING
-- on the pair). detail is PHI-FREE evidence only (expected codes, decision ids, ages).
-- ---------------------------------------------------------------------------
create table if not exists claims.flag (
  id                  bigint generated always as identity primary key,
  business_entity_id  uuid not null references core.business_entity (id) on delete restrict,
  audit_row_id        bigint not null references claims.audit_row (id) on delete cascade,
  rule_id             smallint not null references claims.flag_rule (id),
  status              text not null default 'open'
                        check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  detail              jsonb not null default '{}'::jsonb,  -- PHI-FREE evidence only
  resolved_by         text,
  resolved_at         timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  unique (audit_row_id, rule_id)
);

create index if not exists flag_status_rule_idx
  on claims.flag (business_entity_id, status, rule_id);

-- ---------------------------------------------------------------------------
-- claims_audit_writer grants — least-privilege NOLOGIN ingest/engine role (0045
-- pattern; role created at the top of this file, as postgres).
-- ⚠️ OPERATOR STEP (out of band, NOT in this migration): provision a login inheriting
-- this role via a secure channel and place its connection string in
-- CLAIMS_AUDIT_WRITER_DATABASE_URL. No password ever appears in a migration.
-- ---------------------------------------------------------------------------
-- FK targets: RI checks run as table owner, but the writer also SELECTs the registry
-- (roster→tenant resolution) — read-only. Schema core is claims_admin-owned, so these
-- grants run here, inside the SET ROLE block.
grant usage on schema core to claims_audit_writer;
grant select on core.business_entity, core.cmd_customer to claims_audit_writer;

-- Strip defaults, then grant exactly what each path needs. No DELETE anywhere.
revoke all on claims.audit_row,
              claims.billing_code_decision,
              claims.payer_alias,
              claims.facility_alias,
              claims.flag_rule,
              claims.flag
  from public, anon, authenticated, service_role, claims_audit_writer;

grant select, insert, update on claims.audit_row            to claims_audit_writer;
grant select, insert, update on claims.billing_code_decision to claims_audit_writer;
grant select, insert, update on claims.flag                  to claims_audit_writer;
grant select                 on claims.payer_alias           to claims_audit_writer;
grant select                 on claims.facility_alias        to claims_audit_writer;
grant select                 on claims.flag_rule             to claims_audit_writer;

-- Identity sequences for the three writer-inserted tables.
do $$
declare
  seq text;
  t   text;
begin
  foreach t in array array['claims.audit_row', 'claims.billing_code_decision', 'claims.flag'] loop
    seq := pg_get_serial_sequence(t, 'id');
    if seq is not null then
      execute format('grant usage, select on sequence %s to claims_audit_writer', seq);
    end if;
  end loop;
end $$;

-- Read path (R1 ruling): claims_reader gets SELECT; isolation is the app-layer tenant
-- WHERE in every reader + the reader-isolation test. Permissive SELECT policies below.
grant select on claims.audit_row,
                claims.billing_code_decision,
                claims.payer_alias,
                claims.facility_alias,
                claims.flag_rule,
                claims.flag
  to claims_reader;

-- ---------------------------------------------------------------------------
-- RLS. Writer verbs are GUC-checked (0033 C-flip pattern): 1-arg current_setting
-- RAISES when app.business_entity_id is unset — a write outside withTenant() fails
-- closed and loud. Reader SELECT is permissive (R1: app-layer WHERE isolation).
-- Owner (claims_admin) bypasses its own tables' RLS — no admin policy needed.
-- ---------------------------------------------------------------------------
alter table claims.audit_row             enable row level security;
alter table claims.billing_code_decision enable row level security;
alter table claims.payer_alias           enable row level security;
alter table claims.facility_alias        enable row level security;
alter table claims.flag_rule             enable row level security;
alter table claims.flag                  enable row level security;

-- audit_row
drop policy if exists audit_row_reader_select on claims.audit_row;
create policy audit_row_reader_select on claims.audit_row
  for select to claims_reader using (true);
drop policy if exists audit_row_writer_select on claims.audit_row;
create policy audit_row_writer_select on claims.audit_row
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists audit_row_writer_insert on claims.audit_row;
create policy audit_row_writer_insert on claims.audit_row
  for insert to claims_audit_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists audit_row_writer_update on claims.audit_row;
create policy audit_row_writer_update on claims.audit_row
  for update to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- billing_code_decision
drop policy if exists bcd_reader_select on claims.billing_code_decision;
create policy bcd_reader_select on claims.billing_code_decision
  for select to claims_reader using (true);
drop policy if exists bcd_writer_select on claims.billing_code_decision;
create policy bcd_writer_select on claims.billing_code_decision
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists bcd_writer_insert on claims.billing_code_decision;
create policy bcd_writer_insert on claims.billing_code_decision
  for insert to claims_audit_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists bcd_writer_update on claims.billing_code_decision;
create policy bcd_writer_update on claims.billing_code_decision
  for update to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- payer_alias / facility_alias (writer reads only; rows are migration/ops-managed)
drop policy if exists payer_alias_reader_select on claims.payer_alias;
create policy payer_alias_reader_select on claims.payer_alias
  for select to claims_reader using (true);
drop policy if exists payer_alias_writer_select on claims.payer_alias;
create policy payer_alias_writer_select on claims.payer_alias
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists facility_alias_reader_select on claims.facility_alias;
create policy facility_alias_reader_select on claims.facility_alias
  for select to claims_reader using (true);
drop policy if exists facility_alias_writer_select on claims.facility_alias;
create policy facility_alias_writer_select on claims.facility_alias
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

-- flag_rule (global; read-all for both roles)
drop policy if exists flag_rule_reader_select on claims.flag_rule;
create policy flag_rule_reader_select on claims.flag_rule
  for select to claims_reader using (true);
drop policy if exists flag_rule_writer_select on claims.flag_rule;
create policy flag_rule_writer_select on claims.flag_rule
  for select to claims_audit_writer using (true);

-- flag
drop policy if exists flag_reader_select on claims.flag;
create policy flag_reader_select on claims.flag
  for select to claims_reader using (true);
drop policy if exists flag_writer_select on claims.flag;
create policy flag_writer_select on claims.flag
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists flag_writer_insert on claims.flag;
create policy flag_writer_insert on claims.flag
  for insert to claims_audit_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);
drop policy if exists flag_writer_update on claims.flag;
create policy flag_writer_update on claims.flag
  for update to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

reset role;
