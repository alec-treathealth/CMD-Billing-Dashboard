-- 0070 ROLLBACK — restore 0068's original covering index and drop the member-augmented one.
--
-- Reverses 0070: recreates cmd_charge_rollup_entity_payment_cov with 0068's ORIGINAL four-column
-- INCLUDE payload (no member_id_bidx) and drops cmd_charge_rollup_entity_payment_cov_m. After this,
-- the book-wide KPI query reverts to its Phase-2 regressed plan (plain Index Scan, ~52 ms at 30d) —
-- i.e. this is a genuine revert of the fix, not a silent perf regression left unremarked.
--
-- SAME APPLY DISCIPLINE AS 0070: CREATE/DROP INDEX CONCURRENTLY and VACUUM cannot run in a transaction
-- block — apply statement-by-statement OUTSIDE a transaction, not via a wrapping tool. Re-runnable
-- (IF [NOT] EXISTS); clear any INVALID leftover from an interrupted CONCURRENTLY build before re-running
-- (see 0070 header for the pg_index check).

-- 1) Rebuild 0068's original covering index alongside _cov_m (no coverage gap).
create index concurrently if not exists cmd_charge_rollup_entity_payment_cov
  on collections.cmd_explorer_charge_rollup (business_entity_id, payment_received)
  include (charge_amount, allowed_reliable, allowed_tier, insurance_payments);

-- 2) Drop the member-augmented index.
drop index concurrently if exists collections.cmd_charge_rollup_entity_payment_cov_m;

-- 3) Refresh the visibility map for the restored index's index-only scans.
vacuum (analyze) collections.cmd_explorer_charge_rollup;
