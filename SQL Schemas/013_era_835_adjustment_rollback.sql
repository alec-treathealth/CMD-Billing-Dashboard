-- =============================================================================
-- ROLLBACK for Veris migration 013 — staging.era_835_payment + era_835_adjustment
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
--
-- The forward file had NO paired rollback (it predates the every-migration-ships-a-
-- rollback convention in .claude/rules/sql-migrations.md). Added here alongside the
-- grain-audit amendment.
--
-- SCOPE: drops both tables 013 creates, and nothing else. Roles are NEVER dropped
--   (standing rule: CREATE-if-absent forward, never DROP ROLE back) and the schema-
--   level GRANT USAGE is left in place — both are shared with every other staging
--   table, so revoking them here would break the live plane.
--
-- ⚠️ DATA LOSS: these are append-only landing tables for a money-critical feed. If
--   they hold rows, dropping them discards remittance history that can only be
--   recovered by re-pulling every affected (customer, date) from the CMD API — and
--   CMD's 835 endpoint is keyed on ERA RECEIPT date, so a re-pull is not always
--   possible for older windows. The guard below therefore REFUSES to drop a
--   non-empty table unless you explicitly opt in.
--
-- TO FORCE (deliberate, after exporting): set the GUC in the same session, e.g.
--     SET LOCAL era835.rollback_allow_data_loss = 'on';
--   then run this file. Absent that, a populated table aborts the rollback.
--
-- ORDER: era_835_adjustment first — it FKs to era_835_payment, so the parent cannot
--   be dropped while the child exists.
-- =============================================================================

SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- 1. ACTIVE data-loss guard (counts only — never a row value; both tables are
--    PHI-bearing or money-bearing).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_pay  bigint := 0;
  n_adj  bigint := 0;
  allow  text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='staging' AND table_name='era_835_payment') THEN
    EXECUTE 'SELECT count(*) FROM staging.era_835_payment' INTO n_pay;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='staging' AND table_name='era_835_adjustment') THEN
    EXECUTE 'SELECT count(*) FROM staging.era_835_adjustment' INTO n_adj;
  END IF;

  IF n_pay > 0 OR n_adj > 0 THEN
    -- current_setting(..., true) returns NULL rather than erroring when unset.
    allow := current_setting('era835.rollback_allow_data_loss', true);
    IF allow IS NULL OR lower(allow) NOT IN ('on','true','1','yes') THEN
      RAISE EXCEPTION
        '013 rollback guard: refusing to drop populated tables (era_835_payment=% rows, era_835_adjustment=% rows). This discards remittance history that may not be re-pullable (CMD keys 835 downloads on ERA receipt date). Export first, then re-run with: SET LOCAL era835.rollback_allow_data_loss = ''on'';',
        n_pay, n_adj;
    END IF;
    RAISE WARNING
      '013 rollback: dropping POPULATED tables by explicit opt-in (era_835_payment=% rows, era_835_adjustment=% rows).',
      n_pay, n_adj;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Drop child then parent. Indexes, policies, comments and the column-level
--    grants are all dropped with their tables — no separate cleanup needed.
-- ---------------------------------------------------------------------------
-- ORDER IS LOAD-BEARING: era_835_adjustment.payment_id REFERENCES era_835_payment(id),
-- so the CHILD must go first. Reversing these two lines fails with SQLSTATE 2BP01
-- (dependent objects still exist) — at exactly the moment a failed rollback hurts most.
DROP TABLE IF EXISTS staging.era_835_adjustment;   -- child (FK holder) FIRST
DROP TABLE IF EXISTS staging.era_835_payment;      -- parent SECOND

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 3. Verification (run after rollback)
-- ---------------------------------------------------------------------------
-- SELECT count(*) FROM information_schema.tables
--  WHERE table_schema='staging' AND table_name IN ('era_835_payment','era_835_adjustment');
--   -- expect 0
--
-- SELECT count(*) FROM pg_policies
--  WHERE schemaname='staging' AND tablename LIKE 'era_835%';       -- expect 0
--
-- -- roles intentionally survive (shared with the live staging plane):
-- SELECT rolname FROM pg_roles WHERE rolname IN ('claims_reader','cmd_rollup_writer');
--   -- expect 2 rows
-- =============================================================================
