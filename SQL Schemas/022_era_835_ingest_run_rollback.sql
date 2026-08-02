-- =============================================================================
-- ROLLBACK for migration 022 — drops staging.era_835_ingest_run.
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- DB: dbpabchpvipipkzkogta
--
-- ⚠️ DESTRUCTIVE: this table is the ONLY durable record of what each 835 ingest run did.
-- Dropping it discards that history permanently — the counts exist nowhere else, which is
-- the entire reason 022 exists (run stats live only in a response body Vercel discards and
-- in console.log that ages out of `vercel logs`). PREFER leaving the table in place and
-- reverting the code instead: an un-deployed writer simply never inserts, and an empty
-- observability table costs nothing. Drop only when 022 is being deliberately un-adopted.
--
-- SCOPE: this undoes 022 and nothing else.
--   * Does NOT touch staging.era_835_payment or staging.era_835_adjustment — 022 never
--     altered them (that is what 022 §7's column-count assertions prove: 18 and 42).
--   * Does NOT drop roles. Never DROP ROLE — claims_reader and cmd_rollup_writer are
--     shared across the whole staging plane.
--   * Does NOT revoke the schema-level USAGE grants 022 re-asserted; both roles already
--     held them from 001/013, and revoking would break unrelated paths.
--
-- The index and both RLS policies are objects OF the table and go with the DROP; there is
-- nothing to clean up separately.
--
-- IDEMPOTENT: IF EXISTS. Safe to re-run, and safe to run against a cluster where 022 was
-- never applied.
-- =============================================================================

SET ROLE claims_admin;

DROP TABLE IF EXISTS staging.era_835_ingest_run;

RESET ROLE;

-- Verification (run manually after apply) -------------------------------------
-- -- the table is gone:
-- SELECT count(*) FROM information_schema.tables
--  WHERE table_schema='staging' AND table_name='era_835_ingest_run';       -- expect 0
--
-- -- and its index and policies went with it:
-- SELECT count(*) FROM pg_indexes
--  WHERE schemaname='staging' AND indexname='era_835_ingest_run_recent_idx';  -- expect 0
-- SELECT count(*) FROM pg_policies
--  WHERE schemaname='staging' AND tablename='era_835_ingest_run';           -- expect 0
--
-- -- THE TWO ERA TABLES ARE UNTOUCHED, exactly as they were before 022:
-- SELECT table_name, count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name IN ('era_835_payment','era_835_adjustment')
--  GROUP BY 1 ORDER BY 1;
--   -- expect era_835_adjustment = 42, era_835_payment = 18
-- =============================================================================
