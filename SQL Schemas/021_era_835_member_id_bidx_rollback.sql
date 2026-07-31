-- =============================================================================
-- ROLLBACK for Veris migration 021 — staging.era_835_adjustment.member_id_bidx
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
--
-- SCOPE: drops the index then the column. Nothing else — 021 created no roles, no
--   grants (the column inherited table-level grants; see 021's GRANTS note) and no
--   policies, so there is nothing else to undo.
--
-- DATA LOSS: dropping member_id_bidx discards the blind-index tokens. That is
--   RECOVERABLE, unlike most rollbacks in this plane: the tokens are DERIVED from
--   member_id_enc, which this file does not touch. Re-applying 021 plus an HMAC
--   backfill over the ciphertext (the migration-0037 /
--   src/collections/cmdBlindIndexBackfill.ts pattern) reconstructs them exactly, PROVIDED
--   the SAME INDEX_HMAC_KEY is still in use. If the key has rotated, the old tokens were
--   already dead and a re-mint under the new key is required regardless.
--
--   No guard/opt-in gate here (unlike 013's rollback, which refuses to drop populated
--   tables): losing a derived, re-computable search token is not comparable to discarding
--   remittance history. Rows, money and PHI are untouched — only searchability is lost.
--
-- ORDER: index first, then the column. Postgres would drop the index automatically with
--   the column, but doing it explicitly keeps the intent legible and the file re-runnable.
-- =============================================================================

SET ROLE claims_admin;

DROP INDEX IF EXISTS staging.era_835_member_id_bidx_idx;

ALTER TABLE staging.era_835_adjustment
  DROP COLUMN IF EXISTS member_id_bidx;

RESET ROLE;

-- Verification (run after rollback)
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='era_835_adjustment'
--    AND column_name='member_id_bidx';                      -- expect 0
-- SELECT count(*) FROM pg_indexes
--  WHERE schemaname='staging' AND indexname='era_835_member_id_bidx_idx';   -- expect 0
-- -- the ciphertext the tokens derive from is UNTOUCHED:
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='era_835_adjustment'
--    AND column_name='member_id_enc';                       -- expect 1
-- =============================================================================
