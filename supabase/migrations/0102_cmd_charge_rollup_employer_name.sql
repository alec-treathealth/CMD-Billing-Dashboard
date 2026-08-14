-- 0102 — carry employer_name (0101) INTO the charge rollup matview via BUILD-ALONGSIDE-AND-SWAP,
-- index it for the guided employer filter, and add the employer arm to the filter-options matview.
-- ADDITIVE: one projected rollup column (appended LAST, after column 22 — every existing ordinal
-- consumer untouched) + ONE btree index + one extra UNION arm on cmd_explorer_filter_options.
--
-- ⚠ NUMBER IS PROVISIONAL: re-derive from supabase_migrations.schema_migrations + every worktree's
--   untracked .sql IMMEDIATELY before apply (the 0096 collision rule).
--
-- WHY: the grid page + every summary aggregate FROM collections.cmd_explorer_charge_rollup, so a
--   filterable employer must be a rollup column — the base table serves no post-repoint search
--   (0081's header, verified 2026-08-03).
--
-- INDEX CHOICE — BTREE, NOT a trigram GIN, and that is deliberate. The explorer's employer search is
--   the GUIDED PICKER: the client sends a SET of exact values and the predicate is
--   `employer_name = any($n::text[])` (the free-text bar, and with it the column-scoped ILIKE, was
--   replaced by pickers). Equality/ANY is a btree access path; a trigram GIN cannot serve it and
--   would be ~100MB+ of never-read index on a 164MB heap (the 0092 lesson: price an index by what
--   actually queries it). The per-keystroke TYPE-AHEAD runs against cmd_explorer_filter_options
--   instead — <1MB, so its ILIKE needs no index at all.
--
-- MECHANICS: byte-for-byte the 0067 swap pattern (build `_next` WITH DATA — no lock on live, the
--   :45 cron keeps refreshing — then a sub-second two-RENAME swap with a 5s lock_timeout), with the
--   pre-swap gate that RAISES on ANY column/index/grant loss. TWO deliberate differences from the
--   0067 file:
--     1. The new column is employer_name, taken as the latest NON-NULL snapshot value
--        (`filter (where employer_name is not null)`), NOT the bare latest snapshot: most history
--        gets employer from the one-shot backfill while the newest snapshot may predate it, and an
--        older snapshot that KNOWS the employer beats a newer one that doesn't. (group_number_bidx
--        keeps the bare-latest pattern — a member's group genuinely never changes across snapshots;
--        employer coverage does.)
--     2. The trailing refresh-function re-assert is the 0080 TWO-MATVIEW version (rollup THEN
--        cmd_explorer_filter_options). 0067's tail re-asserts the pre-0080 single-matview body —
--        copying it would silently stop the filter-options refresh. Do not "fix" this back.
--
-- ═══ ORDERING & SEQUENCING (READ BEFORE APPLYING) ═══
--   • APPLY 0101 FIRST (the base column must exist — charge_state selects it).
--   • APPLY BEFORE the ingest-code deploy (the cron INSERT names employer_name → 42703 pre-0101),
--     and BEFORE the search-code deploy (grid SELECT names the rollup column → 42703 pre-0102).
--     Order: apply 0101 → apply 0102 → merge/deploy → run the one-shot employer backfill →
--     next :45 refresh propagates backfilled values into this matview.
--   • INTERPLAY WITH UNAPPLIED 0067: both are fixed-SELECT swap rebuilds, so whichever applies
--     SECOND must include the other's column or its own pre-swap gate ABORTS (loudly, live
--     untouched). 0067 is stale-as-authored anyway (CLAUDE.md landmine); if it is ever revived,
--     regenerate it FROM the then-live definition (which will include employer_name).
--   • DEPENDENCY: 0019, 0028/0030, 0036, 0050, 0059, 0068/0069/0070, 0080 (refresh function body),
--     0081 (the four existing search GINs, carried via enumeration), 0101.
--   • This is authored + presented for review; Alec applies. Plain transactional DDL —
--     apply_migration wraps it; a failure anywhere (including the gate) rolls everything back.
--
-- PHI DISCIPLINE: employer_name is a plaintext plan-level dimension (0101's header records the
--   posture + the open phi.ts tension). Everything else in this file is the existing rollup.
-- OWNERSHIP: postgres (collections plane — no SET ROLE).
-- IDEMPOTENT: no-ops when the canonical matview already carries employer_name.
-- Rollback: 0102_cmd_charge_rollup_employer_name_rollback.sql (same swap form + gate).

set statement_timeout = '15min';

do $apply$
declare
  r record;
  lost text;
begin
  -- Serialize any transport-level retry of this same apply against itself.
  perform pg_advisory_xact_lock(590102);

  -- Idempotent: no-op if the canonical matview already carries employer_name (already applied).
  if exists (
    select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'employer_name' and not a.attisdropped
  ) then
    raise notice '0102 already applied (employer_name present on canonical matview) — skipping';
    return;
  end if;

  -- Defensive: clear any orphaned _next from a MANUALLY-interrupted prior attempt.
  execute 'drop materialized view if exists collections.cmd_explorer_charge_rollup_next';

  -- 1) Build the new matview alongside the live one (no lock on live).
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
  -- 0050's charge_state + the tier inputs, ONE grouped scan. 0102: + employer_name as the latest
  -- NON-NULL snapshot value (see the header's difference #1 for why not bare-latest).
  select
    business_entity_id, member_id_bidx, member_id_prefix_bidx,
    charge_date, cpt_code, coalesce(revenue_code, '') as revenue_key, facility, charge_amount,
    max(insurance_payments) as insurance_payments,
    (array_agg(patient_balance_due order by payment_received desc nulls last, id desc))[1] as patient_balance_due,
    (array_agg(adjustments         order by payment_received desc nulls last, id desc))[1] as adjustments,
    (array_agg(primary_payer       order by payment_received desc nulls last, id desc))[1] as primary_payer,
    (array_agg(group_number_bidx   order by payment_received desc nulls last, id desc))[1] as group_number_bidx,
    (array_agg(employer_name       order by payment_received desc nulls last, id desc)
       filter (where employer_name is not null))[1] as employer_name,
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
  -- Column 23: NEW (0102) — primary-insurance employer (latest non-null snapshot value).
  employer_name
from final
with data
  $mv$;

  -- 2) Ownership = live (postgres); asserted defensively so the swap can never change ownership.
  execute 'alter materialized view collections.cmd_explorer_charge_rollup_next owner to postgres';

  -- 3) Rebuild EVERY live index on _next, ENUMERATED from pg_indexes (not hand-written), each with a
  --    `_nxt` suffix. This carries 0059's six, 0070's `…_cov_m`, 0081's four search GINs, and any
  --    future index forward automatically.
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
  -- The ONE index 0102 introduces: btree on employer_name, serving the picker's
  -- `employer_name = any(...)` predicate (see the header's INDEX CHOICE note for why not a GIN).
  execute 'create index cmd_charge_rollup_employer_nxt
    on collections.cmd_explorer_charge_rollup_next (employer_name)';

  -- 4) Grants + posture on _next — mirror live AND re-assert 0069's MAINTAIN + the writer SELECT.
  execute 'revoke all on collections.cmd_explorer_charge_rollup_next from public, anon, authenticated, service_role';
  execute 'grant select on collections.cmd_explorer_charge_rollup_next to claims_reader';
  execute 'grant select, maintain on collections.cmd_explorer_charge_rollup_next to cmd_rollup_writer';

  -- 5) ══ PRE-SWAP GATE — RAISE on ANY column/index/grant loss vs live. ══
  --    (a) columns: every live column present on _next.
  select string_agg(attname, ', ') into lost from (
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass and attnum > 0 and not attisdropped
    except
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup_next'::regclass and attnum > 0 and not attisdropped
  ) q;
  if lost is not null then
    raise exception '0102 pre-swap gate FAILED — _next is missing live column(s): %', lost;
  end if;
  --    (a') the ONLY new column on _next may be employer_name.
  select string_agg(attname, ', ') into lost from (
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup_next'::regclass and attnum > 0 and not attisdropped
    except
    select attname from pg_attribute
      where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass and attnum > 0 and not attisdropped
  ) q where attname <> 'employer_name';
  if lost is not null then
    raise exception '0102 pre-swap gate FAILED — _next has unexpected extra column(s): %', lost;
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
    raise exception '0102 pre-swap gate FAILED — _next is missing live index(es): %', lost;
  end if;
  --    (c) grants: every (grantee, privilege) on live present on _next.
  select string_agg(grantee || ':' || priv, ', ') into lost from (
    select g.grantee::regrole::text as grantee, g.privilege_type as priv
      from pg_class c, aclexplode(c.relacl) g where c.oid = 'collections.cmd_explorer_charge_rollup'::regclass
    except
    select g.grantee::regrole::text, g.privilege_type
      from pg_class c, aclexplode(c.relacl) g where c.oid = 'collections.cmd_explorer_charge_rollup_next'::regclass
  ) q;
  if lost is not null then
    raise exception '0102 pre-swap gate FAILED — _next is missing live grant(s): %', lost;
  end if;

  -- 6) ══ SWAP — sub-second ACCESS EXCLUSIVE; fail fast (5s) on a :45 REFRESH collision. ══
  perform set_config('lock_timeout', '5s', true);
  execute 'alter materialized view collections.cmd_explorer_charge_rollup      rename to cmd_explorer_charge_rollup_old';
  execute 'alter materialized view collections.cmd_explorer_charge_rollup_next rename to cmd_explorer_charge_rollup';
  execute 'drop materialized view collections.cmd_explorer_charge_rollup_old';

  -- 7) Rename the _nxt indexes back to canonical. After this NOTHING is named `…_nxt` or `…_next`.
  for r in
    select indexname from pg_indexes
    where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup' and indexname like '%\_nxt'
  loop
    execute 'alter index collections.' || quote_ident(r.indexname)
         || ' rename to ' || quote_ident(left(r.indexname, length(r.indexname) - 4));
  end loop;

  raise notice '0102 applied via swap: employer_name added + employer btree; all live indexes + grants carried forward (gate passed)';
end
$apply$;

-- ---------------------------------------------------------------------------
-- Filter-options matview — ADD THE EMPLOYER ARM (0080's shape + one UNION branch).
-- Drop-and-recreate is 0080's own idempotency idiom for this object; it is tiny (<1MB) and its
-- readers are the picker vocabularies only, so the brief lock is immaterial. Facility and payer
-- arms are byte-identical to 0080 — only the third arm is new.
-- ---------------------------------------------------------------------------
drop materialized view if exists collections.cmd_explorer_filter_options;

create materialized view collections.cmd_explorer_filter_options as
  select business_entity_id, 'facility'::text as kind, facility as value
    from collections.cmd_explorer_charge_rollup
   where facility is not null and btrim(facility) <> ''
   group by business_entity_id, facility
  union all
  select business_entity_id, 'payer'::text as kind, primary_payer as value
    from collections.cmd_explorer_charge_rollup
   where primary_payer is not null and btrim(primary_payer) <> ''
   group by business_entity_id, primary_payer
  union all
  select business_entity_id, 'employer'::text as kind, employer_name as value
    from collections.cmd_explorer_charge_rollup
   where employer_name is not null and btrim(employer_name) <> ''
   group by business_entity_id, employer_name
  with data;

create unique index if not exists cmd_explorer_filter_options_key
  on collections.cmd_explorer_filter_options (business_entity_id, kind, value);

revoke all on collections.cmd_explorer_filter_options from public;
grant select on collections.cmd_explorer_filter_options to claims_reader;
grant select, maintain on collections.cmd_explorer_filter_options to cmd_rollup_writer;

-- Refresh hook re-assert (top-level, idempotent) — the 0080 TWO-MATVIEW body, NOT 0067's
-- single-matview tail (see the header's difference #2). Order matters: filter_options derives
-- from the rollup, so it refreshes second.
create or replace function collections.refresh_cmd_explorer_charge_rollup()
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  refresh materialized view concurrently collections.cmd_explorer_charge_rollup;
  refresh materialized view concurrently collections.cmd_explorer_filter_options;
end;
$$;

revoke all on function collections.refresh_cmd_explorer_charge_rollup() from public;
grant execute on function collections.refresh_cmd_explorer_charge_rollup() to cmd_rollup_writer;

-- Verification (run manually after apply) --------------------------------------
-- select count(*) from pg_attribute
--  where attrelid = 'collections.cmd_explorer_charge_rollup'::regclass
--    and attname = 'employer_name' and not attisdropped;          -- 1
-- select indexname from pg_indexes
--  where schemaname = 'collections' and tablename = 'cmd_explorer_charge_rollup'
--  order by indexname;                                            -- 0059 six + _cov_m + four 0081
--                                                                 -- *_trgm + cmd_charge_rollup_employer;
--                                                                 -- NOTHING named %_nxt
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'collections' and table_name = 'cmd_explorer_charge_rollup';
--                                                                 -- claims_reader SELECT;
--                                                                 -- cmd_rollup_writer SELECT+MAINTAIN
-- select collections.refresh_cmd_explorer_charge_rollup();        -- as cmd_rollup_writer: BOTH refresh
-- select kind, count(*) from collections.cmd_explorer_filter_options group by kind;
--   -- expect the 0080 facility + payer counts UNCHANGED, plus a new 'employer' row count
--   -- (0 until the one-shot employer backfill runs — that is correct, not a failure)
-- explain (analyze, buffers) <grid SQL with employer_name = any('{ACME}'::text[])>
--   -- PASS = Index Scan / Bitmap Index Scan on cmd_charge_rollup_employer; FAIL = Seq Scan
