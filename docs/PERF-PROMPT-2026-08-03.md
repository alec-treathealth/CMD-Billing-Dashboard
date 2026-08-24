# Claude Code prompt — CMD Billing Dashboard page-load latency

Paste everything below the line into Claude Code in this repo.

---

You are fixing user-perceived page-load latency in the CMD Billing Dashboard. Read
`CLAUDE.md` first and honor every standing rule — PHI never leaves the boundary, reads run
as `claims_reader`, parameterized values only with fixed-literal identifiers, product-plane
migrations go in `supabase/migrations/` starting at **0077**, and you HOLD before applying
a migration, committing, pushing, or deploying.

## Do not re-derive the diagnosis — it is already done

I profiled `pg_stat_statements` and the live schema on project `dbpabchpvipipkzkogta`. The
conclusion is counterintuitive and you must not "fix" the wrong thing:

**The two queries consuming 87% of all DB time are NOT on the user request path.**

| Query | Share | Reality |
|---|---|---|
| `select collections.refresh_cmd_explorer_charge_rollup()` | 76.9% / 9h28m | The hourly `/api/cron/refresh-charge-rollup` job. 465 calls × 73s mean. `REFRESH MATERIALIZED VIEW CONCURRENTLY` takes only SHARE UPDATE EXCLUSIVE — it never blocks a reader. It hurts page loads **indirectly**, by churning a 257MB matview through a 256MB buffer cache and evicting the pages readers need. |
| `select id, patient_name from collections.cmd_explorer_rows where … patient_name_bidx is null` | 10.1% / 1h14m | `src/collections/cmdNameBidxBackfill.ts`, a one-off manual CLI backfill. 313 batches × 500 rows = 156,500 rows, already complete. It is finished history in the stats table. Do nothing. |

`pg_stat_statements` ranks by **cumulative** time, so long-running batch jobs always dominate
it. What a user waits on is **mean time × queries per page load**. Rank by that instead and a
completely different set of culprits appears — the real ones, below.

## The actual causes, in priority order

### C1 — Free-text search is unindexable (5–13s per call, worst offender)

`buildCmdExplorerFilterConditions` in `src/collections/cmdExplorerQuery.ts` (~line 184) emits:

```ts
const ors = cols.map((c) => `${CMD_EXPLORER_SEARCH_COLUMNS[c]}::text ilike ${p}`);
```

with `likeContains(term)` → a **leading-wildcard** `%term%`. No btree index can serve that, so
every search does a full parallel seq scan of a 503MB / 642k-row table. Measured: 13,405ms mean
on the 11-column variant, 5,063–7,312ms on narrower ones, with `shared_blks_read` up to 191,388
(~1.5GB of disk reads for one query) and cache hit ratio as low as **53.9%**.

Two compounding details you must handle:

1. **All four current search columns are already `text`** — `CMD_EXPLORER_SEARCH_COLUMNS` is
   `{facility, primary_payer, cpt_code, revenue_code}`. The `::text` cast is therefore a no-op
   *semantically* but fatal *for planning*: a trigram index on `facility` will NOT be used
   against `facility::text ilike $1`. **Drop the `::text` cast** for these columns. Keep a
   cast only if you can prove a column is non-text.
2. **`pg_trgm` is installed in the `claims` schema**, not `public` or `extensions`
   (`select extname, nspname from pg_extension … ` → `pg_trgm | claims`). So the operator class
   must be written **`claims.gin_trgm_ops`**, or the migration must set an explicit
   `search_path` that includes `claims`. Get this wrong and the DDL fails with
   `operator class "gin_trgm_ops" does not exist`.

### C2 — Filter dropdowns full-scan 642k rows to return 466 and 48 values

`buildCmdPayerOptionsQuery` (line ~247) and `buildCmdFacilityOptionsQuery` (line ~226) each run
a `distinct` over the whole tenant slice. I ran the plan:

```
Unique  (actual rows=465)
  Buffers: shared hit=84435 read=68603          -- ~536MB of IO
  ->  Parallel Seq Scan on cmd_explorer_rows  (actual rows=321086 loops=2)
Execution Time: 33937 ms
```

Live cardinality: **466 distinct payers, 48 distinct facilities, 2 entities, 642,197 rows.**
Scanning half a gigabyte to produce 48 strings.

Both are wrapped in `unstable_cache`, which is why they only show 152 and 195 calls — but the
facility one rides the `cmd-explorer` tag that the **half-hourly cron busts**, so roughly every
30–60 minutes the next user to click a tab eats the full 2.8s (max recorded: 12,225ms). Caching
is papering over a query that should never be expensive. Fix it in the database.

### C3 — One page load fans out into 5+ independent full scans of the same rows

`buildCmdSearchSummaryQueries` (line ~665) builds `totals` + one grouping per dimension
(`facility`, `primary_payer`, `cpt_code`) + a `(cpt, revenue)` combo — **5 queries that share an
identical WHERE clause and each re-scan the same rows independently**. Add the grid query and the
two dropdown queries and a single tab click issues 8+ queries, each 1–5s. Confirmed by the
matching call counts and near-identical mean times in `pg_stat_statements`:

```
facility as label …   21 calls  4773ms
cpt_code as label …   21 calls  4730ms
primary_payer …       21 calls  4698ms
count(*) totals …     21 calls  4637ms
grid page …           21 calls  3240ms
```

### C4 — The instance is far too small for the working set

```
shared_buffers        = 256 MB
effective_cache_size  = 768 MB
work_mem              = 3.5 MB
max_parallel_workers_per_gather = 1
```

against `cmd_explorer_rows` 503MB + `cmd_explorer_charge_rollup` 257MB + ~175MB of indexes on
`cmd_explorer_rows` alone. The working set is roughly **4x** shared_buffers, which is exactly
why hit ratios sit at 54–76% instead of 99%. `work_mem` of 3.5MB also forces the GROUP BY
aggregates in C3 to spill.

### C5 — Index bloat causing write amplification

13 indexes on `cmd_explorer_rows`, and `pg_stat_user_tables` reports **`n_tup_hot_upd = 0`
against `n_tup_upd = 626,131`** — every single update rewrites all 13 index entries. Several
indexes barely earn their keep: `cmd_explorer_primary_payer` (59 scans),
`cmd_explorer_group_number_bidx_idx` (106), `cmd_explorer_ingested_at` (36),
`cmd_charge_rollup_group` (18), and `cmd_charge_rollup_entity_payment_cov_m` (**64MB for 174
scans**). Also `last_autovacuum` on `cmd_explorer_rows` was 2026-07-09, and I measured
`Heap Fetches: 642172` on an index-only scan — the visibility map is cold, so "index-only"
scans are secretly hitting the heap.

## What to do — phased, each phase independently shippable

### Phase 0 — STOP and report to me before writing any code

Tell me the current Supabase compute add-on tier for `dbpabchpvipipkzkogta` and what the next
tier up would cost. Per C4 this is a dashboard toggle plus a ~2-minute restart, not a code
change, and it is plausibly the largest single win available. **I decide whether to pull that
trigger — you do not.** Do not call `apply_migration` or restart anything in this phase.

### Phase 1 — Kill the dropdown scans (migration `0077`)

Create a tiny non-PHI dimension matview, e.g. `collections.cmd_explorer_filter_options`, keyed
`(business_entity_id, kind, value)` where `kind ∈ ('facility','payer')`, built once from
`cmd_explorer_rows`. At 466 + 48 values × 2 entities this is a sub-100KB object. Add a unique
index so it can be refreshed `CONCURRENTLY`. Rewrite `buildCmdPayerOptionsQuery` and
`buildCmdFacilityOptionsQuery` to read it, keeping the facility→dimension `LEFT JOIN` enrichment
and the exact same return shapes so no caller or test changes semantics. Refresh it from the
existing hourly rollup cron (it is cheap; do not add a new cron entry). Grant `SELECT` to
`claims_reader` and `MAINTAIN`/refresh rights to `cmd_rollup_writer` only.

Expected: 2,800ms → single-digit ms, and the `cmd-explorer` tag bust stops being a latency cliff.

### Phase 2 — Make search indexable (migration `0078`)

Add trigram GIN indexes for the four real search columns on `cmd_explorer_rows`, remembering
**`claims.gin_trgm_ops`** per C1:

```sql
create index concurrently if not exists cmd_explorer_facility_trgm
  on collections.cmd_explorer_rows using gin (facility claims.gin_trgm_ops);
```

…and the same for `primary_payer`, `cpt_code`, `revenue_code`. `CREATE INDEX CONCURRENTLY`
cannot run inside a transaction block — check how the migration runner wraps statements and
split the file if it wraps in `BEGIN`. Then remove the `::text` casts in
`buildCmdExplorerFilterConditions` so the planner can actually reach these indexes.

Before/after, capture `EXPLAIN (ANALYZE, BUFFERS)` for a representative 3-char search and show
me both plans. The pass condition is a Bitmap Index Scan replacing the Parallel Seq Scan — not
merely a smaller number.

Keep `CMD_SEARCH_TERM_MIN = 3`. Do not widen `CMD_EXPLORER_SEARCH_COLUMNS`.

### Phase 3 — Collapse the summary fan-out (no migration)

Rewrite `buildCmdSearchSummaryQueries` so the shared WHERE clause is evaluated **once**. Either
a single query with `GROUPING SETS`/`grouping sets ((facility),(primary_payer),(cpt_code),
(cpt_code, revenue_code),())` returning a tagged label column, or one CTE feeding parallel
aggregates. Constraints: per-dimension top-N and ordering must be preserved exactly, and the
existing SQL-fixture tests in `test/cmdExplorerQuery.test.ts` will need updating — update them
deliberately, do not delete assertions to make them pass. Verify the 5→1 collapse by call counts
in `pg_stat_statements` afterward, not by reading the code.

### Phase 4 — Index and vacuum hygiene (migration `0079`)

Drop only indexes you can independently confirm are near-dead per C5, and put every `DROP` in
the `0079` rollback as a `CREATE`. Set a more aggressive per-table autovacuum on
`collections.cmd_explorer_rows` (`autovacuum_vacuum_scale_factor` ~0.02) so the visibility map
stays warm and index-only scans stop doing 642k heap fetches. Leave the `cov_m` covering index
alone until Phase 3 lands — Phase 3 changes which indexes matter.

**Do not touch** `supabase/migrations/0067_*` (stale per CLAUDE.md), the hourly collections cron
routes/schedules, or `dropFuturePaymentRows` / `FUTURE_PAYMENT_HORIZON_DAYS`.

## Verification gate — all five, before any commit

```bash
npm test                      # expect 889 pass / 0 fail
npm run typecheck
cd app && npm test            # expect 176 pass / 0 fail
cd app && npm run typecheck
cd app && npm run build
```

Those counts are a tripwire: fewer than 889 / 176 means tests were lost — find out why before
committing. Root `tsc` is stricter than app `tsc`; run both.

## Rules for this task specifically

- Ship phases as **separate PRs against `staging`** (`gh pr create --base staging`), in order.
  Never against `main`.
- Every migration needs its paired `_rollback.sql`.
- Merging a migration does not apply it. Show me the plan and **HOLD** before `apply_migration`,
  and state explicitly which statements cannot run in a transaction.
- Measure, don't assert. For each phase, give me the before/after `mean_exec_time` and
  `shared_blks_read` for the affected `queryid`s. "Should be faster" is not a result.
- No `Co-Authored-By` trailer.
- After any push that deploys, confirm the next scheduled collections cron run logs success.

## Report back

A short table: phase, what changed, measured before → after (ms and buffer reads), and which of
C1–C5 remain open. If you conclude any part of my diagnosis above is wrong, say so with the
plan output that proves it rather than working around it.
