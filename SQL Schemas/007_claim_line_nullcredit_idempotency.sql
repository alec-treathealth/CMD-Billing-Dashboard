-- Migration 007: claim_line null-credit idempotency (NULLS NOT DISTINCT)
-- Deployed: 2026-06-22
-- DB: dbpabchpvipipkzkogta
-- Safe to re-run (no-op once NULLS NOT DISTINCT; CREATE INDEX IF NOT EXISTS).
--
-- ROOT CAUSE: staging.claim_line UNIQUE (business_entity_id, charge_debit_id,
-- credit_id) was created with the PG default NULLS DISTINCT. Null-credit rows
-- store credit_id = NULL; since NULL <> NULL in a unique index they never match
-- ON CONFLICT and re-INSERT on every 002 (and 004 Indigo) run. A backfill re-run
-- grew claim_line by 6,842 duplicate null-credit rows (13,843 over 6,842 charges).
--
-- GRAIN DECISION (2026-06-22, data-backed): one row per (business_entity_id,
-- charge_debit_id, credit_id), NULLs collapsed -> at most one null-credit row per
-- charge. Verified read-only: 0 of 6,842 null-credit charges carry >1 distinct
-- claim_status (max = 1), so collapsing nulls discards no status grain. 002's
-- in-memory null-credit dedup key is reconciled to (charge_debit_id) in the same
-- commit so in-memory and DB grain agree (no silent re-insert, no silent collapse).
--
-- FIX: rebuild the unique constraint WITH NULLS NOT DISTINCT (PG15+; here 17.6).
-- credit_id stays NULL (no stored-value change), so downstream `credit_id IS NULL`
-- semantics are preserved: 003 payment_residual ORDER BY credit_id NULLS LAST; 004
-- Indigo episode-grain rows -- this also fixes 004's identical latent idempotency
-- bug with no 004 code change.
--
-- EXPANDED SCOPE: index FK columns on child tables to make cascade-delete feasible
-- (era_adjustment already had its equivalent). Without an index on the child
-- claim_line_id, deleting claim_line rows seq-scans each child once per deleted row.
--
-- PRECONDITION (ENFORCED): the one-time repoint-before-delete cleanup MUST run
-- first; a NULLS NOT DISTINCT unique index cannot build over duplicate null-credit
-- rows. The guard below aborts with a clear message if any remain (table-wide).
--
-- Roles: owner claims_admin; claims_reader keeps SELECT (a constraint swap does
-- not alter grants). Deploy as a role that can ALTER staging.claim_line.

DO $$
DECLARE v_con text; v_notdist boolean; v_dups bigint;
BEGIN
  SELECT c.conname, i.indnullsnotdistinct INTO v_con, v_notdist
  FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
  WHERE c.conrelid='staging.claim_line'::regclass AND c.contype='u'
    AND pg_get_constraintdef(c.oid) LIKE 'UNIQUE%(business_entity_id, charge_debit_id, credit_id)';

  IF v_con IS NULL THEN
    RAISE EXCEPTION '007: expected unique constraint on (be, charge_debit_id, credit_id) not found';
  END IF;
  IF v_notdist THEN
    RAISE NOTICE '007: % already NULLS NOT DISTINCT -- no-op', v_con; RETURN;
  END IF;

  SELECT count(*) INTO v_dups FROM (
    SELECT business_entity_id, charge_debit_id FROM staging.claim_line
    WHERE credit_id IS NULL GROUP BY business_entity_id, charge_debit_id HAVING count(*)>1) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION '007 aborted: % null-credit group(s) still duplicated -- run the cleanup FIRST', v_dups;
  END IF;

  EXECUTE format('ALTER TABLE staging.claim_line DROP CONSTRAINT %I', v_con);
  ALTER TABLE staging.claim_line
    ADD CONSTRAINT claim_line_business_entity_id_charge_debit_id_credit_id_key
    UNIQUE NULLS NOT DISTINCT (business_entity_id, charge_debit_id, credit_id);

  CREATE INDEX IF NOT EXISTS idx_payment_residual_claim_line_id
    ON staging.payment_residual (claim_line_id);
  CREATE INDEX IF NOT EXISTS idx_brain1_features_claim_line_id
    ON staging.brain1_features (claim_line_id);

  RAISE NOTICE '007: swapped % to NULLS NOT DISTINCT', v_con;
END $$;
