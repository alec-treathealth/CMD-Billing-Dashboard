-- 0081 — trigram GIN indexes for the explorer free-text search, on the CHARGE ROLLUP matview
--
-- WHY: the smart-search substring filter (`col ilike '%term%'`, leading wildcard) is served by
--   no btree, so every search seq-scans the search target. MEASURED 2026-08-03 (EXPLAIN
--   (ANALYZE, BUFFERS), the production summary-totals SQL, term 'uhc', all 4 search columns):
--   Parallel Seq Scan on cmd_explorer_charge_rollup, 1,326ms warm (245k rows filtered per
--   worker), 5,063–14,997ms means recorded in pg_stat_statements for the cold/pre-repoint
--   variants. One tab click fans out into 6+ of these. Trigram GIN indexes make a 3+-char
--   ILIKE a Bitmap Index Scan.
--
-- TARGET = collections.cmd_explorer_charge_rollup, NOT cmd_explorer_rows. This is a deliberate
--   correction to the task brief: since the 0059 repoint (2026-07-22), cmdExplorerBaseConds —
--   the ONLY builder that emits the ILIKE block — is consumed exclusively by
--   buildCmdExplorerQuery and buildCmdSearchSummaryQueries, both `FROM
--   collections.cmd_explorer_charge_rollup`. The base table is only ever read by id-join /
--   blind-index equality / the backfill CLIs (verified by grep 2026-08-03), so trigram indexes
--   there would cost hourly-ingest write amplification (C5) and serve zero queries.
--   pg_stat_statements confirms: every `ilike` entry against cmd_explorer_rows predates the
--   repoint; no post-repoint search reads it.
--
-- OPCLASS: pg_trgm is installed in schema `claims` (select extname, nspname from pg_extension
--   join pg_namespace ... → pg_trgm | claims), so the operator class MUST be written
--   `claims.gin_trgm_ops` — a bare `gin_trgm_ops` fails with "operator class does not exist".
--
-- ⚠ APPLY PATH — NOT apply_migration. CREATE INDEX CONCURRENTLY cannot run inside a
--   transaction block, and apply_migration wraps the whole file in one. Apply this file by
--   running EACH statement below as its own single-statement query via the Supabase MCP
--   execute_sql (single statements execute in autocommit — verified 2026-08-03 with a VACUUM
--   probe, which carries the same restriction). Run them in order; avoid the :45–:48 window
--   (the hourly rollup refresh holds SHARE UPDATE EXCLUSIVE, which CIC queues behind).
--   If a build fails midway it leaves an INVALID index: STOP per the live-DB failure rule —
--   do not loop; report. (Remediation, once approved: drop the invalid index, re-run.)
--
-- REFRESH COST: REFRESH ... CONCURRENTLY maintains these indexes on its delta merge; expect the
--   hourly refresh (76–113s measured, maxDuration 180) to gain a few seconds. Verify the first
--   post-apply run via collections.rollup_refresh_run.
--
-- FUTURE REBUILD HAZARD: any migration that drops/recreates the rollup matview (e.g. the stale,
--   unapplied 0067 pattern) silently loses these four indexes — recreate them in the same
--   migration or the search reverts to seq scans.
--
-- PHI DISCIPLINE: indexes over non-PHI text columns (facility / payer / CPT / revenue code).
-- OWNERSHIP: indexes on a matview are owned by its owner (postgres); no grants needed.
-- IDEMPOTENT: IF NOT EXISTS on every statement.
-- DEPENDENCY: 0050/0059 (the matview), pg_trgm in schema claims. Independent of 0080.
-- Rollback: 0081_cmd_charge_rollup_search_trgm_rollback.sql

create index concurrently if not exists cmd_charge_rollup_facility_trgm
  on collections.cmd_explorer_charge_rollup using gin (facility claims.gin_trgm_ops);

create index concurrently if not exists cmd_charge_rollup_payer_trgm
  on collections.cmd_explorer_charge_rollup using gin (primary_payer claims.gin_trgm_ops);

create index concurrently if not exists cmd_charge_rollup_cpt_trgm
  on collections.cmd_explorer_charge_rollup using gin (cpt_code claims.gin_trgm_ops);

create index concurrently if not exists cmd_charge_rollup_revenue_trgm
  on collections.cmd_explorer_charge_rollup using gin (revenue_code claims.gin_trgm_ops);

analyze collections.cmd_explorer_charge_rollup;

-- Verification (run manually after apply) --------------------------------------
-- select indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
--   from pg_stat_user_indexes
--  where relname = 'cmd_explorer_charge_rollup' and indexrelname like '%_trgm';
-- select indexrelid::regclass from pg_index where not indisvalid;  -- expect zero rows
-- explain (analyze, buffers) <the summary-totals search SQL, term 'uhc'>
--   -- PASS = BitmapOr of 4 Bitmap Index Scans on the *_trgm indexes; FAIL = Parallel Seq Scan
