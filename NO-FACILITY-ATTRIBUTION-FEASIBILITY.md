# 'No Facility' bucket — attribution feasibility

**Date:** 2026-08-04 · **Mode:** read-only, zero CMD API calls · **Status:** HOLD

Question: does the migration-0083 technique (attribute to a facility via `member_id_bidx`
against the member's other rows) transfer from the 141 INT rows to the legacy
'No Facility' bucket?

**Answer up front: no. 25.70% of the $29.08M is attributable. 72.05% is unreachable
from `cmd_explorer_rows` alone.**

Nothing was built, no migration written, no matview created.

---

## Grain correction (read this first)

Your figures come from `collections.cmd_explorer_charge_rollup` (charge grain), not
`collections.cmd_explorer_rows` (payment-line grain). Both are reported below; the
rollup is the grain that matters, since it is what a consumer would repoint.

| Source | rows/charges | charge $ | insurance paid $ |
|---|---|---|---|
| `cmd_explorer_charge_rollup`, `facility='No Facility'` | **11,414** | **$29,081,575.38** | $8,209,249.45 |
| `cmd_explorer_rows`, same filter (line grain) | 25,751 | $68,245,789.40 | $20,749,497.68 |

Your stated 11,273 / $29.07M is the rollup, 141 charges stale — the rollup refreshes
hourly. (The 141 delta coinciding with the 141 INT rows is coincidence; the INT rows
are not in this bucket.) Dollar figure confirmed.

**Sentinel literal confirmed from the data: exactly `'No Facility'`.** A scan for
`%no%facil%`, `%unassigned%`, `%unknown%`, `%none%`, and `''` across BXR returns that
one value and nothing else. There is no second spelling to catch.

---

## 1. Bucket shape (charge grain)

| Measure | Value |
|---|---|
| charges | 11,414 |
| charge dollars | $29,081,575.38 |
| insurance paid dollars | $8,209,249.45 |
| distinct `member_id_bidx` | 388 |
| **charges with `member_id_bidx IS NULL`** | **0** |
| charge_date range | 2023-02-27 → 2026-07-06 |
| payment_received range | 2020-07-10 → 2026-07-17 |
| charges with null payment_received | 344 |
| seed era (`ingested_at < 2026-06-30`) | 11,413 |
| cron era | **1** |

**`member_id_bidx` is 100% populated** — across the whole table, both tenants
(146,418/146,418 BXR, 497,378/497,378 Indigo). Nothing in this bucket is unattributable
for want of a join key. The failure mode is not a missing key; it is missing evidence
on the other side of the join.

### patient_name_bidx population rate (verified, not built on)

| Entity | populated | total | rate |
|---|---|---|---|
| BXR | 1,820 | 146,418 | **1.24%** |
| Indigo | 4,795 | 497,378 | **0.96%** |

Confirmed near-empty. Not used for any matching below. The `LAST, FIRST` vs
`LAST FIRST` normalization mismatch is a second, independent reason not to.

---

## 2. Attribution yield

Classification: for each of the 388 bucket members, count distinct facilities on that
member's **non-'No Facility'** rows.

### Charge grain (`cmd_explorer_charge_rollup`) — the number that matters

| Class | members | charges | charge $ | insurance paid $ | % charge $ | % paid $ |
|---|---|---|---|---|---|---|
| **resolvable** (exactly 1 facility) | 114 | 3,102 | **$7,472,871.90** | $2,279,882.24 | **25.70%** | 27.77% |
| **tied** (2+ facilities) | 9 | 145 | $655,235.26 | $299,366.02 | 2.25% | 3.65% |
| **no-match** (0 named-facility rows) | 265 | 8,167 | **$20,953,468.22** | $5,630,001.19 | **72.05%** | 68.58% |

### Line grain (`cmd_explorer_rows`) — same shape, confirms it isn't a grain artifact

| Class | members | rows | charge $ | insurance paid $ | % charge $ |
|---|---|---|---|---|---|
| resolvable | 114 | 6,919 | $18,264,106.05 | $5,756,042.75 | 26.76% |
| tied | 9 | 302 | $1,470,950.13 | $648,381.15 | 2.16% |
| no-match | 265 | 18,530 | $48,510,733.22 | $14,345,073.78 | 71.08% |

### Contrast with 0083

| | INT bucket (0083) | 'No Facility' bucket |
|---|---|---|
| resolved | 137 / 141 = **97.2%** | 3,102 / 11,414 = **27.2%** of charges, **25.70%** of dollars |
| no-match | 3 rows | 8,167 charges |

The INT rows belonged to members who were richly represented under named facilities.
This bucket's members mostly are not. Same technique, opposite population.

---

## 3. Era test — member-scoped, confirmed

**Ingest era:** 11,413 of 11,414 charges are seed-era. **One** cron-era charge exists
(payment month 2026-07, $1,200).

That single row is the finding worth keeping: the bucket is ~entirely legacy but it is
**not sealed**. The live feed can still emit `'No Facility'`, at a trickle. Any framing
of this as a closed historical artifact is wrong.

**Payment-month distribution** — continuous 2020-07 → 2026-07, peaking 2024-03 through
2024-10, tapering hard after 2025-01:

| pay month | charges (line grain) | charge $ |
|---|---|---|
| (null) | 346 | $599,594.43 |
| 2020-07 | 34 | $174,680.00 |
| 2023-04 → 2023-12 | 3,548 | $7,916,436.00 |
| 2024-01 → 2024-12 | 17,549 | $53,214,083.36 |
| 2025-01 → 2025-12 | 1,768 | $5,726,087.05 |
| 2026-01 → 2026-07 | 239 | $513,908.40 |

Not a clean date era. Six years of continuous presence with a 2024 concentration.

**Cross-tenant:** Indigo has **0** 'No Facility' rows across **497,378** rows (your
422,971 is stale — correcting). BXR: 25,751 of 146,418 = **17.59%**.

**Verdict on the member-scoped reading: confirmed.** 265 of 388 bucket members (68%)
have zero named-facility rows *anywhere* in `cmd_explorer_rows`, and they carry 72% of
the bucket's dollars. These members exist only inside the bucket.

One caveat stated plainly: "no-match members have all their charges in the bucket" is
true *by construction* of the classification — it cannot be evidence for itself. The
non-tautological finding is the **size** of that class. Your 3-INT-member observation
generalizes to 265 members and $20.95M.

---

## Definition of done

**25.70% of the $29,081,575.38 — $7,472,871.90 across 3,102 charges and 114 members —
is attributable by the 0083 technique.**

Adding the 9 tied members under any tie-break rule raises the ceiling to 27.95%
($8.13M). The remaining **72.05% / $20,953,468.22** cannot be attributed from
`cmd_explorer_rows` at all, because those 265 members have no named-facility row to
attribute from.

---

## Leads, not measured this round

The 72% is only unreachable *from this table*. Untested sources that could carry a
facility for the 265 no-match members:

- `collections.cmd_charge_census` — different feed, different projection
- `collections.cmd_facility_aliases`
- the VOB plane (`vob.*`) — facility is one of the only populated Indigo VOB columns
- the 835/ERA plane

Each is a separate round. None was queried here.

---

## Queries run (for reproduction)

Project `dbpabchpvipipkzkogta`. BXR entity `af504ab6-3dcd-4aa4-a93c-27bc58de4088`.
Non-PHI aggregates only — `member_id_bidx` used for grouping, never projected.

### Sentinel confirmation

```sql
select facility, count(*) as n,
       sum(charge_amount)::text as charge_sum,
       sum(coalesce(insurance_payments,0))::text as ins_pay_sum
  from collections.cmd_explorer_rows
 where business_entity_id = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and (facility ilike '%no%facil%' or facility ilike '%unassigned%'
        or facility ilike '%unknown%' or facility ilike '%none%' or facility = '')
 group by 1 order by 2 desc;
```

### Blind-index population rates

```sql
select business_entity_id::text as entity,
       count(*) as total_rows,
       count(distinct facility) as distinct_facilities,
       count(*) filter (where patient_name_bidx is not null) as name_bidx_populated,
       round(100.0*count(*) filter (where patient_name_bidx is not null)/nullif(count(*),0),2)::text as name_bidx_pct,
       count(*) filter (where member_id_bidx is not null) as member_bidx_populated,
       round(100.0*count(*) filter (where member_id_bidx is not null)/nullif(count(*),0),2)::text as member_bidx_pct
  from collections.cmd_explorer_rows
 group by 1 order by 1;
```

### §1 — bucket shape (charge grain)

```sql
select count(*) as charges,
       count(distinct member_id_bidx) as members,
       count(*) filter (where member_id_bidx is null) as null_member_bidx,
       sum(charge_amount)::text as charge_dollars,
       sum(coalesce(insurance_payments,0))::text as insurance_paid,
       min(charge_date)::text as min_charge, max(charge_date)::text as max_charge,
       min(payment_received)::text as min_pay, max(payment_received)::text as max_pay,
       count(*) filter (where payment_received is null) as null_pay,
       count(*) filter (where ingested_at < timestamptz '2026-06-30') as seed_era,
       count(*) filter (where ingested_at >= timestamptz '2026-06-30') as cron_era
  from collections.cmd_explorer_charge_rollup
 where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088' and facility='No Facility';
```

### §2 — attribution yield (charge grain)

```sql
with bucket as (
  select member_id_bidx, count(*) as chg,
         sum(charge_amount) as amt, sum(coalesce(insurance_payments,0)) as ins
    from collections.cmd_explorer_charge_rollup
   where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088' and facility='No Facility'
   group by 1
),
other as (
  select member_id_bidx, count(distinct facility) as nf
    from collections.cmd_explorer_charge_rollup
   where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088' and facility <> 'No Facility'
   group by 1
)
select case when o.nf is null then '3 no-match' when o.nf=1 then '1 resolvable' else '2 tied' end as class,
       count(*) as members, sum(b.chg) as charges,
       sum(b.amt)::text as charge_dollars, sum(b.ins)::text as insurance_paid_dollars,
       round(100.0*sum(b.amt)/sum(sum(b.amt)) over (),2)::text as pct_charge_dollars,
       round(100.0*sum(b.ins)/nullif(sum(sum(b.ins)) over (),0),2)::text as pct_paid_dollars
  from bucket b left join other o using (member_id_bidx)
 group by 1 order by 1;
```

(The line-grain variant is the same query against `collections.cmd_explorer_rows`.)

### §3 — era test

```sql
select case when facility='No Facility' then 'No Facility' else 'named facility' end as bucket,
       case when ingested_at < timestamptz '2026-06-30' then '1 seed' else '2 cron' end as era,
       count(*) as n, sum(charge_amount)::text as charge_sum,
       count(*) filter (where charge_id is null) as null_charge_id
  from collections.cmd_explorer_rows
 where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
 group by 1,2 order by 1,2;

select to_char(payment_received,'YYYY-MM') as pay_month,
       count(*) as n, sum(charge_amount)::text as charge_sum,
       count(distinct member_id_bidx) as members
  from collections.cmd_explorer_rows
 where business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and facility='No Facility'
 group by 1 order by 1 nulls first;

select business_entity_id::text as entity,
       count(*) filter (where facility='No Facility') as no_facility_rows,
       count(*) as total_rows,
       round(100.0*count(*) filter (where facility='No Facility')/nullif(count(*),0),2)::text as pct
  from collections.cmd_explorer_rows group by 1 order by 1;
```
