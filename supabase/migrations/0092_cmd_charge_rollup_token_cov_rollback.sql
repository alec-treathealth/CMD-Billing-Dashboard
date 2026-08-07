-- Rollback for 0092 — drop the two token-scoped covering indexes.
--
-- SIZE ESTIMATE (for the decision this leaves open — see 0092's footer): the existing bare
-- `cmd_charge_rollup_prefix` is 3,928 kB and `cmd_charge_rollup_member` is 4,360 kB over 492,287
-- rows (measured 2026-08-06). Each covering index adds business_entity_id (16 B uuid) +
-- payment_received (4 B date) + primary_payer (variable text, short) to every entry, and the
-- prefix one additionally carries member_id_bidx (~65 B HMAC text). Expect roughly a 2-4x per-entry
-- width increase — i.e. a delta on the order of 10-15 MB combined, not the 31 MB the wider
-- member_id_bidx-only precedent (0070) measured on a much larger covering index. Re-measure via
-- pg_relation_size after apply; this is an estimate, not a promise, per the repo's own convention
-- (see 0070's header, which made the same kind of estimate and flagged it as such).
--
-- Idempotent: IF EXISTS. Same apply discipline as the forward file — statement-by-statement,
-- outside a transaction (CONCURRENTLY cannot run inside one).

drop index concurrently if exists collections.cmd_charge_rollup_prefix_cov;
drop index concurrently if exists collections.cmd_charge_rollup_member_cov;
