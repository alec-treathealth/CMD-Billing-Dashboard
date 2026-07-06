-- Rollback for Migration 020 (VERIS sequence): etl_backfill
-- Restores the exact pre-020 label state from staging.etl_backfill_020_undo:
--   - DELETEs only the rows 020 itself INSERTed (action='INSERT'). It can never
--     touch a pre-existing PENDING row: those were never in 020's source set,
--     so they never entered the undo table.
--   - Restores prior label-side values on the rows 020 UPDATEd.
--
-- HONESTY LIMITS (stated, not papered over):
--   - Covers 020's apply-time DML ONLY. Loader runs (src/veris/etl_backfill.ts)
--     after apply are forward-only reconciliation and are NOT audited here;
--     rolling those back means re-running the loader against the desired
--     source state, not this script.
--   - Feature columns on pre-existing rows were never modified by 020, so
--     there is nothing to restore there.
--   - The undo table records the EARLIEST prior state if 020 was re-run
--     (ON CONFLICT DO NOTHING at capture) — rollback lands at pre-FIRST-apply.

SET ROLE claims_admin;

-- Active guard: refuse to "roll back" blind.
DO $$
BEGIN
  IF to_regclass('staging.etl_backfill_020_undo') IS NULL THEN
    RAISE EXCEPTION '020 rollback aborted: staging.etl_backfill_020_undo missing — nothing to restore from (020 never applied, or undo already consumed)';
  END IF;
END $$;

-- 1. Remove rows 020 inserted.
DELETE FROM staging.brain1_features bf
USING staging.etl_backfill_020_undo u
WHERE u.action = 'INSERT'
  AND bf.business_entity_id = u.business_entity_id
  AND bf.charge_debit_id    = u.charge_debit_id;

-- 2. Restore prior labels on rows 020 updated.
UPDATE staging.brain1_features bf SET
  outcome              = u.prior_outcome,
  days_to_pay          = u.prior_days_to_pay,
  was_underpayment     = u.prior_was_underpayment,
  net_underpayment_amt = u.prior_net_underpayment_amt,
  allowed_amount       = u.prior_allowed_amount,
  residual_type        = u.prior_residual_type,
  label_is_terminal    = u.prior_label_is_terminal,
  claim_line_id        = u.prior_claim_line_id,
  built_at             = u.prior_built_at,
  built_by             = u.prior_built_by
FROM staging.etl_backfill_020_undo u
WHERE u.action = 'UPDATE'
  AND bf.business_entity_id = u.business_entity_id
  AND bf.charge_debit_id    = u.charge_debit_id;

-- 3. Report, then consume the audit.
DO $$
DECLARE n_del bigint; n_res bigint;
BEGIN
  SELECT count(*) FILTER (WHERE action = 'INSERT'),
         count(*) FILTER (WHERE action = 'UPDATE')
    INTO n_del, n_res
  FROM staging.etl_backfill_020_undo;
  RAISE NOTICE 'etl_backfill_020 rollback: deleted % inserted rows, restored % updated rows', n_del, n_res;
END $$;

DROP TABLE staging.etl_backfill_020_undo;

RESET ROLE;
