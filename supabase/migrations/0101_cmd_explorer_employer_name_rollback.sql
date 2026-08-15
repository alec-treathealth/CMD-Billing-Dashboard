-- 0101_cmd_explorer_employer_name_rollback.sql — reverses 0101. Apply as `postgres`.
--
-- ⚠ APPLY AS AUTOCOMMIT STATEMENTS (execute_sql), NOT apply_migration — DROP INDEX
--    CONCURRENTLY cannot run inside a transaction block, same as the forward migration.
--
-- ⚠⚠ THIS IS DESTRUCTIVE OF BACKFILLED DATA AND IS NOT SYMMETRIC WITH THE FORWARD MIGRATION.
--    Dropping the column discards every employer value the one-shot backfill wrote. That
--    backfill is reconstructed from an external CSV export, NOT from anything else in this
--    database — there is no query that can regenerate it. If the CSV is not still on hand,
--    this rollback is IRREVERSIBLE in practice.
--
--    Before running section 2, dump the column:
--      \copy (select row_fingerprint, employer_name
--               from collections.cmd_explorer_rows
--              where employer_name is not null)
--        to 'employer_name_backup.csv' csv header
--    row_fingerprint is the correct key to dump against: it is unique across all 650,696 rows
--    (verified 2026-08-15, zero duplicates) and it is the same key the backfill matches on, so
--    the dump can be replayed directly by the backfill script.
--
--    Prefer section 1 alone. Dropping just the index reverses all of this migration's
--    PERFORMANCE cost while preserving the data; the column itself is inert if unread.

-- ---------------------------------------------------------------------------
-- SECTION 1 — drop the index + revoke the write grant (safe, non-destructive)
-- ---------------------------------------------------------------------------
drop index concurrently if exists collections.idx_cmd_explorer_rows_employer_trgm;
drop index concurrently if exists collections.idx_cmd_explorer_rows_has_employer;

-- Revoke the column-scoped UPDATE. Safe to run on its own and worth doing as soon as the one-shot
-- backfill has completed and been verified, even if the rest of this rollback is never run: the
-- hourly cron does NOT need it (it is INSERT ... ON CONFLICT DO NOTHING and never updates), so
-- leaving the grant in place after the backfill is standing privilege with no live caller.
revoke update (employer_name) on collections.cmd_explorer_rows from cmd_rollup_writer;

-- ---------------------------------------------------------------------------
-- SECTION 2 — drop the column (DESTRUCTIVE — read the header first)
-- ---------------------------------------------------------------------------
-- Commented out by default. Uncomment ONLY after the dump above has been taken and verified.
-- alter table collections.cmd_explorer_rows
--   drop column if exists employer_name;

analyze collections.cmd_explorer_rows;
