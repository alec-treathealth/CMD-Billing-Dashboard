-- 0099 — collections.etl_run + pipeline_state + pipeline_lock: one shared ETL run-log, and the
--        state a completion-chained pipeline runs on.
--
-- WHY: data freshness is currently bounded by clock gaps, not by work. The five CMD stages are
--   staggered cmd-explorer :00 / cmd-census :15 / indigo-explorer :30 / indigo-census :35 /
--   refresh-charge-rollup :45, so a CMD change landing at :01 is not visible in the charge rollup
--   until :45 — ~100 minutes worst case, nearly all of it idle waiting on the clock.
--
--   MEASURED 2026-08-12 against this database, which is what makes the gap indefensible:
--
--     stage                     runs   observed wall clock            source
--     refresh-charge-rollup     168    81.6s – 117.5s (avg 98.4s)     rollup_refresh_run, 7d
--     cmd-census (BXR)           98    p50 0.5s / p95 135s / max 214s cmd_census_run, 7d
--     cmd-census (Indigo)        14    p50 30.4s / max 121s           cmd_census_run, 7d
--     cmd-explorer                —    UNKNOWN — no run log exists    —
--     indigo-explorer             —    UNKNOWN — no run log exists    —
--
--   The BXR census p50 of 0.5s is the freshness gate doing its job (every customer already fresh,
--   nothing to pull); the p95/max are the real sweeps. So roughly 7 minutes of actual work is
--   spread across a 100-minute window.
--
--   THE TWO STAGES MOST WORTH SPEEDING UP ARE THE TWO WITH NO TIMING DATA AT ALL. That is the
--   first thing this migration fixes, and it is why the run-log lands before the scheduler change:
--   the tick cadence gets set from a day of etl_run rows, not from a guess.
--
-- WHY A THIRD RUN TABLE rather than migrating the two that exist: collections.cmd_census_run and
--   collections.rollup_refresh_run carry real history worth keeping (168 rollup runs, 395 census
--   rows in the last 7 days alone) and their shapes are genuinely different — census_run is
--   PER-CUSTOMER and tenant-stamped, rollup_refresh_run is whole-book with a matview freshness
--   date. Collapsing them would either lose columns or produce a union table that is mostly NULL.
--   etl_run is the STAGE grain: one row per stage invocation, uniform across all five, which is the
--   grain the pipeline schedules on and the grain neither existing table has. Both existing tables
--   keep being written exactly as they are today — dual-writing costs one INSERT and one UPDATE per
--   stage, which is noise next to a 98-second matview refresh.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not change what any stage computes, and it does not
--   change any cron schedule. The five existing entries in app/vercel.json keep running unchanged;
--   the pipeline ships DISABLED behind ETL_PIPELINE_ENABLED and has to be turned on deliberately.
--
-- THE DEPENDENCY EDGE IS DERIVED, NOT INFERRED FROM THE SCHEDULE. Verified 2026-08-12 by reading
--   what each stage actually touches, because the clock order and the data order are not the same
--   graph and assuming they were would have encoded a false constraint:
--
--     collections.cmd_explorer_charge_rollup's definition reads collections.cmd_explorer_rows and
--     NOTHING ELSE (pg_get_viewdef), and refresh_cmd_explorer_charge_rollup() refreshes only that
--     matview plus cmd_explorer_filter_options, which is itself defined over the rollup. Both
--     explorers write cmd_explorer_rows. So: explorers -> rollup, a real data dependency.
--
--     Both census stages write collections.cmd_charge_census (cmdCensus.ts:240) and read nothing
--     the explorers produce. Nothing in this pipeline reads cmd_charge_census — its consumers are
--     arAging.ts and the live Qualify surface, neither of which is a stage here.
--
--   So the true graph is NOT the linear chain the schedule suggests:
--
--     cmd-explorer  ─┐
--                    ├──> refresh-charge-rollup
--     indigo-explorer┘
--
--     cmd-census      (independent branch)
--     indigo-census   (independent branch)
--
--   Putting either census stage upstream of the rollup — as the clock order implies — would park a
--   run that has hit 214 seconds directly in the rollup's critical path for no data reason at all.
--   The census stages are still SEQUENCED against the explorers, but for a different reason that is
--   recorded in code rather than here: CMD allows one report at a time per partner, so the four
--   CMD-calling stages are mutually exclusive as a RESOURCE. A resource mutex and a data dependency
--   are different constraints and the pipeline models them separately.
--
-- OWNERSHIP: postgres, matching every other live collections relation. NO `SET ROLE claims_admin` —
--   in this plane it downgrades the applying role and fails 42501 (0084/0085, 2026-08-05).
--
-- GRANTS + RLS: BOTH gates, explicitly. 0089/0090 exist because granting SELECT without an RLS
--   policy leaves the reader seeing an empty table with no error. Do not repeat that here.
--   The writer gets SELECT/INSERT/UPDATE and NOT DELETE — the 0091 least-privilege shape. A run log
--   nothing can delete is the point; retention, if it is ever wanted, is a deliberate later change
--   with its own migration (0095 is the worked example of doing that as a one-shot definer).
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY (42710); the
--   seed is ON CONFLICT DO NOTHING.
--
-- Rollback: 0099_etl_run_pipeline_state_rollback.sql

-- 1. The shared stage-grain run log -------------------------------------------------------------
create table if not exists collections.etl_run (
  id            bigint generated always as identity primary key,
  -- Stage identifier, e.g. 'cmd-explorer'. Free text on purpose: the stage set is owned by
  -- src/collections/etlStages.ts and a CHECK here would force a migration to add a stage.
  stage         text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  duration_ms   integer,
  -- 'running' until the stage closes. A row left 'running' with finished_at NULL is the
  -- "started but never finished" signal — a platform timeout (maxDuration) kills the function
  -- before either close-out UPDATE can run. That signal is the whole reason the start row is
  -- INSERTed before the work rather than written once at the end.
  status        text not null default 'running'
                  check (status in ('running', 'ok', 'error', 'skipped')),
  -- Best-effort non-PHI row count the stage reported. NULL when a stage does not report one.
  rows_touched  integer,
  -- A short label or error MESSAGE. Never PHI: stage errors here are HTTP/driver/config failures.
  error_label   text,
  triggered_by  text not null default 'cron'
);

comment on table collections.etl_run is
  'One row per ETL stage invocation, uniform across all five CMD stages. The grain the pipeline '
  'schedules on. collections.cmd_census_run (per-customer) and collections.rollup_refresh_run '
  '(whole-book) keep their own history and are still written — this table does not replace them.';

-- The query this table exists to answer: "how long does each stage actually take?" and the tick's
-- own "what happened last time" lookup. DESC so the latest-per-stage probe is a cheap backward scan.
create index if not exists etl_run_stage_started_idx
  on collections.etl_run (stage, started_at desc);

-- 2. Pipeline state — what the tick reads to decide what runs next ------------------------------
create table if not exists collections.pipeline_state (
  -- Namespaces a stage set, so a second pipeline can exist later without colliding.
  pipeline         text not null,
  stage            text not null,
  -- Last known disposition of this stage: 'idle' | 'running' | 'ok' | 'error'. Free text for the
  -- same reason as etl_run.stage; the tick owns the vocabulary.
  status           text not null default 'idle',
  -- Last attempt, success or not. Drives the interval heartbeat.
  last_run_at      timestamptz,
  -- Last SUCCESS. Drives the completion chain: a dependent becomes due when every dependency's
  -- last_ok_at is newer than the dependent's own. This column IS the edge trigger.
  last_ok_at       timestamptz,
  last_error_label text,
  last_run_id      bigint,
  updated_at       timestamptz not null default now(),
  primary key (pipeline, stage)
);

comment on column collections.pipeline_state.last_ok_at is
  'Last successful completion. The completion chain is exactly the comparison of this value across '
  'the dependency edge — a stage is due when every dependency finished OK more recently than it '
  'last did, which is what replaces waiting for a clock slot.';

-- 3. Tick lease — so a hand-run tick cannot collide with a scheduled one ------------------------
--
-- REQUIRED, not belt-and-braces. Two overlapping ticks would both drive CMD stages, and CMD allows
-- one report at a time per partner: the 2026-08-02 incident (probing during a :15 census) cost 13
-- BXR census fetches. A lease is also why the tick is safe to curl by hand against a preview
-- deployment, which is the only way any of this is testable off main.
--
-- A LEASE, NOT AN ADVISORY LOCK, ON PURPOSE: pg_advisory_lock is session-scoped and this app runs
-- through the Supavisor transaction pooler (6543), where a connection returns to the pool between
-- statements — a session lock would be held by an arbitrary pooled connection and released at a
-- time unrelated to the tick. pg_advisory_xact_lock releases at commit, which would mean holding
-- one transaction open across a 200-second run. A row with an expiry survives both, and a crashed
-- tick self-heals when the lease lapses instead of wedging the pipeline forever.
create table if not exists collections.pipeline_lock (
  pipeline     text primary key,
  -- The lease expiry. NULL or in the past means free. Deliberately not a boolean: a boolean lock
  -- held by a function that got platform-killed never clears.
  locked_until timestamptz,
  -- Non-PHI: a tick id / 'manual' / 'cron'. For attribution when a tick is skipped as locked.
  holder       text,
  acquired_at  timestamptz
);

-- 4. Least privilege ----------------------------------------------------------------------------
grant select on collections.etl_run        to claims_reader;
grant select on collections.pipeline_state to claims_reader;
grant select on collections.pipeline_lock  to claims_reader;

grant select, insert, update on collections.etl_run        to cmd_rollup_writer;
grant select, insert, update on collections.pipeline_state to cmd_rollup_writer;
grant select, insert, update on collections.pipeline_lock  to cmd_rollup_writer;

alter table collections.etl_run        enable row level security;
alter table collections.pipeline_state enable row level security;
alter table collections.pipeline_lock  enable row level security;

-- etl_run: reader SELECT, writer SELECT/INSERT/UPDATE. NOT tenant-scoped — a stage is whole-book
-- (both explorers write both tenants' rows through one invocation), so there is no
-- business_entity_id to scope on and the policies are permissive by design, exactly as
-- rollup_refresh_run's are (0054).
drop policy if exists etl_run_reader_select on collections.etl_run;
create policy etl_run_reader_select on collections.etl_run
  for select to claims_reader using (true);

-- The writer needs SELECT: the close-out UPDATE ... where id = $1 must see its own start row.
drop policy if exists etl_run_writer_select on collections.etl_run;
create policy etl_run_writer_select on collections.etl_run
  for select to cmd_rollup_writer using (true);

drop policy if exists etl_run_writer_insert on collections.etl_run;
create policy etl_run_writer_insert on collections.etl_run
  for insert to cmd_rollup_writer with check (true);

drop policy if exists etl_run_writer_update on collections.etl_run;
create policy etl_run_writer_update on collections.etl_run
  for update to cmd_rollup_writer using (true) with check (true);

drop policy if exists pipeline_state_reader_select on collections.pipeline_state;
create policy pipeline_state_reader_select on collections.pipeline_state
  for select to claims_reader using (true);

drop policy if exists pipeline_state_writer_select on collections.pipeline_state;
create policy pipeline_state_writer_select on collections.pipeline_state
  for select to cmd_rollup_writer using (true);

drop policy if exists pipeline_state_writer_insert on collections.pipeline_state;
create policy pipeline_state_writer_insert on collections.pipeline_state
  for insert to cmd_rollup_writer with check (true);

drop policy if exists pipeline_state_writer_update on collections.pipeline_state;
create policy pipeline_state_writer_update on collections.pipeline_state
  for update to cmd_rollup_writer using (true) with check (true);

drop policy if exists pipeline_lock_reader_select on collections.pipeline_lock;
create policy pipeline_lock_reader_select on collections.pipeline_lock
  for select to claims_reader using (true);

drop policy if exists pipeline_lock_writer_select on collections.pipeline_lock;
create policy pipeline_lock_writer_select on collections.pipeline_lock
  for select to cmd_rollup_writer using (true);

drop policy if exists pipeline_lock_writer_insert on collections.pipeline_lock;
create policy pipeline_lock_writer_insert on collections.pipeline_lock
  for insert to cmd_rollup_writer with check (true);

drop policy if exists pipeline_lock_writer_update on collections.pipeline_lock;
create policy pipeline_lock_writer_update on collections.pipeline_lock
  for update to cmd_rollup_writer using (true) with check (true);

-- 5. Seed the five stages ------------------------------------------------------------------------
-- Seeded so the table is self-describing the moment it exists and `select * from pipeline_state`
-- answers "what is this pipeline" without reading TypeScript. The tick upserts missing rows anyway,
-- so this is visibility, not a dependency. ON CONFLICT DO NOTHING: re-applying must never reset
-- live state back to idle.
insert into collections.pipeline_state (pipeline, stage) values
  ('cmd', 'cmd-explorer'),
  ('cmd', 'indigo-explorer'),
  ('cmd', 'cmd-census'),
  ('cmd', 'indigo-census'),
  ('cmd', 'refresh-charge-rollup')
on conflict (pipeline, stage) do nothing;

-- ── Verification (run manually after apply) ────────────────────────────────────────────────────
--
-- 1. all three relations exist, RLS on, owned by postgres
-- select c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'collections'
--    and c.relname in ('etl_run','pipeline_state','pipeline_lock');
--   -- expect 3 rows, relrowsecurity = true, owner = postgres
--
-- 2. BOTH gates for the reader, and the writer's DELETE genuinely absent (0091 shape)
-- select has_table_privilege('claims_reader','collections.etl_run','SELECT')        as r_sel,
--        has_table_privilege('cmd_rollup_writer','collections.etl_run','INSERT')    as w_ins,
--        has_table_privilege('cmd_rollup_writer','collections.etl_run','UPDATE')    as w_upd,
--        has_table_privilege('cmd_rollup_writer','collections.etl_run','DELETE')    as w_del;
--   -- expect true, true, true, FALSE
--
-- 3. twelve policies across the three tables, none reachable by public/anon
-- select tablename, count(*) from pg_policies
--  where schemaname='collections'
--    and tablename in ('etl_run','pipeline_state','pipeline_lock')
--  group by 1 order by 1;
--   -- expect 4 each
--
-- 4. the seed
-- select pipeline, stage, status from collections.pipeline_state order by stage;
--   -- expect 5 rows, all status='idle'
--
-- 5. the status CHECK actually refuses a bad value (exercise the constraint, do not assume it)
-- insert into collections.etl_run (stage, status) values ('probe','bogus');
--   -- expect ERROR 23514 check constraint "etl_run_status_check"
--
-- ── The measurement this table is FOR, once a day of rows exists ───────────────────────────────
-- select stage, count(*) runs,
--        round(min(duration_ms)/1000.0,1)  min_s,
--        round(percentile_cont(0.5) within group (order by duration_ms)/1000.0, 1) p50_s,
--        round(percentile_cont(0.95) within group (order by duration_ms)/1000.0, 1) p95_s,
--        round(max(duration_ms)/1000.0,1)  max_s,
--        count(*) filter (where status = 'error') errors
--   from collections.etl_run
--  where status in ('ok','error') and started_at > now() - interval '24 hours'
--  group by 1 order by p95_s desc nulls last;
--
-- Those p95 numbers are what set ETL_PIPELINE_STAGE_RESERVE_MS and the tick cadence in the
-- FOLLOW-UP PR that removes the five standalone cron entries. Until they exist, the reserves in
-- src/collections/etlStages.ts are deliberately pessimistic and the two explorer stages are
-- reserved at the full 300s function ceiling because their true cost is unknown.
