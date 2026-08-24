-- Rollback for 0107 — drop the Collections-grid ordered index.
--
-- ⚠ `DROP INDEX CONCURRENTLY` CANNOT run inside a transaction block, same as the CREATE. Run this
-- with autocommit `execute_sql`, NOT `apply_migration`.
--
-- CONSEQUENCE OF ROLLING BACK, so it is a decision and not an accident: the Collections grid's
-- single-entity views (bxr, indigo) revert from an ordered Index Scan with no Sort node
-- (52 buffers / ~1 ms) to a full tenant-slice read plus top-N sort (61,296 buffers / 479 MB,
-- 157 ms – 8,562 ms measured). Nothing breaks and nothing errors — it just gets slow again.
--
-- The companion caller change in `cmdExplorerBaseConds` (plain `= $n::uuid` for a one-id scope) is
-- INDEPENDENTLY CORRECT and does NOT need reverting with this: it selects exactly the same rows as
-- the array form, and with the index gone the planner simply falls back to a scan plus sort. Revert
-- it separately only if you want the diff gone, never because this rollback requires it.
--
-- Recovers 24 MB, and drops the hourly :45 concurrent refresh back to maintaining 13 indexes
-- (344 MB) instead of 14 (368 MB).

drop index concurrently if exists collections.cmd_charge_rollup_entity_payment_id_desc;
