# INT ingest diagnosis — Round 2

**Date:** 2026-08-04 · **Mode:** read-only, zero CMD API calls · **Status:** HOLD

Scope: two queries + one code read. Nothing changed. The 145-vs-141 matview gap is
deliberately untouched (separate follow-up).

Accepted from Round 1 (not re-litigated here): `ingested_at` is first-seen per
`row_fingerprint`; all 145 BXR INT/INTRST rows landed in a 27-second window on
2026-06-29 inside the seed load; zero INT rows have ever arrived via the cron; the
projection has no CPT validation.

Fork under test:

- **(a)** live report/filter never returns interest lines — unbounded, ongoing
- **(b)** CMD stopped posting BXR interest after 06-24 — bounded, benign
- **(c)** the cron's window/anchor structurally excludes interest lines regardless of projection

---

## Query 1 — CSV boundary test

63 BXR members carrying INT lines, restricted to `ingested_at < 2026-06-30`:

| Cohort | rows | min(payment_received) | max(payment_received) | rows after 06-24 |
|---|---|---|---|---|
| INT / INTRST | 145 | 2024-08-26 | **2026-06-24** | **0** |
| non-INT, same 63 members | 7,042 | 2023-07-07 | **2026-06-24** | **0** |

### Verdict (a)/(b)

**06-24 is the CSV's right edge, not an event — (b) has no supporting evidence.**

Seed-era non-INT terminates on the identical date with zero rows past it. The 06-24
cutoff is a property of Derek's export, not of CMD's posting behavior.

---

## Query 2 — window / anchor test

| Cohort | n | charge_date | payment_received | lag p50 / max |
|---|---|---|---|---|
| 145 INT rows | 145 | 2024-08-27 → 2026-06-24 | 2024-08-26 → 2026-06-24 | — |
| cron-era BXR (`ingested_at >= 06-30`) | 7,848 | 2024-08-13 → 2026-07-22 | 2026-02-19 → 2026-08-04 | charge-lag **47 / 721** d; **pay-lag 0 / 131 d** |

Charge-date lag is wide and useless as an anchor signal. Payment-date lag p50 = **0
days** — the feed is payment-anchored and same-day.

Per-week coverage makes the window visible:

| ingest week | n | min_pay | max_pay | rows w/ pay ≤ 06-24 | INT |
|---|---|---|---|---|---|
| 2026-06-29 | 1,098 | 2026-02-19 | 2026-07-03 | 145 | 0 |
| 2026-07-06 | 1,076 | 2026-07-01 | 2026-07-10 | 0 | 0 |
| 2026-07-13 | 2,151 | 2026-07-01 | 2026-07-17 | 0 | 0 |
| 2026-07-20 | 1,837 | 2026-07-09 | 2026-07-24 | 0 | 0 |
| 2026-07-27 | 1,166 | 2026-07-01 | 2026-07-31 | 0 | 0 |
| 2026-08-03 | 520 | 2026-07-20 | 2026-08-04 | 0 | 0 |

### Window construction, from code (not inference)

There is **no date-window construction in `cmdExplorerCron.ts`**. The cron passes no
date argument at any point; the fetch config carries `reportId` + `filterId` and
nothing else — `app/lib/server.ts:2015-2016`.

The window lives entirely inside CMD's saved filter, documented as **payment-received,
rolling current month**:

- `src/collections/cmdExplorerCron.ts:7-9`
- `app/lib/server.ts:1993-1995`

The only code-side date logic is `dropFuturePaymentRows` — a right-edge guard at
today+14 — `src/collections/cmdExplorerCron.ts:245`.

Coverage extends one month back via the catch-up cron's separate last-month filter,
`CMD_EXPLORER_LASTMONTH_FILTER_ID` — `app/lib/server.ts:836-841`.

### Coordinate check

The 145 INT rows occupy **124 distinct (member, payment_date) pairs. The cron pulled 0
of them.** The cron era touched June 1–24 on exactly one payment date, 31 rows.

### Verdict (c)

**Live — the rolling current-month payment-received window structurally excludes every
INT row, and (a) is unnecessary to explain the absence.**

All 145 INT payment dates sit at or before 2026-06-24; from the 2026-07-06 week onward
the window has never reached below 2026-07-01.

---

## Flag against my own Round 1 framing

"Zero INT rows have ever arrived via the cron" is weaker evidence than it reads,
independent of the window.

`on conflict (row_fingerprint) do nothing` means an insert requires coverage **∩
novelty**. The seed already held every pre-06-24 row, so a June-window pull on 06-30
would have returned the INT lines and deduped them to nothing — no row, no
`ingested_at`. That is exactly the sparse shape of the 06-29 week (145 scattered
Feb–Jun rows: the ones whose dollars had *changed* since the CSV).

So for the June-and-earlier population, dedup and the window suppress new INT rows
**independently**, and neither absence proves the report omits interest.

## What survives

The only live signal for (a): CMD posted no in-window interest in **July or August**,
when a genuine interest line would have been both covered and novel. That is equally
what (b) predicts.

Splitting (a) from (b) requires a CMD call — out of scope this round.

---

## Queries run (for reproduction)

All against project `dbpabchpvipipkzkogta`, schema `collections`, via Supabase MCP.
BXR entity `af504ab6-3dcd-4aa4-a93c-27bc58de4088`. Output is non-PHI aggregates only —
`member_id_bidx` is used for grouping and never projected.

### Q1

```sql
with int_members as (
  select distinct member_id_bidx
    from collections.cmd_explorer_rows
   where business_entity_id = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'
     and cpt_code in ('INT','INTRST')
     and member_id_bidx is not null
),
seed as (
  select r.*
    from collections.cmd_explorer_rows r
    join int_members m using (member_id_bidx)
   where r.business_entity_id = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'
     and r.ingested_at < timestamptz '2026-06-30'
)
select 'A. SEED-ERA INT/INTRST' as cohort, count(*) as n,
       min(payment_received)::text as min_pay, max(payment_received)::text as max_pay,
       count(*) filter (where payment_received > date '2026-06-24') as pay_after_0624
  from seed where cpt_code in ('INT','INTRST')
union all
select 'B. SEED-ERA non-INT (same 63 members)', count(*),
       min(payment_received)::text, max(payment_received)::text,
       count(*) filter (where payment_received > date '2026-06-24')
  from seed where cpt_code is null or cpt_code not in ('INT','INTRST')
order by 1;
```

### Q2a — ranges + lag

```sql
select 'A. 145 INT rows' as cohort, count(*) as n,
       min(charge_date)::text as min_charge, max(charge_date)::text as max_charge,
       min(payment_received)::text as min_pay, max(payment_received)::text as max_pay,
       null::text as lag_p50_days, null::text as lag_max_days
  from collections.cmd_explorer_rows
 where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and cpt_code in ('INT','INTRST')
union all
select 'B. cron-era BXR rows', count(*),
       min(charge_date)::text, max(charge_date)::text,
       min(payment_received)::text, max(payment_received)::text,
       percentile_disc(0.5) within group (order by (ingested_at::date - charge_date))::text,
       max(ingested_at::date - charge_date)::text
  from collections.cmd_explorer_rows
 where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and ingested_at >= timestamptz '2026-06-30'
union all
select 'C. cron-era BXR, lag on PAYMENT date', count(*) filter (where payment_received is not null),
       null, null, null, null,
       percentile_disc(0.5) within group (order by (ingested_at::date - payment_received))::text,
       max(ingested_at::date - payment_received)::text
  from collections.cmd_explorer_rows
 where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and ingested_at >= timestamptz '2026-06-30'
order by 1;
```

### Q2b — per-week window shape

```sql
select date_trunc('week', ingested_at)::date::text as ingest_week,
       count(*) as n,
       min(payment_received)::text as min_pay,
       max(payment_received)::text as max_pay,
       count(*) filter (where payment_received <= date '2026-06-24') as pay_on_or_before_0624,
       count(*) filter (where cpt_code in ('INT','INTRST')) as int_rows
  from collections.cmd_explorer_rows
 where business_entity_id = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and ingested_at >= timestamptz '2026-06-30'
 group by 1 order by 1;
```

### Q2c — coordinate overlap

```sql
with int_rows as (
  select distinct member_id_bidx, payment_received
    from collections.cmd_explorer_rows
   where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
     and cpt_code in ('INT','INTRST') and payment_received is not null
),
cron as (
  select member_id_bidx, payment_received, cpt_code
    from collections.cmd_explorer_rows
   where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
     and ingested_at >= timestamptz '2026-06-30'
)
select
  (select count(*) from int_rows) as distinct_int_member_paydate_pairs,
  (select count(*) from int_rows i
     where exists (select 1 from cron c
                    where c.member_id_bidx=i.member_id_bidx
                      and c.payment_received=i.payment_received))
    as pairs_the_cron_ALSO_pulled,
  (select count(*) from cron where payment_received between date '2026-06-01' and date '2026-06-24')
    as cron_rows_in_june_1_to_24,
  (select count(distinct payment_received)::text from cron
    where payment_received between date '2026-06-01' and date '2026-06-24')
    as cron_distinct_june_paydates,
  (select count(*) from cron c
     where exists (select 1 from int_rows i where i.payment_received = c.payment_received))
    as cron_rows_on_an_INT_paydate;
```

Result: `124 / 0 / 31 / 1 / 28`.
