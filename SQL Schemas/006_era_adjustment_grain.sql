-- Migration 006: era_adjustment credit-level grain
-- Deployed: 2026-06-21
-- DB: dbpabchpvipipkzkogta
-- Safe to re-run (ADD COLUMN IF NOT EXISTS + guarded constraint swap)
--
-- PURPOSE
-- Move staging.era_adjustment from charge-level to credit-level grain so that
-- CARC adjustments (which are credit-row-level events) and signed reversals
-- (codes 147 ~34% neg, 242 ~26% neg) survive as distinct rows for Brain 2 drift
-- detection. The unique key changes from
--   (business_entity_id, charge_debit_id, carc_code)
-- to
--   (business_entity_id, charge_debit_id, credit_id, carc_code).
--
-- ADDITIVE ONLY. This migration is a superset of the 001 schema: it adds one
-- column and swaps the unique constraint. No columns are dropped or retyped.
-- The table currently holds 0 rows, so the constraint swap touches no data; the
-- backfill (re-run of 002) repopulates under the new key afterward.
--
-- NULL-CREDIT CONVENTION
-- 002 writes credit_id = '' (empty string), NOT NULL, for charges that have no
-- associated credit row. This is deliberate: SQL UNIQUE treats every NULL as
-- distinct, so a nullable credit_id would let duplicate null-credit charges slip
-- past the key. The '' sentinel makes those rows dedup correctly. credit_id is
-- therefore left NULLABLE at the DDL level (no NOT NULL), but the writer is
-- contractually required to emit '' rather than NULL. Do not change 002 to write
-- NULL without revisiting this key.
--
-- DEPENDENCY: 006 MUST be applied BEFORE the 002 backfill re-runs. 002's
-- INSERT ... ON CONFLICT (business_entity_id, charge_debit_id, credit_id,
-- carc_code) errors with "no unique or exclusion constraint matching the
-- ON CONFLICT specification" until the new constraint below exists.
--
-- Roles: table owned by claims_admin (writer; owner bypasses RLS), claims_reader
--        granted SELECT, RLS enabled. Deploy DDL as a role that owns / can ALTER
--        staging.era_adjustment (see migration 001 notes).

-- =============================================================================
-- 1. Add credit_id column (additive, idempotent)
-- =============================================================================

ALTER TABLE staging.era_adjustment
  ADD COLUMN IF NOT EXISTS credit_id text;

-- Length guard, added separately so the column add stays idempotent and the
-- check can be (re-)created without error on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'staging.era_adjustment'::regclass
      AND conname  = 'era_adjustment_credit_id_check'
  ) THEN
    ALTER TABLE staging.era_adjustment
      ADD CONSTRAINT era_adjustment_credit_id_check
      CHECK (char_length(credit_id) <= 50);
  END IF;
END $$;

-- =============================================================================
-- 2. Swap the unique constraint to credit-level grain (idempotent)
-- =============================================================================
-- The 001 constraint is named
--   era_adjustment_business_entity_id_charge_debit_id_carc_code_key
-- (UNIQUE (business_entity_id, charge_debit_id, carc_code)). Rather than trust
-- that name, drop whatever UNIQUE constraint covers exactly
-- (business_entity_id, charge_debit_id, carc_code) and create the new one only
-- if an equivalent does not already exist.

DO $$
DECLARE
  old_con  text;
  new_def  text := 'UNIQUE (business_entity_id, charge_debit_id, credit_id, carc_code)';
  has_new  boolean;
BEGIN
  -- Already migrated? (constraint with the new 4-column definition present)
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'staging.era_adjustment'::regclass
      AND contype  = 'u'
      AND pg_get_constraintdef(oid) = new_def
  ) INTO has_new;

  -- Drop the old 3-column unique constraint if it is still present.
  SELECT conname INTO old_con
  FROM pg_constraint
  WHERE conrelid = 'staging.era_adjustment'::regclass
    AND contype  = 'u'
    AND pg_get_constraintdef(oid)
        = 'UNIQUE (business_entity_id, charge_debit_id, carc_code)';

  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE staging.era_adjustment DROP CONSTRAINT %I', old_con);
  END IF;

  -- Add the new 4-column unique constraint if not already present.
  IF NOT has_new THEN
    ALTER TABLE staging.era_adjustment
      ADD CONSTRAINT era_adjustment_be_charge_credit_carc_key
      UNIQUE (business_entity_id, charge_debit_id, credit_id, carc_code);
  END IF;
END $$;

-- =============================================================================
-- 3. Verification (run manually after deploy)
-- =============================================================================
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'staging.era_adjustment'::regclass AND contype = 'u';
--   expect: era_adjustment_be_charge_credit_carc_key
--           UNIQUE (business_entity_id, charge_debit_id, credit_id, carc_code)
--
-- SELECT column_name, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='staging' AND table_name='era_adjustment'
--   AND column_name='credit_id';
--   expect: credit_id | YES   (nullable by DDL; writer emits '' not NULL)
