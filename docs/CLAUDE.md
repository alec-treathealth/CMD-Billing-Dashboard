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
| `SUPABASE_SERVICE_ROLE_KEY` | legacy/other tooling only | NOT on the app path; never ship to browser |

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
npm test            # hermetic node:test suite (171 pass, 0 fail)
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
collections domain. Migrations `0006`–`0008`; ingest under `src/collections/`.

| Table | Role | Live count |
|-------|------|-----------:|
| `collections_raw` | verbatim landing — **PHI-bearing, admin-only** | 58,190 |
| `daily_collections` | typed per-day collections | 1,902 |
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

Read APIs (`src/collections/summary.ts`, `daily.ts`; handlers in `src/routes/`)
serve non-PHI monthly/daily aggregates as `claims_reader`, never reading
`collections_raw` and never exposing `source_group_code`.

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
- **`/dashboard`** — non-PHI aggregate overview; sub-routes `/dashboard/payers`
  (filterable payer explorer + multidimensional payer chart) and
  `/dashboard/collections` (collections KPI chart + Collections Explorer). Built
  from per-surface modules in `app/components/dashboard/`
  (`overview`/`payers`/`collections`/`widgets`) over a shared widget shell.
  Widgets read the materialized aggregates (matviews, migration 0009) through
  cached readers.
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

**Access control:** there is no app-level login. The only gate in front of PHI is
**Vercel Deployment Protection** — it MUST be On and **scoped to Production**
(Standard Protection defaults to preview-only; production must be explicitly
included). Sanity check: load the production alias incognito — it should bounce to
Vercel auth, not the console.

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
| VOB | foundation only | Migrations 0010–0011 (schemas `ref`/`vob`/`rag`/`audit`); no app code yet. |

---

## 14. Verification

- **Tests:** `npm test` → **171 pass, 0 fail** (hermetic — faked Anthropic + DB).
- **Typecheck:** `npm run typecheck` clean (root); `cd app && npm run typecheck`
  clean; `cd app && npm run build` succeeds.
- Run `npm test` + both typechecks before any commit. Show results and HOLD
  before any push/deploy.
- `src/liveProbe.ts` is the manually-run live probe (real Anthropic + real DB) —
  never imported by the suite.

---

## 15. Known issues & deferred work

- **`readmission_candidates` performance (open).** The full-population self-join
  times out (>90s → 500), even date-scoped to one quarter with a 30-day gap. The
  quick-question button is intentionally omitted. A real fix is query-layer work
  and is **stop-and-explain gated** (don't alter SQL tools without asking):
  candidate approaches — (a) an index supporting the pair self-join, (b) make a
  facility or tight date window mandatory to bound the scan, (c) a
  `statement_timeout` + friendly "narrow your search" UI error.
- **`SUPABASE_CA_PEM` on non-production deploys.** If set on production only,
  preview/dev (and local dev without the export) hit an `src/ssl.ts` bundled-path
  bug (`ERR_INVALID_URL` on the webpacked `certs/...crt`), 500-ing every DB call.
  Workaround: set `SUPABASE_CA_PEM` on preview/dev too (or export it locally), or
  fix the bundled file-fallback in `src/ssl.ts`.
- **Per-user auth.** Audit principals are currently fixed strings
  (`phase5-ui`/`phase5-dashboard`/route defaults). Real per-user auth (to replace
  Deployment Protection as the PHI gate and to name the real principal in the
  audit trail) is deferred.
- **Manual browser pass required.** This agent environment has no browser driver;
  DOM/Network/click/refresh checks (PHI masking, Server-Action-only network,
  reveal-clears-on-refresh) must be verified by a human at the running app.
- **Archived/historical collections data** not yet ingested (Phase 6 deferral).

---

## 16. Design system

`docs/design-system.md` — the TreatHealthOS visual system applied to this
PHI-aware dashboard: palette (teal/coral/ground), typography (Space Grotesk /
Inter / IBM Plex Mono), layout shells, components (KPI tile, widget card,
skeleton, notice, MiniBar, payer chart, field picker, chat bubbles), navigation,
and the code-enforced PHI rules.
</content>
</invoke>
