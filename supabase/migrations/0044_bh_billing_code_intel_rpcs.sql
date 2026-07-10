-- 0044: Behavioral-health billing-code intelligence — dashboard read RPCs + views.
--
-- WHY: the app reads code intelligence over the least-privilege claims_reader
-- node-postgres path (src/queries/executor.ts). This migration defines the two
-- read surfaces the dashboard needs — "active billing codes for a facility ×
-- payer × setting" and "pending code-change flags" — as a STABLE, SECURITY
-- INVOKER function + a view, both with an explicit non-mutable search_path.
--
-- SECURITY: functions are SECURITY INVOKER (the default) — they read only tables
-- claims_reader already has SELECT on (granted in 0043), so no privilege
-- escalation is created. `search_path` is pinned to `code_intel, pg_temp` to
-- close the mutable-search-path advisory (a SECURITY DEFINER-style footgun even
-- for invoker functions when unqualified names are used).
--
-- PHI DISCIPLINE: outputs are non-PHI reference data only (codes, payer/facility
-- names, policy attributes, CMS change signals). No patient-level data exists in
-- this schema.
--
-- Idempotency: CREATE OR REPLACE for functions/views; DROP … IF EXISTS is implied
-- by REPLACE. GRANTs reapplied unconditionally. Safe to re-run.
--
-- ⚠️ NOT APPLIED YET — review-only until AUDIT.md sign-off. Rollback: 0044_*.
--
-- DEPENDENCY: assumes 0043 (code_intel schema, tables, claims_reader SELECT grants).

-- ------------------------------------------------------------
-- get_active_billing_codes(facility_code, payer_name, setting, as_of)
-- "What codes do we bill today for this facility × carrier × setting?"
-- ------------------------------------------------------------
create or replace function code_intel.get_active_billing_codes(
  p_facility_code text,
  p_payer_name    text,
  p_setting       text,
  p_as_of_date    date default current_date
)
returns table (
  facility          text,
  payer             text,
  plan_name         text,
  state             char(2),
  setting           text,
  hcpcs_code        text,
  hcpcs_desc        text,
  rev_code          text,
  rev_desc          text,
  billing_role      text,
  rule_type         text,
  dos_batch_rule    text,
  tob               text,
  drg_code          text,
  modifier          text,
  admit_type        text,
  condition_code    text,
  observed_per_diem numeric,
  test_status       text,
  decision_date     date,
  notes             text
)
language sql
stable
security invoker
set search_path = code_intel, pg_temp
as $$
  select
    f.short_code                          as facility,
    p.name                                as payer,
    pp.plan_name,
    pp.state,
    bp.setting,
    h.code                                as hcpcs_code,
    h.short_desc                          as hcpcs_desc,
    r.code                                as rev_code,
    r.short_desc                          as rev_desc,
    cr.billing_role::text,
    cr.rule_type::text,
    cr.dos_batch_rule,
    cr.tob,
    cr.drg_code,
    cr.modifier,
    cr.admit_type,
    cr.condition_code,
    cr.observed_per_diem,
    cr.test_status::text,
    cr.decision_date,
    cr.notes
  from code_intel.billing_policy_code_rule cr
  join code_intel.billing_policy bp on cr.billing_policy_id = bp.id
  join code_intel.facility f        on bp.facility_id = f.id
  join code_intel.payer_plan pp     on bp.payer_plan_id = pp.id
  join code_intel.payer p           on pp.payer_id = p.id
  left join code_intel.ref_code h   on cr.code_id = h.id and h.code_type in ('hcpcs','cpt')
  left join code_intel.ref_code r   on cr.required_with_code_id = r.id and r.code_type = 'revenue'
  where f.short_code ilike p_facility_code
    and p.name ilike '%' || p_payer_name || '%'
    and bp.setting = p_setting
    and bp.status = 'confirmed'
    and bp.effective_from <= p_as_of_date
    and (bp.effective_to is null or bp.effective_to >= p_as_of_date)
    and cr.test_status = 'confirmed'
  order by pp.plan_name, cr.billing_role;
$$;

-- ------------------------------------------------------------
-- v_pending_code_change_flags — powers the "⚠️ Pending Review" panel.
-- Deletions surface first (highest urgency), then billing-rule / revised, newest first.
-- ------------------------------------------------------------
create or replace view code_intel.v_pending_code_change_flags as
  select
    pce.id,
    pce.source,
    pce.source_ref,
    pce.change_type::text as change_type,
    pce.change_summary,
    pce.effective_date,
    pce.detected_at,
    rc.code       as affected_code,
    rc.code_type::text as code_type,
    rc.short_desc as code_description,
    p.name        as payer,
    pp.plan_name,
    pp.state,
    f.short_code  as facility,
    pce.previous_value,
    pce.new_value,
    pce.notes
  from code_intel.policy_change_event pce
  left join code_intel.ref_code   rc on pce.code_id = rc.id
  left join code_intel.payer      p  on pce.payer_id = p.id
  left join code_intel.payer_plan pp on pce.payer_plan_id = pp.id
  left join code_intel.facility   f  on pce.facility_id = f.id
  where pce.review_status = 'pending'
  order by
    case pce.change_type
      when 'code_deleted'       then 0
      when 'billing_rule_change' then 1
      when 'auth_rule_change'   then 1
      when 'code_revised'       then 2
      else 3
    end,
    pce.detected_at desc;

-- Views run with the querying role's privileges; claims_reader already has SELECT
-- on the underlying tables (0043), so a plain SELECT grant on the view is enough.
grant select on code_intel.v_pending_code_change_flags to claims_reader;
grant execute on function
  code_intel.get_active_billing_codes(text, text, text, date) to claims_reader;
