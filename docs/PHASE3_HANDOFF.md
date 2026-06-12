# Session Handoff — Phase 3, Step 1: `src/routes/results.ts` (PHI results route)

> Read `CLAUDE.md` in full first. Standing rules apply: PHI never in logs / LLM
> prompts / `summary_stats`; parameterized queries only; secrets from `.env`
> (`export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)`); `node:test` only,
> no new test-runner deps; `DROP POLICY IF EXISTS` before `CREATE POLICY`;
> `IF NOT EXISTS` on tables/indexes; never `DROP ROLE` (CREATE-if-absent +
> unconditional REVOKE/GRANT).

## Verified current state

- **Phase 1 ingest:** complete — 320,116 claims (2024–2026).
- **Phase 2 Step 1 (schema/RLS/plumbing):** complete — migrations `0003`/`0004`
  applied. `claims.claims`, `claims.claims_raw`, `claims.query_log` in the
  `claims` schema; `claims_reader` (SELECT on `claims.claims` only) and
  `claims_admin` roles; `claims.log_query` / `claims.get_query_log` SECURITY
  DEFINER functions.
- **Phase 2 Step 2 (query function library):** COMPLETE — all five functions
  built, gate-reviewed, and approved. **Full suite: 45 pass, 0 fail.
  `tsc --noEmit` clean.**

Run tests: `npm test` · Typecheck: `npm run typecheck`

### `claims.similarity` EXECUTE grant — RESOLVED (no action needed)

Probed live on **2026-06-11** as `claims_reader`:

```
\df claims.similarity        -> claims | similarity | real | text, text | func
SELECT claims.similarity('smith','smith');  -> 1
```

`claims_reader` can execute `claims.similarity(text,text)` — it inherited the
extension's default PUBLIC EXECUTE through the schema move. **Migration
`0005_grant_similarity_execute.sql` was NOT needed and was NOT written.** Phase 3
does not need to re-investigate this.

## The five query functions (all in `src/queries/`)

| Function | File | identity_hash | resultRowCount = |
|----------|------|---------------|------------------|
| `distribution` | `distribution.ts` | null | `buckets.length` |
| `payer_gap_analysis` | `payer_gap_analysis.ts` | null | `by_payer.length` |
| `search_claims` | `search_claims.ts` | null | `rows_matched` |
| `client_history` | `client_history.ts` | **SHA-256** | `rows_matched` |
| `readmission_candidates` | `readmission_candidates.ts` | null | `candidate_pairs` |

Each function: validates args → builds a parameterized query (fixed column names,
`$n` values only) → shapes a non-PHI `summary_stats` → routes through
`finalize()` (writes `query_log` via `claims.log_query`, emits one audit line) →
returns `{ summary_stats, query_id }`. `query_log.arguments` holds ONLY non-PHI
args and drives re-execution.

## Corrected SQL locked in this session

### `readmission_candidates` — pair orientation FIXED

The spec sketch's `a.id < b.id` dedup guard was **removed** (it silently dropped
any pair whose later-dated claim ingested first, because `claims.id` is
insertion-order identity and ingest is not date-sorted). The shipped self-join
orients strictly by service date with a self-pair guard:

```sql
with f as (select * from claims.claims [where <filter $2+>]),
pairs as (
  select case
    when a.member_id_norm is not null and a.member_id_norm <> ''
     and b.member_id_norm is not null and b.member_id_norm <> ''
     and a.member_id_norm = b.member_id_norm
     and lower(a.patient_last) = lower(b.patient_last)            then 'exact'
    when lower(a.patient_last) = lower(b.patient_last)
     and a.payer_name = b.payer_name
     and a.member_id_norm is not null and a.member_id_norm <> ''
     and b.member_id_norm is not null and b.member_id_norm <> ''
     and a.member_id_norm <> b.member_id_norm                     then 'strong'
    when claims.similarity(a.patient_last, b.patient_last) >= 0.7
     and a.payer_name = b.payer_name
     and (a.member_id_norm is null or a.member_id_norm = ''
          or b.member_id_norm is null or b.member_id_norm = '')   then 'possible'
  end as confidence, a.facility_name as facility_name, a.payer_name as payer_name
  from f a
  join f b on a.id <> b.id                       -- self-pair guard only
    and b.date_of_service > a.date_of_service     -- chronological orientation; excludes same-day
    and b.date_of_service <= a.date_of_service + ($1 * interval '1 day')
)
select confidence, facility_name, payer_name from pairs where confidence is not null
```

`$1` = `gap_days` (default 30, bounded [1,365]); filter values follow at `$2+`
inside the `f` CTE (so the filter constrains BOTH join sides). The CTE replaces
the sketch's invalid `HAVING confidence IS NOT NULL` (no `GROUP BY`).

### `client_history` — identity binding (critical for Phase 3)

```sql
select source_year, count(*) as claim_count,
  count(distinct facility_name) as distinct_facilities,
  count(distinct payer_name) as distinct_payers,
  coalesce(sum(charge_amount), 0) as total_charge,
  coalesce(sum(paid_amount), 0) as total_paid,
  avg(collection_rate) as avg_collection_rate,
  min(date_of_service)::text as date_from,
  max(date_of_service)::text as date_to
from claims.claims
where claims.similarity(patient_last, $1) >= $2   -- $2 = 0.4 (fixed)
  [and member_id_norm = $3]                        -- only when a member id is supplied
  [and <filter>]
group by source_year order by source_year
```

`patient_last` / `member_id_norm` are **bound parameters only** — never stored in
`query_log.arguments`, never in the audit line (presence flag `has_member_id`
only). The binding token is:

```
identity_hash = SHA-256( lower(patient_last) | normalizeMemberId(member) | query_id )
```

computed in-process by `src/queries/identity.ts` (`computeIdentityHash` +
`normalizeMemberId`). **The results route MUST import these same helpers** —
do not re-derive the formula.

## Task: `src/routes/results.ts`

The Phase 3 results route turns a `query_id` into the PHI result rows. Outline
(confirm shape with the user before building — this is a fresh gate):

1. Look the row up via `claims.get_query_log(p_id)` (returns non-PHI row, no
   `identity_hash`; already fail-closes on expiry and on a `client_history` row
   with NULL hash).
2. For `client_history`, the caller (authenticated UI) re-supplies the identity
   terms; recompute `identity_hash` with the stored `query_id` via
   `identity.ts` and verify it matches the stored value **before** running
   anything. The stored hash never leaves the DB except through this recompute
   comparison — design how the route obtains it (e.g. a dedicated verify
   function) without widening `get_query_log`.
3. Re-execute the ORIGINAL parameterized query from `query_log.arguments`
   (+ re-supplied identity terms for `client_history`) to produce PHI rows.
   **PHI is never cached at rest** — re-run, don't store.
4. Return the PHI rows over an authenticated route only. Never log PHI; never
   feed PHI to an LLM.

Open design questions for the user:
- Which query function's full row projection each route returns (the functions
  currently return aggregates; the results route needs the row-level SELECTs —
  decide column lists per function, still no patient data to the agent path).
- Transport/auth for the route (this repo is currently scripts + a query lib; no
  HTTP server yet).
- `summary_stats` allowlist enforcement at the route boundary (defense in depth).

## Do not regress

- PHI never in `query_log`, logs, or `summary_stats`. The type-level `NoPhi<S>` +
  `finalize()` chokepoint guarantee this for the query functions; keep the same
  discipline in the route.
- `identity.ts` is the single source of truth for the hash — reuse, never copy.
- Supavisor transaction pooler: `pool.query(sql, params)`, no named prepared
  statements.
