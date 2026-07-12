-- 0048: index collections.cmd_explorer_rows (payment_received DESC NULLS LAST, id DESC)
--       to fix the Consolidated (multi-tenant) first-page latency.
--
-- WHY: the grid's default sort is `payment_received DESC` and the Consolidated view filters
-- `business_entity_id = ANY(both tenants)`, which matches ~100% of the ~627k rows. The existing
-- composite index idx_cmd_explorer_beid_payment_received (business_entity_id, payment_received
-- DESC, id DESC) can't serve a GLOBAL payment_received ordering across two entity values, so the
-- planner fell back to a Parallel Seq Scan + top-N sort of the whole table (~2.4s measured via
-- EXPLAIN ANALYZE on prod). An index on the sort columns ALONE lets the planner walk it in order
-- and apply the ~100%-selective entity filter inline, terminating at LIMIT 50 in milliseconds.
-- Single-tenant (BXR / Indigo) reads keep using the composite index — unaffected.
--
-- APPLIED TO PROD OUT-OF-BAND via `CREATE INDEX CONCURRENTLY` (so the cron writer is never
-- ShareLock-blocked), mirroring how idx_cmd_explorer_beid_payment_received was added. This
-- committed file is the idempotent ledger record: `if not exists` makes a re-run a no-op (the
-- index already exists), and it deliberately omits CONCURRENTLY so it stays safe inside a
-- migration-runner transaction.

create index if not exists idx_cmd_explorer_payment_received
  on collections.cmd_explorer_rows (payment_received desc nulls last, id desc);
