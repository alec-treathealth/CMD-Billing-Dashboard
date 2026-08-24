# 'No Facility' residual — CMD customer-ID lever

**Date:** 2026-08-04 · **Mode:** read-only, zero CMD API calls · **Status:** HOLD

Question: does the CMD customer/account identifier survive the write onto
`collections.cmd_explorer_rows`, giving per-row provenance immune to the "no other
rows" problem that capped the 0083 technique at 25.70%?

## Step 1 — NO. The provenance is discarded.

Per your instruction, steps 2 and 3 are moot and were not run.

### Schema: no such column exists

`collections.cmd_explorer_rows` has 30 columns (enumerated live from
`information_schema.columns`). There is no `customer_id`, `cmd_customer`,
`account_id`, `office_id`, or equivalent:

```
id · charge_date · payment_received · cpt_code · revenue_code · facility ·
patient_name · member_id · group_number · charge_amount · allowed_amount ·
insurance_payments · adjustments · patient_balance_due · primary_payer ·
source_file · ingested_at · row_fingerprint · business_entity_id ·
member_id_bidx · member_id_prefix_bidx · group_number_bidx · pct_allowed ·
pct_paid · charge_id · charge_entered_date · charge_to_date ·
claim_status_raw · claim_status_category · patient_name_bidx
```

`source_file` is the only per-row provenance field, and it is free text.

### Both writers checked separately, as asked

The single row-mapping function takes provenance as one string parameter:

- `mapRow(full: CmdExplorerFullRow, sourceFile: string)` —
  [cmdExplorerSeed.ts:172](src/collections/cmdExplorerSeed.ts#L172), stored at
  [:269](src/collections/cmdExplorerSeed.ts#L269) as `source_file`.

**Cron writer — discards it.** The customer id is destructured at
[cmdExplorerCron.ts:212](src/collections/cmdExplorerCron.ts#L212) and used for exactly
one thing, the fetch at
[:221](src/collections/cmdExplorerCron.ts#L221). The explorer write passes a
compile-time constant instead:

- `const CRON_SOURCE = 'cmd_api'` — [cmdExplorerCron.ts:37](src/collections/cmdExplorerCron.ts#L37)
- `mapRow(full, CRON_SOURCE)` — [cmdExplorerCron.ts:255](src/collections/cmdExplorerCron.ts#L255)

**Seed writer — discards it too.** `mapRow(full, source)` where `source` is the CSV
filename — [cmdExplorerSeed.ts:351](src/collections/cmdExplorerSeed.ts#L351). Same for
the Indigo adapter, [indigoSeedAdapter.ts:123](src/collections/indigoSeedAdapter.ts#L123).

Neither writer differs in the way that would have helped: both collapse per-pull
provenance into a string that does not identify the customer.

### Empirical confirmation on the actual residual

`source_file` distribution across the 265 no-match members' 18,530 line-grain rows:

| source_file | rows | charge $ | paid $ |
|---|---|---|---|
| `Derek Automation.csv` | 18,529 | $48,509,533.22 | $14,345,073.78 |
| `cmd_api` | 1 | $1,200.00 | $0.00 |

One filename for the entire legacy residual. The seed was a single combined export, not
per-customer files, so even the filename carries no customer discrimination. There is
nothing to look up.

**Fraction of the $20.95M made attributable by this lever: 0%.**

---

## One forward-looking fact, stated but not acted on

The cron *holds* both identifiers at write time and uses them on the other surface —
`facilityCode` is passed to the daily-deposit path at
[cmdExplorerCron.ts:268-269](src/collections/cmdExplorerCron.ts#L268-L269)
(`aggregateDailyDeposits(reportRows, facilityCode)` →
`replaceCmdDailyForFacility(deps.writeDb, facilityCode, …)`), while the explorer path
takes `facility` from the report cell only.

So the provenance is available in the cron's hand and deliberately dropped on the
explorer write. That is recoverable **for future rows** by a schema change; it is not
recoverable for the 11,413 seed-era charges in this bucket, which were never written by
that path.

Relatedly, `splitFacilityLabel` parses and then discards a CMD-internal facility id from
labels shaped `NAME (10272858)` —
[cmdExplorer.ts:275](src/collections/cmdExplorer.ts#L275). It does not help here: these
rows' label is the bare string `No Facility`, with no parenthesised id to parse. The
comment at [cmdExplorer.ts:246-251](src/collections/cmdExplorer.ts#L246-L251) also
records that this id is **not** a CMD customer id.

Neither observation is a recommendation. Next lever is your call.

---

## Queries run

Project `dbpabchpvipipkzkogta`. BXR entity `af504ab6-3dcd-4aa4-a93c-27bc58de4088`.
Non-PHI aggregates only.

```sql
select ordinal_position, column_name, data_type
  from information_schema.columns
 where table_schema='collections' and table_name='cmd_explorer_rows'
 order by ordinal_position;
```

```sql
with resid as (
  select r.source_file, r.charge_amount, r.insurance_payments
    from collections.cmd_explorer_rows r
   where r.business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
     and r.facility='No Facility'
     and not exists (
       select 1 from collections.cmd_explorer_rows o
        where o.business_entity_id='af504ab6-3dcd-4aa4-a93c-27bc58de4088'
          and o.member_id_bidx = r.member_id_bidx
          and o.facility <> 'No Facility')
)
select source_file, count(*) as rows,
       sum(charge_amount)::text as charge_dollars,
       sum(coalesce(insurance_payments,0))::text as paid_dollars
  from resid group by 1 order by 2 desc limit 40;
```
