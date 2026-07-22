-- ROLLBACK for 0059 — restores collections.cmd_explorer_charge_rollup to its PRE-0059 LIVE state:
-- the 0050 definition (18 columns; allowed_amount = the netted-posting sum; NO allowed_reliable /
-- allowed_tier / pct_allowed / pct_paid) PLUS all six live indexes — including
-- cmd_charge_rollup_entity_payer_payment, which pre-dates 0059 as uncommitted drift (0059's header),
-- so rolling back must NOT lose it.
--
-- ⚠ ORDERING: 0059 itself changes no behavior (no consumer reads the new columns at its landing).
-- But once any repoint diff has shipped (buildFacilityRankingQuery, buildFacilityCasesQuery, the
-- grid's rollup-direct read, the cohort/PCT readers), those readers reference the new columns —
-- ROLL THE APP BACK FIRST (or together), else they 42703 on the restored 18-column matview.
--
-- APPLY GUARD (symmetric with 0059 forward): same advisory lock + state check, so a transport-level
-- retry of this rollback blocks instead of colliding, and no-ops if the matview is already back on
-- the 18-column 0050 shape. Leading SET clears the MCP session's 2-minute statement_timeout.
--
-- Same mechanics as forward: DROP + CREATE ... WITH DATA (matviews can't be altered in place),
-- ~1 min synchronous build, matview absent meanwhile — apply off the cron ticks
-- (:00/:15/:30/:35/:45) with the refresh + ingest crons idle.

set statement_timeout = '10min';

do $apply$
begin
  perform pg_advisory_xact_lock(590059);
  if not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'allowed_reliable' and not a.attisdropped
  ) then
    raise notice '0059 rollback: allowed_reliable not present — matview already on the 0050 shape, skipping';
    return;
  end if;

  execute 'drop materialized view if exists collections.cmd_explorer_charge_rollup';

  -- ── 0050 definition, verbatim ──────────────────────────────────────────────────────────────────
  execute $mv$
create materialized view collections.cmd_explorer_charge_rollup as
with postings as (
  -- One row per REAL payment posting: collapses re-pull snapshots that restate a posting
  -- (same payment_received + allowed_amount, other fields evolved), keeps ± reversal rows.
  select distinct
    business_entity_id, member_id_bidx, member_id_prefix_bidx,
    charge_date, cpt_code, coalesce(revenue_code, '') as revenue_key,
    facility, charge_amount, payment_received, allowed_amount
  from collections.cmd_explorer_rows
),
allowed as (
  select
    business_entity_id, member_id_bidx, member_id_prefix_bidx,
    charge_date, cpt_code, revenue_key, facility, charge_amount,
    sum(allowed_amount) as allowed_amount
  from postings
  group by 1, 2, 3, 4, 5, 6, 7, 8
),
charge_state as (
  select
    business_entity_id, member_id_bidx, member_id_prefix_bidx,
    charge_date, cpt_code, coalesce(revenue_code, '') as revenue_key,
    facility, charge_amount,
    -- Charge-cumulative running total: max, never sum (see 0050 header).
    max(insurance_payments) as insurance_payments,
    -- Latest-snapshot state for the point-in-time fields.
    (array_agg(patient_balance_due order by payment_received desc nulls last, id desc))[1] as patient_balance_due,
    (array_agg(adjustments         order by payment_received desc nulls last, id desc))[1] as adjustments,
    (array_agg(primary_payer       order by payment_received desc nulls last, id desc))[1] as primary_payer,
    (array_agg(group_number_bidx   order by payment_received desc nulls last, id desc))[1] as group_number_bidx,
    (array_agg(id                  order by payment_received desc nulls last, id desc))[1] as id,
    max(payment_received) as payment_received,
    max(ingested_at)      as ingested_at,
    count(*)::int         as snapshot_rows
  from collections.cmd_explorer_rows
  group by 1, 2, 3, 4, 5, 6, 7, 8
)
select
  s.id,
  s.business_entity_id,
  s.member_id_bidx,
  s.member_id_prefix_bidx,
  s.group_number_bidx,
  s.charge_date,
  s.payment_received,
  s.cpt_code,
  nullif(s.revenue_key, '') as revenue_code,
  s.facility,
  s.charge_amount,
  a.allowed_amount,
  s.insurance_payments,
  s.adjustments,
  s.patient_balance_due,
  s.primary_payer,
  s.ingested_at,
  s.snapshot_rows
from charge_state s
join allowed a using (business_entity_id, member_id_bidx, member_id_prefix_bidx,
                      charge_date, cpt_code, revenue_key, facility, charge_amount)
with data
  $mv$;
  -- ── end 0050 definition ────────────────────────────────────────────────────────────────────────

  -- All six pre-0059 live indexes (unique id first — REFRESH ... CONCURRENTLY requires it).
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

-- BOTH reader grants (claims_reader per 0050, cmd_rollup_writer per 0054 — the refresh run-log's
-- freshness read runs as the writer; a DROP destroys the ACL, so the rollback must restore both).
revoke all on collections.cmd_explorer_charge_rollup
  from public, anon, authenticated, service_role;
grant select on collections.cmd_explorer_charge_rollup to claims_reader;
grant select on collections.cmd_explorer_charge_rollup to cmd_rollup_writer;

-- Refresh hook re-asserted (identical body in 0050 and 0059 — the matview name never changed).
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
