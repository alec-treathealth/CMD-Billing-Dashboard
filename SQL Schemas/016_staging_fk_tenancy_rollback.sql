-- =============================================================================
-- ROLLBACK for Veris migration 016 — drop the staging.* → core.business_entity FKs.
-- Apply via apply_migration (as postgres). Reverse-order teardown:
-- 019 → 018 → 017 → 016 → 015 → 014 (014's rollback guard enforces that this
-- one has run first).
--
-- Non-destructive to data: only the 9 FK constraints are dropped; rows,
-- columns, indexes, and RLS are untouched.
-- =============================================================================

SET ROLE claims_admin;

DO $$
DECLARE
  t      text;
  tables text[] := ARRAY[
    'payer_dim','claim_line','era_adjustment','payment_residual',
    'brain1_features','brain1_scores','brain2_alerts',
    'claim_signatures','appeal_evidence'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE staging.%I DROP CONSTRAINT IF EXISTS %I',
                   t, t || '_business_entity_id_fkey');
  END LOOP;
END $$;

RESET ROLE;

-- Verification: expect ZERO rows —
--   SELECT conrelid::regclass, conname FROM pg_constraint
--    WHERE contype = 'f' AND confrelid = 'core.business_entity'::regclass
--      AND conrelid::regclass::text LIKE 'staging.%';
