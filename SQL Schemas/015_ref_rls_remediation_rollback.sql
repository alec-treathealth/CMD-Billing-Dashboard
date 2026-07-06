-- =============================================================================
-- ROLLBACK for Veris migration 015 — ref.* RLS remediation.
-- Apply via apply_migration (as postgres). Reverse order: drop policies →
-- disable RLS → restore drift-table ownership to postgres.
--
-- Restores pre-015 state (verified from the S2 ACL snapshot, veris-data-notes.md):
--   * all 12 tables RLS-disabled + read-all policy dropped;
--   * the 5 VOB tables (migration 0010) returned to owner=postgres, with their
--     ORIGINAL 0010 grants re-asserted: claims_reader SELECT + claims_admin
--     SELECT/INSERT/UPDATE. (These grants PRE-DATE 015 — do NOT revoke them.)
--   * the 7 claims_admin-owned tables keep their pre-existing 005/009/011
--     claims_reader SELECT.
-- =============================================================================

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
    EXECUTE format('DROP POLICY IF EXISTS %I ON ref.%I', t || '_read_all', t);
    EXECUTE format('ALTER TABLE ref.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
RESET ROLE;

-- Return the 5 VOB tables to their original owner (postgres). Runs as postgres
-- (owner of nothing here now, but member of claims_admin WITH SET, so it may
-- alter claims_admin-owned objects and reassign them to itself).
ALTER TABLE ref.payers          OWNER TO postgres;
ALTER TABLE ref.plans           OWNER TO postgres;
ALTER TABLE ref.service_codes   OWNER TO postgres;
ALTER TABLE ref.diagnosis_codes OWNER TO postgres;
ALTER TABLE ref.denial_codes    OWNER TO postgres;

-- Re-assert the ORIGINAL 0010 grants (ownership churn can rewrite acl entries).
-- These are pre-015 state, NOT added by 015 — restore, never revoke.
GRANT SELECT                 ON ref.payers, ref.plans, ref.service_codes, ref.diagnosis_codes, ref.denial_codes TO claims_reader;
GRANT SELECT, INSERT, UPDATE ON ref.payers, ref.plans, ref.service_codes, ref.diagnosis_codes, ref.denial_codes TO claims_admin;
