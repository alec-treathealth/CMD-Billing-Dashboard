# CLAUDE.md — Historical Claims Search System

This file is persistent context for Claude Code. Read it fully before writing any code.

## What this project is

An AI-powered search system over three years of out-of-network behavioral
health billing data (BXR / Treat Health). A user asks questions in natural
language ("find readmissions at My Time Recovery", "show payer gaps for
Beacon Carelon"); an Anthropic tool-calling agent maps the question to one
of a small set of **vetted, parameterized query functions** and renders the
results.

**This data is PHI.** The compliance layer is ON for the entire project
(SOC 2 / HIPAA / OWASP). Patient names, member IDs, payers, and claim
amounts are all present. Never log PHI. Never put PHI in an LLM prompt
(see "PHI boundary" below). Parameterized queries only.

## Architecture (whole system, for context — you are building Phase 1 only)

- **Ingestion:** read 3 Google Sheets → normalize → land raw → transform to typed.
- **Storage:** Supabase Postgres, RLS on, app-layer encryption for PHI at rest.
- **Search agent (later phase):** Anthropic API picks a query function + args.
  It NEVER receives raw SQL and NEVER receives patient rows.
- **PHI boundary (later phase, but design toward it now):** query functions
  return two shapes — a non-PHI `summary_stats` object the agent may see, and
  a PHI result set keyed by an opaque `query_id` that only the UI fetches via
  a separate authenticated route. The results route re-runs the parameterized
  query rather than caching PHI at rest.
- **Frontend (later phase):** Next.js 15 / TS / Tailwind / shadcn/ui on Vercel.

## ⛔ Phase 1 scope — build ONLY this

1. A Supabase migration creating `claims_raw`, `claims`, and the indexes,
   exactly as specified under "Schema" below.
2. An ingestion script that:
   - reads the three sheets **via the Google Sheets API as structured cells**
     (NOT CSV — see "Why not CSV"),
   - normalizes per the "Column map",
   - lands every row verbatim in `claims_raw`,
   - transforms into typed `claims`,
   - writes a **failed-coercion report** (any row that lands raw but fails to
     produce a clean typed row is logged with file id, row number, and reason —
     never silently dropped).

Do NOT build the agent, the query functions, readmission matching, the PHI
results route, or any UI. Those are later phases. Make the smallest change
that delivers a correct, verifiable ingest. If you spot adjacent work, name
it under "Phase 2+ notes" — don't build it.

## Data sources

Canonical source = the **"Copy of"** set inside the Drive folder
**"Reports for Alec AI"** (`1pXsb22qF9Jx8osxSnyyWt40fnNu5FxGc`):

| Year | Sheet title | Google Sheet ID |
|------|-------------|-----------------|
| 2024 | Copy of Historical Data for 2024 | `1BE3d6lzaopaWNQXUUrP1_yLs21uwYG2LNQBDjqzK2Ic` |
| 2025 | Copy of Historical Data for 2025 | `1FMXHl4b57IPp2jlMsatmkfZHYmq-HfVBQXJrzWjtlOg` |
| 2026 | Copy of Historical Data for 2026 | `1GQrOoQUhf5JgWrjnHXl-iJ28ZZzrM-9CEt-X7UiC8pc` |

> ⚠️ There is a second, near-identical "Historical Data for…" set in a
> different folder. Do NOT use it. If the IDs above don't resolve, stop and
> ask — do not substitute the other copies.

All three sheets have data in `Sheet1`, row 1 is the header.

## Why not CSV

`Patient Name` is always `LAST, FIRST` (embedded comma, every row) and
`Employer Name` sometimes contains a comma (`THE VANGUARD GROUP, INC.`), and
the raw export is **not reliably quoted**. Splitting on commas WILL misalign
columns. Read cells as structured values through the Sheets API so delimiter
handling never happens. This is a correctness requirement, not a preference.

## Column map (per-year — 2024 differs)

2024's first column header is **`Office Name`**; 2025 and 2026 use
**`Facility Name`**. Map by position + per-year header, normalize to the
canonical name. All other columns are positionally identical across years.

| Canonical | 2024 header | 2025/2026 header | Notes |
|-----------|-------------|------------------|-------|
| `facility_name` | `Office Name` | `Facility Name` | header differs in 2024 |
| `date_of_service` | `Date of Service` | same | mixed `M/D/YYYY` and `MM/DD/YYYY` |
| `hcpcs_code` | `HCPCS Code` | same | **nullable** — blank for some 2024 rows |
| `revenue_code` | `Revenue Code` | same | **nullable** — blank for some 2024 rows |
| `patient_name` | `Patient Name` | same | `LAST, FIRST`, embedded comma |
| `member_id` | `Member ID` | same | mixed numeric / alphanumeric (`PGE081`); **can be negative in 2024** (`-11724767`) |
| `group_number` | `Group Number` | same | often blank |
| `employer_name` | `Employer Name` | same | often blank; embedded comma when present |
| `charge_debit_amount` | `Charge/Debit Amount` | same | money |
| `allowed_amount` | `Allowed Amount` | same | money; **can be negative** |
| `paid_amount` | `Paid Amount` | same | money |
| `adjustment` | `Adjustment` | same | money |
| `balance_due_pt` | `Balance Due Pt` | same | money |
| `payer_name` | `Payer Name` | same | |

## Normalization rules

- **Money** (`charge_debit_amount`, `allowed_amount`, `paid_amount`,
  `adjustment`, `balance_due_pt`): strip `$` and `,`; preserve leading `-`;
  parse to `numeric(12,2)`. Blank → NULL.
- **Dates** (`date_of_service`): accept both `M/D/YYYY` and `MM/DD/YYYY`;
  store as a real `date`. Never string-compare.
- **HCPCS / Revenue codes:** blank cell → NULL (do not coerce to empty string).
- **Patient name:** keep `patient_name` verbatim; also split into
  `patient_last` / `patient_first` on the first comma for later matching.
- **Member ID:** store original in `member_id_raw`; also store
  `member_id_norm` = trimmed, upper-cased, leading `-` removed (absolute value
  for matching). Blank → NULL in both.
- Any cell that fails its expected coercion → write the row to the
  failed-coercion report with `{source_file_id, source_row_num, column, raw_value, reason}`
  and skip inserting that row into `claims` (it still lands in `claims_raw`).

## Schema (create exactly this)

```sql
create table claims_raw (
  id              bigint generated always as identity primary key,
  source_year     smallint  not null,
  source_file_id  text      not null,
  source_row_num  integer   not null,
  ingested_at     timestamptz not null default now(),
  raw             jsonb     not null,
  unique (source_file_id, source_row_num)
);

create table claims (
  id              bigint generated always as identity primary key,
  claims_raw_id   bigint not null references claims_raw(id),
  source_year     smallint not null,

  facility_name   text not null,
  date_of_service date not null,
  hcpcs_code      text,
  revenue_code    text,
  patient_name    text not null,
  patient_last    text not null,
  patient_first   text not null,
  member_id_raw   text,
  member_id_norm  text,
  group_number    text,
  employer_name   text,

  charge_amount   numeric(12,2),
  allowed_amount  numeric(12,2),
  paid_amount     numeric(12,2),
  adjustment      numeric(12,2),
  balance_due_pt  numeric(12,2),
  payer_name      text not null,

  collection_rate numeric(6,4)
    generated always as (
      case when allowed_amount is not null and allowed_amount <> 0
           then paid_amount / allowed_amount end
    ) stored,

  created_at      timestamptz not null default now()
);

create extension if not exists pg_trgm;
create index claims_patient_trgm  on claims using gin (patient_name gin_trgm_ops);
create index claims_facility_trgm on claims using gin (facility_name gin_trgm_ops);
create index claims_payer_trgm    on claims using gin (payer_name gin_trgm_ops);
create index claims_member_norm   on claims (member_id_norm);
create index claims_dos           on claims (date_of_service);
create index claims_facility_payer on claims (facility_name, payer_name);
```

Migrations: use `IF NOT EXISTS` on `CREATE TABLE`/`CREATE INDEX`; for any RLS
policy use explicit `DROP POLICY IF EXISTS` before `CREATE POLICY`
(SQLSTATE 42710 otherwise).

## Idempotency

Re-running ingest must not duplicate. Identity is `(source_file_id,
source_row_num)` on `claims_raw` (note the unique constraint). The heavy
ROW duplication in the data (e.g. group therapy 90853 billed identically day
after day) is **legitimate billing** — never dedupe on business columns.
Only ever collapse true re-ingestion of the same source cell.

## Secrets / config

- Supabase URL + service role key, and Google credentials, come from env /
  secret manager — never hardcoded, never logged.
- macOS/zsh dev env: load `.env` with
  `export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)` before running.

## Verification (Phase 1 is done when)

- Migration applies cleanly to a fresh Supabase project.
- Ingest run loads all three years; `claims_raw` row count == total source
  rows; `claims` count == raw minus failed-coercion count.
- Spot-check: a Covenant Hills 2024 row has NULL hcpcs_code/revenue_code and a
  positive `member_id_norm` from a negative `member_id_raw`.
- Spot-check: a `THE VANGUARD GROUP, INC.` row has correctly aligned columns
  (employer comma did not shift the money fields).
- Money negatives (`-$1,660.05`) and mixed date formats parse correctly.
- Failed-coercion report is produced and reviewed.
- A second ingest run inserts zero new rows (idempotent).

## Phase 2+ notes (DO NOT build now — recorded so they aren't lost)

- **Readmission matching is fuzzy and graded.** Member ID is unreliable
  (blank / negative / alphanumeric), group number mostly blank. Cross-year
  identity will rest on `patient_name + payer_name` (+ `member_id_norm` when
  present), returning confidence tiers (exact / strong / possible) as
  candidate generation for a human — never an auto-asserted truth.
- **`summary_stats` allowlist** (fields the agent may ever see): facility_name,
  payer_name, hcpcs_code, revenue_code, source_year, date_of_service (as
  ranges/buckets), and aggregates (counts/sums/avg/min/max/collection_rate).
  NEVER patient_name, patient_first/last, member_id_*, group_number,
  employer_name. Enforce in code.
- Query functions = a versioned, tested library, each with fixtures — not
  inline SQL in API routes.
- Audit log captures who ran which function with which args (structured).
- **A NULL `collection_rate` is itself a signal — don't treat it as "missing".**
  The generated column yields NULL when the rate isn't representable: reversals,
  adjustments, or a near-zero/negative `allowed_amount` (the "< 100" guard in the
  `claims` schema is a `numeric(6,4)` representability limit, not a business
  threshold). When `paid_amount` and `allowed_amount` are both non-null but
  `collection_rate` is NULL, that row is exactly the kind of payer/policy-gap
  anomaly this system exists to surface. A later phase may add a derived boolean
  (e.g. `is_rate_anomalous`) or an analyst filter so these aren't lost behind the
  NULL. (Do not build now.)
- **RLS scoping is mandatory (shared project).** `claims_raw` / `claims` live in
  the same Supabase project (`dbpabchpvipipkzkogta`) as unrelated CMD billing
  automation tables (`cmd_transactions`, `cmd_facility_daily_summary`). In the
  storage phase, enable RLS on `claims`/`claims_raw` and scope the search app's
  credential so it can reach ONLY these two tables — never the unrelated CMD
  tables. Use a dedicated least-privilege DB role / policy set; do not rely on
  the service-role key for the app path. (Phase 1 ingest uses the service-role
  key for the loader only.)
