-- =============================================================================
-- ROLLBACK for Veris migration 014 — core.business_entity + core.cmd_customer.
-- Apply via apply_migration (postgres-level).
--
-- ⚠️ ORDER DEPENDENCY: run this ONLY AFTER 016 (staging FK tenancy) is rolled
--    back. The staging.* tables' business_entity_id FKs REFERENCE
--    core.business_entity; DROP TABLE here will fail while any such FK exists.
--    Reverse-order teardown: 019 → 018 → 017 → 016 → 015 → 014.
--    This is ENFORCED below (active guard, not a comment).
--
-- This DROPs the tenant registry and its seed. Destructive — the seed is
-- re-creatable from 014 (canonical UUIDs are fixed), but confirm no live
-- dependency remains before running.
-- =============================================================================

-- ACTIVE GUARD: refuse to proceed while any EXTERNAL FK still references either
-- core table. Excludes only the internal parent-child FK (core.cmd_customer ->
-- core.business_entity) that this script itself tears down. DROP would fail on
-- RESTRICT anyway; the guard turns that into an actionable message.
DO $$
DECLARE
  be_oid   oid := to_regclass('core.business_entity');
  cust_oid oid := to_regclass('core.cmd_customer');
  offending text;
BEGIN
  IF be_oid IS NULL AND cust_oid IS NULL THEN RETURN; END IF;  -- already dropped
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO offending
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN (be_oid, cust_oid)
    -- exclude the internal cmd_customer -> business_entity FK (torn down here)
    AND NOT (conrelid = cust_oid AND confrelid = be_oid);
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot roll back 014: external FK(s) still reference core.* : %. Roll back dependents (016 staging FKs, and any core.cmd_customer references) first.', offending;
  END IF;
END $$;

DROP POLICY IF EXISTS cmd_customer_isolation    ON core.cmd_customer;
DROP POLICY IF EXISTS business_entity_isolation ON core.business_entity;

-- cmd_customer first (its FK references business_entity).
DROP TABLE IF EXISTS core.cmd_customer;
DROP TABLE IF EXISTS core.business_entity;

-- Drop the schema only if nothing else was added to it (consolidated path, etc.).
-- RESTRICT (the default) fails loudly if other core.* objects exist — intended.
DROP SCHEMA IF EXISTS core RESTRICT;
