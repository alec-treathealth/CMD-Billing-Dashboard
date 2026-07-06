-- =============================================================================
-- ROLLBACK for Veris migration 019 — remove the consolidated read path.
-- Apply via apply_migration (as postgres). Reverse-order teardown:
-- **019** → 018 → 017 → 016 → 015 → 014.
--
-- RESTORE TARGET (verified LIVE pre-019, 2026-07-05 — not inferred from the
-- migration's inverse): consolidated_reader absent from pg_roles;
-- core.consolidated_summary absent; policies on the 3 tables = ONLY the three
-- *_isolation policies (014/017); table grants = claims_admin (owner, full) +
-- claims_reader SELECT; schema USAGE = claims_admin/claims_reader (+ postgres
-- CREATE/USAGE on staging). This script touches ONLY consolidated_* artifacts —
-- the isolation policies and claims_* grants are not referenced.
--
-- §2 EXCEPTION (Alec's 019 directive, 2026-07-05 — supersedes the "never DROP
-- ROLE" pattern FOR THIS ROLE ONLY): consolidated_reader is 019-exclusive
-- (owns exactly one object, the function dropped first; no other migration
-- grants it anything), so DROP ROLE IF EXISTS restores the exact pre-019
-- state. The never-DROP-ROLE rule stands for claims_reader / claims_admin /
-- cmd_rollup_writer, which are shared across migrations.
-- =============================================================================

-- Function first (owned by consolidated_reader; postgres drops via membership).
DROP FUNCTION IF EXISTS core.consolidated_summary();

-- Per-table policies (owned by the table owner).
SET ROLE claims_admin;
DROP POLICY IF EXISTS business_entity_consolidated_read  ON core.business_entity;
DROP POLICY IF EXISTS claim_line_consolidated_read       ON staging.claim_line;
DROP POLICY IF EXISTS payment_residual_consolidated_read ON staging.payment_residual;
RESET ROLE;

-- Strip the enumerated read surface.
REVOKE SELECT ON core.business_entity     FROM consolidated_reader;
REVOKE SELECT ON staging.claim_line       FROM consolidated_reader;
REVOKE SELECT ON staging.payment_residual FROM consolidated_reader;
REVOKE USAGE ON SCHEMA core    FROM consolidated_reader;
REVOKE USAGE ON SCHEMA staging FROM consolidated_reader;

-- Remove the apply-path membership, then the role itself (§2 exception above:
-- exact pre-019 restore; the role owns nothing by this point).
REVOKE consolidated_reader FROM postgres;
DROP ROLE IF EXISTS consolidated_reader;

-- Verification: expect zero rows from each —
--   SELECT rolname FROM pg_roles WHERE rolname = 'consolidated_reader';
--   SELECT p.proname FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core';
--   SELECT schemaname, tablename, policyname FROM pg_policies
--    WHERE policyname LIKE '%consolidated%';
