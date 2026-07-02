# CLAUDE.md — CMD Billing Dashboard

Persistent context for Claude Code. **Read this file in full before writing any
code.** It is the single source of truth for this project; the per-phase handoff
docs have been consolidated here.

---

## 1. What this project is

An internal, PHI-aware web application over three years of out-of-network
behavioral-health billing data (BXR / Treat Health / CMD). It has two pillars:

1. **A natural-language claims search agent.** A user asks a question in plain
   English ("show payer gaps for Beacon Carelon", "claim history for Smith"); an
   Anthropic tool-calling agent maps it to ONE of a small set of **vetted,
   parameterized query functions** and renders the result. The agent never writes
   SQL and never sees patient rows.
2. **A non-PHI analytics dashboard.** Deterministic, aggregate-only views over
   claims and collections (payer overview, distributions, daily/monthly
   collections, charts), plus a paginated Claims Explorer with audited per-row
   PHI reveal, and a static behavioral-health code reference.

**This entire dataset is PHI** (patient names, member IDs, payers, claim
amounts). The compliance layer is ON for the whole project (SOC 2 / HIPAA /
OWASP). The PHI-boundary rules in §2 are non-negotiable invariants, not
preferences.

**Live data scale:** 320,116 claims (2024–2026) in `claims.claims`; collections
domain ~58k raw rows (see §7). Deployed to Vercel at
`https://cmd-billing-dashboard.vercel.app` (Vercel project `cmd-billing-dashboard`,
team `bloomhouse-marketings-projects`, app root linked at `app/`).

---

## 2. Standing rules — DO NOT REGRESS

These hold across every phase and every change:

- **PHI never** appears in logs, LLM prompts/transcripts, `summary_stats`, any
  URL/query string, browser storage (`localStorage`/cookies), or `query_log`.
- **The agent sees only `summary_stats` + `query_id`** — never raw SQL, never
  rows. PHI rows are fetched by the UI (not the agent) via the results path.
- **Parameterized queries only.** Column/table names are fixed string literals;
  only values are `$n` bound params. Never `SELECT *` — project explicit
  allowlisted columns.
- **All query/agent DB access runs as `claims_reader`** (least privilege, SELECT
  on typed tables only) — never the service-role key, never `claims_admin`. The
  service-role key and `claims_admin` are ingest-path only.
- **`identity.ts` is the single source of truth** for the `client_history`
  identity hash — reuse `computeIdentityHash` / `normalizeMemberId`, never copy
  the formula.
- **Verify-full TLS stays on** (`src/ssl.ts`). Never reintroduce
  `rejectUnauthorized: false`. The pool verifies the certificate chain AND the
  hostname (proof against active MITM, not merely encrypted).
- **Secrets from env only** (never hardcoded, never logged). Server secrets
  (`RESULTS_API_SECRET`, `REVALIDATE_SECRET`, DB URLs, `ANTHROPIC_API_KEY`)
  **never reach the browser** — no `NEXT_PUBLIC_*`, no client fetch holding a
  token. The browser uses **Next Server Actions only** as its data path.
- **Migrations are idempotent:** `IF NOT EXISTS` on tables/indexes; `DROP POLICY
  IF EXISTS` before `CREATE POLICY` (SQLSTATE 42710 otherwise); never `DROP ROLE`
  (CREATE-if-absent + unconditional REVOKE/GRANT).
- **Supavisor transaction pooler (port 6543) forbids named prepared statements** —
  use `pool.query(sql, params)` only.
- **Tests stay hermetic** — `node:test` only, no new test-runner deps, no live
  LLM/DB in `npm test`. `src/liveProbe.ts` is the separate, manually-run live
  probe.
- **Never add a `Co-Authored-By` trailer** to commits or PRs.
- **Gate outward-facing actions.** Show results and HOLD before live migrations,
  commits, pushes, or deploys. Don't add or alter SQL query tools without asking.

---

## 3. Tech stack & repo layout

**Stack:** Node ≥20, TypeScript (ESM), `tsx` runner. Supabase Postgres via
`node-postgres` (`pg`). Anthropic SDK (`@anthropic-ai/sdk`, default model
`claude-opus-4-8`, override via `ANTHROPIC_MODEL`). Next.js 15 App Router (React
18, Tailwind, shadcn/ui, recharts) deployed on Vercel. `zod` for validation.

This is a **monorepo-style two-package** repo: the root package is the
ingest + query/agent/results library (`src/`); the `app/` package is the Next.js
transport + UI, which imports the library from `../src`.

```
src/                     Root library (ingest + query/agent/results)
  ingest.ts, sheets.ts, normalize.ts, types.ts, report.ts   claims ingest
  probe.ts, diagnose.ts, dbcheck.ts, liveProbe.ts           dev/ops scripts
  db.ts, ssl.ts, config.ts, auth.ts, bearerAuth.ts          infra
  cacheTags.ts, revalidateClient.ts                         cache invalidation
  queries/               the vetted query function library (see §8)
  agent/                 the Anthropic tool-calling agent (see §9)
  routes/                transport-agnostic handlers (see §10)
  collections/           collections domain ingest + readers (see §7)
supabase/migrations/     0001–0011 (claims, RLS, collections, matviews, VOB)
certs/supabase-ca.crt    public Supabase Root CA (verify-full TLS; not a secret)
secrets/                 gitignored: OAuth client/token for Google Sheets
reports/                 gitignored: failed-coercion / skipped-tab reports (PHI)
test/                    node:test fixtures (hermetic — no live LLM/DB)
docs/                    this file + design-system.md
app/                     Next.js 15 App Router app (see §11)
```

---

## 4. Architecture & the PHI boundary

```
Google Sheets ──ingest──> claims_raw (verbatim) ──transform──> claims (typed)
                                                                   │
NL question ─> agent (Anthropic tool-calling) ─> ONE query fn ─────┤ runs as
                       │ sees summary_stats + query_id only         claims_reader
                       ▼                                            │
                  query_log (non-PHI args, drives re-execution)     │
                                                                    ▼
UI ──(query_id [+ re-supplied identity])──> results route ──> PHI rows
        (Server Action, server-side)         re-executes query     (allowlisted
                                             from query_log         columns, never
                                             never caches PHI)      cached at rest)
```

**Two-shape split (the core invariant):** every query function returns a non-PHI
`summary_stats` object (the agent may see it) plus an opaque `query_id`. PHI rows
live only behind the results route, which **re-runs** the parameterized query
from `query_log.arguments` on each fetch (PHI is never cached at rest) and
projects only allowlisted columns.

**`client_history` is special:** its inputs (patient last name + member id) are
PHI. They are passed only as bound query params, never stored in `query_log`,
never echoed into the model transcript, never logged. The binding token is
`identity_hash = SHA-256(lower(patient_last) | normalizeMemberId(member) |
query_id)`, computed in-process by `src/queries/identity.ts`. The results route
requires the caller to **re-supply** the identity terms and verifies them
server-side (`claims.verify_identity`) before serving any row; wrong/absent
identity fails closed to empty.

---

## 5. Environment, secrets & running

Load `.env` on macOS/zsh before running scripts:
`export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)`. See `.env.example`
for the full annotated list. Key vars:

| Var | Used by | Purpose |
|-----|---------|---------|
| `CLAIMS_READER_DATABASE_URL` | query/agent/results path | least-privilege reader role (Supavisor txn pooler, port 6543) |
| `CLAIMS_ADMIN_DATABASE_URL` | ingest only | admin role for load + matview refresh |
| `ANTHROPIC_API_KEY` | agent | LLM client (env only) |
| `ANTHROPIC_MODEL` | agent | optional; defaults to `claude-opus-4-8` |
| `RESULTS_API_SECRET` | both API routes + collections routes | shared Bearer secret; **server-only** |
| `REVALIDATE_SECRET` | `/api/revalidate` + ingest | authorizes cache invalidation; distinct from `RESULTS_API_SECRET` |
| `REVALIDATE_URL` | ingest host only | deployed `…/api/revalidate` URL the ingest POSTs to |
| `SUPABASE_CA_PEM` | TLS | public Supabase Root CA; `src/ssl.ts` reads it first, falls back to committed `certs/supabase-ca.crt` |
| `SUPABASE_SERVICE_ROLE_KEY` | in-app user **invites** (server-only) + other tooling | bypasses RLS (god key); used ONLY by the `inviteUser` Server Action via `app/lib/supabase/admin.ts`; **server-side only, never `NEXT_PUBLIC_*`, never browser**. Must be set in the Vercel app env for prod invites. |

- **Google Sheets auth** is OAuth installed-app (org policy forbids
  service-account keys): OAuth client at `secrets/oauth-client.json`; first
  `npm run probe`/`ingest` does a one-time browser consent writing
  `secrets/token.json`. Both gitignored.
- **Local app dev** MUST export the CA first:
  `export SUPABASE_CA_PEM="$(cat certs/supabase-ca.crt)"` then
  `cd app && npm install && npm run dev`. The app reads the repo-root `.env`.

**Commands:**

```bash
# root library
npm run ingest      # load 3 Google Sheets -> claims_raw + claims (idempotent)
npm run dbcheck     # DB smoke (counts only)
npm run probe       # one-off sheet/auth probe
npm test            # hermetic node:test suite (239 pass, 0 fail)
npm run typecheck   # tsc --noEmit (clean)

# app
cd app && npm run dev        # http://localhost:3000
cd app && npm run typecheck  # clean
cd app && npm run build      # succeeds
```

---

## 6. Claims data — sources, schema, normalization

### Data sources (canonical)
The **"Copy of"** set inside Drive folder **"Reports for Alec AI"**
(`1pXsb22qF9Jx8osxSnyyWt40fnNu5FxGc`). There is a second, near-identical
"Historical Data for…" set in another folder — **do NOT use it**; if the IDs
below don't resolve, stop and ask.

| Year | Sheet ID |
|------|----------|
| 2024 | `1BE3d6lzaopaWNQXUUrP1_yLs21uwYG2LNQBDjqzK2Ic` |
| 2025 | `1FMXHl4b57IPp2jlMsatmkfZHYmq-HfVBQXJrzWjtlOg` |
| 2026 | `1GQrOoQUhf5JgWrjnHXl-iJ28ZZzrM-9CEt-X7UiC8pc` |

Data is in `Sheet1`, row 1 = header.

### Why not CSV (correctness requirement)
`Patient Name` is always `LAST, FIRST` (embedded comma every row) and
`Employer Name` sometimes contains a comma (`THE VANGUARD GROUP, INC.`), and the
export is **not reliably quoted**. Splitting on commas misaligns columns. Read
cells as structured values through the Sheets API — never CSV.

### Column map (per-year — 2024 differs)
2024's first column header is `Office Name`; 2025/2026 use `Facility Name`. Map by
position + per-year header to the canonical `facility_name`. Other columns are
positionally identical. Notable: `hcpcs_code`/`revenue_code` nullable (blank in
some 2024 rows); `member_id` mixed numeric/alphanumeric (`PGE081`) and **can be
negative in 2024** (`-11724767`); money fields can be negative (`-$1,660.05`);
dates are mixed `M/D/YYYY` and `MM/DD/YYYY`.

### Normalization
- **Money:** strip `$`/`,`, preserve leading `-`, parse to `numeric(12,2)`; blank → NULL.
- **Dates:** accept both formats, store real `date` (never string-compare).
- **Codes:** blank → NULL (not empty string).
- **Patient name:** keep verbatim; also split into `patient_last`/`patient_first`
  on the first comma.
- **Member ID:** store `member_id_raw`; also `member_id_norm` = trimmed,
  upper-cased, leading `-` removed (abs value for matching). Blank → NULL in both.
- Any cell failing coercion → row written to the **failed-coercion report**
  `{source_file_id, source_row_num, column, raw_value, reason}` and skipped from
  `claims` (it still lands in `claims_raw`) — **never silently dropped**.

### Schema (claims schema)
`claims.claims_raw` (verbatim jsonb landing, `unique(source_file_id,
source_row_num)`) and `claims.claims` (typed). `claims.claims` has a stored
generated `collection_rate = paid_amount / allowed_amount` (NULL when
`allowed_amount` is null/0 or the rate isn't representable as `numeric(6,4)`).
Trigram GIN indexes on patient/facility/payer names; btree on `member_id_norm`,
`date_of_service`, `(facility_name, payer_name)`. Full DDL in
`supabase/migrations/0001`–`0002`.

**`collection_rate` NULL is a signal, not "missing"** — when `paid_amount` and
`allowed_amount` are both non-null but `collection_rate` is NULL, that's exactly
the payer/policy-gap anomaly this system surfaces (`rate_anomaly_count`).

### Idempotency
Identity is `(source_file_id, source_row_num)`. Re-running ingest inserts zero new
rows. Heavy row duplication in the source (e.g. 90853 group therapy billed
identically day after day) is **legitimate billing** — never dedupe on business
columns.

---

## 7. Collections domain (Phase 6+)

A separate `collections` Postgres schema alongside `claims`, for the CMD
collections domain. Migrations `0006`–`0022`; ingest under `src/collections/`.

| Table | Role | Live count |
|-------|------|-----------:|
| `collections_raw` | verbatim landing — **PHI-bearing, admin-only** | 58,190 |
| `daily_collections` | typed per-day collections (`source_tag`: legacy `workbook`, and **`cmd`** — the live CMD-sourced deposit series) | — |
| `payment_lines` | typed payment line items | 56,176 |
| `negotiation_worklist` | typed negotiation worklist | 16 |
| `rollup_snapshots` | typed rollup snapshots | 714 |
| `facilities` | facility reference | 15 |

- **`collections_raw` is PHI-bearing and admin-only** — `claims_reader` has NO
  SELECT on it. The reader gets SELECT on the five typed tables + `facilities`
  only. Read-side features use the typed tables, never `collections_raw`.
- **Lineage rule (locked):** `TREAT_FRCA` and `LSMH_DMH` are `source_group_code`
  **lineage only** — NEVER a `facility_code` (0 group-code leaks, 0 FK orphans).
- **Deferred:** archived/historical collections data is not yet ingested.

Read APIs (`src/collections/summary.ts`, `daily.ts`, `collectionsYoy.ts`; handlers in
`src/routes/`) serve non-PHI monthly/daily aggregates as `claims_reader`, never reading
`collections_raw` and never exposing `source_group_code`. **`collectionsYoy.ts`** (the
overview YTD/forecast YoY trend) reads ONLY `payment_lines` — the only multi-year
collections series, since `daily_collections_resolved` is 2026-only — projecting only
`sum(insurance_paid)` windowed on `payment_date`. The **`cmd_explorer_rows`** grid reader
(`app/lib/server.ts`: `buildCmdExplorerQuery`/`loadCmdExplorerPage`) supports optional
**server-side Facility + Month filters** (parameterized, keyset paging preserved, non-PHI
projection unchanged; PHI columns surface only via the audited per-row reveal).

### CMD-sourced collections pipeline (the live source for BOTH surfaces)
The **Collections Explorer** (`collections.cmd_explorer_rows`, charge-line detail) and the
**Master BXR chart's "By Facility" deposit series** (`daily_collections`, `source_tag='cmd'`)
are both fed from ONE daily Vercel cron (`/api/cron/cmd-explorer`, `0 6 * * *`). The CMD Web API
scopes data by **customer** (one customer == one facility), so the cron loops the 15 active
facility accounts in `src/collections/cmdCustomers.ts`, running report **`10091971`** / filter
**`10147499`** (14 explorer columns **+ `Check Payment` + `EFT Payment` + `Charge Patient Payments`**)
windowed on **Payment Received date** 1/1/2026→6/30/2027 once per customer (`cmdExplorerConfigFor(customerId)`).
The filter MUST window on payment-received (not charge date): a charge-date filter (the earlier
10147430) drops 2026 payments on pre-2026 charges, undercounting collections by ~$6.9M. Patient
payments are $0 in 2026 (none yet). The
`CMD_CUSTOMER_ID` default (`10027973` = CA Mental Health) is the per-customer override target;
filter/report/poll are tunable via `CMD_EXPLORER_*` env. Per customer the cron (`cmdExplorerCron`,
transport-agnostic; composed in `app/lib/server.ts`):
- maps + encrypts charge lines → `cmd_explorer_rows` (append-only `ON CONFLICT (row_fingerprint)`);
- aggregates Check+EFT by payment-received date → `daily_collections` via `replaceCmdDailyForFacility`
  (per-facility `DELETE source_tag='cmd' + INSERT`, so a partial run never wipes other facilities).
It runs SEQUENTIALLY (CMD = one report at a time per partner) with a wall-clock guard; unfinished
facilities catch up next run (idempotent). `maxDuration=300` (needs Vercel Pro+). Writes as the
least-privilege `cmd_rollup_writer` (migration **0021** = explorer SELECT/RLS; **0022** = daily
SELECT/INSERT/DELETE + RLS, nullable `collections_raw_id`, `source_tag='cmd'`). Backfill / timing
check: `npm run ingest:cmd-daily [-- --commit]`. The Master BXR chart UI + readers
(`daily_collections_resolved`, max-gross-wins) are **unchanged** — only the writer changed.

**⚠️ TENANCY GUARDRAIL — the collections cron is BXR-ONLY; do NOT ingest Indigo here yet.** The
`collections.*` dashboard tables (`cmd_explorer_rows`, `daily_collections`, `cmd_payer_facility_monthly`)
are **single-tenant**: they carry NO `business_entity_id` column, the readers do NOT filter by entity,
and `viewToEntityIds()` (`app/lib/views.ts`) is carried but **not consumed**. Migration **0027** adds only
a *registry* (`collections.business_entities` + BXR/Indigo seed), NOT per-row columns. So the cron loops
`CMD_EXPLORER_CUSTOMERS` = **`BXR_CUSTOMERS` (15) ONLY** — `ALL_CMD_CUSTOMERS` (BXR + 36 Indigo) exists in
`cmdCustomers.ts` for the staging/835 pipeline but **must NOT** be wired into this cron. **Do not** point
the explorer/deposit ingest at Indigo (don't swap the roster to `ALL_CMD_CUSTOMERS`, don't backfill Indigo
deposits) until per-row tenancy lands: (1) a `business_entity_id` column on the three tables + existing
rows backfilled → BXR + folded into `row_fingerprint`; (2) tenant-scoped RLS + the writer setting the
`app.business_entity_id` GUC; (3) EVERY collections reader filtering by the clamped view's entity ids.
Until all three ship, Indigo rows would commingle with BXR in shared tables with no way to separate them —
on the Collections tab, All Facilities table, and Master chart, regardless of `?view=`. Follow-up:
**collections per-row tenancy (migration 0028)** — see §15.

**REMOVED:** the deposit Google-Sheet ingest (`depositSheet*.ts`, `DEPOSIT_SHEET_ID`,
`replaceDepositSheetDaily`, `ingest:deposit`, `source_tag='deposit_sheet'` rows).

**The CMD cron is the authoritative live source of truth going forward.** It is the ONLY scheduled
writer (the single entry in `app/vercel.json` `crons`). The legacy `workbook` ingest
(`src/collections/ingest.ts` → `payment_lines`/`negotiation_worklist`/`rollup_snapshots` +
`source_tag='workbook'` dailies, sourced from Google-Sheet workbooks) is a **frozen** manual CLI:
unscheduled, not aliased in `package.json`, DRY-RUN unless `--commit`. It cannot write on its own, so
every future date is pure CMD. Its existing 2026 daily rows (~$20.85M, spanning the same
1/2→6/30 window) are **intentionally retained** — on 59 facility/days workbook's gross exceeds CMD's,
so the resolved view's max-gross precedence puts the chart at ~$26.97M vs ~$26.75M pure-CMD (a
deliberate "leave historical as-is" call, 2026-06-29). `daily_collections_resolved` (max-gross-wins)
is **unchanged**. ⚠️ Do NOT re-run the `workbook` ingest for any period CMD covers — that would let a
stale legacy import override the authoritative CMD figures; treat it as a historical backfill tool only.

---

## 8. The query function library (`src/queries/`)

PHI boundary is enforced **in the type system**: every function returns
`QueryResult<NoPhi<S>>`; `NoPhi<T>` collapses to `never` if a `PhiKey` appears in
a summary, and `Expect<HasNoPhiKey<S>>` asserts it at build time. Every function
routes through `finalize()` — the single chokepoint that writes `query_log` (via
the SECURITY DEFINER `claims.log_query`) and emits exactly one non-PHI audit line;
no function returns without logging.

| Function | Groups by | identity_hash | Notes |
|----------|-----------|---------------|-------|
| `distribution` | one allowlisted field | null | metric per bucket + `pct_of_total` |
| `payer_gap_analysis` | payer | null | write-down vs collection-gap lenses |
| `search_claims` | flat aggregate | null | `rate_anomaly_count`; HCPCS/revenue filters |
| `client_history` | source_year | **SHA-256** | PHI INPUT; terms never stored/logged; threshold 0.4 fixed |
| `readmission_candidates` | confidence tiers | null | self-join; `gap_days` [1,365]; exact/strong/possible |
| `browse_claims` | keyset page | null | Claims Explorer pagination (non-PHI list columns) |
| `dashboard_aggregates` | — | null | reads the pre-aggregated matviews (0009) |

Shared infra: `types.ts` (PHI types + per-summary compile-time assertions),
`filters.ts` (`ClaimFilter` validate + parameterized WHERE), `runtime.ts`
(`finalize`), `executor.ts` (`claims_reader` pool), `identity.ts` (hash — the
single source of truth), `columns.ts` (per-function PHI column allowlists;
`getColumns()` throws on unknown names), `index.ts` (public surface). Every
function has a fixture file using a fake executor (no live DB in tests).

**Locked semantics:**
- `rate_anomaly_count` counts rows where `paid_amount` and `allowed_amount` are
  both non-null but `collection_rate` is NULL — covers BOTH `allowed<=0` reversals
  AND representability overflow. Deliberately NOT narrowed to overflow-only.
- `readmission_candidates` orients pairs strictly by `b.date_of_service >
  a.date_of_service` with `a.id <> b.id` as the only self-pair guard. The
  `a.id < b.id` dedup guard was REMOVED — `claims.id` is insertion order, ingest
  is not date-sorted, so it silently dropped pairs whose later-dated claim
  ingested first.

**`summary_stats` allowlist** (fields the agent may ever see): `facility_name`,
`payer_name`, `hcpcs_code`, `revenue_code`, `source_year`, `date_of_service` (as
ranges/buckets), and aggregates (counts/sums/avg/min/max/`collection_rate`).
NEVER `patient_name`/`patient_first`/`patient_last`, `member_id_*`,
`group_number`, `employer_name`.

### Column allowlists (results route projections)
- `distribution` / `payer_gap_analysis` (no identity): `id, facility_name,
  payer_name, source_year, date_of_service, hcpcs_code, revenue_code,
  charge_amount, allowed_amount, paid_amount, adjustment, balance_due_pt,
  collection_rate`.
- `search_claims` (**PHI**): above **plus** `patient_name, patient_last,
  patient_first, member_id_raw, member_id_norm`.
- `client_history` (**PHI**): adds `group_number, employer_name` too.
- `readmission_candidates` (**PHI, paired**): allowlist columns appear twice,
  prefixed `a_`/`b_`, plus computed `confidence, gap_days, a_id, b_id` (no bare
  unprefixed `id`).

### Postgres roles & SECURITY DEFINER plumbing (migrations 0003–0005)
- Tables live in the `claims` schema; `pg_trgm` moved into `claims` (reader needs
  `similarity()`/`%`); `claims_reader`'s `search_path = claims`.
- Two least-privilege LOGIN roles: `claims_reader` (SELECT on `claims.claims`
  only, + typed collections tables + matviews) and `claims_admin` (full schema,
  ingest path). Passwords out of band (`.env`), never in migrations.
- `claims.log_query` / `claims.get_query_log` / `claims.verify_identity` —
  SECURITY DEFINER, owner `claims_admin`, EXECUTE granted to `claims_reader`.
  `get_query_log` excludes `identity_hash` and fail-closes on expiry / NULL hash.

---

## 9. The search agent (`src/agent/`)

`runAgentTurn` maps a natural-language question to ONE query function via
Anthropic tool-calling:
- Five tool defs mirror the function args types (`tools.ts`); `tool_choice: any`,
  parallel disabled — single tool per turn. The model never writes SQL.
- Untrusted tool input is validated at the dispatch boundary (`validators.ts`,
  reusing the per-function validators) before the function runs as
  `claims_reader`. The tool result handed back to the model is built from the
  post-`finalize()` return — `{ summary_stats, query_id }` only, non-PHI by
  construction. `client_history` identity is never reflected back or logged.
- A narrow `AnthropicMessagesClient` seam (`client.ts`) is faked in tests and
  satisfied in production by `anthropicClient.ts` (`new Anthropic()` from
  `ANTHROPIC_API_KEY`).

---

## 10. API routes & contracts

All under `app/app/api/`. Transport-agnostic handlers live in `src/routes/` and
are composed in `app/lib/server.ts` (the **composition root**: builds the
`claims_reader` executor, the Anthropic client, reads the secrets). Browser
traffic does NOT hit these directly — it goes through Server Actions
(`app/lib/actions.ts`) which call the composition root in-process.

| Route | Method | Auth | Returns |
|-------|--------|------|---------|
| `/api/agent` | POST | Bearer `RESULTS_API_SECRET` | `{ tool_name, query_id, summary_stats }` — **no PHI** |
| `/api/results` | POST | Bearer | `{ rows, function_name, query_id }` — **PHI** (allowlisted cols) |
| `/api/collections/summary` | GET | Bearer | non-PHI monthly collections summary |
| `/api/collections/daily` | GET | Bearer | non-PHI daily collections |
| `/api/collections/kpis` | GET | Bearer | non-PHI collections KPIs |
| `/api/revalidate` | POST | Bearer `REVALIDATE_SECRET` | drops `dashboard-aggregates` cache tag |

- **Results is POST, not GET**, so `query_id` and identity terms never ride a URL.
  Non-allowed verbs → 405 with `Allow`. Errors are generic (`agent_failed`,
  `results_failed`) — never echo the underlying error (could name a tool/column).
- `/api/results` body: `{ query_id, identity?: { patient_last, member_id_norm? },
  created_by? }`. `identity` is **required for `client_history`** (re-verified
  server-side; wrong/absent → `rows: []`), ignored otherwise. Missing/expired
  handle → `function_name: null`, `rows: []` (fail-closed).
- Optional `x-created-by` header sets the audit principal (default
  `agent-api`/`results-api`).
- **`/api/revalidate`** (Phase 8.2): POST-only, constant-time Bearer, closed tag
  allowlist (only `dashboard-aggregates`; any other → 400), no PHI/DB. After a
  daily ingest + matview refresh, `src/ingest.ts` calls
  `notifyDashboardRevalidate()` (`src/revalidateClient.ts`) — env-gated (no-op
  unless both `REVALIDATE_URL` + `REVALIDATE_SECRET` set) and non-fatal. The
  dashboard readers also carry a 15-minute `unstable_cache` `revalidate` fallback,
  so a failed revalidate just delays freshness; it never breaks the pipeline.

---

## 11. The Next.js app (`app/`)

Next.js 15 App Router (TS, Tailwind, shadcn/ui, recharts), Vercel-targeted, app
root linked at `app/` (install bundles the repo root via `app/vercel.json` so
`../src` and `../certs` ship). **The browser's only data path is Server Actions**
(`app/lib/actions.ts`, `'use server'`) → composition root (`app/lib/server.ts`)
in-process. `RESULTS_API_SECRET` never reaches the client.

**Surfaces (top nav: Dashboard · Claims · Code Reference · Ask):**
- **`/dashboard`** — non-PHI aggregate overview with a dashboard **"view"** selector
  (Consolidated / BXR Consulting / Indigo Billing) in the global top bar. **Two tabs**
  (`app/components/dashboard-nav.tsx`): **Overview** and **Collections** (the former
  standalone "Collections Explorer" sub-route `/dashboard/collections/explorer` now
  redirects into Collections).
  - **Overview**: a row of KPI tiles — MTD Gross (MoM trend), YTD Gross split
    **IP / OP / IP+OP** (YoY trend), and **Year Forecast** (linear YTD run-rate,
    recomputed live) — plus an **All Facilities** table (all rows; Month + IP/OP
    filters), above the **Master chart** (one bar chart: By Facility / By Payer +
    Month dropdown + per-facility/payer drill-down).
  - **Collections**: a unified surface (`collections-view.tsx`) with a view dropdown —
    **Payment Type** (daily Checks/EFT/Gross by facility, from
    `daily_collections_resolved`) and **All Collections** (CMD charge-line detail from
    `cmd_explorer_rows`, PHI masked + audited per-row reveal, **server-side
    Facility/Month filters**). Columns reorder by **dragging the table headers** (no
    separate "Columns" panel).
  - Built from per-surface modules in `app/components/dashboard/` (`overview`,
    `overview-kpis`, `overview-bar-chart`, `collections`, `collections-view`,
    `cmd-explorer`, `widgets`) over a shared widget shell + `data-grid.tsx`. Aggregate
    reads go through cached readers (matviews migration 0009, `daily_collections_resolved`,
    `cmd_explorer_rows`, and the `payment_lines` YoY reader).
- **Dashboard "view" scoping seam (`app/lib/views.ts`).** `resolveView(searchParams)`
  parses `?view=` (URL only — never browser storage; non-PHI; default `consolidated`);
  `viewToEntityIds(view)` is the ONE place the view→business_entity_id decision lives.
  **Today the dashboard tables carry no `business_entity_id` and no GUC scoping** (that
  lives only in the `staging.*` ML pipeline, §17), and there is **no separate Indigo
  UUID**, so all three views render BXR-or-stub data — the entity ids are carried but
  not yet consumed. The top-bar `view-switcher.tsx` (dashboard routes only) drives the
  param; `brand-theme.tsx` sets `<html data-view=…>` so per-view branding applies.
- **`/claims`** + **`/claims/[claimId]`** — Claims Explorer: keyset pagination,
  faceted dropdowns, drag-to-reorder/sortable/selectable columns (shared
  `data-grid.tsx`), and an **audited PHI-gated per-row reveal** on the detail
  route. Lists project non-PHI columns; reveal goes through the results path.
- **`/code-reference`** — Phase 9 static, client-only BH HCPCS/CPT + Revenue Code
  reference. No data access, no API, no PHI (cited sources: CMS, NUBC UB-04,
  Novitas, Ensora).
- **`/ask`** — transcript-style NL search console (the agent path) with a
  deterministic `needs_input` field-picker when a query is too broad, PHI masked
  by default with per-row reveal, `client_history` identity re-entry, and
  paginated row reveal.

**PHI rules in the UI (enforced in code):** PHI columns are listed in
`app/lib/phi.ts`; `ResultsTable` renders `••••••` by default and reveals only on
explicit per-row action; `IdentityForm` holds patient inputs in local component
state only (never lifted/persisted); nothing in the transcript is written to
`localStorage`/cookies. See `docs/design-system.md` for the TreatHealthOS visual
system (palette, typography, components, nav, PHI rules).

**Top bar & per-view branding.** The global top bar shows a user-initials avatar at the
far right (`app/components/user-menu.tsx`, click → email + Sign out) and, on dashboard
routes, the view switcher. On dashboard routes the bar + dashboard accents (KPI tiles,
nav, MiniBar, active states, gross/YTD tooltip emphasis) recolor per active view via
`--brand-bar/-ink/-accent/-soft` CSS variables — set by `brand-theme.tsx`
(`<html data-view=…>`) and defined in `globals.css`: **Consolidated** = TreatHealthOS
teal, **BXR** = deep navy + brass/gold, **Indigo** = indigo + violet. Off-dashboard
chrome stays teal; charts keep their functional multi-series colors.

**Access control (per-user login, invite-only + RBAC roles).** The PHI surface is
gated by real per-user Supabase Auth (email + password) — this supersedes Vercel
Deployment Protection as the primary gate. **Authentication** is **invite-only**:
the admin invites users from the Supabase dashboard (Authentication → Users →
Invite), **self-signup is disabled**, and there is no email allowlist.
**Authorization** is **role-based** (migration **0025**, `claims.app_user`): a
verified session is necessary but not sufficient — the user must also have a role
row, else they are *unprovisioned* (default-deny, friendly notice).
- **Roles (`app/lib/rbac.ts`, pure policy):** `super_admin` (all three views; may
  reveal PHI; may manage users), `admin` + entity `bxr`/`indigo` (that entity's
  view only; may reveal PHI; user-mgmt UI deferred), `user` + entity (that entity's
  view only; **NON-PHI only — cannot reveal patient identifiers**). The
  view→entitlement decision lives in `rbac.ts`; `app/lib/access.ts`
  (`dashboardAccess()`, React-`cache`d) resolves the principal (`requireExecutive`)
  + role row (`appUserFor` → `claims.app_user`, read as `claims_reader`) into
  allowed views + `canRevealPhi`/`canManageUsers`. Seed: `alec@treathealth.ai` =
  `super_admin` (bootstrap; idempotent in 0025). **Apply 0025 + seed BEFORE
  deploying enforcement** (lockout prevention).
- **Enforcement:** dashboard pages gate on `dashboardAccess()` and `clampView` the
  `?view=` to an allowed view (entity users redirect to their canonical `?view=` so
  URL/branding/data agree); the top-bar `view-switcher` lists only entitled views
  (hidden at ≤1). Every PHI reveal Server Action (claims `fetchRows`/`revealClaim`,
  CMD `revealCmdReportRow[s]`) gates on `canRevealPhi`; the Collections "Reveal all"
  control is hidden for `user` roles. Non-PHI surfaces (overview, browse, `/ask`
  summaries) stay open to all provisioned roles.
- **In-app user management (`/admin/users`, migration 0026).** Admins/super_admins
  provision/change/revoke roles from the UI (no SQL). Surfaced via the avatar menu
  ("Manage users", shown only when `canManageUsers`). Reads the auth roster through
  the **postgres-owned** SECURITY DEFINER `claims.list_app_users()` (projects ONLY
  id/email/confirmed — never password columns; no role gets a broad `auth.users`
  grant, **no service-role key on the app path**); writes go through the
  `claims_admin`-owned `claims.upsert_app_user` / `claims.delete_app_user`
  (data-integrity + **last-super-admin guard**), EXECUTE granted to `claims_reader`
  only. Authorization (caller role, **entity scope**, **no self-edit**) is enforced
  in `app/lib/admin-actions.ts`; every mutation writes a `claims.access_audit` row.
  A super_admin manages everyone/all entities; an entity admin manages only their
  own entity + unprovisioned users and may assign only `admin`/`user` in that entity.
- **In-app invites (super_admin only).** The Manage Users page has an "Invite by email"
  form (shown to super_admins) that creates the Supabase Auth account, emails the invite,
  and assigns the role in one step — via `inviteUser` (`admin-actions.ts`) using the
  service-role admin client (`app/lib/supabase/admin.ts`, **server-side only**). If the
  email already exists it falls back to assigning the role. This is the ONE place the
  service-role key is on the app path (a deliberate exception to the §5 "off the app path"
  rule, accepted 2026-06-30 for in-app invites); it never reaches the browser. Requires
  `SUPABASE_SERVICE_ROLE_KEY` in the Vercel app env; invite email delivery uses Supabase
  SMTP (custom SMTP recommended for external domains). Entity admins still provision only
  already-invited users.
- **Server gate:** `requireExecutive()` (`app/lib/executive.ts`, default-deny,
  closest to the data) validates the session via `auth.getUser()`; it underpins
  `dashboardAccess()` and the data Server Actions (`app/lib/actions.ts`). The
  Next middleware (`app/lib/supabase/middleware.ts`) refreshes the session and
  bounces unauthenticated requests on protected paths to `/login`. Both no-op
  until `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set
  (staged rollout). PHI/claims data still flows only through the least-privilege
  `claims_reader` node-postgres path — **never** Supabase PostgREST; the Supabase
  client is for AUTH only.
- **Routes/actions:** `/login` + `signIn`, `/forgot-password` +
  `requestPasswordReset`, `/set-password` + `setPassword` (used by invite
  acceptance, recovery, and self-service change), `/account` (own identity,
  audited), `signOut`. Email links (invite/recovery) land on **`/auth/confirm`**
  (token-hash `verifyOtp`, routes invite+recovery → `/set-password`);
  `/auth/callback` handles the PKCE `?code=` flow (OAuth/future).
- **Audit:** authorized access writes one durable row to `claims.access_audit`
  via `recordAccess()`, attributed to the real user (email + uid) — replacing the
  old fixed `phase5-*` principals.
- **History:** migration **0018** introduced an `auth_config.allowed_emails`
  allowlist + a "Before User Created" signup-gating hook; **0024** retires both
  (the invite-only model makes them redundant). Manual Supabase config (toggles,
  redirect URLs, email templates, SMTP) is documented in 0024's header.
- Vercel Deployment Protection is now optional defense-in-depth, not the gate;
  custom SMTP is recommended (the default sender is rate-limited and unreliable
  to external domains).

---

## 12. VOB AI foundation (migrations 0010–0011) — schema only

Migrations `0010_vob_ai_foundation.sql` and `0011_vob_function_revoke.sql` add
the schema foundation for a future VOB (verification-of-benefits) AI intelligence
layer: schemas `ref`, `vob`, `rag`, `audit`. **No application code consumes these
yet** — it is groundwork.

- **Access model is role-based** (`claims_reader`/`claims_admin`), NOT
  JWT/org-scoped; no Supabase Auth / PostgREST exposure (mirrors 0003–0009). All
  four schemas revoked from public/anon/authenticated/service_role.
- **PHI-at-rest obligations** (runtime, not DDL): `vob.benefit_checks.patient_hash`
  must be a 64-char lowercase SHA-256 hex (CHECK-enforced format);
  `rag.document_chunks.content` must be de-identified before chunking OR treated
  as PHI-at-rest; `notes`/`visit_limit_text`/`audit.ai_queries.user_prompt`/
  `audit.ai_answers.*` are PHI-at-rest, protected by role grants.
- 0011 revokes PUBLIC EXECUTE from the three VOB/RAG functions (defense-in-depth;
  Postgres auto-grants EXECUTE to PUBLIC on function creation).
- Apply 0009 before 0010.

---

## 13. Phase history (condensed)

| Phase | Status | What shipped |
|-------|--------|--------------|
| 1 | ✅ | Claims ingest — 320,116 claims (2024–2026); `claims_raw` + typed `claims`; failed-coercion report; idempotent. Migrations 0001–0002. |
| 2 | ✅ | Schema separation + RLS + least-privilege roles + SECURITY DEFINER plumbing (0003–0005); the vetted query function library behind the `NoPhi<S>` type chokepoint + `finalize()` audit gate. |
| 3 | ✅ | PHI results route (`src/routes/results.ts`): re-executes from `query_log`, column allowlists, `client_history` identity re-verify; verify-full TLS (`src/ssl.ts`). |
| 4 | ✅ | Anthropic tool-calling agent (`src/agent/`) + Next.js 15 transport (`app/`); `/api/agent` + `/api/results`; shared Bearer auth; Express dev harness retired. **Deployed to production** (Vercel), live smoke passed. |
| 5 / 5.2 | ✅ | Search UI (server-only BFF via Server Actions, PHI masking, identity re-entry) + quick-question buttons + default non-PHI dashboard. |
| 6 | ✅ | Collections schema + ingest (0006–0008); typed tables; admin-only `collections_raw`. |
| 7.x | ✅ | Collections summary/daily/KPI APIs + dashboard; TreatHealthOS design system; dashboard subroutes; Claims Explorer foundation + keyset pagination + claim detail; `/ask` transcript with field-picker; materialized aggregates (0009); payer chart; collections/payers explorers. |
| 8.0–8.2 | ✅ | Audited PHI-gated claim detail reveal; faceted dropdowns + column controls for Claims Explorer; authenticated post-ingest cache revalidation (`/api/revalidate`). |
| 9 | ✅ | Static BH code reference page. |
| 10 | ✅ | Dashboard "views" (Consolidated/BXR/Indigo) via top-bar `?view=` switcher + `app/lib/views.ts` seam (`8aa0ba1`); overview KPI tiles (MTD/YTD gross + IP/OP split, MoM/YoY, linear-run-rate forecast) + `payment_lines` YoY reader; All Facilities table. Then (`3cb478e`): top-bar user avatar, collapse to **two tabs** (Overview, Collections) with a unified Collections view (Payment Type / All Collections, server-side explorer filters, header drag-reorder), and **per-view branding** (`--brand-*` / `brand-theme.tsx`). Data still BXR-or-stub (no `business_entity_id` on dashboard tables). |
| 11 | ✅ | Per-user **RBAC** (migration **0025** `claims.app_user`): `super_admin` / entity `admin` / entity `user`; `rbac.ts` (pure policy) + `access.ts` (`dashboardAccess`); pages clamp `?view=` to entitled views; PHI reveal (claims + CMD) gated on `canRevealPhi`; unprovisioned = default-deny notice. Seeded `alec@treathealth.ai`=super_admin. Replaces the flat "any verified session = full access". |
| 11.1 | ✅ | **In-app user management** (`/admin/users`, migration **0026**): admins provision/change/revoke roles (no SQL) via avatar-menu link. Auth roster via postgres-owned SECURITY DEFINER `list_app_users` (id/email/confirmed only); writes via `claims_admin`-owned `upsert_app_user`/`delete_app_user` with last-super-admin guard; authz (role/entity scope, no self-edit) + audit in `admin-actions.ts`. |
| 11.2 | ✅ | **In-app invites** (super_admin only): `inviteUser` (`admin-actions.ts`) creates the Supabase account + emails the invite + assigns the role via the service-role admin client (`app/lib/supabase/admin.ts`, **server-only** — the one deliberate service-role-on-app-path exception). Needs `SUPABASE_SERVICE_ROLE_KEY` in the Vercel app env. |
| VOB | foundation only | Migrations 0010–0011 (schemas `ref`/`vob`/`rag`/`audit`); no app code yet. |

---

## 14. Verification

- **Tests:** `npm test` → **239 pass, 0 fail** (hermetic — faked Anthropic + DB).
- **Typecheck:** `npm run typecheck` clean (root); `cd app && npm run typecheck`
  clean; `cd app && npm run build` succeeds.
- Run `npm test` + both typechecks before any commit. Show results and HOLD
  before any push/deploy.
- `src/liveProbe.ts` is the manually-run live probe (real Anthropic + real DB) —
  never imported by the suite.

---

## 15. Known issues & deferred work

- **Collections per-row tenancy (deferred — migration 0028).** The dashboard's `collections.*`
  tables are single-tenant and the explorer/deposit cron is **BXR-only** (see §7's ⚠️ TENANCY
  GUARDRAIL). Migration 0027 seeded a `business_entities` registry only. Before Indigo (or any
  2nd tenant) can appear on the dashboard, three things must ship together: `business_entity_id`
  on `cmd_explorer_rows`/`daily_collections`/`cmd_payer_facility_monthly` (backfill existing→BXR,
  fold into `row_fingerprint`) + tenant-scoped RLS/GUC on the writer + every collections reader
  filtering by `viewToEntityIds(clampedView)`. Do NOT enable Indigo collections ingest before all
  three land, or BXR/Indigo commingle irrecoverably in shared tables.
- **`readmission_candidates` performance (open).** The full-population self-join
  times out (>90s → 500), even date-scoped to one quarter with a 30-day gap. The
  quick-question button is intentionally omitted. A real fix is query-layer work
  and is **stop-and-explain gated** (don't alter SQL tools without asking):
  candidate approaches — (a) an index supporting the pair self-join, (b) make a
  facility or tight date window mandatory to bound the scan, (c) a
  `statement_timeout` + friendly "narrow your search" UI error.
- **`SUPABASE_CA_PEM` on non-production deploys (bundled-path fragility — hardened
  in `370c1bd`).** Historically, if `SUPABASE_CA_PEM` was set on production only,
  preview/dev (and local dev without the export) hit an `src/ssl.ts` bundled-path
  bug (`ERR_INVALID_URL` on the webpacked `certs/...crt`), 500-ing every DB call.
  `supabaseCa()` now resolves the CA through a fallback ladder — `SUPABASE_CA_PEM`
  → `SUPABASE_CA_PATH` (absolute-path override) → `process.cwd()/certs/supabase-ca.crt`
  (reliable on Vercel serverless) → the `import.meta.url`-relative path (last resort) —
  each file path tried independently in try/catch, throwing only when all are
  exhausted, and logging the path label that succeeded (never cert content). Setting
  `SUPABASE_CA_PEM` everywhere is still the simplest path; the ladder is defense in
  depth. The CA bundle itself is the public Supabase Root **+ Intermediate** 2021 CAs
  (`370c1bd`'s sibling fix `1a2c289`); a single root-only PEM no longer anchors the
  Supavisor pooler chain.
- **Per-user auth — DONE (invite-only).** Real per-user Supabase Auth gates the
  PHI surface and names the real principal in `claims.access_audit` (see §11).
  Migration 0018 (allowlist + signup hook) was superseded by 0024 (invite-only;
  allowlist dropped). The remaining work is **operational, not code**: the
  Supabase dashboard steps in 0024's header (disable the Before-User-Created hook,
  disable self-signup, set Site/Redirect URLs, point the Invite + Reset Password
  email templates at `/auth/confirm`, ideally custom SMTP) must be done for the
  flow to work end-to-end, and **0024 must be applied only after the new build is
  deployed** (the live build reads the allowlist table on every request).
- **Manual browser pass required.** This agent environment has no browser driver;
  DOM/Network/click/refresh checks (PHI masking, Server-Action-only network,
  reveal-clears-on-refresh) must be verified by a human at the running app.
- **Archived/historical collections data** not yet ingested (Phase 6 deferral).
- **`libsodium-wrappers` needs `serverExternalPackages` before the next `next build`.**
  The package's ESM build (`dist/modules-esm/libsodium-wrappers.mjs`) imports a
  non-existent sibling `./libsodium.mjs`, so a native `import` throws
  `ERR_MODULE_NOT_FOUND`; `src/collections/phiCrypto.ts` therefore loads the working
  CJS build via `createRequire`. Any Next route that pulls in `phiCrypto` —
  the `/api/cron/cmd-explorer` route (Collections Explorer ingest) and the future PHI
  reveal path — must NOT be bundled by webpack. **Before the next `next build`/deploy
  that includes those routes, add `serverExternalPackages: ['libsodium-wrappers']` to
  `app/next.config.*`** (and ensure `libsodium-wrappers` is installed for the `app/`
  package so it ships). Until then, `next build` will fail on the wasm. `tsc`/typecheck
  is unaffected (it does not bundle).
- **Pre-deploy gate: run `next build` with `.env` temporarily moved aside (or in a
  clean checkout) before any push that adds a new env-dependent import.** Local builds
  with `.env` present mask Vercel-only webpack/bundler failures. Concretely:
  `new URL('../../.env', import.meta.url)` in `cmdExplorerSeed.ts` is detected by
  webpack as a static asset reference; it compiled locally (the repo-root `.env`
  existed) but failed the Vercel build where it does not — fixed in `fc46db8` by
  resolving the path via `dirname(fileURLToPath(...))` + `path.join`. `tsc`/typecheck
  will NOT catch this class of failure (it does not bundle).

---

## 16. Design system

`docs/design-system.md` — the TreatHealthOS visual system applied to this
PHI-aware dashboard: palette (teal/coral/ground), typography (Space Grotesk /
Inter / IBM Plex Mono), layout shells, components (KPI tile, widget card,
skeleton, notice, MiniBar, payer chart, field picker, chat bubbles), navigation,
and the code-enforced PHI rules.

---

## 17. Staging pipeline — CMD batch ingest + three-brain ML

A SECOND data pipeline alongside the `claims`/`collections` system, built from
the CMD **BATCH DUMP ALL TIME** custom report (not the Google Sheets path).
Source of truth for the RCM ML system. Lives in the `staging.*` / `ref.*` schemas.

> **Provenance warning.** Most of this pipeline's prior-session work was authored
> in an ephemeral container that was reclaimed before it was pushed; only what is
> committed to `origin` survives. Verified-in-repo facts (schema, columns, grain)
> are stated plainly below. DB-state facts (row counts, what is actually deployed)
> are **unverified from this clone** — there is no DB MCP wired into the web
> session, so anything about live tables is last-known, not confirmed.

### Tenancy & connection
- **Single tenant today:** `business_entity_id = af504ab6-3dcd-4aa4-a93c-27bc58de4088`
  (BXR Consulting LLC, CMD account #475729). Scoped via GUC `app.business_entity_id`,
  set transaction-locally (`set_config(..., true)`) and read with
  `current_setting('app.business_entity_id')::uuid` in every RLS policy.
- DB: project `dbpabchpvipipkzkogta`. Transaction pooler 6543 — no named prepared
  statements. Money is `numeric(12,2)`, never float. Timestamps `timestamptz`.
- `claims_admin` owns `staging.*`/`ref.*` (writer; owner bypasses RLS for builds);
  `claims_reader` has SELECT, RLS-scoped by `business_entity_id`.

### Tables (schema verified in `SQL Schemas/001` + `005`)
| Object | Grain / key | Notes |
|--------|-------------|-------|
| `ref.remittance_code` | `(code, code_type)` | CARC/RARC codebook + reconciliation `category`; Brain-2/3 seed. Shared (no tenant scope). |
| `ref.payer_alias` | `raw_name` PK | raw → `canonical_name` → `payer_family` (13 families). Global, non-PHI. Seeded in `005` (262 raw rows). |
| `staging.payer_dim` | `(business_entity_id, cmd_payer_id)` | Payer master; `participates_in_era` = false today (CARC from manual EOB, not 835). |
| `staging.claim_line` | `(business_entity_id, charge_debit_id, credit_id)` **NULLS NOT DISTINCT** (`007`) | One row per charge/credit. PHI cols are libsodium-encrypted bytea — never features. 4 canonical payer cols added in `005`. `is_training_eligible = COALESCE(tob_frequency,1) NOT IN (2,8)`. |
| `staging.era_adjustment` | `(business_entity_id, charge_debit_id, credit_id, carc_code)` (`006`) | Long-format CARC/RARC; `adjustment_amount` sign-preserved (reversals negative). FK `claim_line_id → claim_line.id`. |
| `staging.payment_residual` | `(business_entity_id, charge_debit_id)` | Gap miner. `residual_type ∈ {BALANCE_DUE_INSURANCE, ALLOWED_GAP, MATH_GAP, CLEAN}`. |
| `staging.brain1_features` | `(business_entity_id, charge_debit_id)` | Leakage firewall: FEATURES submission-time-knowable; LABELS post-adjudication, separated. |
| `staging.mv_payer_drift` | `(business_entity_id, payer_name, carc_code, carc_type)` (`008`, matview) | Brain 2 drift. `REFRESH … CONCURRENTLY` after each ingest. |

### `allowed_amount` decision
`allowed_amount = "Charge Amount" − "Charge Insurance Adjustments"` for adjudicated
rows, NULL otherwise. `Follow Up Allowed Amt` is 100% blank and `Fee Schedule
Applied` is a text label (not a dollar) — both rejected as allowed sources. Parse
money via `parseMoney()` (handles `$`/`,`), never `parseFloat`.

### Migration files (`SQL Schemas/`, NOT `supabase/migrations/`)
`000` seed remittance codes · `001` staging schema · `002` ETL ingest (claim_line +
era_adjustment unpivot) · `003` reconciliation (payment_residual) · `004` Indigo
ETL · `005` payer normalization + brain1 schema · `006` era_adjustment credit grain
· `007` claim_line null-credit idempotency (NULLS NOT DISTINCT) · `008` Brain 2
drift MV. Canonical drift read: `SQL Schemas/brain2_drift_query.sql`.
- **No `payer_carc_monthly` / `payer_code_monthly` and no superseded `008/009
  payer_drift` exist in this clone.** That approach (and the `007 = drift MV`
  numbering the lost-container lore references) never reached `origin`. `008` is
  the canonical drift MV here.

### Three brains
- **Brain 1 (predictor):** `staging.brain1_features`. Targets P(paid)/P(denied)/
  days_to_pay. `outcome` DENIED is a v1 proxy (`BALANCE_DUE_INSURANCE`); upgrades to
  CARC-driven once 835/Brain 2 matures. Time-based split required, not random.
- **Brain 2 (drift):** `staging.mv_payer_drift` (`008`). Per-(tenant, canonical
  primary payer, CARC) adjudication-rate drift: baseline(120d) vs recent(60d) on
  `primary_payment_date` (adjudication date, NOT DOS), anchored on each tenant's own
  `max(primary_payment_date)` — not `CURRENT_DATE` — so a historical batch dump
  yields a real signal instead of an empty recent window. Statuses:
  `NEW_PAYER` / `NEW_CODE` / `INCREASING` / `DECREASING` / `LIKELY_LAG_ARTIFACT`
  (`STABLE` not materialized). Alert layer filters `WHERE drift_status <> 'NEW_PAYER'`.
  - **CO-45 — CORRECTED:** on full data CO-45 shows **real INCREASING drift across
    Anthem/BCBS/United**. The earlier "structural OON haircut / ingestion artifact"
    conclusion was drawn on a **partial ingest and is retracted.** `LIKELY_LAG_ARTIFACT`
    is a general under-population guard (fires only on a material *decrease* under a
    thin recent window) — it is NOT a CO-45 verdict; a genuinely rising CO-45 rate
    classifies as `INCREASING`.
  - `008` is **reconstructed from this section's prose** (original lost with the
    container), grounded in the committed schema. Thresholds live in a `params` CTE
    — review before first `REFRESH`. **Not yet deployed to the DB.**
- **Brain 3 (evidence):** not started. pgvector intended (embedding columns stubbed
  in `001`). Similar-claim retrieval for appeals (same payer/CPT/LOC).

### Multi-tenancy note
`008` deliberately does **not** hardcode the tenant UUID (the matview `GROUP BY
business_entity_id` over all tenants; a refresh has no session GUC). A matview
cannot carry RLS, so the `claims_reader` SELECT grant exposes all tenants' MV rows
— moot at one tenant. **Before onboarding tenant #2:** gate MV reads behind a
`security_barrier` view filtering `business_entity_id = current_setting('app.business_entity_id')`,
or read only via `brain2_drift_query.sql` (a plain query that DOES see the GUC).

### Known gaps
- WELLNESS RECOVERY CENTER (CMD `10033951`) — 1 of 17 account customers failed at
  pull; re-pull when convenient.
- `008` drift MV authored but **not deployed/refreshed/verified** against live data
  (no DB access from web sessions). First-run checks live in the file footer.
</content>
</invoke>
