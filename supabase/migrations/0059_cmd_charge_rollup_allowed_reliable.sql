-- 0059 — materialize the tiered "reliable allowed" INTO the 0050 charge-rollup matview
-- (collections.cmd_explorer_charge_rollup): allowed_reliable + allowed_tier + pct_allowed + pct_paid.
--
-- ADDITIVE (ruling Q4, Alec 2026-07-22): the four new columns are APPENDED; allowed_amount (the
-- netted-posting sum) keeps its exact 0050 meaning — it is the e1 reconciliation input, not dead.
-- NO consumer reads the new columns at this migration's landing (buildFacilityRankingQuery,
-- buildFacilityCasesQuery, the grid's snaps/sel/picked override, and the PCT_RATIO_SELECT/cohort
-- readers each repoint in their own later, separately-HELD diff) — so this migration has NO
-- observable behavior change, which is why the DROP+CREATE outage lands here.
--
-- WHY: BUILD X (1586f8c) fixed the grid DISPLAY by selecting a tiered per-charge allowed inline in
-- buildCmdExplorerQuery — paginating this rollup, then OVERRIDING allowed/pct per page from the base
-- snapshots, because the rollup's summed allowed over-states restated charges (133.88% on the
-- reference fixture). That hotfix left allowed_amount/pct_allowed/pct_paid unsortable (nothing
-- materialized to keyset on) and left Qualify reading the summed allowed directly (inflated per-claim
-- allowed in the recent-claims panel; inflated pct_allowed feeding the value-first facility rating).
-- Materializing the rule lets the grid re-point cleanly (3 sorts restorable) and Qualify inherit the fix.
--
-- TIERED allowed_reliable (per logical charge, over its posting snapshots;
-- target = max(insurance_payments) + latest(patient_balance_due)):
--   a    single distinct non-zero allowed                          -> that value
--   b    single distinct allowed == 0 WITH insurance_payments > 0  -> NULL (the CMD phantom $0)
--   cd   restated, a snapshot allowed reconciles target (<=$0.01)  -> that snapshot (latest by
--        payment_received desc, id desc on ties)
--   e1   restated, no snapshot reconciles, but the signed-delta    -> the netted sum (ruling Q1,
--        NETTED sum (allowed_amount) reconciles target (<=$0.01)      Alec 2026-07-22: reversal-aware
--                                                                     tier-e; scratch-verified to fire
--                                                                     on 122 BXR + 5,290 Indigo charges)
--   e2   restated, nothing reconciles                              -> latest POSITIVE allowed, else NULL
--   none no non-null allowed on any snapshot                       -> NULL
-- allowed_tier records which branch fired. Ruling Q2a (Alec 2026-07-22): the RATING aggregate
-- (buildFacilityRankingQuery, when it repoints) EXCLUDES tier 'e2' — filter allowed_tier <> 'e2',
-- NOT merely allowed_reliable IS NOT NULL — because an unreconciled latest-positive can push
-- pct_paid > 100%, which the grid deliberately shows unclamped (X's tell) but the value-first
-- rating's clamp0to100 would silently turn into a false "Strong" green. Grid display keeps e2.
-- pct_allowed / pct_paid follow allowed_reliable via the exact 0038 formula; NULL allowed -> NULL pct,
-- never coerced to 0%. pct_paid is deliberately UNCLAMPED (>100% stays visible per Alec's BUILD X ruling).
--
-- SHAPE (single-scan; scratch-verified 2026-07-22): the tier inputs fold into the SAME grouped pass
-- 0050's charge_state already ran (arrays + filtered aggregates), and the reconciling-snapshot pick
-- happens in `resolved` over the small ordered per-charge array — NOT via a second join of the base
-- table against the grain (that double-scan shape measured >120s to build and was rejected: it would
-- have blown the :45 refresh cron's maxDuration). Measured on prod data (634,680 rows -> 484,680
-- charges, 2026-07-22): CREATE ... WITH DATA 62s; REFRESH ... CONCURRENTLY 76s (vs ~58s for the 0050
-- definition). The refresh route's maxDuration is bumped 120 -> 180 in the SAME push as this
-- migration (operational headroom for the migration's own refresh, per Alec — not a consumer repoint).
--
-- APPLY GUARD (in-artifact, learned during scratch verification): the MCP transport's HTTP timeout
-- fires well before this ~85-95s apply completes, and a timed-out request can be RETRIED while the
-- first backend is still mid-CREATE. The DO wrapper below therefore (a) leads with
-- pg_advisory_xact_lock so a retry BLOCKS instead of colliding, and (b) no-ops (RAISE NOTICE) if
-- allowed_reliable already exists — so a retry that lands after the first apply commits is harmless.
-- The trailing grants/function re-asserts are idempotent and safe to re-run on that path. The leading
-- SET raises the MCP session's 2-minute statement_timeout ceiling (which killed the double-scan
-- scratch build twice) clear of the whole apply.
--
-- MATVIEW MECHANICS: matviews cannot ALTER ... ADD COLUMN / CREATE OR REPLACE -> DROP + CREATE ...
-- WITH DATA (synchronous ~1 min; CONCURRENTLY does not apply to an initial CREATE). During the build
-- the matview is ABSENT: collections aggregate reads (search summary, cohort, drilldown) and Qualify
-- error for ~1-2 min. Ruling Q5 (Alec): accept the outage; APPLY OFF THE CRON TICKS
-- (:00/:15/:30/:35/:45) with the refresh + ingest crons idle. `id` REMAINS the latest snapshot's real
-- cmd_explorer_rows id — the grid keyset, audited PHI reveal join, and cohort-drilldown `using (id)`
-- joins depend on it, and it backs the unique index REFRESH ... CONCURRENTLY requires.
--
-- INDEXES: recreates all SIX live indexes — the five from 0050 PLUS
-- cmd_charge_rollup_entity_payer_payment (business_entity_id, primary_payer, payment_received), which
-- existed live but in no committed migration (provenance drift, folded in here per Alec 2026-07-22;
-- definition copied verbatim from pg_indexes). It serves the qualify facility-ranking/movers scans.
--
-- SECURITY: unchanged from 0050 — no PHI ciphertext projected; claims_reader SELECT only; the
-- SECURITY DEFINER refresh function re-asserted with EXECUTE solely to cmd_rollup_writer.
--
-- VERIFICATION (scratch build collections._cmd_rollup_0059_check, prod data, 2026-07-22 — all green):
--   parity: row counts EXACT per tenant (BXR 66,741 / Indigo 417,939), zero NULL charge_date;
--   X-parity: tiers a/b/cd/e2/none reproduce BUILD X's shipped selector 100% (478,268/478,268,
--     IS NOT DISTINCT FROM); every e1 row (122 BXR + 5,290 Indigo, exactly the R2 probe counts)
--     equals the netted sum and differs from X's latest_pos — the intended Q1 divergence;
--   fixtures: charge 786560 (the 350% pct_paid tell) lands e1 -> allowed_reliable 1,143.53,
--     pct_paid 100.00; the 133.88% netted fixture (7,892.29 on 5,895.00) lands cd ->
--     allowed_reliable 1,997.29, pct_allowed 33.88;
--   null-safety: zero rows with NULL allowed_reliable and non-NULL pct; zero coerced-0% rows.
-- DEPENDENCY: 0019 (table), 0028/0030 (business_entity_id), 0036 (blind indexes), 0050 (prior matview).
-- Rollback: 0059_cmd_charge_rollup_allowed_reliable_rollback.sql (restores the 0050 definition +
-- all six indexes; if any consumer has already repointed to the new columns, roll the app back FIRST).

set statement_timeout = '10min';

do $apply$
begin
  -- Serialize against a transport-level retry of this same apply (see APPLY GUARD above).
  perform pg_advisory_xact_lock(590059);
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'collections' and c.relname = 'cmd_explorer_charge_rollup'
      and a.attname = 'allowed_reliable' and not a.attisdropped
  ) then
    raise notice '0059 already applied (allowed_reliable present) — skipping rebuild';
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
  -- The reconciling-snapshot pick (tiers c/d) over the ordered per-charge array: first (= latest)
  -- non-null allowed within $0.01 of target. The scalar subquery runs per charge over a ~2-element
  -- array — this is what replaces the rejected base-table re-join (see SHAPE above).
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
  -- Columns 19-22: NEW (this migration). Nothing reads them until the per-consumer repoint HOLDs.
  allowed_reliable, allowed_tier,
  case when charge_amount > 0 and allowed_reliable is not null
       then round(allowed_reliable / charge_amount * 100, 2) end as pct_allowed,
  case when allowed_reliable > 0
       then round(insurance_payments / allowed_reliable * 100, 2) end as pct_paid
from final
with data
  $mv$;

  -- All SIX live indexes: five from 0050 + the previously-uncommitted
  -- cmd_charge_rollup_entity_payer_payment (verbatim from pg_indexes, folded in per Alec 2026-07-22).
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
end
$apply$;

-- Grants + refresh hook: top-level, idempotent — safe on both the first apply and a no-op'd retry.
-- ⚠ BOTH reader grants are required: DROP MATERIALIZED VIEW destroys the old matview's ACL, and the
-- cmd_rollup_writer SELECT (0054) is what the refresh run-log's freshness read
-- (max(payment_received), refreshChargeRollup step 3) runs under — the first live apply
-- (2026-07-22) shipped without it and the very next cron-path refresh failed
-- "permission denied for materialized view" at exactly that read (rollup_refresh_run id 130);
-- restored by hand same-session, folded in here so any re-apply carries the full posture.
revoke all on collections.cmd_explorer_charge_rollup
  from public, anon, authenticated, service_role;
grant select on collections.cmd_explorer_charge_rollup to claims_reader;
grant select on collections.cmd_explorer_charge_rollup to cmd_rollup_writer;

-- Refresh hook unchanged from 0050 (matview name unchanged); re-asserted so a standalone apply of
-- this file leaves the full posture in place. SECURITY DEFINER, search_path pinned; EXECUTE only
-- to cmd_rollup_writer (the :45 cron role).
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
