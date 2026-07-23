-- 0062_vob_sync_state.sql   — DRAFT, NOT APPLIED. Apply as `postgres`. Supports the incremental
-- Monday cron: change-detection watermark on each row + a SOFT-DELETE marker + a per-source
-- run/health state row.
--
-- SOFT-DELETE (decided 2026-07-23): the cron's "de-admitted / off-board" branch marks
-- deactivated_at instead of DELETEing. Rationale: vob.indigo_vob now feeds member_benefits_latest
-- and the live Collections/Qualify market search, so a de-admitted member's benefits still enrich
-- their HISTORICAL collections claims; a hard delete destroys retained records (SOC 2) that are
-- costly to rebuild (the PDF may be off the board). Rows stay VISIBLE (valid history); the marker
-- exists so a future policy can hide de-admitted members from Qualify without a data-loss decision.
-- Re-admission clears deactivated_at (the cron reactivates).

alter table vob.indigo_vob
  add column if not exists monday_updated_at timestamptz,   -- last-seen Monday item updated_at
  add column if not exists deactivated_at timestamptz;      -- soft-delete: set when de-admitted, NULL = active
-- (cmd_rollup_writer already has table-level UPDATE from 0060, so no new column grant needed.)

create table if not exists vob.sync_state (
  source        text primary key,          -- e.g. 'indigo_monday_1606316049'
  last_run_at   timestamptz,
  board_items   integer,                    -- items scanned on the board
  admitted      integer,                    -- items with a facility
  upserted      integer,                    -- rows downloaded+extracted+written this run
  deactivated   integer,                    -- rows SOFT-deleted this run (de-admitted / off-board)
  reactivated   integer,                    -- rows cleared back to active this run (re-admitted)
  errors        integer,                    -- items that failed download/extract
  note          text                        -- free text (e.g. safety-cap skips) — NO PHI
);

grant select, insert, update on vob.sync_state to cmd_rollup_writer;
grant select on vob.sync_state to claims_reader, consolidated_reader;
