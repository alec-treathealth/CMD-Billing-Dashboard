-- =============================================================================
-- 0010_vob_ai_foundation.sql
-- CMD Billing Dashboard — VOB AI Intelligence Layer
--
-- Adds schemas: ref, vob, rag, audit
-- Access model: role-based (claims_reader / claims_admin), NOT JWT/org-scoped.
--   No Supabase Auth / PostgREST exposure — mirrors the pattern in 0003–0009.
--   All four schemas are revoked from public/anon/authenticated/service_role.
--
-- Apply 0009_aggregate_matviews.sql to hosted DB before applying this file.
--
-- PHI notes (runtime obligations — not enforced by DDL alone):
--   • vob.benefit_checks.patient_hash: must be a 64-char lowercase SHA-256 hex
--     digest before insert. A CHECK constraint enforces the format.
--   • rag.document_chunks.content: the ingestion pipeline MUST de-identify
--     content before chunking, OR treat this column as PHI-at-rest and scope
--     all access to claims_reader / claims_admin only (enforced below).
--   • vob.benefit_checks.notes, visit_limit_text, benefit_check_services.notes,
--     audit.ai_queries.user_prompt, audit.ai_answers.answer_text / answer_json:
--     treated as PHI-at-rest; protected by role grants below.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

create schema if not exists ref;
create schema if not exists vob;
create schema if not exists rag;
create schema if not exists audit;

comment on schema ref   is 'Reference dimensions for VOB and claims intelligence.';
comment on schema vob   is 'Verification of benefits operational and aggregate intelligence tables.';
comment on schema rag   is 'Document and chunk storage for role-gated retrieval augmented generation.';
comment on schema audit is 'Audited AI session, retrieval, and answer traces.';

-- ---------------------------------------------------------------------------
-- Extensions
-- pg_trgm (1.6, in schema claims) and pgcrypto (1.3, in schema extensions)
-- are already installed on this project — do not reinstall.
-- vector (0.8.0) is not yet installed — create it here.
-- ---------------------------------------------------------------------------

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- ref — normalized dimensions
-- ---------------------------------------------------------------------------

create table if not exists ref.payers (
  payer_id  bigint generated always as identity primary key,
  payer_name text   not null,
  payer_code text,
  payer_type text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (payer_name)
);

comment on table ref.payers is 'Normalized payer dimension.';

create table if not exists ref.plans (
  plan_id      bigint generated always as identity primary key,
  payer_id     bigint not null references ref.payers(payer_id),
  plan_name    text   not null,
  product_type text,
  funding_type text,
  network_type text,
  state_code   text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique nulls not distinct (payer_id, plan_name, state_code)
);

comment on table ref.plans is 'Normalized payer plan dimension.';

create table if not exists ref.service_codes (
  service_code_id bigint generated always as identity primary key,
  code_type       text   not null check (code_type in ('CPT','HCPCS','REV','OTHER')),
  code            text   not null,
  description     text,
  mh_sud_category text,
  active          boolean not null default true,
  unique (code_type, code)
);

comment on table ref.service_codes is 'Billable service codes used for VOB and claims analytics.';

create table if not exists ref.diagnosis_codes (
  diagnosis_code_id bigint generated always as identity primary key,
  icd10_code        text not null unique,
  description       text,
  active            boolean not null default true
);

comment on table ref.diagnosis_codes is 'ICD-10 diagnosis code dimension.';

create table if not exists ref.denial_codes (
  denial_code_id bigint generated always as identity primary key,
  code_system    text not null,
  code           text not null,
  description    text,
  denial_family  text,
  unique (code_system, code)
);

comment on table ref.denial_codes is 'Normalized denial reason and remittance code dimension.';

-- ---------------------------------------------------------------------------
-- vob — benefit check history and claim-line feature mart
-- ---------------------------------------------------------------------------

create table if not exists vob.benefit_checks (
  benefit_check_id     bigint generated always as identity primary key,
  -- patient_hash: runtime obligation — must be SHA-256(patient identifier)
  -- before insert. Format enforced by the check constraint below.
  patient_hash         text,
  payer_id             bigint references ref.payers(payer_id),
  plan_id              bigint references ref.plans(plan_id),
  provider_npi         text,
  billing_taxonomy     text,
  servicing_taxonomy   text,
  place_of_service     text,
  state_code           text,
  requested_at         timestamptz not null default now(),
  source_channel       text check (source_channel in ('portal','phone','fax','api','manual')),
  auth_required        boolean,
  auth_obtained        boolean,
  oop_benefits         boolean,
  telehealth_covered   boolean,
  deductible_individual  numeric(12,2),
  deductible_remaining   numeric(12,2),
  oop_max_individual     numeric(12,2),
  oop_remaining          numeric(12,2),
  coinsurance_percent    numeric(5,2),
  copay_amount           numeric(12,2),
  -- notes / visit_limit_text: PHI-at-rest — protected by role grants only
  visit_limit_text       text,
  notes                  text,
  verification_status    text not null default 'pending'
    check (verification_status in ('pending','verified','partially_verified','failed','superseded')),
  created_by             text,
  created_at             timestamptz not null default now(),
  -- Enforce SHA-256 hex format (same convention as query_log.identity_hash in 0004)
  constraint benefit_checks_patient_hash_ck
    check (patient_hash is null or patient_hash ~ '^[0-9a-f]{64}$')
);

comment on table vob.benefit_checks is 'Historical and live VOB events and benefit verification outcomes. patient_hash must be SHA-256 before insert.';

create table if not exists vob.benefit_check_services (
  benefit_check_service_id bigint generated always as identity primary key,
  benefit_check_id         bigint not null references vob.benefit_checks(benefit_check_id) on delete cascade,
  service_code_id          bigint not null references ref.service_codes(service_code_id),
  units                    integer,
  auth_required            boolean,
  medically_necessary      boolean,
  coverage_status          text check (coverage_status in ('covered','not_covered','unclear','conditional')),
  reimbursement_basis      text,
  notes                    text   -- PHI-at-rest; protected by role grants
);

comment on table vob.benefit_check_services is 'Service-line detail captured during benefit checks.';

create table if not exists vob.claim_line_features (
  claim_line_feature_id bigint generated always as identity primary key,
  claim_id              bigint not null,
  claim_line_id         bigint,
  payer_id              bigint references ref.payers(payer_id),
  plan_id               bigint references ref.plans(plan_id),
  service_code_id       bigint references ref.service_codes(service_code_id),
  diagnosis_code_id     bigint references ref.diagnosis_codes(diagnosis_code_id),
  date_of_service       date,
  place_of_service      text,
  billed_amount         numeric(12,2),
  allowed_amount        numeric(12,2),
  paid_amount           numeric(12,2),
  patient_responsibility numeric(12,2),
  denial_code_id        bigint references ref.denial_codes(denial_code_id),
  auth_on_file          boolean,
  final_status          text,
  turnaround_days       integer,
  created_at            timestamptz not null default now()
);

comment on table vob.claim_line_features is 'Claim-line feature mart for historical VOB and reimbursement intelligence. Backfill from claims.claims via ETL.';

-- ---------------------------------------------------------------------------
-- rag — document metadata and pgvector chunks
-- PHI note: content must be de-identified before chunking, OR treated as
-- PHI-at-rest. Access is restricted to claims_reader / claims_admin only
-- (PostgREST / authenticated are explicitly revoked below).
-- ---------------------------------------------------------------------------

create table if not exists rag.documents (
  document_id     bigint generated always as identity primary key,
  doc_type        text not null check (doc_type in ('payer_policy','benefit_fax','call_note','sop','portal_screenshot_text','appeal_template')),
  payer_id        bigint references ref.payers(payer_id),
  plan_id         bigint references ref.plans(plan_id),
  title           text not null,
  source_uri      text,
  effective_date  date,
  expiration_date date,
  -- access_tier is advisory metadata; enforcement is via role grants below
  access_tier     text not null default 'phi_restricted',
  created_at      timestamptz not null default now()
);

comment on table rag.documents is 'Metadata for payer policies, notes, SOPs, and other retrieval documents.';

create table if not exists rag.document_chunks (
  chunk_id      bigint generated always as identity primary key,
  document_id   bigint  not null references rag.documents(document_id) on delete cascade,
  chunk_index   integer not null,
  -- content: treat as PHI-at-rest unless ingestion pipeline explicitly de-identifies
  content       text    not null,
  token_count   integer,
  embedding     extensions.vector(1536),
  metadata      jsonb   not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (document_id, chunk_index)
);

comment on table rag.document_chunks is 'Chunked retrieval corpus with pgvector embeddings. Content is PHI-at-rest unless pipeline de-identifies before insert.';

-- ---------------------------------------------------------------------------
-- audit — AI session, query, retrieval, and answer traces
-- user_prompt, answer_text, answer_json: PHI-at-rest; role-gated below.
-- ---------------------------------------------------------------------------

create table if not exists audit.ai_sessions (
  ai_session_id uuid        primary key default gen_random_uuid(),
  user_id       uuid,
  session_type  text        not null check (session_type in ('vob','claim_search','clinical_support')),
  started_at    timestamptz not null default now()
);

comment on table audit.ai_sessions is 'Top-level audited AI sessions.';

create table if not exists audit.ai_queries (
  ai_query_id        uuid    primary key default gen_random_uuid(),
  ai_session_id      uuid    not null references audit.ai_sessions(ai_session_id) on delete cascade,
  -- user_prompt: PHI-at-rest (a question may name a patient)
  user_prompt        text    not null,
  normalized_prompt  jsonb,
  requested_payer_id bigint  references ref.payers(payer_id),
  requested_plan_id  bigint  references ref.plans(plan_id),
  created_at         timestamptz not null default now()
);

comment on table audit.ai_queries is 'Each AI request, including normalized extraction payloads. user_prompt is PHI-at-rest.';

create table if not exists audit.ai_retrieval_events (
  retrieval_event_id bigint generated always as identity primary key,
  ai_query_id        uuid   not null references audit.ai_queries(ai_query_id) on delete cascade,
  retrieval_type     text   not null check (retrieval_type in ('sql','aggregate','vector','tool')),
  target_name        text   not null,
  applied_filters    jsonb  not null default '{}'::jsonb,
  result_count       integer,
  created_at         timestamptz not null default now()
);

comment on table audit.ai_retrieval_events is 'Structured trace of retrieval actions used to build an answer.';

create table if not exists audit.ai_answers (
  ai_answer_id         bigint generated always as identity primary key,
  ai_query_id          uuid    not null references audit.ai_queries(ai_query_id) on delete cascade,
  -- answer_text / answer_json: PHI-at-rest
  answer_text          text    not null,
  answer_json          jsonb   not null,
  confidence_score     numeric(5,4),
  human_review_required boolean not null default true,
  created_at           timestamptz not null default now()
);

comment on table audit.ai_answers is 'Persisted AI answer payloads for later review and QA. human_review_required defaults true.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists idx_ref_plans_payer
  on ref.plans(payer_id);

create index if not exists idx_vob_benefit_checks_lookup
  on vob.benefit_checks(payer_id, plan_id, state_code, place_of_service, requested_at desc);

create index if not exists idx_vob_claim_line_features_dos
  on vob.claim_line_features(date_of_service desc);

create index if not exists idx_vob_claim_line_features_lookup
  on vob.claim_line_features(payer_id, plan_id, service_code_id, place_of_service, date_of_service);

create index if not exists idx_vob_claim_line_features_claim
  on vob.claim_line_features(claim_id, claim_line_id);

create index if not exists idx_rag_documents_lookup
  on rag.documents(payer_id, plan_id, doc_type, effective_date desc);

create index if not exists idx_rag_document_chunks_doc
  on rag.document_chunks(document_id, chunk_index);

-- HNSW vector index for cosine similarity search
create index if not exists idx_rag_document_chunks_hnsw
  on rag.document_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- Trigram index for keyword search within chunk content.
-- pg_trgm lives in schema claims (installed by 0003) on this project.
create index if not exists idx_rag_document_chunks_content_trgm
  on rag.document_chunks using gin (content claims.gin_trgm_ops);

create index if not exists idx_audit_ai_queries_session
  on audit.ai_queries(ai_session_id, created_at desc);

create index if not exists idx_audit_ai_answers_query
  on audit.ai_answers(ai_query_id);

-- ---------------------------------------------------------------------------
-- Materialized views
-- ---------------------------------------------------------------------------

create materialized view if not exists vob.mv_payer_plan_service_stats as
select
  payer_id,
  plan_id,
  service_code_id,
  place_of_service,
  count(*)                                                         as claim_count,
  avg(allowed_amount)                                              as avg_allowed_amount,
  percentile_cont(0.5) within group (order by allowed_amount)      as median_allowed_amount,
  avg(case when auth_on_file  then 1.0 else 0.0 end)               as auth_on_file_rate,
  avg(case when final_status = 'denied' then 1.0 else 0.0 end)     as denial_rate,
  avg(turnaround_days)                                             as avg_turnaround_days
from vob.claim_line_features
where payer_id is not null
  and plan_id is not null
  and service_code_id is not null
group by 1,2,3,4;

comment on materialized view vob.mv_payer_plan_service_stats
  is 'Historical service-level reimbursement and authorization performance summary. Refresh via vob.refresh_ai_matviews().';

create unique index if not exists idx_mv_pps_stats_unique
  on vob.mv_payer_plan_service_stats(payer_id, plan_id, service_code_id, place_of_service);

-- NOTE: the original submitted migration contained `group by 1,2,3,4,5` here
-- which is invalid (position 5 is count(*), an aggregate — not groupable).
-- The hosted DB has the correct 4-column GROUP BY, indicating the fix was
-- applied before or during execution. This file corrects that to match the DB.
create materialized view if not exists vob.mv_denial_patterns as
select
  payer_id,
  plan_id,
  service_code_id,
  denial_code_id,
  count(*) as denial_count
from vob.claim_line_features
where final_status = 'denied'
  and denial_code_id is not null
group by 1,2,3,4;

comment on materialized view vob.mv_denial_patterns
  is 'Historical denial patterns by payer, plan, and service. Refresh via vob.refresh_ai_matviews().';

create unique index if not exists idx_mv_denial_patterns_unique
  on vob.mv_denial_patterns(payer_id, plan_id, service_code_id, denial_code_id);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Hybrid semantic + filter retrieval over rag.document_chunks.
-- Accessible to claims_reader (read path) and claims_admin.
create or replace function rag.match_document_chunks (
  p_query_embedding extensions.vector(1536),
  p_match_count      integer  default 8,
  p_payer_id         bigint   default null,
  p_plan_id          bigint   default null,
  p_doc_types        text[]   default null
)
returns table (
  chunk_id       bigint,
  document_id    bigint,
  title          text,
  content        text,
  similarity     double precision,
  doc_type       text,
  payer_id       bigint,
  plan_id        bigint,
  effective_date date
)
language sql
stable
security definer
set search_path = rag, ref, extensions, pg_temp
as $$
  select
    dc.chunk_id,
    d.document_id,
    d.title,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity,
    d.doc_type,
    d.payer_id,
    d.plan_id,
    d.effective_date
  from rag.document_chunks dc
  join rag.documents d on d.document_id = dc.document_id
  where (p_payer_id  is null or d.payer_id   = p_payer_id)
    and (p_plan_id   is null or d.plan_id    = p_plan_id)
    and (p_doc_types is null or d.doc_type   = any(p_doc_types))
    and (d.expiration_date is null or d.expiration_date >= current_date)
  order by dc.embedding <=> p_query_embedding
  limit greatest(p_match_count, 1)
$$;

comment on function rag.match_document_chunks(extensions.vector(1536), integer, bigint, bigint, text[])
  is 'Filtered semantic retrieval for payer and plan scoped document chunks. Pushes filters into SQL before HNSW scan.';

-- Structured historical VOB evidence lookup from precomputed matview.
create or replace function vob.get_service_history (
  p_payer_id         bigint,
  p_plan_id          bigint,
  p_service_code_id  bigint,
  p_place_of_service text default null
)
returns table (
  claim_count            bigint,
  avg_allowed_amount     numeric,
  median_allowed_amount  numeric,
  auth_on_file_rate      numeric,
  denial_rate            numeric,
  avg_turnaround_days    numeric
)
language sql
stable
security definer
set search_path = vob, pg_temp
as $$
  select
    claim_count,
    avg_allowed_amount,
    median_allowed_amount,
    auth_on_file_rate,
    denial_rate,
    avg_turnaround_days
  from vob.mv_payer_plan_service_stats
  where payer_id        = p_payer_id
    and plan_id         = p_plan_id
    and service_code_id = p_service_code_id
    and (p_place_of_service is null or place_of_service = p_place_of_service)
$$;

comment on function vob.get_service_history(bigint, bigint, bigint, text)
  is 'Returns historical reimbursement and authorization stats for a payer/plan/service tuple from the precomputed matview.';

-- Refresh all VOB AI matviews. Must be owned by postgres (the migration role)
-- to hold SECURITY DEFINER rights over matviews it owns.
-- Grant EXECUTE to claims_admin (the role that runs ingest / refresh in src/db.ts).
-- Uses CONCURRENTLY so readers are not blocked (requires the unique indexes above).
create or replace function vob.refresh_ai_matviews()
returns void
language plpgsql
security definer
set search_path = vob, pg_temp
as $$
begin
  refresh materialized view concurrently vob.mv_payer_plan_service_stats;
  refresh materialized view concurrently vob.mv_denial_patterns;
end;
$$;

comment on function vob.refresh_ai_matviews()
  is 'Refreshes VOB materialized views concurrently (non-blocking). Call from the daily CMD ingest after claims_admin refresh of existing matviews.';

-- ---------------------------------------------------------------------------
-- Grants — mirror the role model from 0003–0009
-- Revoke from public/anon/authenticated/service_role first, then grant only
-- to claims_reader (read/query path) and claims_admin (ingest/write/refresh).
-- PostgREST never touches these schemas — same as the claims schema.
-- ---------------------------------------------------------------------------

-- Schemas
revoke all on schema ref   from public, anon, authenticated, service_role;
revoke all on schema vob   from public, anon, authenticated, service_role;
revoke all on schema rag   from public, anon, authenticated, service_role;
revoke all on schema audit from public, anon, authenticated, service_role;

grant usage on schema ref   to claims_reader, claims_admin;
grant usage on schema vob   to claims_reader, claims_admin;
grant usage on schema rag   to claims_reader, claims_admin;
grant usage on schema audit to claims_reader, claims_admin;

-- ref tables — read for both roles, write for admin
grant select on
  ref.payers, ref.plans, ref.service_codes, ref.diagnosis_codes, ref.denial_codes
  to claims_reader, claims_admin;

grant insert, update on
  ref.payers, ref.plans, ref.service_codes, ref.diagnosis_codes, ref.denial_codes
  to claims_admin;

grant usage on all sequences in schema ref to claims_admin;

-- vob tables
grant select on vob.benefit_checks, vob.benefit_check_services, vob.claim_line_features
  to claims_reader, claims_admin;

grant insert, update on vob.benefit_checks, vob.benefit_check_services, vob.claim_line_features
  to claims_admin;

grant usage on all sequences in schema vob to claims_admin;

-- vob matviews
grant select on vob.mv_payer_plan_service_stats, vob.mv_denial_patterns
  to claims_reader, claims_admin;

-- rag tables
grant select on rag.documents, rag.document_chunks to claims_reader, claims_admin;
grant insert, update on rag.documents, rag.document_chunks to claims_admin;
grant usage on all sequences in schema rag to claims_admin;

-- audit tables
grant select on
  audit.ai_sessions, audit.ai_queries, audit.ai_retrieval_events, audit.ai_answers
  to claims_reader, claims_admin;

grant insert on
  audit.ai_sessions, audit.ai_queries, audit.ai_retrieval_events, audit.ai_answers
  to claims_admin;

grant usage on all sequences in schema audit to claims_admin;

-- functions
-- NOTE: REVOKE EXECUTE FROM PUBLIC is intentionally absent here to match the
-- state that was applied to the hosted DB. The proacl on all three functions
-- includes `=X/postgres` (PUBLIC EXECUTE). A follow-on migration
-- 0011_vob_function_revoke.sql should add the revokes for defense-in-depth.
-- See audit report for corrective SQL.
grant execute on function rag.match_document_chunks(extensions.vector(1536), integer, bigint, bigint, text[])
  to claims_reader, claims_admin;

grant execute on function vob.get_service_history(bigint, bigint, bigint, text)
  to claims_reader, claims_admin;

grant execute on function vob.refresh_ai_matviews()
  to claims_admin;

-- ---------------------------------------------------------------------------
-- RLS
-- Role-based, not JWT/org-scoped (no Supabase Auth / JWT tenancy in project).
-- claims_reader gets unrestricted SELECT (same as claims schema in 0003).
-- claims_admin bypasses RLS entirely (same as 0003: set row_security = off).
-- Write policies are omitted — writes go through claims_admin which bypasses RLS.
-- ref tables intentionally omitted: they are read-only reference dimensions
-- with no PHI and are protected by table-level grants only (same pattern as
-- the existing claims non-PHI views in 0009).
-- ---------------------------------------------------------------------------

alter table vob.benefit_checks          enable row level security;
alter table vob.benefit_check_services  enable row level security;
alter table vob.claim_line_features     enable row level security;
alter table rag.documents               enable row level security;
alter table rag.document_chunks         enable row level security;
alter table audit.ai_sessions           enable row level security;
alter table audit.ai_queries            enable row level security;
alter table audit.ai_retrieval_events   enable row level security;
alter table audit.ai_answers            enable row level security;

-- claims_reader: full SELECT on all new tables (mirrors 0003 pattern)
drop policy if exists vob_benefit_checks_reader_select          on vob.benefit_checks;
drop policy if exists vob_benefit_check_services_reader_select  on vob.benefit_check_services;
drop policy if exists vob_claim_line_features_reader_select     on vob.claim_line_features;
drop policy if exists rag_documents_reader_select               on rag.documents;
drop policy if exists rag_document_chunks_reader_select         on rag.document_chunks;
drop policy if exists audit_ai_sessions_reader_select           on audit.ai_sessions;
drop policy if exists audit_ai_queries_reader_select            on audit.ai_queries;
drop policy if exists audit_ai_retrieval_events_reader_select   on audit.ai_retrieval_events;
drop policy if exists audit_ai_answers_reader_select            on audit.ai_answers;

create policy vob_benefit_checks_reader_select
  on vob.benefit_checks for select to claims_reader using (true);

create policy vob_benefit_check_services_reader_select
  on vob.benefit_check_services for select to claims_reader using (true);

create policy vob_claim_line_features_reader_select
  on vob.claim_line_features for select to claims_reader using (true);

create policy rag_documents_reader_select
  on rag.documents for select to claims_reader using (true);

create policy rag_document_chunks_reader_select
  on rag.document_chunks for select to claims_reader using (true);

create policy audit_ai_sessions_reader_select
  on audit.ai_sessions for select to claims_reader using (true);

create policy audit_ai_queries_reader_select
  on audit.ai_queries for select to claims_reader using (true);

create policy audit_ai_retrieval_events_reader_select
  on audit.ai_retrieval_events for select to claims_reader using (true);

create policy audit_ai_answers_reader_select
  on audit.ai_answers for select to claims_reader using (true);

commit;
