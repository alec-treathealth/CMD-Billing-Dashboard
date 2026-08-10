-- =============================================================================
-- ROLLBACK for 034 — recreates staging.expected_payment_manual_live_idx exactly as 033 had it.
--
-- ⚠️ RESTORING THIS INDEX RESTORES A KNOWN-DEAD OBJECT. Measured live 2026-08-10 it had
-- idx_scan = 0 while 024's non-partial expected_payment_manual_upcoming_idx (same leading
-- columns) had 155. Postgres cannot use a partial index for `getUpcomingManual`, whose only
-- predicate is `business_entity_id = $1` — nothing there implies `removed_at IS NULL`.
--
-- So run this ONLY as part of reverting 033 wholesale, where the index needs to exist again for
-- 033's own rollback to be a faithful inverse. Do NOT run it expecting a performance change:
-- there was none to lose.
--
-- If you are here because a live-only read path was later added and the index is wanted for
-- real, do not use this file — write a forward migration that creates it alongside the query
-- that justifies it, so the two arrive together and the next reader can see the connection.
--
-- OWNERSHIP: claims_admin, matching 033. IDEMPOTENT: CREATE INDEX IF NOT EXISTS.
-- =============================================================================

SET ROLE claims_admin;

CREATE INDEX IF NOT EXISTS expected_payment_manual_live_idx
  ON staging.expected_payment_manual (business_entity_id, expected_date)
  WHERE removed_at IS NULL;

RESET ROLE;

-- Verification -----------------------------------------------------------------
-- SELECT indexrelname FROM pg_stat_user_indexes
--  WHERE schemaname='staging' AND relname='expected_payment_manual' ORDER BY 1;
--   -- expect 4, including _live_idx
-- =============================================================================
