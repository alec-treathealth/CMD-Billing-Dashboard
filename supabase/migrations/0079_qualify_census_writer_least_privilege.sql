-- 0079 — census writer least-privilege (PR #73 review): revoke the unused DELETE.
--
-- WHY: the census sync's ONLY write is INSERT .. ON CONFLICT .. DO UPDATE
--   (src/collections/qualifyCensusSync.ts). cmd_rollup_writer held DELETE from 0078 out of habit,
--   not need — least privilege says a credential compromise or a bug should not be able to empty
--   the table. Row removal (a decommissioned board) is an operator action on the admin path.
--
-- TENANCY, on the record (PR #73 review, deliberate exception — documented, not fixed, because it
--   is not a defect): collections.qualify_facility_census carries NO business_entity_id. It is
--   facility-grain, non-PHI ops data keyed by collections.facilities.facility_code, and the
--   facilities table itself is entity-less — verified live 2026-08-03: the per-row tenant key
--   exists on exactly six DATA tables (cmd_explorer_rows, daily_collections,
--   daily_collections_resolved, cmd_payer_facility_monthly, cmd_census_run, cmd_charge_census).
--   Census values only surface joined to entity-scoped ranking rows (app/lib/qualify/core.ts), and
--   the Qualify surface is deliberately cross-tenant (QUALIFY_TENANT_SCOPE). Adding a tenant column
--   here would diverge from the facilities-table precedent without adding enforcement.
--
-- IDEMPOTENT: REVOKE is repeatable. Rollback: 0079_qualify_census_writer_least_privilege_rollback.sql

revoke delete on collections.qualify_facility_census from cmd_rollup_writer;

-- Verification (run manually after apply)
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'collections' and table_name = 'qualify_facility_census'
--    and grantee = 'cmd_rollup_writer' order by privilege_type;
-- -- expect exactly: INSERT, SELECT, UPDATE
