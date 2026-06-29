-- 0020: make collections.cmd_explorer_rows.cpt_code nullable.
--
-- WHY: ~8% of CMD charge lines are revenue-code-only institutional charges (UB-04 room &
-- board, facility fees) that carry NO CPT code. Under 0019 cpt_code was NOT NULL, so the
-- shared ingest path (cmdExplorerSeed.mapRow, used by BOTH the historical seed and the
-- daily cron) dropped every such line — an ~12k-row blind spot in the Collections
-- Explorer. The ingest now PERSISTS these lines with an em-dash ('—', U+2014) placeholder
-- in cpt_code (matching the grid's empty-cell glyph); dropping the NOT NULL constraint lets
-- a legitimately-CPT-less charge line land instead of being rejected. In practice the app
-- always writes a non-null value (the real CPT or the placeholder), so nullable here is
-- defense-in-depth, not a new null path.
--
-- This rewrites NO existing data: it only drops the column constraint. The dedup grain
-- (row_fingerprint over the normalized plaintext 14 fields) is unchanged for every row
-- that already had a CPT; blank-CPT rows are purely additive (they fingerprint with '—'
-- in the cpt position, a value no real CPT code can collide with).
--
-- Idempotent: drops NOT NULL only if the column is currently NOT NULL. Safe to re-run.
-- No other column, index, grant, policy, or RLS change — 0019 still defines the table.
-- DEPENDENCY: assumes 0019 (collections.cmd_explorer_rows) has run.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'collections'
      and table_name = 'cmd_explorer_rows'
      and column_name = 'cpt_code'
      and is_nullable = 'NO'
  ) then
    alter table collections.cmd_explorer_rows alter column cpt_code drop not null;
  end if;
end $$;
