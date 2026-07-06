-- =============================================================================
-- ROLLBACK for Veris migration 017 — restore the USING-only isolation policies
-- (the pre-017 shape from migrations 001/005/010/011/012).
-- Apply via apply_migration (as postgres). Reverse-order teardown:
-- 019 → 018 → **017** → 016 → 015 → 014.
-- =============================================================================

SET ROLE claims_admin;

DO $$
DECLARE
  t         text;
  tables    text[] := ARRAY[
    'payer_dim','claim_line','era_adjustment','payment_residual',
    'brain1_features','brain1_scores','brain2_alerts',
    'claim_signatures','appeal_evidence'
  ];
  predicate constant text :=
    'business_entity_id = current_setting(''app.business_entity_id'')::uuid';
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON staging.%I', t || '_isolation', t);
    EXECUTE format('CREATE POLICY %I ON staging.%I USING (%s)',
                   t || '_isolation', t, predicate);
  END LOOP;
END $$;

RESET ROLE;

-- Verification: expect 9 rows, with_check IS NULL —
--   SELECT tablename, policyname, with_check FROM pg_policies
--    WHERE schemaname = 'staging' ORDER BY tablename;
