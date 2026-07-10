-- 0038 — payer-gap ratio columns on collections.cmd_explorer_rows: pct_allowed, pct_paid.
--
-- WHY: the Collections Explorer (Session A of the collections-explorer feedback spec) surfaces
-- the payer gap per charge line so Admissions/Billing can read "% allowed" and "% paid" without
-- opening a row, AND sort the grid by them. Sorting uses the existing keyset cursor, which needs
-- a real, stable, sortable column (not a client-computed value) — so these are GENERATED STORED
-- columns, computed at write time. They then drop straight into CMD_EXPLORER_SORTABLE_COLUMNS and
-- the existing cursor machinery with no pagination-strategy change.
--
--   pct_allowed = allowed_amount     / charge_amount   * 100   (charge  > 0, else NULL)
--   pct_paid    = insurance_payments / allowed_amount  * 100   (allowed > 0, else NULL)
--
-- TYPE = unbounded `numeric` (NOT numeric(n,s)) ON PURPOSE. Migrations 0002/0008 are scar tissue:
-- a bounded numeric(6,4) ratio column OVERFLOWED on reversals / near-zero denominators (ratios
-- reached ~61,932). A GENERATED column whose expression can overflow its type would fail EVERY
-- insert and break the daily cron. Unbounded numeric cannot overflow; round(...,2) keeps it tidy.
--
-- DENOMINATOR GUARD = `> 0` (NOT merely `= 0`/NULLIF): mirrors claims.collection_rate /
-- collections'.collection_rate (0002/0008), where a zero/negative/near-zero denominator yields a
-- NULL "signal" rather than a nonsensical or negative percentage. NULL numerator (allowed_amount /
-- insurance_payments are nullable) also propagates to NULL. Never an error, never divide-by-zero.
--
-- PHI: none. All three source columns are non-PHI numerics; the derived ratios are non-PHI. These
-- columns are safe to ship in the cached, browser-bound non-PHI projection (CMD_EXPLORER_SELECT).
--
-- WRITE PATH: unaffected. Generated columns cannot appear in an INSERT column list; the seed/cron
-- INSERT_COLS (src/collections/cmdExplorerSeed.ts) does not reference them, and ON CONFLICT
-- (row_fingerprint) DO NOTHING has no SET clause — so ingest keeps working untouched.
--
-- GRANTS: none needed. A table-level GRANT SELECT (0019, to claims_reader) automatically covers
-- columns added later; cmd_rollup_writer's INSERT is unaffected (generated cols are never written).
--
-- ⚠️ LOCK / REWRITE: adding a STORED generated column REWRITES the table and holds ACCESS
-- EXCLUSIVE for the duration (~625k rows total across both tenants). Apply OUTSIDE the :30 cron
-- window; expect a brief full-table lock (reads + the cron INSERT block until it completes).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Rollback (drops both columns) lives in
-- supabase/rollbacks/0038_cmd_explorer_pct_columns_rollback.sql (separate dir so no forward
-- auto-apply can ever run it). DEPENDENCY: 0019 (the table + its numeric columns).

alter table collections.cmd_explorer_rows
  add column if not exists pct_allowed numeric
    generated always as (
      case when charge_amount > 0
           then round(allowed_amount / charge_amount * 100, 2)
      end
    ) stored,
  add column if not exists pct_paid numeric
    generated always as (
      case when allowed_amount > 0
           then round(insurance_payments / allowed_amount * 100, 2)
      end
    ) stored;
