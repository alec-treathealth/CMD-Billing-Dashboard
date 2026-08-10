-- =============================================================================
-- ROLLBACK for 033 — restores staging.expected_payment_manual to its 024 shape:
--   hard-delete removal, no lifecycle status, matched_era_key forbidden on an 'add'.
--
-- ⚠️ THIS ROLLBACK DESTROYS DATA, and not only the columns it drops.
--
--   1. SOFT-REMOVED ROWS BECOME LIVE AGAIN. Dropping removed_at is dropping the only
--      marker that says "a super admin took this decision back". Every tombstone
--      immediately starts rendering on the Future Payments tile as expected money —
--      including any row whose removal is the reason a total currently looks right.
--      PURGE THEM FIRST if that is not what you want (§0 below).
--
--   2. RECONCILED 'add' ROWS LOSE THEIR 835 LINK. §3 re-imposes 024's kind-shape CHECK,
--      which forbids matched_era_key on an 'add'. The ALTER cannot succeed while such a
--      row exists, so §2 NULLs those keys first. That is a real loss of provenance: the
--      record of which remit an operator agreed covered which forecast is gone.
--
--   ROLL THE APP BACK FIRST, OR TOGETHER. app/lib/server.ts calls
--   staging.remove_expected_payment_manual and staging.set_expected_payment_manual_status;
--   both are dropped in §4. A deployed build running against a rolled-back database will
--   500 on every Remove and every reconciliation action on the tile. 024's
--   delete_expected_payment_manual is untouched and is what the older code calls.
--
-- Verification of the pre-state, before running any of this:
--   SELECT count(*) FILTER (WHERE removed_at IS NOT NULL) AS tombstones,
--          count(*) FILTER (WHERE status <> 'expected')   AS reconciled
--     FROM staging.expected_payment_manual;
--   -- Both numbers are what this rollback is about to lose. Write them down.
-- =============================================================================

SET ROLE claims_admin;

-- 0. OPTIONAL — purge instead of resurrecting. ---------------------------------
-- Commented out because it is irreversible and the correct choice depends on WHY you are
-- rolling back. Uncomment ONLY if the tombstones must not come back as live money.
--   DELETE FROM staging.expected_payment_manual WHERE removed_at IS NOT NULL;

-- 1. Drop the partial read index added by 033. ---------------------------------
DROP INDEX IF EXISTS staging.expected_payment_manual_live_idx;

-- 2. Clear the data 024's constraint cannot hold. ------------------------------
-- Must run BEFORE §3, or the ALTER ... ADD CONSTRAINT below fails validation on exactly
-- the rows 033 made legal. See hazard 2 in the header — this is a deliberate data loss.
UPDATE staging.expected_payment_manual
   SET matched_era_key = NULL
 WHERE kind = 'add' AND matched_era_key IS NOT NULL;

-- 3. Restore 024's constraint set. ---------------------------------------------
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_status_shape_ck;
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_removal_shape_ck;
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_status_ck;

-- 024's kind-shape CHECK, verbatim: matched_era_key allowed ONLY on a 'landed' suppress.
ALTER TABLE staging.expected_payment_manual
  DROP CONSTRAINT IF EXISTS expected_payment_manual_kind_shape_ck;
ALTER TABLE staging.expected_payment_manual
  ADD CONSTRAINT expected_payment_manual_kind_shape_ck CHECK (
    (kind = 'add'      AND amount IS NOT NULL AND method_label IS NOT NULL
                       AND suppress_reason IS NULL AND matched_era_key IS NULL)
    OR
    (kind = 'correct'  AND amount IS NOT NULL
                       AND suppress_reason IS NULL AND matched_era_key IS NULL)
    OR
    (kind = 'suppress' AND amount IS NULL AND method_label IS NULL
                       AND suppress_reason IS NOT NULL
                       AND (suppress_reason = 'landed' OR matched_era_key IS NULL))
  );

-- 4. Drop 033's columns and functions. -----------------------------------------
ALTER TABLE staging.expected_payment_manual DROP COLUMN IF EXISTS status;
ALTER TABLE staging.expected_payment_manual DROP COLUMN IF EXISTS removed_at;
ALTER TABLE staging.expected_payment_manual DROP COLUMN IF EXISTS removed_by;

DROP FUNCTION IF EXISTS staging.remove_expected_payment_manual(uuid, bigint, uuid);
DROP FUNCTION IF EXISTS staging.set_expected_payment_manual_status(uuid, bigint, text, text, uuid);

-- 5. Restore 024's upsert body. ------------------------------------------------
-- 033 replaced this function in place (same signature), so dropping columns is not enough:
-- the 033 body references status/removed_at and would fail on its next call. This is
-- 024 §5's definition verbatim.
CREATE OR REPLACE FUNCTION staging.upsert_expected_payment_manual(
  p_business_entity_id uuid,
  p_kind               text,
  p_facility_code      text,
  p_payer_label        text,
  p_expected_date      date,
  p_method_label       text,
  p_amount             numeric,
  p_suppress_reason    text,
  p_matched_era_key    text,
  p_actor              uuid
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  IF p_business_entity_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'upsert_expected_payment_manual: tenant and actor are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.business_entity b WHERE b.id = p_business_entity_id) THEN
    RAISE EXCEPTION 'upsert_expected_payment_manual: unknown business_entity_id';
  END IF;

  INSERT INTO staging.expected_payment_manual (
    business_entity_id, kind, facility_code, payer_label, expected_date,
    method_label, amount, suppress_reason, matched_era_key,
    created_by, updated_by
  ) VALUES (
    p_business_entity_id, p_kind, p_facility_code, p_payer_label, p_expected_date,
    p_method_label, p_amount, p_suppress_reason, p_matched_era_key,
    p_actor, p_actor
  )
  ON CONFLICT (business_entity_id, kind, facility_code, payer_label, expected_date)
  DO UPDATE SET
    method_label    = excluded.method_label,
    amount          = excluded.amount,
    suppress_reason = excluded.suppress_reason,
    matched_era_key = excluded.matched_era_key,
    updated_by      = excluded.updated_by,
    updated_at      = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

RESET ROLE;

-- 6. Verification (run manually after rollback) --------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='staging' AND table_name='expected_payment_manual'
--    AND column_name IN ('status','removed_at','removed_by');   -- expect 0 rows
--
-- SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname='staging' AND p.proname LIKE '%expected_payment_manual%';
--   -- expect exactly 2: upsert_ and delete_ (024's pair)
--
-- SELECT conname FROM pg_constraint
--  WHERE conrelid='staging.expected_payment_manual'::regclass AND conname LIKE '%_ck';
--   -- expect kind_shape only; no status_ck / status_shape_ck / removal_shape_ck
-- =============================================================================
