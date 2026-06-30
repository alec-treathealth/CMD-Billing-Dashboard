-- 0022: let the cmd_rollup_writer cron re-source collections.daily_collections from CMD,
-- and retire the deposit-Sheet rows.
--
-- WHY: the Master BXR chart's collections series is moving off the manually-maintained
-- deposit Google Sheet onto the live CMD report (report 10091971 / filter 10147430 carries
-- per-charge-line Check Payment + EFT Payment). The daily cron (src/collections/cmdExplorerCron.ts)
-- now aggregates those to per-facility/day totals and writes them to collections.daily_collections
-- with source_tag='cmd', via replaceCmdDailyForFacility (per-facility DELETE+INSERT). That writer
-- runs as the least-privilege cmd_rollup_writer, which previously had NO rights on daily_collections.
--
-- This migration:
--   1. Allows collections_raw_id to be NULL — CMD daily rows are aggregates that do NOT derive
--      from a collections_raw landing row, so the writer never touches the PHI-bearing
--      collections_raw table (keeps the PHI boundary intact, docs/CLAUDE.md §2/§7).
--   2. Adds 'cmd' to the source_tag CHECK (keeps 'workbook' + 'deposit_sheet' legal for safety).
--   3. Grants cmd_rollup_writer SELECT/INSERT/DELETE + RLS policies on daily_collections
--      (NON-PHI aggregates only — no PHI columns exist on this table, so table-level is fine).
--      SELECT is required for the ON CONFLICT arbiter and the DELETE filter under RLS.
--
-- This is CAPABILITY-ONLY: it does NOT delete the existing source_tag='deposit_sheet' rows.
-- Those are retired by migration 0023, which is applied ONLY AFTER the CMD backfill has loaded
-- 'cmd' rows and they've been verified — so the old source is never destroyed before the new one
-- is confirmed good, and the chart never shows a gap (the resolved view's max-gross precedence
-- shows whichever source has the real dollars while both briefly coexist).
--
-- The daily_collections_resolved view (0014/0015, max-gross-wins) needs NO change: CMD's real
-- dollar rows beat the all-zero 'workbook' 2026 placeholders automatically.
--
-- Idempotent (docs/CLAUDE.md §2): role created only-if-absent (never DROP ROLE); DROP NOT NULL
-- is a no-op on re-run; CHECK + POLICY are dropped IF EXISTS before re-create; GRANT re-applies
-- cleanly.
--
-- Depends on: 0006 (daily_collections + RLS), 0013 (cmd_rollup_writer role), 0014 (source_tag +
-- resolved view), 0015 (resolved-view precedence).

-- 1. Role (privilege-only; reuse existing, created only-if-absent — mirrors 0013/0019/0021).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cmd_rollup_writer') then
    create role cmd_rollup_writer nologin;
  end if;
end$$;

-- 2. CMD daily rows are aggregates with no collections_raw lineage → allow NULL FK.
alter table collections.daily_collections alter column collections_raw_id drop not null;

-- 3. Permit source_tag='cmd' (keep the prior values legal).
alter table collections.daily_collections drop constraint if exists daily_collections_source_tag_ck;
alter table collections.daily_collections
  add constraint daily_collections_source_tag_ck
  check (source_tag = any (array['workbook'::text, 'deposit_sheet'::text, 'cmd'::text]));

-- 4. Least-privilege grants + RLS policies for the writer (non-PHI table; no column ACL needed).
grant select, insert, delete on collections.daily_collections to cmd_rollup_writer;

drop policy if exists cmd_daily_writer_select on collections.daily_collections;
create policy cmd_daily_writer_select on collections.daily_collections
  for select to cmd_rollup_writer using (true);

drop policy if exists cmd_daily_writer_insert on collections.daily_collections;
create policy cmd_daily_writer_insert on collections.daily_collections
  for insert to cmd_rollup_writer with check (true);

drop policy if exists cmd_daily_writer_delete on collections.daily_collections;
create policy cmd_daily_writer_delete on collections.daily_collections
  for delete to cmd_rollup_writer using (true);
