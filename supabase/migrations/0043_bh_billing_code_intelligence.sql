-- 0043: Behavioral-health billing-code intelligence — schema, enums, tables, RLS.
--
-- WHY: the Code Reference feature (Phase 9, app/app/code-reference) is today a
-- STATIC client-side constant of HCPCS/CPT + revenue-code combinations. Billing
-- logic that decides "what do we bill for facility × payer × setting" lives in
-- Excel and in observed adjudication patterns. That is unauditable and can drift
-- silently when a payer changes a rule or CMS revises a HCPCS code. This migration
-- lays the structured, versioned, auditable data layer that replaces that: canonical
-- code tables, a payer/plan/facility hierarchy, versioned billing policies with code +
-- claim rules, and a policy_change_event flag layer that the quarterly CMS sync job
-- (src/jobs/cmsHcpcsSync) and manual payer-bulletin review write into.
--
-- PHI DISCIPLINE (docs/CLAUDE.md §2): this schema is NON-PHI BY CONSTRUCTION. It holds
-- reference/administrative data only — code definitions, payer names, facility names,
-- policy rules, and CMS-published change signals. NO patient identifier, member id,
-- DOS, or claim-level PHI is stored here. (The draft's claim_issue_log /
-- facility_payer_enrollment tables are intentionally OMITTED — an AR/issue tracker that
-- carries member initials + DOS is PHI and must instead follow the existing encrypt-
-- identifiers + blind-index pattern used by collections.cmd_explorer_rows. See AUDIT.md
-- §"Deferred / out of scope".)
--
-- ⚠️ PostgREST exposure: the `code_intel` schema MUST stay OFF Supabase's exposed-schemas
-- list, same posture as `claims` / `collections`. Reads go through the least-privilege
-- claims_reader node-postgres path (RPCs in 0044), never PostgREST.
--
-- Idempotency: CREATE SCHEMA / TABLE / INDEX IF NOT EXISTS; enum types created only-if-
-- absent via a pg_type guard (CREATE TYPE has no IF NOT EXISTS); roles created only-if-
-- absent (never DROP ROLE); DROP POLICY IF EXISTS before CREATE POLICY; REVOKE/GRANT
-- reapplied unconditionally. Safe to re-run.
--
-- ⚠️ NOT APPLIED YET. This file is written for review only. Do NOT run it against the
-- live database until AUDIT.md is signed off. Rollback: supabase/rollbacks/0043_*.
--
-- DEPENDENCY: assumes 0003 (claims_reader / claims_admin roles) has run.

create extension if not exists "pgcrypto";

create schema if not exists code_intel;

-- The reader role already exists (0003); guard for safety when running in isolation.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claims_reader') then
    create role claims_reader nologin;
  end if;
end $$;

-- ============================================================
-- ENUMS (in the code_intel schema; created only-if-absent)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'code_type_enum' and n.nspname = 'code_intel') then
    create type code_intel.code_type_enum as enum ('revenue', 'hcpcs', 'cpt');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'payer_type_enum' and n.nspname = 'code_intel') then
    create type code_intel.payer_type_enum as enum (
      'commercial', 'medicaid_mcp', 'county_mhp', 'medicare',
      'medicare_advantage', 'tpa', 'work_comp', 'tricare', 'other');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'lob_enum' and n.nspname = 'code_intel') then
    create type code_intel.lob_enum as enum (
      'commercial', 'medicaid', 'medicare', 'exchange', 'self_funded', 'other');
  end if;

  -- Lifecycle status shared by billing_policy and code rules.
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'policy_status_enum' and n.nspname = 'code_intel') then
    create type code_intel.policy_status_enum as enum (
      'confirmed', 'test_open', 'test_discontinued', 'pending', 'suspended');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'claim_rule_type_enum' and n.nspname = 'code_intel') then
    create type code_intel.claim_rule_type_enum as enum (
      'allowed', 'required', 'mutually_exclusive', 'bundled',
      'not_separately_reimbursable', 'requires_prior_auth', 'informational_only');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'billing_role_enum' and n.nspname = 'code_intel') then
    create type code_intel.billing_role_enum as enum (
      'primary_service', 'accommodation', 'room_board', 'professional_component',
      'ancillary', 'assessment', 'detox', 'crisis', 'iop', 'php');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'unit_type_enum' and n.nspname = 'code_intel') then
    create type code_intel.unit_type_enum as enum (
      'per_diem', 'per_15_min', 'per_hour', 'per_session',
      'per_visit', 'per_unit', 'per_claim');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'change_type_enum' and n.nspname = 'code_intel') then
    create type code_intel.change_type_enum as enum (
      'code_added', 'code_deleted', 'code_revised',
      'policy_new', 'policy_updated', 'policy_retired',
      'rate_change', 'auth_rule_change', 'billing_rule_change');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'review_status_enum' and n.nspname = 'code_intel') then
    create type code_intel.review_status_enum as enum (
      'pending', 'accepted', 'rejected', 'needs_test', 'monitored');
  end if;
end $$;

-- ============================================================
-- CORE REFERENCE TABLES
-- ============================================================
create table if not exists code_intel.facility (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  short_code    text not null unique,
  state         char(2) not null,
  facility_type text,
  npi           text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint facility_name_len_ck  check (char_length(name) <= 200),
  constraint facility_short_len_ck check (char_length(short_code) <= 40),
  constraint facility_npi_ck       check (npi is null or npi ~ '^[0-9]{10}$')
);

create table if not exists code_intel.ref_code (
  id                 uuid primary key default gen_random_uuid(),
  code_type          code_intel.code_type_enum not null,
  code               text not null,
  short_desc         text not null,
  long_desc          text,
  service_domain     text,   -- sud, mh, dual_diagnosis, iop, php, residential
  setting            text,   -- residential, iop, php, outpatient, inpatient, detox
  unit_type          code_intel.unit_type_enum,
  is_active          boolean not null default true,
  -- CMS provenance (populated only for code_type = 'hcpcs' by the quarterly sync).
  cms_source_ref     text,   -- e.g. 'july-2026' — the CMS quarterly file this reflects
  cms_effective_date date,
  last_cms_check     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (code_type, code),
  constraint ref_code_code_len_ck check (char_length(code) between 1 and 12)
);

create table if not exists code_intel.ref_code_relationship (
  id                uuid primary key default gen_random_uuid(),
  parent_code_id    uuid not null references code_intel.ref_code(id) on delete cascade,
  child_code_id     uuid not null references code_intel.ref_code(id) on delete cascade,
  relationship_type text not null,   -- pairs_with, requires, mutually_exclusive, replaces
  clinical_context  text,
  created_at        timestamptz not null default now(),
  unique (parent_code_id, child_code_id, relationship_type),
  constraint ref_code_rel_not_self_ck check (parent_code_id <> child_code_id)
);

-- ============================================================
-- PAYER HIERARCHY
-- ============================================================
create table if not exists code_intel.payer (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  payer_type      code_intel.payer_type_enum not null,
  parent_payer_id uuid references code_intel.payer(id),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint payer_name_len_ck check (char_length(name) <= 200)
);

create table if not exists code_intel.payer_plan (
  id           uuid primary key default gen_random_uuid(),
  payer_id     uuid not null references code_intel.payer(id) on delete cascade,
  plan_name    text not null,
  state        char(2) not null,
  lob          code_intel.lob_enum not null,
  plan_type    text,   -- hmo, ppo, epo, pos, aso
  network_type text,   -- in_network, out_of_network, oon_contract
  alpha_prefix text,   -- e.g. BCBS routing prefixes
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint payer_plan_name_len_ck check (char_length(plan_name) <= 200)
);

-- Delegate / MCP / county / IPA relationships (who owns UM / financial risk).
create table if not exists code_intel.payer_entity_role (
  id                        uuid primary key default gen_random_uuid(),
  payer_plan_id             uuid not null references code_intel.payer_plan(id) on delete cascade,
  role_type                 text not null,   -- mcp, county_mhp, bh_delegate, ipa, tpa
  delegate_name             text,
  um_responsibility         boolean not null default false,
  financial_responsibility  boolean not null default false,
  notes                     text,
  created_at                timestamptz not null default now()
);

-- ============================================================
-- BILLING POLICY (versioned: facility × payer_plan × service × setting)
-- ============================================================
create table if not exists code_intel.billing_policy (
  id                   uuid primary key default gen_random_uuid(),
  facility_id          uuid not null references code_intel.facility(id),
  payer_plan_id        uuid not null references code_intel.payer_plan(id),
  service_domain       text not null,   -- sud, mh, dual_diagnosis
  setting              text not null,   -- residential, iop, php, detox
  effective_from       date not null,
  effective_to         date,            -- null = currently active
  status               code_intel.policy_status_enum not null default 'confirmed',
  reimbursement_method text,            -- per_diem, fee_schedule, case_rate, global_per_diem
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint billing_policy_effective_ck check (effective_to is null or effective_to >= effective_from)
);

-- Guard against two overlapping "currently active" (effective_to IS NULL) policies for
-- the same facility × plan × domain × setting. Historical (closed) versions are unconstrained.
create unique index if not exists billing_policy_one_open
  on code_intel.billing_policy (facility_id, payer_plan_id, service_domain, setting)
  where effective_to is null;

create table if not exists code_intel.billing_policy_code_rule (
  id                    uuid primary key default gen_random_uuid(),
  billing_policy_id     uuid not null references code_intel.billing_policy(id) on delete cascade,
  code_id               uuid not null references code_intel.ref_code(id),
  billing_role          code_intel.billing_role_enum not null,
  rule_type             code_intel.claim_rule_type_enum not null,
  required_with_code_id uuid references code_intel.ref_code(id),   -- paired code (rev <-> HCPCS)
  decision_date         date,
  test_status           code_intel.policy_status_enum not null default 'confirmed',
  dos_batch_rule        text,   -- single, range_2_3, range_5, range_10_11, bulk
  tob                   text,   -- type of bill: 86X, 133, 763, 117
  drg_code              text,
  modifier              text,   -- GT, 95, U1
  admit_type            text,
  condition_code        text,
  observed_per_diem     numeric(10,2),
  observed_allowed      numeric(12,2),
  observed_paid         numeric(12,2),
  sample_dos_count      int,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint bpcr_sample_ck check (sample_dos_count is null or sample_dos_count >= 0)
);

create table if not exists code_intel.billing_policy_claim_rule (
  id                   uuid primary key default gen_random_uuid(),
  billing_policy_id    uuid not null references code_intel.billing_policy(id) on delete cascade,
  bill_type            text,   -- institutional bill type: 111, 117, 131, 133, 86X
  pos                  text,   -- place of service
  requires_auth        boolean,
  auth_notes           text,
  bundling_rule        text,
  room_board_rule      text,   -- included_in_per_diem, separately_billed, not_covered
  drg_rule             text,
  modifier_rule        text,
  reimbursement_method text,
  notes                text,
  created_at           timestamptz not null default now()
);

-- ============================================================
-- SOURCE DOCUMENTS + EVIDENCE
-- ============================================================
create table if not exists code_intel.policy_source_document (
  id            uuid primary key default gen_random_uuid(),
  payer_plan_id uuid references code_intel.payer_plan(id),
  title         text not null,
  source_type   text not null,  -- payer_manual, cms_quarterly, state_medicaid, bulletin, observed_adjudication
  url           text,
  published_at  date,
  jurisdiction  text,
  created_at    timestamptz not null default now()
);

create table if not exists code_intel.policy_source_excerpt (
  id                   uuid primary key default gen_random_uuid(),
  document_id          uuid not null references code_intel.policy_source_document(id) on delete cascade,
  billing_policy_id    uuid references code_intel.billing_policy(id),
  section_ref          text,
  excerpt_text         text not null,
  normalized_fact_type text,   -- billing_rule, code_requirement, auth_rule, rate_info
  confidence           numeric(5,4),
  created_at           timestamptz not null default now(),
  constraint excerpt_conf_ck check (confidence is null or (confidence >= 0 and confidence <= 1))
);

-- ============================================================
-- POLICY CHANGE EVENT (the flag/alert layer)
-- ============================================================
create table if not exists code_intel.policy_change_event (
  id                   uuid primary key default gen_random_uuid(),
  source               text not null,   -- cms_quarterly, payer_bulletin, manual
  source_ref           text,            -- e.g. 'july-2026' CMS file id, bulletin URL
  payer_id             uuid references code_intel.payer(id),
  payer_plan_id        uuid references code_intel.payer_plan(id),
  facility_id          uuid references code_intel.facility(id),
  code_id              uuid references code_intel.ref_code(id),
  change_type          code_intel.change_type_enum not null,
  change_summary       text,
  previous_value       jsonb,
  new_value            jsonb,
  effective_date       date,
  detected_at          timestamptz not null default now(),
  reviewed_by          text,
  reviewed_at          timestamptz,
  review_status        code_intel.review_status_enum not null default 'pending',
  applied_to_policy_id uuid references code_intel.billing_policy(id),
  notes                text
);

-- Idempotency key for the sync job: the same (source_ref, code, change_type) can only
-- be flagged once. Lets the quarterly job use ON CONFLICT DO NOTHING so re-running a
-- quarter never duplicates flags. code_id is nullable, so key on it via coalesce is not
-- possible in a plain unique index — we instead key on (source, source_ref, code_id,
-- change_type) and rely on source_ref being set for machine-generated events. A partial
-- unique index over the machine sources enforces this without blocking manual dupes.
create unique index if not exists policy_change_event_dedup
  on code_intel.policy_change_event (source, source_ref, code_id, change_type)
  where source_ref is not null and code_id is not null;

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists idx_ref_code_code            on code_intel.ref_code (code);
create index if not exists idx_ref_code_type_code        on code_intel.ref_code (code_type, code);
create index if not exists idx_ref_code_active           on code_intel.ref_code (is_active) where is_active = true;
create index if not exists idx_ref_code_cms              on code_intel.ref_code (code_type, cms_source_ref) where code_type = 'hcpcs';

create index if not exists idx_billing_policy_facility   on code_intel.billing_policy (facility_id);
create index if not exists idx_billing_policy_plan       on code_intel.billing_policy (payer_plan_id);
create index if not exists idx_billing_policy_active     on code_intel.billing_policy (effective_to) where effective_to is null;

create index if not exists idx_bpcr_policy               on code_intel.billing_policy_code_rule (billing_policy_id);
create index if not exists idx_bpcr_code                 on code_intel.billing_policy_code_rule (code_id);
create index if not exists idx_bpcr_status               on code_intel.billing_policy_code_rule (test_status);

create index if not exists idx_pce_pending               on code_intel.policy_change_event (review_status) where review_status = 'pending';
create index if not exists idx_pce_code                  on code_intel.policy_change_event (code_id);
create index if not exists idx_pce_plan                  on code_intel.policy_change_event (payer_plan_id);
create index if not exists idx_pce_detected              on code_intel.policy_change_event (detected_at desc);

create index if not exists idx_payer_plan_payer          on code_intel.payer_plan (payer_id);
create index if not exists idx_payer_plan_state_lob      on code_intel.payer_plan (state, lob);

-- ============================================================
-- RLS + READER GRANTS
-- ============================================================
-- Every table has RLS enabled (defensive posture, matches claims/collections). The
-- GRANTs are the real privilege boundary. claims_reader gets SELECT everywhere for the
-- dashboard read path (via the RPCs in 0044). The code_intel_writer role + its write
-- policies are added in 0045 (mirrors how 0013 layers cmd_rollup_writer onto 0012).
grant usage on schema code_intel to claims_reader;

do $$
declare t text;
begin
  foreach t in array array[
    'facility','ref_code','ref_code_relationship','payer','payer_plan',
    'payer_entity_role','billing_policy','billing_policy_code_rule',
    'billing_policy_claim_rule','policy_source_document','policy_source_excerpt',
    'policy_change_event'
  ]
  loop
    execute format('alter table code_intel.%I enable row level security;', t);
    execute format('revoke all on code_intel.%I from claims_reader;', t);
    execute format('grant select on code_intel.%I to claims_reader;', t);
    execute format('drop policy if exists %I on code_intel.%I;', t || '_reader_read', t);
    execute format(
      'create policy %I on code_intel.%I for select to claims_reader using (true);',
      t || '_reader_read', t);
  end loop;
end $$;
