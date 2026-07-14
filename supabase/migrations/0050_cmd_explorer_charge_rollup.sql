-- 0050 — collections.cmd_explorer_charge_rollup: the CHARGE-GRAIN read surface over the
-- append-only snapshot table, fixing the row-grain aggregate corruption confirmed 2026-07-13.
--
-- WHY: cmd_explorer_rows is one row per CONTENT SNAPSHOT of a charge×payment posting (0019,
-- by design — append-only, ON CONFLICT row_fingerprint). Every aggregate that summed it as if
-- 1 row = 1 charge line was corrupted: BXR carries 2.14 rows per logical charge (89.9% of
-- charges duplicated), so tenant %-paid read 197% and cohort %-paid up to 292% per bucket.
-- Verified field semantics (read-only probes, W29 cohort, 2026-07-13):
--   • charge_amount        — charge-level, repeated on every snapshot → count ONCE per charge.
--   • insurance_payments   — charge-CUMULATIVE running total (monotone over payment_received in
--                            99.9% of duplicated groups) → max() per charge, NEVER sum().
--   • allowed_amount       — PER PAYMENT POSTING, with explicit ± reversal rows (48.5% of dup
--                            groups contain a negative) → sum over DISTINCT postings per charge,
--                            where a posting is a distinct (payment_received, allowed_amount)
--                            pair (fingerprint dedup means an exact re-pull never re-inserts;
--                            a same-pair row differing only in other fields is the SAME posting).
--   • everything else      — latest-snapshot state (payment_received desc nulls last, id desc).
-- Under these rules the W29 cohort moves: charged $39.5M→$20.8M, %-allowed 14.1%→26.8%,
-- %-paid 179.7%→84.6% (post-fix curve runtime-verified: 61–90% across buckets); charges where
-- paid > allowed drop from 17% to 1.5%.
--
-- WHY MATERIALIZED (measured, not speculative): a plain view was runtime-verified for
-- correctness but tenant-wide aggregates over it ran 20–32s per query and the drilldown's
-- second join against it hit the reader's statement timeout — the search summary fires five
-- such queries per filter change. The matview turns all of those into indexed scans. Freshness:
-- the data only changes via the ingest crons, and each cron refreshes the matview right after
-- inserting (function below), so the matview is exactly as fresh as the table it summarizes.
--
-- GRAIN KEY: (business_entity_id, member_id_bidx, member_id_prefix_bidx, charge_date, cpt_code,
-- coalesce(revenue_code,''), facility, charge_amount). member_id_prefix_bidx is functionally
-- dependent on member_id_bidx (prefix of the same normalized id, 0036) — grouping by it is free
-- and keeps the cohort queries' prefix predicate on a grouping column. Known grain limits
-- (accepted): a same-day duplicate service (same CPT+amount+facility) collapses to one charge;
-- a genuine charge-amount revision splits into two.
--
-- CONSUMERS: every AGGREGATE read in src/collections/cmdExplorerQuery.ts (search-summary totals
-- + groupings + combo, cohort curves, cohort-point drilldown stats/breakdowns). The row-browsing
-- grid and the drilldown patient table stay on cmd_explorer_rows (row grain is what they show);
-- `id` here is the LATEST snapshot's row id, so joins back to the base table land on real rows
-- and the audited PHI reveal path is unchanged. daily_collections is a separate, correct
-- pipeline (per-pull Check/EFT postings) — untouched.
--
-- SECURITY: a matview cannot carry RLS, matching the existing posture — claims_reader's policy
-- on the base table is `using (true)` (tenant scoping is app-side, per the tenancy plane).
-- Non-PHI: the three ciphertext columns are NOT projected; blind-index tokens are keyed one-way
-- digests (0036) already readable by claims_reader on the base table. The refresh function is
-- SECURITY DEFINER (only the owner may REFRESH) with EXECUTE granted solely to cmd_rollup_writer,
-- so the ingest cron can refresh without any new table privilege. The refresh is CONCURRENT:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY takes a SHARE UPDATE EXCLUSIVE lock (NOT ACCESS
-- EXCLUSIVE), so summary/cohort/drilldown reads keep serving throughout a cron refresh — it does
-- NOT block reads. CONCURRENTLY requires (a) the unique index below (cmd_charge_rollup_id) and
-- (b) an already-POPULATED matview; this migration creates it WITH DATA (below), so the first
-- cron refresh has a base to diff against and cannot throw "CONCURRENTLY ... not populated".
-- (Verified on PG16.14: CONCURRENTLY runs inside a plpgsql SECURITY DEFINER function with
-- search_path = '', provably propagates data, and a read completed in ~112ms mid-refresh over
-- ~900k rows.) Trade-off: a CONCURRENT refresh is diff-based and SLOWER than a plain refresh —
-- its logged duration (cmdExplorerCron) feeds the cron wall-clock budget check.
--
-- Idempotency: IF NOT EXISTS on matview + indexes; CREATE OR REPLACE on the function; grants
-- reapplied unconditionally. Safe to re-run. First CREATE populates it (WITH DATA) — expect the
-- apply to take on the order of a minute over ~630k rows.
-- DEPENDENCY: 0019 (table), 0028/0030 (business_entity_id), 0036 (blind-index columns).
-- Rollback: 0050_cmd_explorer_charge_rollup_rollback.sql (drops function + matview; base table
-- untouched — roll the app back first or together).

create materialized view if not exists collections.cmd_explorer_charge_rollup as
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
    -- Charge-cumulative running total: max, never sum (see header).
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
with data;

-- Indexes: the drilldown joins by id (UNIQUE — also enables a manual CONCURRENT refresh); the
-- cohort queries scan one prefix token; the summary scans a tenant slice, usually windowed by
-- payment_received; the exact member/group blind-index lookups mirror the base table's (0036).
create unique index if not exists cmd_charge_rollup_id
  on collections.cmd_explorer_charge_rollup (id);
create index if not exists cmd_charge_rollup_prefix
  on collections.cmd_explorer_charge_rollup (member_id_prefix_bidx);
create index if not exists cmd_charge_rollup_entity_payment
  on collections.cmd_explorer_charge_rollup (business_entity_id, payment_received);
create index if not exists cmd_charge_rollup_member
  on collections.cmd_explorer_charge_rollup (member_id_bidx);
create index if not exists cmd_charge_rollup_group
  on collections.cmd_explorer_charge_rollup (group_number_bidx);

revoke all on collections.cmd_explorer_charge_rollup
  from public, anon, authenticated, service_role;
grant select on collections.cmd_explorer_charge_rollup to claims_reader;

-- Refresh hook for the ingest crons (SECURITY DEFINER: only the owner may REFRESH; the writer
-- role gets EXECUTE on exactly this function, no table privilege). CONCURRENTLY so reads never
-- block during a refresh (see header — requires the unique index + a populated matview).
-- search_path pinned per SECURITY DEFINER hygiene.
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
