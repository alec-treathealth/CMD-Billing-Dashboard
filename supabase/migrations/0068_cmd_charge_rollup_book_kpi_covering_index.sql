-- 0068 — Covering index for the book-wide Qualify KPI aggregate (index-only scan).
--
-- WHY: the book-wide KPI query (src/collections/qualifyQuery.ts buildBookKpisQuery) sums
-- charge_amount / allowed_reliable (ex-e2) / insurance_payments over a payment_received window,
-- scoped by business_entity_id. At the new 12-month rolling window (~152k rows) the planner picked a
-- serial Index Scan on cmd_charge_rollup_entity_payment and did random heap access per row (~8.3s).
-- This covering index carries the four summed columns in its INCLUDE payload, so the same query runs
-- as a PARALLEL INDEX-ONLY SCAN (Heap Fetches: 0) in ~40ms — a ~200x win. Every shorter window (incl.
-- today's 90d) benefits too.
--
-- The LIVE index was created with CREATE INDEX CONCURRENTLY (no lock) followed by
-- VACUUM (ANALYZE) collections.cmd_explorer_charge_rollup so the visibility map is all-visible (a
-- prerequisite for the index-only scan). This file uses a plain, transaction-safe IF NOT EXISTS
-- create so it is a no-op where the index already exists and still provisions a fresh environment.
--
-- NOTE 1: the matview must be VACUUMed after each REFRESH for the index-only scan to stay hot — the
--         refresh job should run `vacuum (analyze) collections.cmd_explorer_charge_rollup`.
-- NOTE 2: the existing cmd_charge_rollup_entity_payment (business_entity_id, payment_received) index
--         is now a strict key-subset of this one and MAY be dropped in a later cleanup, once the
--         trend query's plan is confirmed against the covering index in production.
-- NOTE 3: a future full rebuild of the matview (0059-style) should re-create this index alongside
--         the other six.

create index if not exists cmd_charge_rollup_entity_payment_cov
  on collections.cmd_explorer_charge_rollup (business_entity_id, payment_received)
  include (charge_amount, allowed_reliable, allowed_tier, insurance_payments);
