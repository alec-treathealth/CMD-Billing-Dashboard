-- =============================================================================
-- Veris migration 015 — ref.* RLS remediation (the master plan's "0013_rls_remediation")
-- Sequence: SQL Schemas/0NN_* (Veris). Apply via apply_migration (as postgres).
-- Gate-review artifact 2 of the S2 set. HOLD before live apply.
--
-- WHY: 12 ref.* tables have RLS DISABLED. They are GLOBAL, non-tenant reference
--   data (X12 CARC/RARC, CMS PFS, NPPES, payer aliases, VOB dimension tables) —
--   tenancy does NOT apply, so remediation is: enable RLS + a read-all
--   (FOR SELECT USING(true)) policy, mirroring ref.remittance_code (already
--   gated in 001). This closes the master plan's original 0013_rls_remediation
--   thread AND the get_advisors/veris-runbook.md §50 "RLS disabled" flag.
--
-- SCOPE — all 12 ungated ref tables (ref.remittance_code already gated, excluded):
--   claims_admin-owned (7): payer_alias, carc_code, rarc_code, cms_pfs_rate,
--     nppes_provider, carc_embeddings, rarc_embeddings.
--   postgres-owned (5): payers, plans, service_codes, diagnosis_codes,
--     denial_codes — these are the VOB FOUNDATION tables from
--     supabase/migrations/0010_vob_ai_foundation.sql (CLAUDE.md §12), owner=postgres
--     only because 0010 never ran ALTER OWNER (unlike 009/011). They are empty, have
--     no app writers (§12 groundwork; verified via repo grep + pg_stat_user_tables),
--     and already carry 0010 grants: claims_reader SELECT + claims_admin
--     SELECT/INSERT/UPDATE. runbook §50/§63 flagged them "decide separately" — S2
--     decides: reassign to claims_admin (convention + so owner keeps write access
--     once RLS is on) and gate them. (NOT lost-container drift — corrected from the
--     initial S2 read; they were simply never reached by a prior read of 0010.)
--
-- APPLY EXCEPTION (deliberate, recorded): Section 1 (ALTER … OWNER TO
--   claims_admin on the 5 drift tables) MUST run as the current owner, postgres.
--   apply_migration runs as postgres, a non-superuser member of claims_admin with
--   the SET option (GRANT claims_admin TO postgres WITH SET TRUE — see the S2
--   privilege note in veris-data-notes.md). Section 2 runs born-owned under
--   SET ROLE claims_admin. This is NOT the silent provenance pattern being
--   cleaned up — the exception is stated here on purpose.
--
-- POLICY SHAPE: FOR SELECT USING(true) only — NO write policies, so mutation
--   stays owner-only (claims_admin bypasses RLS as owner; ingest-path, expected).
--   GRANT SELECT to claims_reader; nothing to anon/authenticated/PUBLIC.
--
-- Idempotent forward. Paired rollback: 015_ref_rls_remediation_rollback.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Section 1 — AS postgres: transfer the 5 §17-drift tables to claims_admin.
-- (Only the current owner can transfer; the standing grant makes claims_admin a
--  valid target.) Section 2's SET ROLE then treats all 12 uniformly as owner.
-- ---------------------------------------------------------------------------
ALTER TABLE ref.payers          OWNER TO claims_admin;
ALTER TABLE ref.plans           OWNER TO claims_admin;
ALTER TABLE ref.service_codes   OWNER TO claims_admin;
ALTER TABLE ref.diagnosis_codes OWNER TO claims_admin;
ALTER TABLE ref.denial_codes    OWNER TO claims_admin;

-- ---------------------------------------------------------------------------
-- Section 2 — AS claims_admin (owner of all 12): enable RLS + read-all policy +
-- reader SELECT. Fixed table list (no external input); DROP POLICY IF EXISTS
-- before CREATE for idempotency.
-- ---------------------------------------------------------------------------
SET ROLE claims_admin;
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'payer_alias','carc_code','rarc_code','cms_pfs_rate','nppes_provider',
    'carc_embeddings','rarc_embeddings',
    'payers','plans','service_codes','diagnosis_codes','denial_codes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE ref.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON ref.%I', t || '_read_all', t);
    EXECUTE format('CREATE POLICY %I ON ref.%I FOR SELECT USING (true)', t || '_read_all', t);
    EXECUTE format('GRANT SELECT ON ref.%I TO claims_reader', t);
  END LOOP;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- First-run verification (run after apply):
--   -- MUST be ZERO ungated ref tables (closes 0013_rls_remediation):
--   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='ref' AND c.relkind='r' AND c.relrowsecurity=false;   -- expect 0
--   -- all 5 drift tables now owner=claims_admin:
--   SELECT relname, pg_get_userbyid(relowner) FROM pg_class c
--     JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='ref' AND relname IN
--      ('payers','plans','service_codes','diagnosis_codes','denial_codes');
-- ---------------------------------------------------------------------------
