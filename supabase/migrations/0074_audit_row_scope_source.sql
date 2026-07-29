-- 0074: audit_row.scope_source — provenance for the TOB-vs-roster scope derivation
--       (Alec's ruling 2026-07-29 on the 301 quarantined professional-claim rows).
--
-- WHY: professional claims (CMS-1500/837P) STRUCTURALLY carry no Type of Bill and no
-- revenue code — those are institutional (UB-04/837I) fields. TOB scope derivation is
-- INAPPLICABLE to them, not degraded. Ruled fallback: when TOB and revenue code are
-- BOTH blank, scope derives from the customer's roster membership (AUDIT_IP_CUSTOMERS /
-- AUDIT_OP_CUSTOMERS — entity-level, not row-level). CPT was REJECTED as a signal
-- (H2018 spans both scopes, recon-measured). Fail-loud NARROWS but stays: blank TOB
-- with a revenue code PRESENT, an unrecognised non-blank TOB, or a both-blank row from
-- a customer not in exactly one roster still QUARANTINE.
--
-- scope_source is the audit trail: a fallback-derived row is always distinguishable
-- from a TOB-derived one, so a customer that ever returns a mixed scope is detectable
-- after the fact.
--
-- Idempotent-forward; safe to re-run. Backfill: every consolidated-feed row written
-- before this migration (charge_debit_id IS NOT NULL) was TOB-derived by construction
-- (the fallback did not exist yet; both-blank rows were quarantined, never written) —
-- stamped 'tob'. Legacy/OP-pair rows (charge_debit_id IS NULL) stay NULL: their scope
-- was roster-implied by the old per-scope crons, neither of these two sources.
--
-- APPLY PATH: apply_migration as postgres; born-owned via SET ROLE claims_admin
-- (standing posture). New column inherits table-level grants; RLS unchanged.
-- ROLLBACK: 0074_audit_row_scope_source_rollback.sql (drops the column).

set role claims_admin;

alter table claims.audit_row add column if not exists scope_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'audit_row_scope_source_check'
      and conrelid = 'claims.audit_row'::regclass
  ) then
    alter table claims.audit_row
      add constraint audit_row_scope_source_check
      check (scope_source is null or scope_source = any (array['tob'::text, 'roster_fallback'::text]));
  end if;
end
$$;

comment on column claims.audit_row.scope_source is
  'How audit_scope was derived on the consolidated feed: ''tob'' (Type of Bill prefix) or ''roster_fallback'' (TOB+rev both blank — professional claim — scoped by the customer''s roster membership; ruling 2026-07-29). NULL on legacy/OP-pair rows (roster-implied by the old per-scope crons).';

-- Backfill: pre-0074 consolidated rows were all TOB-derived (see header).
update claims.audit_row
set scope_source = 'tob'
where charge_debit_id is not null and scope_source is null;

reset role;
