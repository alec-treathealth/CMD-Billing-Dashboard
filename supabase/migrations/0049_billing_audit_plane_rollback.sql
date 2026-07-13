-- 0049 ROLLBACK: Billing Audit plane — drops the six claims.* audit tables (policies +
-- indexes + identity sequences go with them) and revokes claims_audit_writer's grants.
--
-- ⚠️ DESTRUCTIVE: drops claims.audit_row (encrypted PHI rows), billing_code_decision,
-- payer_alias, facility_alias, flag_rule, and flag — including any operator work
-- product (acknowledged/resolved/dismissed flags, notes). Run only on a deliberate
-- rollback decision; there is no undo table.
--
-- NEVER `DROP ROLE` (docs/CLAUDE.md §2): claims_audit_writer is left in place with all
-- grants revoked (same posture as every prior role rollback). Re-applying 0049 restores it.
--
-- MIXED-MODE (mirrors 0049 forward): drops + core revokes run as claims_admin (owner);
-- the schema-claims USAGE revoke runs as postgres (schema owner — claims_admin holds
-- no grant option there). Idempotent: guards + IF EXISTS everywhere; safe to re-run.

set role claims_admin;

-- Dropping the tables removes their table/sequence grants and policies implicitly;
-- order: flag first (FKs onto audit_row + flag_rule), then the rest.
drop table if exists claims.flag;
drop table if exists claims.flag_rule;
drop table if exists claims.audit_row;
drop table if exists claims.billing_code_decision;
drop table if exists claims.payer_alias;
drop table if exists claims.facility_alias;

-- core registry read grants (core is claims_admin-owned).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'claims_audit_writer') then
    revoke all on core.business_entity, core.cmd_customer from claims_audit_writer;
    revoke usage on schema core from claims_audit_writer;
  end if;
end $$;

reset role;

-- As postgres (schema owner): retract the writer's foothold in schema claims.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'claims_audit_writer') then
    revoke usage on schema claims from claims_audit_writer;
  end if;
end $$;
