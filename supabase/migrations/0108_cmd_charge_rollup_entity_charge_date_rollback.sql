-- 0108 ROLLBACK — drop the (business_entity_id, charge_date) btree on the charge rollup.
--
-- Apply as ONE autocommit `execute_sql` statement, NOT `apply_migration`: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block (the same restriction as the CREATE). Run it outside the
-- :45–:48 window — the hourly refresh holds SHARE UPDATE EXCLUSIVE and the drop queues behind it.
--
-- Consequence: /code-performance's per-tenant charge_date windows fall back to the plans measured
-- before 0108 — BXR to a payment-ordered index walk that discards 72% of what it reads (10,959 ms
-- cold), Indigo to a parallel seq scan. No other reader depends on this index (verified 2026-09-08:
-- it was the first charge_date-led index on the relation, so nothing older could have planned on it).
--
-- The hand-inserted ledger row (version 20260908223624) is NOT deleted here — a consumed number stays
-- consumed (the 0095 rule); a re-apply is the CREATE in 0108, not a new number.

drop index concurrently if exists collections.cmd_charge_rollup_entity_charge_date;

-- Verification: select to_regclass('collections.cmd_charge_rollup_entity_charge_date');  -- expect NULL
