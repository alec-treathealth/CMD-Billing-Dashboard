-- 0067 — carry patient_name_bidx (0066) INTO the charge rollup matview, so the Qualify client-name
-- resolve (buildResolveByNameQuery) can equality-match it at the SAME logical-charge grain every
-- other Qualify read uses. ADDITIVE: one projected column + one index; every 0059 column keeps its
-- exact position/meaning (columns 1-5 gain patient_name_bidx after group_number_bidx? NO — appended
-- LAST, after pct_paid, so all existing ordinal consumers are untouched).
--
-- The per-charge value is the LATEST snapshot's patient_name_bidx (array_agg ... desc)[1] — the
-- IDENTICAL latest-snapshot pattern group_number_bidx already uses (a charge's member, and thus
-- name, never changes across its posting snapshots; [1] is deterministic).
--
-- MATVIEW MECHANICS + APPLY GUARD: copied from 0059 verbatim — matviews cannot ADD COLUMN, so this
-- is DROP + CREATE ... WITH DATA (~60-95s on prod data). During the build the matview is ABSENT:
-- collections aggregate reads + Qualify error for ~1-2 min. APPLY OFF THE CRON TICKS
-- (:00/:15/:30/:35/:45) with the refresh + ingest crons idle. The DO wrapper serializes transport
-- retries via pg_advisory_xact_lock and no-ops if patient_name_bidx already exists on the matview.
-- Recreates all SEVEN indexes (0059's six + the new patient-name index). Grants + the SECURITY
-- DEFINER refresh function are re-asserted (DROP destroys the ACL — the 0059 lesson, run-log
-- freshness read needs cmd_rollup_writer SELECT).
--
-- SEQUENCING: apply AFTER 0066 (the base column must exist) and ideally AFTER the one-shot name
-- backfill (cmdNameBidxBackfill.ts) so the rebuilt matview carries tokens for historical rows in
-- one pass. Applying before the backfill is safe but name-search returns only post-0066-ingest
-- rows until the next REFRESH after the backfill completes.
-- DEPENDENCY: 0019, 0028/0030, 0036, 0050, 0059, 0066.
-- Rollback: 0067_cmd_charge_rollup_patient_name_bidx_rollback.sql (restores the 0059 definition).

set statement_timeout = '10min';

do $apply$
begin
  -- Serialize against a transport-level retry of this same apply (see APPLY GUARD above).
  perform pg_advisory_xact_lock(590067);
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'patient_name_bidx' and not a.attisdropped
  ) then
    raise notice '0067 already applied (patient_name_bidx present) — skipping rebuild';
    return;
  end if;

  execute 'drop materialized view if exists collections.cmd_explorer_charge_rollup';

  execute $mv$
create materialized view collections.cmd_explorer_charge_rollup as
with allowed_netted as (
  -- 0050's postings+allowed CTEs verbatim: one row per REAL payment posting (distinct
  -- (payment_received, allowed_amount) per charge; fingerprint dedup means an exact re-pull never
  -- re-inserts), summed so explicit ± reversal rows net out. This is the column BUILD X proved
  -- over-states restated charges — kept AS allowed_amount (meaning unchanged) and used as the e1 input.
  select business_entity_id, member_id_bidx, member_id_prefix_bidx,
         charge_date, cpt_code, revenue_key, facility, charge_amount,
         sum(allowed_amount) as allowed_amount
  from (
    select distinct business_entity_id, member_id_bidx, member_id_prefix_bidx,
      charge_date, cpt_code, coalesce(revenue_code, '') as revenue_key,
      facility, charge_amount, payment_received, allowed_amount
    from collections.cmd_explorer_rows
  ) p
  group by 1, 2, 3, 4, 5, 6, 7, 8
),
charge_state as (
  -- 0050's charge_state + the tier inputs, ONE grouped scan: max for the cumulative field,
  -- latest-snapshot arrays for point-in-time fields, and the tiered-allowed ingredients
  -- (distinct count / single value / latest positive / the full ordered allowed array).
  -- 0067: + patient_name_bidx via the SAME latest-snapshot pattern group_number_bidx uses.
  select
    business_entity_id, member_id_bidx, member_id_prefix_bidx,
    charge_date, cpt_code, coalesce(revenue_code, '') as revenue_key, facility, charge_amount,
    max(insurance_payments) as insurance_payments,
    (array_agg(patient_balance_due order by payment_received desc nulls last, id desc))[1] as patient_balance_due,
    (array_agg(adjustments         order by payment_received desc nulls last, id desc))[1] as adjustments,
    (array_agg(primary_payer       order by payment_received desc nulls last, id desc))[1] as primary_payer,
    (array_agg(group_number_bidx   order by payment_received desc nulls last, id desc))[1] as group_number_bidx,
    (array_agg(patient_name_bidx   order by payment_received desc nulls last, id desc))[1] as patient_name_bidx,
    (array_agg(id                  order by payment_received desc nulls last, id desc))[1] as id,
    max(payment_received) as payment_received,
    max(ingested_at)      as ingested_at,
    count(*)::int         as snapshot_rows,
    count(distinct allowed_amount) as distinct_allowed,
    min(allowed_amount) filter (where allowed_amount is not null) as single_val,
    (array_agg(allowed_amount order by payment_received desc nulls last, id desc)
       filter (where allowed_amount > 0))[1] as latest_pos,
    array_agg(allowed_amount order by payment_received desc nulls last, id desc)
       filter (where allowed_amount is not null) as allowed_ordered
  from collections.cmd_explorer_rows
  group by 1, 2, 3, 4, 5, 6, 7, 8
),
resolved as (
  -- The reconciling-snapshot pick (tiers c/d) over the ordered per-charge array: first (= latest)
  -- non-null allowed within $0.01 of target. The scalar subquery runs per charge over a ~2-element
  -- array — this is what replaces the rejected base-table re-join (see 0059 SHAPE).
  select s.*,
    an.allowed_amount as allowed_netted,
    coalesce(s.insurance_payments, 0) + coalesce(s.patient_balance_due, 0) as target,
    (select u.v from unnest(s.allowed_ordered) with ordinality as u(v, ord)
      where abs(u.v - (coalesce(s.insurance_payments, 0) + coalesce(s.patient_balance_due, 0))) <= 0.01
      order by u.ord limit 1) as recon_val
  from charge_state s
  join allowed_netted an using (business_entity_id, member_id_bidx, member_id_prefix_bidx,
                                charge_date, cpt_code, revenue_key, facility, charge_amount)
),
final as (
  select r.*,
    case
      when distinct_allowed = 0 then null
      when distinct_allowed = 1 then (case when single_val = 0 and coalesce(insurance_payments, 0) > 0 then null else single_val end)
      when recon_val is not null then recon_val
      when allowed_netted is not null and abs(allowed_netted - target) <= 0.01 then allowed_netted
      else latest_pos
    end as allowed_reliable,
    case
      when distinct_allowed = 0 then 'none'
      when distinct_allowed = 1 then (case when single_val = 0 and coalesce(insurance_payments, 0) > 0 then 'b' else 'a' end)
      when recon_val is not null then 'cd'
      when allowed_netted is not null and abs(allowed_netted - target) <= 0.01 then 'e1'
      else 'e2'
    end as allowed_tier
  from resolved r
)
select
  -- Columns 1-18: byte-identical order and meaning to the 0050 matview (no consumer breakage).
  id, business_entity_id, member_id_bidx, member_id_prefix_bidx, group_number_bidx,
  charge_date, payment_received, cpt_code, nullif(revenue_key, '') as revenue_code,
  facility, charge_amount,
  allowed_netted as allowed_amount,
  insurance_payments, adjustments, patient_balance_due, primary_payer, ingested_at, snapshot_rows,
  -- Columns 19-22: 0059's tiered-allowed columns, unchanged.
  allowed_reliable, allowed_tier,
  case when charge_amount > 0 and allowed_reliable is not null
       then round(allowed_reliable / charge_amount * 100, 2) end as pct_allowed,
  case when allowed_reliable > 0
       then round(insurance_payments / allowed_reliable * 100, 2) end as pct_paid,
  -- Column 23: NEW (0067) — the client-name blind index (latest snapshot's token).
  patient_name_bidx
from final
with data
  $mv$;

  -- All SEVEN indexes: 0059's six + the new client-name equality index.
  -- Unique id index first — REFRESH ... CONCURRENTLY requires it.
  execute 'create unique index cmd_charge_rollup_id
    on collections.cmd_explorer_charge_rollup (id)';
  execute 'create index cmd_charge_rollup_prefix
    on collections.cmd_explorer_charge_rollup (member_id_prefix_bidx)';
  execute 'create index cmd_charge_rollup_entity_payment
    on collections.cmd_explorer_charge_rollup (business_entity_id, payment_received)';
  execute 'create index cmd_charge_rollup_entity_payer_payment
    on collections.cmd_explorer_charge_rollup (business_entity_id, primary_payer, payment_received)';
  execute 'create index cmd_charge_rollup_member
    on collections.cmd_explorer_charge_rollup (member_id_bidx)';
  execute 'create index cmd_charge_rollup_group
    on collections.cmd_explorer_charge_rollup (group_number_bidx)';
  execute 'create index cmd_charge_rollup_patient_name
    on collections.cmd_explorer_charge_rollup (patient_name_bidx)';
end
$apply$;

-- Grants + refresh hook: top-level, idempotent — safe on both the first apply and a no-op'd retry.
-- ⚠ BOTH reader grants are required: DROP MATERIALIZED VIEW destroys the old matview's ACL, and the
-- cmd_rollup_writer SELECT (0054) is what the refresh run-log's freshness read runs under (the 0059
-- incident: missing it failed the very next cron refresh with "permission denied").
revoke all on collections.cmd_explorer_charge_rollup
  from public, anon, authenticated, service_role;
grant select on collections.cmd_explorer_charge_rollup to claims_reader;
grant select on collections.cmd_explorer_charge_rollup to cmd_rollup_writer;

-- Refresh hook unchanged (matview name unchanged); re-asserted so a standalone apply of this file
-- leaves the full posture in place. SECURITY DEFINER, search_path pinned; EXECUTE only to
-- cmd_rollup_writer (the :45 cron role).
create or replace function collections.refresh_cmd_explorer_charge_rollup()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently collections.cmd_explorer_charge_rollup;
end;
$$;

revoke all on function collections.refresh_cmd_explorer_charge_rollup() from public;
grant execute on function collections.refresh_cmd_explorer_charge_rollup() to cmd_rollup_writer;
