-- 0087 — collections.qualify_census_run: a durable run-log for the monday census sync.
--
-- WHY: /api/cron/qualify-census is the only Qualify-plane cron with no run table, and its
--   failure mode is silent by construction. runQualifyCensusSync catches PER BOARD
--   (src/collections/qualifyCensusSync.ts:207-212) and the route returns HTTP 200 with counts
--   (route.ts:41-42). So a dead MONDAY_SECRET_API_KEY produces:
--     200 OK  { boards_total: 2, boards_synced: 0, boards_failed: 2 }
--   — a success status code, an empty-but-present table, and the Qualify auth-fit factor showing
--   "no data yet" for every facility, which is EXACTLY what an uncurated board looks like. The two
--   states are indistinguishable on the surface. The only distinguishing signal today is a
--   console.error line, and CLAUDE.md records that Vercel logs are 403-scoped away from this
--   project. Sibling crons already solved this: collections.rollup_refresh_run (0054) and
--   collections.cmd_census_run (0058). This extends that pattern; it does NOT complete it —
--   cmd-explorer, indigo-explorer, cmd-explorer-catchup, refresh-cmd-payer and reconcile-deposits
--   all write collections.* tables and still have no run table.
--
-- MEASURED 2026-08-05, the reason this is not hypothetical: the cron IS scheduled — hourly at :22
--   in app/vercel.json, live on main since PR #109 — and collections.qualify_facility_census was
--   still EMPTY (0 rows) after three consecutive :22 ticks with a valid MONDAY_SECRET_API_KEY
--   present in Vercel Production. Running the identical sync by hand
--   (scripts/run-qualify-census.ts, 09:57 UTC) wrote both facilities on the first attempt. So the
--   deployed cron and a hand-run of the same code disagree, and the database cannot say why: there
--   is no record that the cron ever ran at all. That is the gap this table closes.
--
-- STATUS TAXONOMY — three states, because "partial" is the interesting one:
--     'ok'      every configured board synced, no conformance gap. A zero-board config is also
--               'ok' — nothing to sync is not an incident (see deriveCensusRunStatus).
--     'partial' at least one board synced AND at least one failed — stale-but-present aggregates.
--               ALSO: every board synced but at least one had missing columns
--               (conformance_gap_boards > 0), which writes zeros over good data. See that column.
--     'failed'  at least one board configured and none synced, or the sync threw before the loop
--               (bad token, monday outage).
--   'partial' is the state the old console-only posture hid best: the factor keeps working for
--   some facilities while silently rotting for others.
--
-- DURABILITY MODEL (lifted verbatim in spirit from refreshChargeRollup.ts:12-18): the start row is
--   INSERTed FIRST as its own autocommit statement, BEFORE any monday I/O. If a platform timeout
--   kills the function mid-run, neither the success nor the failure UPDATE lands, leaving a row
--   with finished_at IS NULL — the "started but never finished" signal. That row is the evidence a
--   pure try/catch cannot produce, because a hard kill runs no catch block.
--
-- PHI DISCIPLINE: none, end to end. The census GraphQL selection asks for `column_values` only and
--   never item names (which on census boards are patient names) — see qualifyCensusSync.ts's PHI
--   POSTURE header. This table stores counts, timestamps, a status enum, and a BOUNDED error label.
--   `error_label` is capped at 200 chars by CHECK and is fed monday's error MESSAGE only, never a
--   response body and never a column value. Facility-info names ARE facility names (non-PHI) and
--   are counted here, not stored.
--
-- OWNERSHIP: postgres. ⚠ MEASURED — every live collections relation is relowner=postgres. Do NOT
--   add `SET ROLE claims_admin`: in this plane it downgrades the applying role from owner to
--   non-owner and fails 42501. That trap cost two failed applies on 0084/0085 (2026-08-05); the
--   generic "born owned via SET ROLE" guidance in .claude/rules/sql-migrations.md describes the
--   `claims` schema, not this one.
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS, DROP POLICY before CREATE POLICY, grants
--   reapplied unconditionally. Re-running converges.
-- DEPENDENCY: none. Purely additive — no existing object is altered, so this can apply before or
--   after the cron is ever scheduled, and applying it changes no behavior on its own.
-- Rollback: 0087_qualify_census_run_rollback.sql

-- 1. Table ---------------------------------------------------------------------------
create table if not exists collections.qualify_census_run (
  id                       bigint generated always as identity primary key,
  started_at               timestamptz not null default now(),
  finished_at              timestamptz,
  duration_ms              integer,
  -- NULL until the run closes; a non-null status with a null finished_at is impossible by
  -- construction (both are written by the same UPDATE).
  status                   text,
  boards_total             integer not null default 0,
  boards_synced            integer not null default 0,
  boards_failed            integer not null default 0,
  capacity_mapped          integer not null default 0,
  capacity_unmapped_count  integer not null default 0,
  -- Boards that synced but whose expected monday column titles did not all resolve. This is the
  -- quietest failure the sync has: resolveCensusColumns returns every id null, the item fetch is
  -- SKIPPED entirely (ids = []), aggregateCensusItems([]) yields zeros, and the upsert overwrites a
  -- good facility row with those zeros AND a fresh synced_at — while boards_synced is incremented,
  -- so the run would otherwise read a clean 'ok'. stats.conformance was the only evidence this
  -- happened and it was in-memory only. Non-zero here forces status to 'partial'.
  conformance_gap_boards   integer not null default 0,
  error_label              text,
  triggered_by             text not null default 'cron',
  constraint qualify_census_run_status_ck
    check (status is null or status in ('ok', 'partial', 'failed')),
  constraint qualify_census_run_triggered_by_ck
    check (triggered_by in ('cron', 'manual')),
  -- Bounded so a monday error message can never balloon a row. Truncation happens app-side.
  constraint qualify_census_run_error_len_ck
    check (error_label is null or char_length(error_label) <= 200),
  -- finished_at and status are written together; neither may appear without the other.
  constraint qualify_census_run_finish_pair_ck
    check ((finished_at is null) = (status is null))
);

-- The health-check read is "newest runs first"; nothing else queries this table.
create index if not exists qualify_census_run_started_at
  on collections.qualify_census_run (started_at desc);

comment on table collections.qualify_census_run is
  'Durable run-log for /api/cron/qualify-census (monday census sync). One row per attempt, '
  'inserted BEFORE any monday I/O so a platform kill leaves finished_at NULL rather than no '
  'evidence. status: ok | partial | failed. No PHI — counts, timestamps and a bounded error label.';

-- 2. RLS + grants --------------------------------------------------------------------
-- Mirrors rollup_refresh_run (0054): the writer needs INSERT + UPDATE, the reader needs SELECT so
-- the morning health check is answerable from the app's own role. NOT tenant-scoped: one sync
-- covers every configured board across the roster, so there is no business_entity_id to scope by
-- and the writer policies are permissive by design — the same ruling 0054 made.
alter table collections.qualify_census_run enable row level security;

drop policy if exists qualify_census_run_reader_select on collections.qualify_census_run;
create policy qualify_census_run_reader_select
  on collections.qualify_census_run
  for select to claims_reader
  using (true);

drop policy if exists qualify_census_run_writer_insert on collections.qualify_census_run;
create policy qualify_census_run_writer_insert
  on collections.qualify_census_run
  for insert to cmd_rollup_writer
  with check (true);

drop policy if exists qualify_census_run_writer_update on collections.qualify_census_run;
create policy qualify_census_run_writer_update
  on collections.qualify_census_run
  for update to cmd_rollup_writer
  using (true) with check (true);

drop policy if exists qualify_census_run_writer_select on collections.qualify_census_run;
create policy qualify_census_run_writer_select
  on collections.qualify_census_run
  for select to cmd_rollup_writer
  using (true);

revoke all on collections.qualify_census_run from public, anon, authenticated, service_role;
grant select on collections.qualify_census_run to claims_reader;
grant select, insert, update on collections.qualify_census_run to cmd_rollup_writer;
-- The identity column's implicit sequence needs no separate grant (GENERATED ALWAYS AS IDENTITY
-- is covered by the table INSERT privilege, unlike a serial's owned sequence).

-- 3. Verification (run manually after apply) --------------------------------------------
-- Object shape:
--   select column_name, data_type from information_schema.columns
--    where table_schema='collections' and table_name='qualify_census_run' order by ordinal_position;
--   select conname from pg_constraint where conrelid='collections.qualify_census_run'::regclass;
--
-- Constraint teeth (each must FAIL):
--   insert into collections.qualify_census_run (status) values ('bogus');            -- status_ck
--   insert into collections.qualify_census_run (triggered_by) values ('robot');      -- triggered_by_ck
--   insert into collections.qualify_census_run (finished_at) values (now());         -- finish_pair_ck
--   insert into collections.qualify_census_run (error_label) values (repeat('x',201)); -- error_len_ck
--
-- THE HEALTH CHECK this table exists to make possible — the morning question, answerable by SELECT
-- with zero Vercel-log access:
--   select id, started_at, status, boards_synced, boards_failed, conformance_gap_boards,
--          capacity_mapped, duration_ms, coalesce(error_label, '(none)') as error
--     from collections.qualify_census_run
--    order by started_at desc limit 5;
--   -- finished_at IS NULL on the newest row  => the run is still in flight, OR the closing UPDATE
--   --                                           failed (check writer grants — closeRow swallows it
--   --                                           to a console line), OR a platform kill. These three
--   --                                           are indistinguishable in the row; rule out "still
--   --                                           running" by started_at before blaming maxDuration.
--   -- status='failed'                        => every board failed: suspect MONDAY_SECRET_API_KEY
--   -- status='partial'                       => some boards rotting while others look healthy;
--   --                                           if conformance_gap_boards > 0 the cause is renamed
--   --                                           monday column titles, not a fetch failure
--   -- capacity_mapped = 0                    => bed capacity did not resolve for ANY facility, so
--   --                                           bed_capacity is NULL roster-wide (this was the live
--   --                                           state on 2026-08-05 — a name-map mismatch)
--   -- no rows at all                         => the deployed build predates 0087, or the fail-soft
--   --                                           start-row INSERT is being refused (writer grants);
--   --                                           it does NOT mean the cron is unscheduled — it is
--   --                                           scheduled hourly at :22
