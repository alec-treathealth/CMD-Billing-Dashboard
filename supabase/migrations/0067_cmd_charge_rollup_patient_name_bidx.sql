-- 0067 — carry patient_name_bidx (0066) INTO the charge rollup matview via BUILD-ALONGSIDE-AND-SWAP,
-- so the Qualify client-name resolve can equality-match it at the same logical-charge grain every other
-- Qualify read uses. ADDITIVE: one projected column (appended LAST, after pct_paid — every existing
-- ordinal consumer untouched) + one index.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS A SWAP, NOT AN IN-PLACE DROP+CREATE (the history that forced the rewrite)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Matviews cannot ADD COLUMN, so the column must come from a full rebuild. The ORIGINAL 0067 did an
-- in-place `drop materialized view … + create … with data`, which had two fatal problems:
--   1. ~90–150s of ACCESS EXCLUSIVE on a matview BOTH Qualify and Collections read live — a ~1.5–2.5 min
--      production stall (reads queue the instant the lock is REQUESTED), plus a collision risk with the
--      hourly :45 REFRESH … CONCURRENTLY.
--   2. It was authored BEFORE 0068 (the KPI covering index) and 0069 (the cmd_rollup_writer MAINTAIN
--      grant), and its hand-written "recreate 0059's six indexes + re-grant SELECT" SILENTLY DROPPED
--      both — regressing the book-KPI index-only scan AND breaking the post-refresh VACUUM permission.
--      (See docs/veris-data-notes.md "0067 ops analysis".)
--
-- THIS VERSION fixes both:
--   • Build `…_next` WITH DATA (no lock on the live object; the :45 cron keeps refreshing live during the
--     ~60–95s build), then swap by two RENAMEs in one transaction → sub-second ACCESS EXCLUSIVE, no
--     maintenance window, and a `lock_timeout` so a cron collision fails fast instead of stalling readers.
--   • Rebuild EVERY index by ENUMERATING pg_indexes on the LIVE object (not a hand-written list), so
--     0068's covering index — as amended by 0070 to `cmd_charge_rollup_entity_payment_cov_m` — and any
--     future index are carried forward automatically. Then add the ONE new index this migration owns
--     (patient_name_bidx).
--   • Re-assert grants INCLUDING 0069's `MAINTAIN` to cmd_rollup_writer + owner = postgres.
--   • A PRE-SWAP GATE that RAISES (fails the whole transaction, leaving live untouched) on ANY index,
--     grant, or column loss between `…_next` and live. This is the check that would have caught all three
--     prior regressions; it is the most important thing in this file.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ORDERING & SEQUENCING (READ BEFORE APPLYING)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--   • APPLY 0070 FIRST. 0070 renames the covering index to `…_cov_m` (adds member_id_bidx). This file
--     enumerates live indexes at apply time, so it carries whatever covering index is live — which MUST
--     be `…_cov_m`. If 0070 has not been applied, the gate still passes (it carries live's `…_cov`), but
--     you would ship the pre-0070 covering index; apply 0070 first so the post-0067 matview is optimal.
--   • APPLY AFTER 0066 (base column must exist) and ideally AFTER the one-shot name backfill
--     (cmdNameBidxBackfill.ts) so the rebuilt matview carries tokens for historical rows in one pass.
--   • The swapped-in data is a build-time snapshot (~2 min stale) until the next :45 REFRESH; nothing
--     requires a manual refresh, but you may run one immediately after the swap if desired.
--   • DEPENDENCY: 0019, 0028/0030, 0036, 0050, 0059, 0066, 0068, 0069, 0070.
--   • This is authored + presented for review; Alec applies. Full apply procedure + checks:
--     docs/veris-data-notes.md → "0067 swap apply procedure".
--   • Rollback: 0067_cmd_charge_rollup_patient_name_bidx_rollback.sql (same swap form + gate).
--
-- Whole migration is ONE transaction (apply_migration wraps it): a failure at any point — including the
-- gate — rolls everything back, so `…_next` never persists (no orphan) and live is never touched. The
-- advisory lock serializes a transport-level retry; the state check no-ops a re-run after success.

set statement_timeout = '15min';

do $apply$
declare
  r record;
  lost text;
begin
  -- Serialize any transport-level retry of this same apply against itself.
  perform pg_advisory_xact_lock(590067);

  -- Idempotent: no-op if the canonical matview already carries patient_name_bidx (already applied).
  if exists (
    select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'patient_name_bidx' and not a.attisdropped
  ) then
    raise notice '0067 already applied (patient_name_bidx present on canonical matview) — skipping';
    return;
  end if;

  -- Defensive: clear any orphaned _next from a MANUALLY-interrupted prior attempt. (A rolled-back txn
  -- leaves none; this only matters if a previous run was killed outside transaction control.) The DROP
  -- cascades its _nxt-suffixed indexes.
  execute 'drop materialized view if exists collections.cmd_explorer_charge_rollup_next';

  -- 1) Build the new matview alongside the live one (no lock on live; the :45 cron keeps refreshing live).
  execute $mv$
create materialized view collections.cmd_explorer_charge_rollup_next as
with allowed_netted as (
  -- 0050's postings+allowed CTEs verbatim: one row per REAL payment posting (distinct
  -- (payment_received, allowed_amount) per charge; fingerprint dedup means an exact re-pull never
  -- re-inserts), summed so explicit ± reversal rows net out. Kept AS allowed_amount (meaning unchanged).
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
  -- 0050's charge_state + the tier inputs, ONE grouped scan. 0067: + patient_name_bidx via the SAME
  -- latest-snapshot pattern group_number_bidx uses (a charge's member, and thus name, never changes
  -- across its posting snapshots; [1] is deterministic).
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
  -- Columns 1-18: byte-identical order and meaning to the 0059 matview (no consumer breakage).
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

  -- 2) Ownership = live (postgres). apply_migration runs as postgres, so _next is already postgres-owned;
  --    asserted defensively so the swap can never change ownership.
  execute 'alter materialized view collections.cmd_explorer_charge_rollup_next owner to postgres';

  -- 3) Rebuild EVERY live index on _next, ENUMERATED from pg_indexes (not hand-written), each with a
  --    `_nxt` suffix (index names are unique per schema, and the canonical names are still held by live).
  --    This carries 0070's `…_cov_m` covering index + 0059's six forward automatically.
  for r in
    select indexname, indexdef from pg_indexes
    where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup'
  loop
    execute regexp_replace(
      r.indexdef,
      '^CREATE( UNIQUE)? INDEX ' || r.indexname || ' ON collections\.cmd_explorer_charge_rollup ',
      'CREATE\1 INDEX ' || r.indexname || '_nxt ON collections.cmd_explorer_charge_rollup_next '
    );
  end loop;
  -- The ONE index 0067 introduces (absent from live until now): the client-name equality index.
  execute 'create index cmd_charge_rollup_patient_name_nxt
    on collections.cmd_explorer_charge_rollup_next (patient_name_bidx)';

  -- 4) Grants + posture on _next — mirror live AND re-assert 0069's MAINTAIN (the post-refresh VACUUM
  --    role) and the cmd_rollup_writer SELECT the run-log freshness read needs. Broad roles revoked.
  execute 'revoke all on collections.cmd_explorer_charge_rollup_next from public, anon, authenticated, service_role';
  execute 'grant select on collections.cmd_explorer_charge_rollup_next to claims_reader';
  execute 'grant select, maintain on collections.cmd_explorer_charge_rollup_next to cmd_rollup_writer';

  -- 5) ══ PRE-SWAP GATE — RAISE on ANY column/index/grant loss vs live. Fails the whole transaction
  --    (live untouched) rather than shipping a matview that lost an index, grant, or column. This is the
  --    check that would have caught 0067's original _cov (0068) and MAINTAIN (0069) drops. ══
  --    (a) columns: every live column present on _next.
  select string_agg(attname, ', ') into lost from (
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass and attnum > 0 and not attisdropped
    except
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup_next'::regclass and attnum > 0 and not attisdropped
  ) q;
  if lost is not null then
    raise exception '0067 pre-swap gate FAILED — _next is missing live column(s): %', lost;
  end if;
  --    (a') the ONLY new column on _next may be patient_name_bidx.
  select string_agg(attname, ', ') into lost from (
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup_next'::regclass and attnum > 0 and not attisdropped
    except
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass and attnum > 0 and not attisdropped
  ) q where attname <> 'patient_name_bidx';
  if lost is not null then
    raise exception '0067 pre-swap gate FAILED — _next has unexpected extra column(s): %', lost;
  end if;
  --    (b) indexes: every live index STRUCTURE (name-independent signature) present on _next.
  select string_agg(sig, '  |  ') into lost from (
    select regexp_replace(indexdef, ' \S+ ON collections\.\S+ USING', ' USING') as sig
      from pg_indexes where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup'
    except
    select regexp_replace(indexdef, ' \S+ ON collections\.\S+ USING', ' USING') as sig
      from pg_indexes where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup_next'
  ) q;
  if lost is not null then
    raise exception '0067 pre-swap gate FAILED — _next is missing live index(es): %', lost;
  end if;
  --    (c) grants: every (grantee, privilege) on live present on _next (catches a dropped MAINTAIN/SELECT).
  select string_agg(grantee || ':' || priv, ', ') into lost from (
    select g.grantee::regrole::text as grantee, g.privilege_type as priv
      from pg_class c, aclexplode(c.relacl) g where c.oid = 'collections.cmd_explorer_charge_rollup'::regclass
    except
    select g.grantee::regrole::text, g.privilege_type
      from pg_class c, aclexplode(c.relacl) g where c.oid = 'collections.cmd_explorer_charge_rollup_next'::regclass
  ) q;
  if lost is not null then
    raise exception '0067 pre-swap gate FAILED — _next is missing live grant(s): %', lost;
  end if;

  -- 6) ══ SWAP — sub-second ACCESS EXCLUSIVE; fail fast (5s) on a :45 REFRESH collision. ══
  perform set_config('lock_timeout', '5s', true);
  execute 'alter materialized view collections.cmd_explorer_charge_rollup      rename to cmd_explorer_charge_rollup_old';
  execute 'alter materialized view collections.cmd_explorer_charge_rollup_next rename to cmd_explorer_charge_rollup';
  execute 'drop materialized view collections.cmd_explorer_charge_rollup_old';

  -- 7) Rename the _nxt indexes back to canonical (the _old drop freed the names). After this NOTHING is
  --    named `…_nxt` or `…_next`.
  for r in
    select indexname from pg_indexes
    where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup' and indexname like '%\_nxt'
  loop
    execute 'alter index collections.' || quote_ident(r.indexname)
         || ' rename to ' || quote_ident(left(r.indexname, length(r.indexname) - 4));
  end loop;

  raise notice '0067 applied via swap: patient_name_bidx added; all live indexes + grants carried forward (gate passed)';
end
$apply$;

-- Refresh hook re-assert (top-level, idempotent). The matview name is unchanged, so the function's
-- by-name reference re-resolves post-swap; re-asserting keeps a standalone apply self-contained.
-- SECURITY DEFINER, search_path pinned; EXECUTE only to cmd_rollup_writer (the :45 cron role).
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
