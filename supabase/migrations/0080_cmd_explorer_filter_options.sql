-- 0080 — collections.cmd_explorer_filter_options: tiny non-PHI dimension matview backing the
--        explorer's facility + payer filter dropdowns
--
-- WHY: the dropdown vocabulary queries ran a DISTINCT over the whole tenant slice of
--   collections.cmd_explorer_rows (503MB / 642k rows) to return 466 payer + 48 facility strings.
--   MEASURED 2026-08-03 (EXPLAIN (ANALYZE, BUFFERS), payer options, exact production SQL):
--   Parallel Seq Scan, 1,881ms warm-ish, 42,891 shared_blks_read (~335MB of IO); 33,937ms on a
--   cold cache (2026-08-03 capture during diagnosis). The unstable_cache wrappers (revalidate
--   3600) only amortize it — the first visitor after every expiry eats the full scan, and the
--   scan itself churns the 256MB buffer cache everyone else needs. This matview precomputes
--   (business_entity_id, kind, value) at ~514 rows / <100KB so the dropdowns become a
--   single-digit-ms indexed read and the scan disappears from the read path entirely.
--
-- SOURCE = the 0050/0059 charge rollup, NOT cmd_explorer_rows, deliberately: since the 0059
--   repoint (2026-07-22) the grid + summary filters (`facility = any(...)`,
--   `primary_payer = any(...)`) execute against collections.cmd_explorer_charge_rollup, so the
--   rollup IS the authoritative filter vocabulary — a value present only in superseded snapshot
--   rows would filter to zero grid rows anyway — and one grouped scan of the 257MB rollup at
--   refresh time beats two grouped scans of the 503MB base table.
--
-- PHI DISCIPLINE: non-PHI only — facility and payer NAMES. No identifiers, no ciphertext, no
--   blind-index tokens. A matview cannot carry RLS, but reads go through the app's
--   entity-scoped queries (business_entity_id = any($1)) exactly like the sibling rollup.
-- OWNERSHIP: postgres (mirrors cmd_explorer_charge_rollup); claims_reader gets SELECT,
--   cmd_rollup_writer gets SELECT + MAINTAIN (MAINTAIN covers the writer's best-effort
--   post-refresh VACUUM (ANALYZE), the same 0069 posture the rollup has).
-- IDEMPOTENT: drop-and-recreate of the matview, IF NOT EXISTS on the index, CREATE OR REPLACE
--   on the function; re-running converges.
-- DEPENDENCY: 0050/0059 (collections.cmd_explorer_charge_rollup + its refresh function must
--   exist and be populated).
-- Rollback: 0080_cmd_explorer_filter_options_rollback.sql

-- 1. The matview --------------------------------------------------------------
drop materialized view if exists collections.cmd_explorer_filter_options;

create materialized view collections.cmd_explorer_filter_options as
  select business_entity_id, 'facility'::text as kind, facility as value
    from collections.cmd_explorer_charge_rollup
   where facility is not null and btrim(facility) <> ''
   group by business_entity_id, facility
  union all
  select business_entity_id, 'payer'::text as kind, primary_payer as value
    from collections.cmd_explorer_charge_rollup
   where primary_payer is not null and btrim(primary_payer) <> ''
   group by business_entity_id, primary_payer
  with data;

-- 2. Unique key — REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY --------
create unique index if not exists cmd_explorer_filter_options_key
  on collections.cmd_explorer_filter_options (business_entity_id, kind, value);

-- 3. Grants — least privilege, mirroring the sibling rollup's ACL -------------
revoke all on collections.cmd_explorer_filter_options from public;
grant select on collections.cmd_explorer_filter_options to claims_reader;
grant select, maintain on collections.cmd_explorer_filter_options to cmd_rollup_writer;

-- 4. Refresh wiring — extend the existing SECURITY DEFINER function so the
--    hourly /api/cron/refresh-charge-rollup route refreshes BOTH matviews with
--    zero cron/route/schedule changes. Order matters: the options matview
--    derives from the rollup, so it refreshes second. REFRESH ... CONCURRENTLY
--    is transaction-safe (unlike CREATE INDEX CONCURRENTLY) — the live 0059
--    function has run it inside plpgsql 465+ times.
create or replace function collections.refresh_cmd_explorer_charge_rollup()
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  refresh materialized view concurrently collections.cmd_explorer_charge_rollup;
  refresh materialized view concurrently collections.cmd_explorer_filter_options;
end;
$$;

revoke all on function collections.refresh_cmd_explorer_charge_rollup() from public;
grant execute on function collections.refresh_cmd_explorer_charge_rollup() to cmd_rollup_writer;

-- 5. Verification (run manually after apply) ----------------------------------
-- select kind, count(*) from collections.cmd_explorer_filter_options group by kind;
--   -- expect ~48-96 facility rows and ~466-932 payer rows (per-entity dedup)
-- select collections.refresh_cmd_explorer_charge_rollup();  -- as cmd_rollup_writer: both refresh
-- explain (analyze, buffers)
--   select distinct value as primary_payer from collections.cmd_explorer_filter_options
--    where business_entity_id = any('{...}'::uuid[]) and kind = 'payer' order by primary_payer;
--   -- expect an index/seq scan over ~514 rows, single-digit ms, single-digit buffers
