-- 0077 — coding decision registry: the billing team's code-decision matrix as versioned data
--        (qualify-v2-build-plan §4 — "the one genuinely new thing").
--
-- WHY: which code combo we bill for a payer at a facility, when it was decided, and whether the
--   decision is confirmed or still under test lives today in a Google Sheet whose two copies have
--   already drifted in seven places and whose history is destructively overwritten (one
--   "Date We Stopped Code" populated once across 47 rows). Qualify's coding-confidence factor (30%
--   of rating v2) needs a queryable, versioned source; the sheet becomes the historical record
--   after a one-time reviewed seed (scripts/seed-coding-decisions.ts — NO recurring Sheets sync,
--   deliberately: a two-way sync recreates the drift this table exists to end).
--
-- PHI DISCIPLINE: NO PHI, structurally. Payer families, plan labels, employer norms, facility
--   codes, HCPCS/revenue codes, dates, lifecycle enums, prose billing rules. No member id, no
--   patient name, no dollar amounts. That absence is what lets registry contents be edited by the
--   billing team without an audit-reveal path AND flow into an LLM prompt (Phase H). Keep it that way.
--
-- OWNERSHIP: schema `coding` created with AUTHORIZATION claims_admin (postgres holds SET-capable
--   membership — the standing apply-path posture); tables born owned via SET ROLE claims_admin.
--   Writes go through the NEW narrow role `coding_editor` (NOLOGIN here; LOGIN + password are set
--   out-of-band — passwords never live in a migration). Never claims_admin on the app path, never
--   the service key.
--
-- IDEMPOTENT: CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS; role created only if absent (never DROP
--   ROLE); DROP POLICY IF EXISTS before CREATE POLICY; GRANTs unconditional and repeatable.
-- DEPENDENCY: none (new schema). The seed script and grants assume 0025's claims_reader exists.
-- Rollback: 0077_coding_decision_registry_rollback.sql

-- 1. Role (create-if-absent; never dropped) ------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'coding_editor') then
    -- NOLOGIN here: the LOGIN attribute + password are granted out-of-band (env-only secrets).
    create role coding_editor nologin;
  end if;
end
$$;

-- 2. Schema + tables (born owned by claims_admin) ------------------------------------------------

create schema if not exists coding authorization claims_admin;

set role claims_admin;

-- coding.code_decision — current + historical decisions. NEVER destructively updated: a change is
-- INSERT new + close old (effective_to + superseded_by). The registry UI and the seed importer both
-- follow that contract; UPDATE privilege exists only for the supersede columns' write path.
create table if not exists coding.code_decision (
  id                  bigint generated always as identity primary key,
  payer_family        text        not null check (char_length(payer_family) between 1 and 40),
  payer_variant_label text        check (payer_variant_label is null or char_length(payer_variant_label) <= 120), -- verbatim sheet label, traceability
  plan_alpha          text        check (plan_alpha is null or char_length(plan_alpha) <= 20),       -- 'ZGP' / 'NON-ZGP'
  employer_norm       text        check (employer_norm is null or char_length(employer_norm) <= 120), -- joins vob.member_benefits_latest.employer_norm
  level_of_care       text        check (level_of_care is null or level_of_care in ('DTX','RTC','IP','IOP','OP')),
  facility_code       text        check (facility_code is null or char_length(facility_code) <= 40),  -- collections.facilities.facility_code; NULL = payer-wide default
  hcpcs_code          text        check (hcpcs_code is null or char_length(hcpcs_code) <= 10),        -- NULL when suppressed
  revenue_code        text        not null check (char_length(revenue_code) between 1 and 10),
  hcpcs_suppressed    boolean     not null default false,   -- 'NO HCPCS' — a billing METHOD, not a missing value
  dos_batch_min       integer     check (dos_batch_min is null or dos_batch_min between 1 and 60),
  dos_batch_max       integer     check (dos_batch_max is null or dos_batch_max between 1 and 60),
  type_of_bill        text        check (type_of_bill is null or char_length(type_of_bill) <= 8),
  drg_code            text        check (drg_code is null or char_length(drg_code) <= 8),
  condition_codes     text[],
  modifiers_removed   text[],
  units_per_dos       numeric(6,2) check (units_per_dos is null or units_per_dos > 0),
  billing_span        text        check (billing_span is null or billing_span in ('admit_dc','interim')),
  lifecycle           text        not null check (lifecycle in (
                        'CONFIRMED CODES','FINALIZED CODES','CONTINUE TESTS','OPEN TEST',
                        'UPCOMING TEST','CLOSED','DISCONTINUED','DISCONTINUE - DID NOT WORK')),
  decided_on          date        not null,
  effective_from      date        not null,
  effective_to        date,                                   -- NULL = current
  superseded_by       bigint      references coding.code_decision(id),
  notes               text        check (notes is null or char_length(notes) <= 2000),
  created_at          timestamptz not null default now(),
  created_by          text        not null check (char_length(created_by) <= 320),  -- app-user email (operator identity, non-PHI)
  constraint code_decision_batch_sane check (
    dos_batch_min is null or dos_batch_max is null or dos_batch_min <= dos_batch_max
  ),
  constraint code_decision_effective_sane check (
    effective_to is null or effective_to >= effective_from
  )
);

-- The factor lookup's hot path: current rows by family+facility. Partial (current-only) keeps it tiny.
create index if not exists code_decision_current_lookup
  on coding.code_decision (payer_family, facility_code)
  where effective_to is null;

-- coding.code_decision_audit — append-only who/what/when/before/after. Append-only BY PRIVILEGE
-- (0075 pattern): the editor gets INSERT, nobody gets UPDATE/DELETE.
create table if not exists coding.code_decision_audit (
  id            bigint generated always as identity primary key,
  decision_id   bigint      not null references coding.code_decision(id),
  actor_email   text        not null check (char_length(actor_email) <= 320),
  action        text        not null check (action in ('create','supersede','lifecycle')),
  before_state  jsonb,
  after_state   jsonb,
  at            timestamptz not null default now()
);

create index if not exists code_decision_audit_by_decision
  on coding.code_decision_audit (decision_id, at desc);

reset role;

-- 3. RLS — explicit policies (a policy-less RLS table default-denies the writer; 0065 incident) ---

alter table coding.code_decision enable row level security;
alter table coding.code_decision_audit enable row level security;

drop policy if exists coding_decision_ro on coding.code_decision;
create policy coding_decision_ro on coding.code_decision
  for select to claims_reader, consolidated_reader
  using (true);

drop policy if exists coding_decision_editor_rw on coding.code_decision;
create policy coding_decision_editor_rw on coding.code_decision
  for all to coding_editor
  using (true) with check (true);

drop policy if exists coding_audit_ro on coding.code_decision_audit;
create policy coding_audit_ro on coding.code_decision_audit
  for select to claims_reader, consolidated_reader
  using (true);

drop policy if exists coding_audit_editor_insert on coding.code_decision_audit;
create policy coding_audit_editor_insert on coding.code_decision_audit
  for insert to coding_editor
  with check (true);

-- 4. Grants --------------------------------------------------------------------------------------
-- Reader: SELECT both (the rating factor + registry UI list run as claims_reader).
-- Editor: INSERT + UPDATE on code_decision (UPDATE only for the supersede close — the app writes
-- decision changes as INSERT-new + close-old), INSERT-only on the audit, SELECT to read back its
-- own writes inside the transaction. Sequences: identity columns need USAGE.

grant usage on schema coding to claims_reader, consolidated_reader, coding_editor;
grant select on coding.code_decision, coding.code_decision_audit to claims_reader, consolidated_reader;
grant select, insert, update on coding.code_decision to coding_editor;
grant select, insert on coding.code_decision_audit to coding_editor;
grant usage, select on all sequences in schema coding to coding_editor;

-- 5. Verification (run manually after apply)
--
-- -- schema + tables exist, owned by claims_admin
-- select n.nspname, c.relname, pg_get_userbyid(c.relowner) as owner
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'coding' and c.relkind = 'r';
--
-- -- editor is append/update-narrow: INSERT+UPDATE on code_decision, INSERT on audit, NO DELETE anywhere
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'coding' order by grantee, table_name, privilege_type;
--
-- -- policies present (2 per table)
-- select polrelid::regclass, polname, polcmd from pg_policy
--  where polrelid in ('coding.code_decision'::regclass, 'coding.code_decision_audit'::regclass);
--
-- -- role exists and is NOLOGIN until the out-of-band step
-- select rolname, rolcanlogin from pg_roles where rolname = 'coding_editor';
--
-- Out-of-band (Alec, after apply — never in a migration):
--   alter role coding_editor login password '<from the secret manager>';
--   then set CODING_WRITER_DB_URL in Vercel (all envs) + app/.env.local.
