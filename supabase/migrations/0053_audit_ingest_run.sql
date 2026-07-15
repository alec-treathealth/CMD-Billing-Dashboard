-- 0053: claims.audit_ingest_run — per-run ingest observability (the durable fix for the
-- soak "log gap": the cron's per_customer array + writer_user + counts are response-body-only
-- today and unreachable from `vercel logs` by morning). Each successful roster-cron run writes
-- ONE summary row here so a morning health check reads straight from the DB.
--
-- ⚠️ DRAFT — NOT APPLIED until Alec's go (separate HOLD, per his 2026-07-14 ruling: "propose it
-- as its own small migration + cron write whenever convenient"). Rollback:
-- 0053_audit_ingest_run_rollback.sql (drops the table). 0053 was unclaimed (checked
-- origin/main + all worktrees + untracked + the reservation table).
--
-- NON-PHI: counts + column labels + the writer role name + the per_customer array (customer id,
-- facility LOG label, outcome, row counts, and CMD/DB error MESSAGES only — never a cell value).
-- Same discipline as the cron's in-memory stats, now persisted.
--
-- WRITE PATH: the claims_audit_writer role INSERTs it inside withTenant (GUC-checked writer RLS,
-- 0049 C-flip pattern); the write is FAIL-SOFT in the handler (a summary-write failure never
-- fails an ingest that already succeeded). Reader gets SELECT for a future ops surface.
--
-- APPLY PATH: postgres → SET ROLE claims_admin (owns claims.*); same mechanism as 0049/0051/0052.
-- Additive + empty on create, so applying ahead of the cron-write deploy is harmless (an
-- un-deployed cron simply never inserts). The cron-write code MUST NOT deploy before this applies.

set role claims_admin;

create table if not exists claims.audit_ingest_run (
  id                        bigint generated always as identity primary key,
  business_entity_id        uuid not null references core.business_entity (id) on delete restrict,
  scope                     text not null check (scope in ('IP', 'OP')),
  source_report_id          text not null,
  writer_user               text not null,          -- current_user asserted by the identity guard
  status                    text not null default 'ok' check (status in ('ok', 'partial')),
  started_at                timestamptz not null,
  finished_at               timestamptz not null default now(),
  customers_total           int not null default 0,
  customers_processed       int not null default 0,
  customers_failed          int not null default 0,
  customers_header_mismatch int not null default 0,
  customers_skipped_budget  int not null default 0,
  rows_fetched              int not null default 0,
  mapped_valid              int not null default 0,
  skipped                   int not null default 0,
  inserted                  int not null default 0,
  updated                   int not null default 0,
  all_rows_skipped_customers int not null default 0,
  per_customer              jsonb not null default '[]'::jsonb,  -- non-PHI outcome array
  created_at                timestamptz not null default now()
);

create index if not exists audit_ingest_run_recent_idx
  on claims.audit_ingest_run (business_entity_id, scope, finished_at desc);

-- Grants (mirror the 0049 audit-plane pattern): writer INSERT/SELECT, reader SELECT. No DELETE.
revoke all on claims.audit_ingest_run from public, anon, authenticated, service_role, claims_audit_writer;
grant select, insert on claims.audit_ingest_run to claims_audit_writer;
grant select          on claims.audit_ingest_run to claims_reader;

do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('claims.audit_ingest_run', 'id');
  if seq is not null then execute format('grant usage, select on sequence %s to claims_audit_writer', seq); end if;
end $$;

-- RLS: writer INSERT/SELECT GUC-checked (fails closed outside withTenant); reader SELECT permissive
-- (R1: app-layer tenant WHERE). Owner (claims_admin) bypasses its own table's RLS.
alter table claims.audit_ingest_run enable row level security;

drop policy if exists audit_ingest_run_reader_select on claims.audit_ingest_run;
create policy audit_ingest_run_reader_select on claims.audit_ingest_run
  for select to claims_reader using (true);

drop policy if exists audit_ingest_run_writer_select on claims.audit_ingest_run;
create policy audit_ingest_run_writer_select on claims.audit_ingest_run
  for select to claims_audit_writer
  using (business_entity_id = current_setting('app.business_entity_id')::uuid);

drop policy if exists audit_ingest_run_writer_insert on claims.audit_ingest_run;
create policy audit_ingest_run_writer_insert on claims.audit_ingest_run
  for insert to claims_audit_writer
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);

reset role;
