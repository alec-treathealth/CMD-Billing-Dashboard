-- =============================================================================
-- ROLLBACK for migration 023 — drops staging.expected_payment_override.
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- DB: dbpabchpvipipkzkogta
--
-- SAFE TO RUN, unlike 022's rollback. This table holds NO original data: every row is a
-- verbatim projection of the "Upcoming Payments" Google Sheet, which remains the sole
-- editing surface and is untouched by this migration or its rollback. Dropping the table
-- loses nothing that the next sync would not immediately rebuild from the sheet.
--
-- PREFERRED ORDER when un-adopting 023: remove the cron entry from app/vercel.json and
-- deploy FIRST, then drop. Dropping while the cron is still scheduled leaves an hourly job
-- failing against a missing relation. The sync is fail-soft (it logs and returns a non-ok
-- field rather than crash-looping), so the reverse order degrades rather than breaks — but
-- do not rely on that.
--
-- SCOPE: this undoes 023 and nothing else.
--   * Does NOT touch staging.era_835_payment or staging.era_835_adjustment — 023 never
--     altered them (that is what 023 §8's column-count assertions prove: 18 and 42).
--   * Does NOT touch staging.era_835_ingest_run (022) or any collections.* table.
--   * Does NOT drop roles. Never DROP ROLE — claims_reader and cmd_rollup_writer are
--     shared across the whole staging plane. 023 created neither; it only re-asserted
--     grants they already held.
--   * Does NOT revoke the schema-level USAGE grants 023 re-asserted; both roles already
--     held them from 001/013, and revoking would break unrelated paths.
--
-- The index and all four RLS policies are objects OF the table and go with the DROP; there
-- is nothing to clean up separately. The table-level GRANTs vanish with the table too.
--
-- IDEMPOTENT: IF EXISTS. Safe to re-run, and safe to run against a cluster where 023 was
-- never applied.
-- =============================================================================

SET ROLE claims_admin;

DROP TABLE IF EXISTS staging.expected_payment_override;

RESET ROLE;

-- Verification (run manually after apply) -------------------------------------
-- -- the table is gone:
-- SELECT count(*) FROM information_schema.tables
--  WHERE table_schema='staging' AND table_name='expected_payment_override';    -- expect 0
--
-- -- and its index and all four policies went with it:
-- SELECT count(*) FROM pg_indexes
--  WHERE schemaname='staging'
--    AND indexname='expected_payment_override_upcoming_idx';                   -- expect 0
-- SELECT count(*) FROM pg_policies
--  WHERE schemaname='staging' AND tablename='expected_payment_override';       -- expect 0
--
-- -- no orphaned grants left behind:
-- SELECT count(*) FROM information_schema.role_table_grants
--  WHERE table_schema='staging' AND table_name='expected_payment_override';    -- expect 0
--
-- -- THE ERA TABLES AND 022 ARE UNTOUCHED, exactly as they were before 023:
-- SELECT table_name, count(*) FROM information_schema.columns
--  WHERE table_schema='staging'
--    AND table_name IN ('era_835_payment','era_835_adjustment')
--  GROUP BY 1 ORDER BY 1;
--   -- expect era_835_adjustment = 42, era_835_payment = 18
-- SELECT count(*) FROM information_schema.tables
--  WHERE table_schema='staging' AND table_name='era_835_ingest_run';           -- expect 1
--
-- -- the shared roles still exist (023's rollback must never drop them):
-- SELECT rolname FROM pg_roles
--  WHERE rolname IN ('claims_reader','cmd_rollup_writer') ORDER BY 1;  -- expect both rows
-- =============================================================================
