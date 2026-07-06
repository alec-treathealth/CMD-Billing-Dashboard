-- =============================================================================
-- Veris migration 017 — staging.* RLS: add WITH CHECK to all 9 isolation policies
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review artifact: S2 bundle, apply position 4 of the ratified order
-- (016 → 018 → withTenant commit+push+prod-verify → **017** → 019).
--
-- ⚠️ HARD SEQUENCING GUARD (Alec, S2 gate ruling — no exceptions): this file
--   applies ONLY AFTER src/veris/withTenant.ts is committed, pushed, AND
--   verified on the production deployment (next hourly cmd-explorer run green
--   + one live BXR-scoped read through withTenant in prod). 017 is the moment
--   session-scoped GUCs become an active cross-tenant leak vector on the
--   Supavisor transaction pooler. If ordering is tight, 017 WAITS.
--
-- WHY: all 9 staging isolation policies are ALL/USING-only (verified live
--   2026-07-05). For a FOR ALL policy with no WITH CHECK, Postgres does fall
--   back to the USING expression when checking new rows — so today's write
--   side is gated only IMPLICITLY. The ratified S2 posture is an explicit
--   WITH CHECK: self-documenting, and immune to a later policy reshape (e.g.
--   splitting into FOR SELECT + FOR UPDATE policies, where the fallback
--   silently disappears) dropping the write-side tenant gate. Matches
--   core.business_entity / core.cmd_customer (014).
--
-- INGEST SAFETY: claims_admin OWNS all 9 tables and no table has FORCE ROW
--   LEVEL SECURITY (both verified live 2026-07-05, re-asserted below by an
--   active guard) — so owner-path ingest writes (ETL, builders, 835) bypass
--   RLS entirely and are untouched by this change. The policies bind only
--   non-owner roles: claims_reader (and consolidated_reader after 019, whose
--   read-all SELECT policies are additive).
--
-- Idempotent forward: DROP POLICY IF EXISTS + CREATE POLICY (SQLSTATE 42710
--   otherwise). Policy names unchanged (<table>_isolation). Fixed table array +
--   format(%I/%s with a fixed literal predicate) — no external input.
-- Paired rollback: 017_staging_rls_with_check_rollback.sql (restores the
--   USING-only 001/005/010/011/012 shape).
-- =============================================================================

SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- 0. ACTIVE GUARD — no staging table may have FORCE ROW LEVEL SECURITY.
--    claims_admin ingest writes must keep owner-bypass after WITH CHECK lands.
-- ---------------------------------------------------------------------------
DO $$
DECLARE offending text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO offending
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'staging' AND c.relkind = 'r' AND c.relforcerowsecurity;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      '017 guard: FORCE ROW LEVEL SECURITY is set on staging.% — owner-bypass for claims_admin ingest would be lost; resolve before applying', offending;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Recreate each isolation policy with an explicit WITH CHECK.
--    Same names, same USING expression; transaction-atomic (no unprotected
--    window — apply_migration is one transaction).
-- ---------------------------------------------------------------------------
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
    EXECUTE format(
      'CREATE POLICY %I ON staging.%I
         USING      (%s)
         WITH CHECK (%s)',
      t || '_isolation', t, predicate, predicate);
  END LOOP;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- First-run verification (run after apply):
--   SELECT tablename, policyname, cmd,
--          (qual IS NOT NULL)       AS has_using,
--          (with_check IS NOT NULL) AS has_with_check
--     FROM pg_policies WHERE schemaname = 'staging'
--    ORDER BY tablename;      -- expect 9 rows, cmd=ALL, both flags = t
-- =============================================================================
