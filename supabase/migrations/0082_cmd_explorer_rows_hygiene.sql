-- 0082 — index + autovacuum hygiene on collections.cmd_explorer_rows
--
-- WHY (C5, all figures measured live 2026-08-03; stats window since the 2026-05-22 reset):
--   * Write amplification: n_tup_hot_upd = 0 vs n_tup_upd = 626,131 — every ON CONFLICT update
--     rewrites an entry in ALL indexes on the table (updates touch indexed columns, so HOT can
--     never apply). Each near-dead index is pure per-update cost on the hourly ingest path.
--   * Cold visibility map: last_autovacuum was 2026-07-09; a measured "index-only" scan did
--     642,172 heap fetches — i.e. it was secretly a full heap read. The default
--     autovacuum_vacuum_scale_factor (0.2) needs ~128k dead tuples on a 644k-row table before
--     vacuum runs, and the insert threshold (0.2) is just as lazy — so the VM stays cold
--     between rare vacuums.
--
-- DROPPED (independently confirmed near-dead over the 2.5-month stats window, and confirmed by
-- grep 2026-08-03 that NO code path filters or orders by these columns on the base table):
--   * cmd_explorer_ingested_at    — 39 scans, 4.7MB. ingested_at is only ever PROJECTED
--                                   (to_char in the row shape), never filtered.
--   * cmd_explorer_primary_payer  — 60 scans, 4.8MB. Since the 0059 repoint every interactive
--                                   payer filter runs against the rollup (which has
--                                   cmd_charge_rollup_entity_payer_payment); base-table reads
--                                   are id-joins, blind-index equality, or the backfill CLIs.
--
-- KEPT deliberately (do not "finish the job" later without re-measuring):
--   * The blind-index equality indexes (member_id / member_id_prefix / patient_name /
--     group_number bidx) — low scan counts only because the gated PHI identifier search is
--     rare; when it runs, the alternative is a 503MB seq scan per lookup.
--   * cmd_explorer_charge_id_idx — 360KB partial; serves the qualify-census charge_id joins.
--   * cmd_charge_rollup_entity_payment_cov_m (on the rollup) — explicitly out of scope until
--     the summary fan-out collapse lands and changes which indexes matter.
--
-- PHI DISCIPLINE: DDL only; touches no data, projects no columns.
-- OWNERSHIP: objects owned by postgres (the apply role) — no SET ROLE needed.
-- IDEMPOTENT: IF EXISTS on drops; ALTER TABLE SET overwrites the same reloptions.
-- DEPENDENCY: none (independent of 0080/0081).
-- Rollback: 0082_cmd_explorer_rows_hygiene_rollback.sql
--
-- NOTE — post-apply step that CANNOT live in this file: VACUUM cannot run inside
-- apply_migration's transaction. Immediately after apply, run as its own autocommit statement:
--   vacuum (analyze) collections.cmd_explorer_rows;
-- to set the visibility map + refresh stats now, rather than waiting for the first
-- autovacuum under the new thresholds.

-- 1. Drop the two near-dead indexes -------------------------------------------
drop index if exists collections.cmd_explorer_ingested_at;
drop index if exists collections.cmd_explorer_primary_payer;

-- 2. Per-table autovacuum: keep the visibility map warm so index-only scans
--    stay index-only. 0.02 → vacuum after ~13k dead tuples / ~13k inserts on
--    the current 644k-row table (vs ~128k at the 0.2 default).
alter table collections.cmd_explorer_rows set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

-- 3. Verification (run manually after apply) ----------------------------------
-- select indexrelname from pg_stat_user_indexes
--  where relname = 'cmd_explorer_rows'
--    and indexrelname in ('cmd_explorer_ingested_at','cmd_explorer_primary_payer');
--   -- expect zero rows
-- select reloptions from pg_class where oid = 'collections.cmd_explorer_rows'::regclass;
--   -- expect the three autovacuum settings
-- (after the manual VACUUM) select relallvisible::float / greatest(relpages, 1) from pg_class
--   where oid = 'collections.cmd_explorer_rows'::regclass;  -- expect ~1.0
