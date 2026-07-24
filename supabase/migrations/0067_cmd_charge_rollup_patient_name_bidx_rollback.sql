-- ROLLBACK for 0067 — restores collections.cmd_explorer_charge_rollup to its PRE-0067 LIVE state:
-- the 0059 definition (22 columns — allowed_reliable/allowed_tier/pct_allowed/pct_paid kept, NO
-- patient_name_bidx) plus 0059's six indexes.
--
-- ⚠ ORDERING: once the client-name resolve code has shipped (buildResolveByNameQuery reads
-- patient_name_bidx off this matview), ROLL THE APP BACK FIRST (or together), else the name-search
-- path 42703s on the restored 22-column matview (every other Qualify read is untouched).
--
-- APPLY GUARD (symmetric with 0067 forward): advisory lock + state check — no-ops if
-- patient_name_bidx is already absent. Same DROP + CREATE ... WITH DATA mechanics (~1 min build,
-- matview absent meanwhile) — apply off the cron ticks (:00/:15/:30/:35/:45), crons idle.

set statement_timeout = '10min';

do $apply$
begin
  perform pg_advisory_xact_lock(590067);
  if not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'patient_name_bidx' and not a.attisdropped
  ) then
    raise notice '0067 rollback: matview already lacks patient_name_bidx — skipping rebuild';
    return;
  end if;

  execute 'drop materialized view if exists collections.cmd_explorer_charge_rollup';

  execute $mv$
create materialized view collections.cmd_explorer_charge_rollup as
with allowed_netted as (
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
  select
    business_entity_id, member_id_bidx, member_id_prefix_bidx,
    charge_date, cpt_code, coalesce(revenue_code, '') as revenue_key, facility, charge_amount,
    max(insurance_payments) as insurance_payments,
    (array_agg(patient_balance_due order by payment_received desc nulls last, id desc))[1] as patient_balance_due,
    (array_agg(adjustments         order by payment_received desc nulls last, id desc))[1] as adjustments,
    (array_agg(primary_payer       order by payment_received desc nulls last, id desc))[1] as primary_payer,
    (array_agg(group_number_bidx   order by payment_received desc nulls last, id desc))[1] as group_number_bidx,
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
  id, business_entity_id, member_id_bidx, member_id_prefix_bidx, group_number_bidx,
  charge_date, payment_received, cpt_code, nullif(revenue_key, '') as revenue_code,
  facility, charge_amount,
  allowed_netted as allowed_amount,
  insurance_payments, adjustments, patient_balance_due, primary_payer, ingested_at, snapshot_rows,
  allowed_reliable, allowed_tier,
  case when charge_amount > 0 and allowed_reliable is not null
       then round(allowed_reliable / charge_amount * 100, 2) end as pct_allowed,
  case when allowed_reliable > 0
       then round(insurance_payments / allowed_reliable * 100, 2) end as pct_paid
from final
with data
  $mv$;

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
end
$apply$;

revoke all on collections.cmd_explorer_charge_rollup
  from public, anon, authenticated, service_role;
grant select on collections.cmd_explorer_charge_rollup to claims_reader;
grant select on collections.cmd_explorer_charge_rollup to cmd_rollup_writer;

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
