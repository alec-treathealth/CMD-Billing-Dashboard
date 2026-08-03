-- =============================================================================
-- ROLLBACK for 024_expected_payment_manual.sql
--
-- ⚠️ THIS DESTROYS HUMAN DECISIONS. Unlike 023's table — which is a mirror of a Google Sheet
-- and rebuilds itself on the next cron run — every row here was typed by a named super admin
-- and exists NOWHERE else. Dropping this table permanently loses:
--   · corrections to sheet amounts (the sheet still shows the wrong number),
--   · 'landed' suppressions (forecast rows already paid REAPPEAR on the tile, double-counting
--     against their 835s — exactly the failure 023's additive-only note warns about),
--   · manual 'add' rows for payments neither feed knows about (silently gone from the tile).
--
-- SO: EXPORT FIRST, ALWAYS. The claims.access_audit trail records that each edit happened and
-- by whom, but not the row contents — it is not a backup.
--
--   \copy (SELECT * FROM staging.expected_payment_manual ORDER BY id)
--     TO 'expected_payment_manual_backup.csv' WITH (FORMAT csv, HEADER);
--
-- Safe to run twice (IF EXISTS throughout). Run as postgres via apply_migration.
--
-- Nothing else references this table: there is no FK to or from 023 by design, and no view,
-- matview or trigger reads it — the resolver that merges it with the sheet feed lives in the
-- app (src/veris/upcomingForecast.ts), not in the database. So this drop cannot cascade
-- beyond the objects named below.
-- =============================================================================

SET ROLE claims_admin;

-- Functions first: they are the only write surface, so removing them before the table means
-- no window exists where a call could half-succeed against a vanishing table.
DROP FUNCTION IF EXISTS staging.upsert_expected_payment_manual(
  uuid, text, text, text, date, text, numeric, text, text, uuid
);
DROP FUNCTION IF EXISTS staging.delete_expected_payment_manual(uuid, bigint);

-- The policy goes with the table, but drop it explicitly so a partial apply (table created,
-- policy created, functions failed) also rolls back cleanly.
DROP POLICY IF EXISTS expected_payment_manual_reader_isolation
  ON staging.expected_payment_manual;

-- Indexes are owned by the table and go with it; named here for the partial-apply case.
DROP INDEX IF EXISTS staging.expected_payment_manual_decision_uidx;
DROP INDEX IF EXISTS staging.expected_payment_manual_upcoming_idx;

DROP TABLE IF EXISTS staging.expected_payment_manual;

RESET ROLE;

-- Roles are NEVER dropped (they predate this migration and are shared across 013–024).
-- claims_reader's schema USAGE also predates 024; leaving it is correct.

-- Verification: all four objects gone, and 023's feed untouched.
-- SELECT count(*) FROM information_schema.tables
--  WHERE table_schema='staging' AND table_name='expected_payment_manual';   -- expect 0
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='staging' AND p.proname LIKE '%expected_payment_manual'; -- expect 0
-- SELECT count(*) FROM information_schema.tables
--  WHERE table_schema='staging' AND table_name='expected_payment_override';  -- expect 1
-- =============================================================================
