-- Rollback for 0102 — rebuild the rollup WITHOUT employer_name (the pre-0102 22-column shape) via
-- the SAME BUILD-ALONGSIDE-AND-SWAP mechanics. A pre-swap gate RAISES on ANY loss OTHER than the
-- intended removals (the employer_name column + its trigram GIN), leaving live untouched on failure.
--
-- ⚠ ORDERING: once search code that SELECTs employer_name off this matview has deployed, rolling
--   this back 42703s the Collections grid — roll the CODE back first (or with it).
-- ⚠ Does NOT touch collections.cmd_explorer_rows.employer_name (0101's rollback owns that) and
--   deliberately leaves the 0080 two-matview refresh function in place.

set statement_timeout = '15min';

do $apply$
declare
  r record;
  lost text;
begin
  perform pg_advisory_xact_lock(590102);

  -- Idempotent: no-op if the canonical matview already lacks employer_name (already rolled back).
  if not exists (
    select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'employer_name' and not a.attisdropped
  ) then
    raise notice '0102 rollback: canonical matview already lacks employer_name — skipping';
    return;
  end if;

  execute 'drop materialized view if exists collections.cmd_explorer_charge_rollup_next';

  -- 1) Build the pre-0102 (0059-shape, 22-column) matview alongside live.
  execute $mv$
create materialized view collections.cmd_explorer_charge_rollup_next as
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

  execute 'alter materialized view collections.cmd_explorer_charge_rollup_next owner to postgres';

  -- 2) Carry forward EVERY live index EXCEPT the employer ones (their column no longer exists).
  for r in
    select indexname, indexdef from pg_indexes
    where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup'
      and indexdef !~ 'employer_name'
  loop
    execute regexp_replace(
      r.indexdef,
      '^CREATE( UNIQUE)? INDEX ' || r.indexname || ' ON collections\.cmd_explorer_charge_rollup ',
      'CREATE\1 INDEX ' || r.indexname || '_nxt ON collections.cmd_explorer_charge_rollup_next '
    );
  end loop;

  -- 3) Grants + posture on _next.
  execute 'revoke all on collections.cmd_explorer_charge_rollup_next from public, anon, authenticated, service_role';
  execute 'grant select on collections.cmd_explorer_charge_rollup_next to claims_reader';
  execute 'grant select, maintain on collections.cmd_explorer_charge_rollup_next to cmd_rollup_writer';

  -- 4) ══ GATE — allow ONLY the intended removals (employer_name + its index). ══
  select string_agg(attname, ', ') into lost from (
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass and attnum > 0 and not attisdropped
    except
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup_next'::regclass and attnum > 0 and not attisdropped
  ) q where attname <> 'employer_name';
  if lost is not null then
    raise exception '0102 rollback gate FAILED — _next drops unexpected column(s): %', lost;
  end if;
  select string_agg(attname, ', ') into lost from (
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup_next'::regclass and attnum > 0 and not attisdropped
    except
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass and attnum > 0 and not attisdropped
  ) q;
  if lost is not null then
    raise exception '0102 rollback gate FAILED — _next has unexpected extra column(s): %', lost;
  end if;
  select string_agg(sig, '  |  ') into lost from (
    select regexp_replace(indexdef, ' \S+ ON collections\.\S+ USING', ' USING') as sig
      from pg_indexes where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup'
      and indexdef !~ 'employer_name'
    except
    select regexp_replace(indexdef, ' \S+ ON collections\.\S+ USING', ' USING') as sig
      from pg_indexes where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup_next'
  ) q;
  if lost is not null then
    raise exception '0102 rollback gate FAILED — _next is missing live index(es): %', lost;
  end if;
  select string_agg(grantee || ':' || priv, ', ') into lost from (
    select g.grantee::regrole::text as grantee, g.privilege_type as priv
      from pg_class c, aclexplode(c.relacl) g where c.oid = 'collections.cmd_explorer_charge_rollup'::regclass
    except
    select g.grantee::regrole::text, g.privilege_type
      from pg_class c, aclexplode(c.relacl) g where c.oid = 'collections.cmd_explorer_charge_rollup_next'::regclass
  ) q;
  if lost is not null then
    raise exception '0102 rollback gate FAILED — _next is missing live grant(s): %', lost;
  end if;

  -- 5) ══ SWAP ══
  perform set_config('lock_timeout', '5s', true);
  execute 'alter materialized view collections.cmd_explorer_charge_rollup      rename to cmd_explorer_charge_rollup_old';
  execute 'alter materialized view collections.cmd_explorer_charge_rollup_next rename to cmd_explorer_charge_rollup';
  execute 'drop materialized view collections.cmd_explorer_charge_rollup_old';

  for r in
    select indexname from pg_indexes
    where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup' and indexname like '%\_nxt'
  loop
    execute 'alter index collections.' || quote_ident(r.indexname)
         || ' rename to ' || quote_ident(left(r.indexname, length(r.indexname) - 4));
  end loop;

  raise notice '0102 rolled back via swap: employer_name + its trigram GIN removed; everything else carried (gate passed)';
end
$apply$;
