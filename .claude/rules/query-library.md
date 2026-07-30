---
paths:
  - "src/queries/**"
  - "src/agent/**"
  - "src/routes/**"
---

# Query library, agent, and the PHI boundary

The two-shape split is the core invariant of this system. Every query function
returns a non-PHI `summary_stats` object (the agent may see it) plus an opaque
`query_id`. PHI rows live **only** behind the results route, which re-runs the
parameterized query from `query_log.arguments` on each fetch — PHI is never
cached at rest — and projects only allowlisted columns.

```
NL question -> agent (Anthropic tool-calling) -> ONE query fn   runs as
                    | sees summary_stats + query_id only        claims_reader
                    v
               query_log (non-PHI args, drives re-execution)
                    |
UI --(query_id [+ re-supplied identity])--> results route --> PHI rows
     (Server Action, server-side)           re-executes        (allowlisted cols)
```

## Type-level enforcement — don't route around it

- Every function returns `QueryResult<NoPhi<S>>`. `NoPhi<T>` collapses to `never`
  if a `PhiKey` appears in a summary; `Expect<HasNoPhiKey<S>>` asserts it at
  build time. If you find yourself widening these types, stop — that is the
  chokepoint doing its job.
- Every function routes through `finalize()` (`runtime.ts`), the single point
  that writes `query_log` (via SECURITY DEFINER `claims.log_query`) and emits
  exactly one non-PHI audit line. **No function returns without logging.**
- `identity.ts` is the single source of truth for the `client_history` identity
  hash. Reuse `computeIdentityHash` / `normalizeMemberId`; never re-derive the
  formula.
- `columns.ts` holds per-function PHI column allowlists; `getColumns()` throws on
  an unknown name. Add a column there, not inline in a query.

## The five functions

`distribution` · `payer_gap_analysis` · `search_claims` · `client_history` ·
`readmission_candidates`, plus `browse_claims` (Explorer keyset paging),
`dashboard_aggregates` (reads the 0009 matviews), and `code_intel`.

`client_history` is the only one with PHI **inputs**. Patient last name +
member id are passed as bound params only: never stored in `query_log`, never
echoed into the model transcript, never logged. The binding token is
`identity_hash = SHA-256(lower(patient_last) | normalizeMemberId(member) |
query_id)`. The results route requires the caller to **re-supply** the identity
terms and verifies them server-side (`claims.verify_identity`) before serving a
row; wrong or absent identity fails closed to empty.

## Locked semantics — changing these is a stop-and-ask

- `rate_anomaly_count` counts rows where `paid_amount` and `allowed_amount` are
  both non-null but `collection_rate` is NULL. This covers BOTH `allowed<=0`
  reversals AND representability overflow. Deliberately not narrowed.
- `collection_rate IS NULL` with both amounts present is a **signal**, not
  missing data — it is exactly the payer/policy gap this system surfaces.
- `readmission_candidates` orients pairs strictly by `b.date_of_service >
  a.date_of_service`, with `a.id <> b.id` as the only self-pair guard. The
  `a.id < b.id` dedup guard was removed on purpose: `claims.id` is insertion
  order and ingest is not date-sorted, so it silently dropped pairs whose
  later-dated claim ingested first.
- `summary_stats` allowlist — the fields the agent may ever see: `facility_name`,
  `payer_name`, `hcpcs_code`, `revenue_code`, `source_year`, `date_of_service`
  (as ranges/buckets), and aggregates. **Never** `patient_name`/`patient_first`/
  `patient_last`, `member_id_*`, `group_number`, `employer_name`.

## Agent

`runAgentTurn` maps a question to ONE function: five tool defs mirroring the
arg types, `tool_choice: any`, parallel tool use disabled. The model never
writes SQL. Untrusted tool input is re-validated at the dispatch boundary
(`validators.ts`) before the function runs. The tool result handed back to the
model is built from the post-`finalize()` return — `{ summary_stats, query_id }`
only, non-PHI by construction.

The `AnthropicMessagesClient` seam (`client.ts`) is faked in tests and satisfied
in production by `anthropicClient.ts`. Keep it that way — no live LLM in the suite.

## Routes

Handlers here are transport-agnostic and composed in `app/lib/server.ts` (the
composition root). Browser traffic does not hit them directly.

- `/api/results` is **POST, not GET**, so `query_id` and identity terms never
  ride a URL. Non-allowed verbs return 405 with `Allow`.
- Errors to clients are generic (`agent_failed`, `results_failed`). Never echo
  the underlying error — it can name a tool or a column.
- Missing/expired handle → `function_name: null`, `rows: []`. Fail closed.
- `/api/revalidate` uses a closed tag allowlist (only `dashboard-aggregates`);
  any other tag → 400. Constant-time Bearer compare, no DB, no PHI.

## Known open issue

`readmission_candidates` on the full population times out (>90s → 500), even
date-scoped to a quarter. The quick-question button is intentionally omitted.
A real fix is query-layer work and is stop-and-ask gated.
