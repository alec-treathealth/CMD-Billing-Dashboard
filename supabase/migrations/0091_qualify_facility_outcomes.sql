-- 0091 — collections.qualify_facility_outcomes: completed-stay LOS/auth, so auth-fit compares evenly.
--
-- WHY: the auth-fit factor divides average length of stay by average authorized days. Both inputs
--   come from collections.qualify_facility_census, which is a snapshot of CURRENTLY ADMITTED clients
--   — so "length of stay" there is `today - adm_date`, a stay IN PROGRESS, not a completed one.
--   Those are different quantities, and the difference is not small.
--
--   MEASURED 2026-08-06 against the executive-dashboard census history (public.census_records,
--   completed stays with a real discharge date, trailing 365d by dc_date):
--
--     facility            in-progress LOS/auth      completed LOS/auth
--     Opus     (10021573)        0.86                      0.92
--     SVR      (10025950)        0.90                      1.05   <-- overruns
--     Hillside (10026624)        0.85                      1.10   <-- overruns
--     Revival  (10028595)        0.76                      0.88
--     CAMH                       0.93                      0.91
--     NASH                       0.72                      0.94
--     LSMH                       0.86                      1.00   <-- at the limit
--     TBH                        0.69                      0.92
--     DMH                        0.75                      0.87
--     PCMH                       0.75                      1.03   <-- overruns
--     KWC                        0.96                      0.89
--     LAMH                       0.76                      0.87
--
--   Under the in-progress read NO facility ever reaches 1.0, so the overrun penalty can never fire
--   and every facility scores as comfortably within authorization. Under completed stays FOUR are at
--   or past the limit. The factor was not measuring what it claimed to measure.
--
--   Sample size moves the same way: the census snapshot carries 4-15 authorized-day values per
--   facility (below or barely at the QUALIFY_AUTH_FIT_MIN_SAMPLE floor of 3), while completed stays
--   carry 47-165. The floor was suppressing the factor on thin snapshots of a population that is
--   actually well measured.
--
-- WHY A SEPARATE TABLE rather than more columns on qualify_facility_census: different GRAIN and
--   different lifecycle. That table is a live snapshot, fully rewritten every hour from monday, and
--   its rows mean "right now". These rows are a trailing-window aggregate over finished admissions
--   and change slowly. Folding them in would make one row mean two things and force the hourly cron
--   to rewrite history it does not own.
--
-- PROVENANCE, on the record: the source is a DIFFERENT Supabase project (the executive dashboard,
--   ref khnaconatuspmzkmsfge), whose census_records table carries facility, adm_date, dc_date,
--   discharge terms and total_auth_days — and, unlike this repo's monday read, 93.4% of its rows
--   have a real discharge date. `source` names it per row so a future reader never has to guess
--   which system a number came from.
--
-- PHI POSTURE — AGGREGATES ONLY, DELIBERATELY: no patient row crosses projects. census_records is
--   patient-grain (one row per admission; it carries no name, but facility + adm_date + dc_date is a
--   limited data set) and copying it would multiply PHI surface for no capability this factor needs.
--   Everything here is facility-grain: counts, day averages, a window length. Keep it that way — if a
--   future need genuinely requires per-stay detail, that is a separate decision with its own review.
--
-- SEEDED VALUES are measured, not assumed, and are a point-in-time backfill so the factor change can
--   ship and be verified today. The recurring sync needs a connection string for the source project
--   that does not exist in this repo's env yet (see the note at the bottom of this file).
--
-- EXCLUDED, each for a stated reason rather than silently:
--   * MHC (10024431) — care_setting BOTH; it runs residential AND outpatient programs, so one
--     blended LOS mixes two quantities. Same reason its census board is deferred.
--   * AMH — no facility_code in collections.facilities, and zero authorized-day values on file.
--   * Wellness Recovery — one completed stay, and still unseeded in the roster (0006 header).
--
-- OWNERSHIP: postgres, matching every other live collections relation. NO `SET ROLE claims_admin` —
--   in this plane it downgrades the applying role and fails 42501 (0084/0085, 2026-08-05).
--
-- GRANTS + RLS: BOTH gates, explicitly. 0089/0090 exist because granting SELECT without an RLS
--   policy leaves the reader seeing an empty table with no error. Do not repeat that here.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY (42710);
--   the seed is ON CONFLICT DO UPDATE.
--
-- Rollback: 0091_qualify_facility_outcomes_rollback.sql

-- 1. Table -------------------------------------------------------------------------------------
create table if not exists collections.qualify_facility_outcomes (
  facility_code   text primary key references collections.facilities (facility_code),
  -- Completed stays contributing to avg_los_days (a real discharge date, dc_date >= adm_date).
  stays_sample    integer not null default 0,
  avg_los_days    numeric(6,2),
  -- Of those stays, how many carried a Total Auth Days value. Separate count: a stay can have a
  -- discharge date and no authorization on file, and averaging over the wrong denominator is how
  -- the census snapshot's auth number got thin in the first place.
  auth_sample     integer not null default 0,
  avg_auth_days   numeric(6,2),
  -- Trailing window, in days, that the two averages were computed over — BY DISCHARGE DATE. Stored
  -- rather than assumed so the number stays self-describing when the window is retuned.
  window_days     integer not null,
  -- Which system produced this row. Free text on purpose: the set of upstreams is not this table's
  -- business, and a CHECK here would need a migration every time one is added.
  source          text not null,
  synced_at       timestamptz not null default now()
);

comment on table collections.qualify_facility_outcomes is
  'Completed-stay LOS and authorized days per facility, trailing window by discharge date. Feeds the '
  'Qualify auth-fit factor in preference to the in-progress census snapshot, which measures stays '
  'that have not ended yet and therefore never trips the overrun penalty. Aggregates only — no '
  'patient row is copied from the source system.';

-- 2. Least privilege ---------------------------------------------------------------------------
grant select on collections.qualify_facility_outcomes to claims_reader;
grant select, insert, update on collections.qualify_facility_outcomes to cmd_rollup_writer;

alter table collections.qualify_facility_outcomes enable row level security;

drop policy if exists qfo_reader_select on collections.qualify_facility_outcomes;
create policy qfo_reader_select on collections.qualify_facility_outcomes
  for select to claims_reader using (true);

-- The writer needs SELECT too: the upsert's ON CONFLICT path reads the existing row.
drop policy if exists qfo_writer_select on collections.qualify_facility_outcomes;
create policy qfo_writer_select on collections.qualify_facility_outcomes
  for select to cmd_rollup_writer using (true);

drop policy if exists qfo_writer_insert on collections.qualify_facility_outcomes;
create policy qfo_writer_insert on collections.qualify_facility_outcomes
  for insert to cmd_rollup_writer with check (true);

drop policy if exists qfo_writer_update on collections.qualify_facility_outcomes;
create policy qfo_writer_update on collections.qualify_facility_outcomes
  for update to cmd_rollup_writer using (true) with check (true);

-- 3. Seed — measured 2026-08-06, trailing 365d by discharge date -------------------------------
insert into collections.qualify_facility_outcomes
  (facility_code, stays_sample, avg_los_days, auth_sample, avg_auth_days, window_days, source)
values
  ('10021573', 202, 24.62, 165, 26.64, 365, 'exec-dashboard/census_records'),
  ('10025950', 180, 32.81, 153, 31.34, 365, 'exec-dashboard/census_records'),
  ('10026624', 142, 40.10, 102, 36.35, 365, 'exec-dashboard/census_records'),
  ('10028595', 145, 26.35, 128, 29.89, 365, 'exec-dashboard/census_records'),
  ('CAMH',     132, 30.08, 110, 33.11, 365, 'exec-dashboard/census_records'),
  ('NASH',     133, 30.66, 121, 32.55, 365, 'exec-dashboard/census_records'),
  ('LSMH',     111, 34.05, 110, 33.98, 365, 'exec-dashboard/census_records'),
  ('TBH',      107, 24.93,  95, 27.19, 365, 'exec-dashboard/census_records'),
  ('DMH',       70, 26.31,  61, 30.08, 365, 'exec-dashboard/census_records'),
  ('PCMH',      65, 30.12,  54, 29.26, 365, 'exec-dashboard/census_records'),
  ('KWC',       63, 27.21,  59, 30.69, 365, 'exec-dashboard/census_records'),
  ('LAMH',      54, 24.44,  47, 28.13, 365, 'exec-dashboard/census_records')
on conflict (facility_code) do update set
  stays_sample  = excluded.stays_sample,
  avg_los_days  = excluded.avg_los_days,
  auth_sample   = excluded.auth_sample,
  avg_auth_days = excluded.avg_auth_days,
  window_days   = excluded.window_days,
  source        = excluded.source,
  synced_at     = now();

-- ── Verification (run manually after apply) ────────────────────────────────────────────────────
--
-- 1. twelve rows, every facility_code resolving against the roster (the FK guarantees it)
-- select count(*) from collections.qualify_facility_outcomes;   -- expect 12
--
-- 2. the ratio the factor will now read — four facilities at or over 1.0
-- select facility_code, avg_los_days, avg_auth_days,
--        round(avg_los_days / nullif(avg_auth_days,0), 2) as los_over_auth, auth_sample
--   from collections.qualify_facility_outcomes order by 4 desc nulls last;
--   -- expect 10026624 ~1.10, 10025950 ~1.05, PCMH ~1.03, LSMH ~1.00, rest below
--
-- 3. BOTH gates for the reader — a GRANT alone is not visibility (0089/0090's lesson)
-- select has_table_privilege('claims_reader','collections.qualify_facility_outcomes','SELECT'),
--        (select count(*) from pg_policies where schemaname='collections'
--          and tablename='qualify_facility_outcomes' and 'claims_reader' = any(roles));
--   -- expect true, 1
--
-- ── FOLLOW-UP: the recurring sync ──────────────────────────────────────────────────────────────
-- These values are a point-in-time backfill. Keeping them fresh needs a read-only connection string
-- for the source project (Supabase ref khnaconatuspmzkmsfge) in this repo's env — it is not there
-- today, and no credential is invented here. Once it exists the sync is a small module in the
-- established shape: aggregate IN the source database (so only facility-grain rows cross the wire),
-- map facility text -> facility_code, upsert as cmd_rollup_writer. Until then this table is
-- accurate as of its synced_at, and the factor discloses the window it was measured over.
