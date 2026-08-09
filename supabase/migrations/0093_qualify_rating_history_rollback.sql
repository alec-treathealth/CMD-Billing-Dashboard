-- Rollback for 0093 — drops the Qualify rating-history tables, their policies, and the echo seam.
--
-- DATA LOSS WARNING: qualify_policy_rating_daily is a HISTORY table. The claims aggregates are
-- reconstructible from the rollup (the cron's backfill re-derives them), but the coding/census
-- CONTEXT each rating was computed under is current-state-only upstream — a re-backfill after a
-- context change reconstructs with TODAY's context, not the original. Dropping this table loses
-- that provenance. qualify_prefix_echo's operator-typed echos are NOT reconstructible at all.
--
-- Idempotent: IF EXISTS throughout. Plain transactional DDL — safe under apply_migration
-- (no CONCURRENTLY, no VACUUM in this pair).

drop function if exists collections.record_qualify_prefix_echo(text, text);

drop table if exists collections.qualify_policy_rating_daily; -- policies drop with the table
drop table if exists collections.qualify_rating_run;
drop table if exists collections.qualify_prefix_echo;
