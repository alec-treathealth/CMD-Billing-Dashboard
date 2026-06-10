-- Phase 1: Historical Claims Search System — raw landing + typed claims.
-- Schema is verbatim from CLAUDE.md "Schema"; IF NOT EXISTS per migration rules.
-- Applied to project dbpabchpvipipkzkogta (cmd-billing-dashboard) via Supabase MCP.

create extension if not exists pg_trgm;

create table if not exists claims_raw (
  id              bigint generated always as identity primary key,
  source_year     smallint  not null,
  source_file_id  text      not null,
  source_row_num  integer   not null,
  ingested_at     timestamptz not null default now(),
  raw             jsonb     not null,
  unique (source_file_id, source_row_num)
);

create table if not exists claims (
  id              bigint generated always as identity primary key,
  claims_raw_id   bigint not null references claims_raw(id),
  source_year     smallint not null,

  facility_name   text not null,
  date_of_service date not null,
  hcpcs_code      text,
  revenue_code    text,
  patient_name    text not null,
  patient_last    text not null,
  patient_first   text not null,
  member_id_raw   text,
  member_id_norm  text,
  group_number    text,
  employer_name   text,

  charge_amount   numeric(12,2),
  allowed_amount  numeric(12,2),
  paid_amount     numeric(12,2),
  adjustment      numeric(12,2),
  balance_due_pt  numeric(12,2),
  payer_name      text not null,

  collection_rate numeric(6,4)
    generated always as (
      case when allowed_amount is not null and allowed_amount <> 0
           then paid_amount / allowed_amount end
    ) stored,

  created_at      timestamptz not null default now()
);

create index if not exists claims_patient_trgm  on claims using gin (patient_name gin_trgm_ops);
create index if not exists claims_facility_trgm on claims using gin (facility_name gin_trgm_ops);
create index if not exists claims_payer_trgm    on claims using gin (payer_name gin_trgm_ops);
create index if not exists claims_member_norm   on claims (member_id_norm);
create index if not exists claims_dos           on claims (date_of_service);
create index if not exists claims_facility_payer on claims (facility_name, payer_name);
