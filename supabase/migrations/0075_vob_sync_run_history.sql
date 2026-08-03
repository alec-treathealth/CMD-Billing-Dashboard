-- 0075 — vob.sync_run: append-only per-run history for the Monday -> vob.indigo_vob sync.
--
-- WHY: vob.sync_state (0062) is keyed `source text primary key`, so it holds exactly ONE row per
-- feed and can only ever answer "how did the LAST run go". That blind spot is not hypothetical —
-- it is why a real defect went unnoticed for ~2 weeks. Monday's items(ids:) carries an undocumented
-- default limit of 25 (MEASURED 2026-08-03: request 26 -> 25 returned, 50 -> 25, 60 -> 25; with an
-- explicit limit all are returned), so the sync's 50-id chunks silently dropped their last 25 ids
-- every run. Dropped items were never inserted, stayed "new", and were re-dropped next run.
-- Reconciles exactly against both observed runs:
--   2026-08-01  182 new/changed -> 4 chunks -> 100 returned, 2 genuinely unattached -> 98 upserted / 84 "no_pdf"
--   2026-08-02   36 new/changed -> 1 chunk  ->  25 returned, same 2 unattached        -> 23 upserted / 13 "no_pdf"
-- Against a single-row state table a stable errors=84 reads as a steady state rather than a bug.
-- With history, the same data is an obvious flat line that never drains. The ETL fix (explicit
-- limit + an api_missing counter) ships in etl/vob/vob_cron_sync.py; this table is how we SEE it.
--
-- PHI DISCIPLINE: counts and a free-text ops note ONLY. No member id, no employer, no file name, no
-- Monday item id, no URL. The note is assembled from fixed literals + integers in the ETL
-- (never from row data), mirroring the collections.cmd_census_run error_label discipline.
-- OWNERSHIP: apply as `postgres`, which OWNS schema vob — do NOT wrap this in SET ROLE
-- claims_admin the way the claims/collections migrations do. claims_admin has no privileges on
-- vob and the create fails with 42501 (confirmed on the first apply attempt). 0062 / 0064 / 0065
-- are the precedent: every vob migration runs unwrapped as postgres.
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY;
-- GRANTs are unconditional and repeatable. Safe to re-run.
-- DEPENDENCY: 0062 (vob.sync_state, establishes the feed + the cmd_rollup_writer grant pattern),
-- 0065 (the RLS policy shape mirrored below). No data migration — history starts at first run.
-- Rollback: 0075_vob_sync_run_history_rollback.sql

-- 1. The append-only run log ------------------------------------------------------------------

create table if not exists vob.sync_run (
  id             bigint generated always as identity primary key,
  source         text        not null,             -- 'indigo_monday_1606316049' (matches sync_state.source)
  ran_at         timestamptz not null default now(),
  board_items    integer,                          -- items scanned on the board
  admitted       integer,                          -- items with a facility set
  to_process     integer,                          -- new + changed this run (the denominator for the split below)
  upserted       integer,                          -- downloaded + extracted + written
  deactivated    integer,                          -- soft-deleted (de-admitted / off-board)
  reactivated    integer,                          -- cleared back to active (re-admitted)
  -- The error split. Previously all three collapsed into sync_state.errors, which is precisely how
  -- an API truncation hid inside what looked like a PDF-attachment problem.
  no_pdf         integer,                          -- API RETURNED the item; it has no files4 attachment yet
  download_fail  integer,                          -- URL resolved but the download/extract threw
  api_missing    integer,                          -- API did NOT return a requested id (the truncation class)
  note           text                              -- ops note — NO PHI
);

-- Trend reads are always "this feed, most recent first".
create index if not exists sync_run_source_ran_at on vob.sync_run (source, ran_at desc);

-- 2. RLS — same permissive shape as vob.indigo_vob (0060) and vob.sync_state (0065) -------------
-- Supabase enables RLS on tables in API-exposed schemas, and a table with RLS on but no policies
-- default-DENIES the writer (the 0065 incident). Declare both policies explicitly.

alter table vob.sync_run enable row level security;

drop policy if exists vob_sync_run_rw on vob.sync_run;
create policy vob_sync_run_rw on vob.sync_run
  for all to cmd_rollup_writer
  using (true) with check (true);

drop policy if exists vob_sync_run_ro on vob.sync_run;
create policy vob_sync_run_ro on vob.sync_run
  for select to claims_reader, consolidated_reader
  using (true);

-- 3. Grants ------------------------------------------------------------------------------------
-- Append-only by privilege, not just by convention: the writer gets INSERT but NOT update/delete,
-- so a run row cannot be rewritten after the fact. Identity column needs USAGE on its sequence.

grant select, insert on vob.sync_run to cmd_rollup_writer;
grant usage, select on all sequences in schema vob to cmd_rollup_writer;
grant select on vob.sync_run to claims_reader, consolidated_reader;

-- 4. Verification (run manually after apply)
--
-- -- table + policies exist, writer has INSERT but not UPDATE/DELETE
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='vob' and table_name='sync_run' order by grantee, privilege_type;
-- select polname, polcmd from pg_policy where polrelid = 'vob.sync_run'::regclass;
--
-- -- after the next scheduled run (09:17 UTC), the fix is proven by api_missing = 0
-- -- with to_process > 25 — i.e. a chunk that WOULD have been truncated before:
-- select ran_at, to_process, upserted, no_pdf, download_fail, api_missing, note
--   from vob.sync_run where source = 'indigo_monday_1606316049'
--  order by ran_at desc limit 10;
--
-- -- the standing backlog should converge to the genuinely-unattached items (2 as of 2026-08-03):
-- select (select admitted from vob.sync_state where source='indigo_monday_1606316049')
--        - (select count(*) from vob.indigo_vob) as never_ingested;
