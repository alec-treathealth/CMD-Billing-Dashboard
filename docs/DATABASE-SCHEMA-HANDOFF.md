# CMD Billing Dashboard — Database Schema Handoff

**Audience:** an engineer joining this codebase who needs to understand the data layer well
enough to read a query, write a migration, and not break production.

**Provenance and how much to trust this.** Every structural claim below is derived from the
**migration files in the working tree** (`supabase/migrations/*.sql`, `SQL Schemas/*.sql`) plus
the code that reads them, on branch `fix/qualify-a11y-contrast` @ `ec92aa7`, 2026-08-14. It is
**not** a live `pg_catalog` introspection — the Supabase MCP connector was unauthenticated in
the session that produced this. So:

- A table described here exists **if its migration was applied**. A handful are authored and
  deliberately not applied — see [§10 Known drift](#10-known-drift-and-open-questions).
- Before you claim a migration number, **query `supabase_migrations.schema_migrations`**. The
  file listing is a floor, not the answer. This has already caused one real collision (0096).
- `veris-data-notes.md` (repo root) is the live tribal-knowledge ledger and **wins over this
  document** wherever the two disagree.

---

## 1. The big picture

One Supabase Postgres cluster. **Two logical planes**, twelve schemas, two migration
directories that must never be mixed.

```
                          one Supabase cluster
    ┌──────────────────────────────────────┬──────────────────────────────────┐
    │  PRODUCT PLANE                       │  VERIS ML PLANE                  │
    │  supabase/migrations/00NN_*.sql      │  SQL Schemas/0NN_*.sql           │
    ├──────────────────────────────────────┼──────────────────────────────────┤
    │  claims       app users, RBAC,       │  core     tenant registry        │
    │               billing audit,         │  staging  CMD claim-line ETL,    │
    │               query library          │           brains 1/2/3, ERA 835  │
    │  collections  CMD ingest, explorer,  │  ref      global reference data  │
    │               deposits, Qualify      │  intel    payer policy findings  │
    │  vob          verification of        │                                  │
    │               benefits (Monday)      │                                  │
    │  coding       coding decisions       │                                  │
    │  code_intel   BH billing-code intel  │                                  │
    │  rag          doc chunks + vectors   │                                  │
    │  audit        AI query audit trail   │                                  │
    │  auth_config  signup allowlist       │                                  │
    └──────────────────────────────────────┴──────────────────────────────────┘
```

| Schema | Plane | What it holds | PHI? |
|---|---|---|---|
| `claims` | Product | App users + RBAC, access audit, query log, the Claims Audit workbench (`audit_row`/`flag`), Qualify per-user state, the original 2024 claims table | **Yes** |
| `collections` | Product | The CMD ingest landing + typed tables, the Explorer rollup, deposits, facility dimension, Qualify census/rating, ETL run logs | **Yes** |
| `vob` | Product | Indigo verification-of-benefits pulled from monday.com | **Yes** (blind-indexed) |
| `coding` | Product | The coding-decision registry (which HCPCS/rev code to bill per payer) | No |
| `code_intel` | Product | BH billing-code intelligence: policies, code rules, source excerpts | No |
| `rag` | Product | Document chunks + `vector(1536)` embeddings for the VOB AI path | Treat as PHI-at-rest |
| `audit` | Product | AI session / query / retrieval / answer trail | PHI-at-rest (prompts) |
| `auth_config` | Product | Signup email allowlist + the signup-restriction trigger | No |
| `core` | Veris | `business_entity` (the two tenants) + `cmd_customer` (facilities) | No |
| `staging` | Veris | CMD claim-line ETL, ML feature/score tables, ERA 835 remits, expected-payment overrides | **Yes** (encrypted) |
| `ref` | Veris | CARC/RARC, CMS PFS, NPPES, payer identity + alias map | No — **global, read-all** |
| `intel` | Veris | Payer/federal policy findings from the monthly research run | **Deliberately non-PHI** |

> **Every row is PHI — except `intel.*`.** That is the standing assumption. `intel` is the one
> schema explicitly built to be publishable (public payer/federal policy findings, see
> `SQL Schemas/025_*.sql`).

Two packages consume this: the root package (`src/`) is the ingest + query library; `app/` is
the Next.js 15 transport/UI and the Vercel app root. `app/` imports the library from `../src`.

---

## 2. The access model — read this before you write a query

There is **no PostgREST and no service-role key** on the app path. Everything goes over
node-postgres with a per-role connection string.

| Role | Env var | Purpose | Notes |
|---|---|---|---|
| `claims_reader` | `CLAIMS_READER_DATABASE_URL` | **Every application read** | RLS-scoped SELECT; no INSERT/DELETE on most tables — writes go through SECURITY DEFINER functions |
| `claims_admin` | `CLAIMS_ADMIN_DATABASE_URL` | Ingest CLIs, owner of `claims.*` objects | Never on the browser-facing request path |
| `cmd_rollup_writer` | `CMD_ROLLUP_WRITER_DATABASE_URL` | The hourly/daily collections crons | Narrow, per-table grants — **not** blanket schema grants |
| `claims_audit_writer` | `CLAIMS_AUDIT_WRITER_DATABASE_URL` | The Claims Audit ingest crons | SELECT/INSERT/UPDATE on `claims.audit_row` etc., no DELETE |
| `code_intel_writer` | `CODE_INTEL_WRITER_DATABASE_URL` | The quarterly CMS HCPCS sync | |
| `intel_writer` | `INTEL_WRITER_DATABASE_URL` | The monthly payer-intel run | |
| `consolidated_reader` | — | Owns `core.consolidated_summary()`; `NOBYPASSRLS` | The cross-tenant read surface, super-admin only |
| `coding_editor` | — | Writes `coding.code_decision` | |
| `postgres` | (Supabase MCP / `apply_migration`) | Migrations only | Non-superuser, **`rolbypassrls = true`** |

**Rules that are not preferences:**

- **Parameterized queries only.** Table/column/GUC names are fixed string literals; only values
  are `$n` bound params. **Never `SELECT *`** — project explicit allowlisted columns.
- **Verify-full TLS stays on** (`src/ssl.ts`). Never reintroduce `rejectUnauthorized: false`.
  **Never put `sslmode` in a DB URL** — it silently drops the CA and defeats verification.
- **Supavisor transaction pooler (port 6543) forbids named prepared statements.** Use
  `pool.query(sql, params)` only.
- Secrets from env only. No `NEXT_PUBLIC_*` for anything server-side. The browser's only data
  path is Next Server Actions.

### 2.1 The two-gate trap that has bitten this repo twice

A GRANT and an RLS policy are **separate gates, and only the GRANT errors.**

```sql
-- gate 1: the GRANT (raises 42501 when missing)
select has_table_privilege('cmd_rollup_writer','collections.<table>','SELECT');
-- gate 2: RLS — enabled? and is there a policy for THIS role?
select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'collections' and c.relname = '<table>';
select policyname, roles, cmd from pg_policies
 where schemaname = 'collections' and tablename = '<table>';
```

Under RLS, a role with **no applicable policy sees an empty table — not an error.** Migration
0089 granted a SELECT the census sync needed; the alarm still read `23 of 23` because
`collections.facilities` had RLS on and no matching policy. 0090 added the policy.

**You cannot verify this as `postgres`** — it has `rolbypassrls = true`, and the Supabase MCP
connects as `postgres`, so every MCP query is blind to this entire class of bug. Read
`pg_policies` directly, or run the job with the real role's credential.

In code: **never let a fail-soft `catch` absorb a 42501**, and treat "zero rows for a non-empty
ask" as a misconfiguration, not a data state. See `CensusVisibilityError` in
`src/collections/qualifyCensusSync.ts` for the shape.

### 2.2 The narrow write surface

`claims_reader` mostly cannot write. Writes it *is* allowed to trigger go through
`SECURITY DEFINER` functions with `EXECUTE` granted to the reader and revoked from
`public`/`anon`. Current inventory:

| Function | Owner | What it does |
|---|---|---|
| `claims.log_query` / `claims.get_query_log` | `claims_admin` | Query-library handle log |
| `claims.verify_identity` | `claims_admin` | `client_history` identity re-verification |
| `claims.log_access` / `claims.list_access_audit` | `claims_admin` | Access audit write/read |
| `claims.upsert_app_user` / `list_app_users` / `delete_app_user` / `delete_orphan_app_users` | `claims_admin` | RBAC provisioning |
| `claims.save_grid_view` / `set_default_grid_view` / `delete_grid_view` | `claims_admin` | Explorer saved column views |
| `claims.save_qualify_watcher` / `delete_qualify_watcher` / `record_qualify_recent_search` / `clear_qualify_recent_searches` | `claims_admin` | Qualify per-user state (0097) |
| `claims.refresh_aggregate_matviews` | `claims_admin` | Refreshes the 0009 matviews CONCURRENTLY |
| `collections.refresh_cmd_explorer_charge_rollup` | `postgres` | The :45 rollup refresh |
| `collections.refresh_facility_resolution` | `postgres` | Facility-resolution matview refresh |
| `collections.save_facility_assignments` | `postgres` | Human "No Facility" assignment (0085) |
| `collections.add_manual_deposit` / `remove_manual_deposit` | `postgres` | **Applied but UNREACHABLE from the app since 2026-09-04 — no caller remains; do not wire it** (see §5.2) |
| `collections.record_qualify_prefix_echo` | `postgres` | **Applied but deliberately UNWIRED — do not wire it** (see §5.2) |
| `staging.upsert_expected_payment_manual` / `remove_*` / `set_*_status` / `delete_*` | — | Upcoming-payments manual overrides |
| `core.consolidated_summary` | `consolidated_reader` | The cross-tenant aggregate |
| `vob.refresh_member_benefits_latest` / `refresh_ai_matviews` | — | VOB matview refresh |
| `rag.match_document_chunks` | — | Vector search |
| `auth_config.restrict_signup_to_allowlist` | — | Signup trigger |

⚠ **A SECURITY DEFINER function runs as its OWNER.** In `collections`, every live relation is
`relowner = postgres`, so a `claims_admin`-owned definer **cannot write a postgres-owned
table**. That is why the ownership column above splits the way it does. See §9.

---

## 3. The PHI model

Three independent mechanisms. Understand all three before touching a PHI column.

### 3.1 Encryption at rest — `src/collections/phiCrypto.ts`

The identifier columns are **libsodium `crypto_secretbox_easy` ciphertext stored as `bytea`,
with the 24-byte random nonce prepended**: the stored value is `nonce ‖ ciphertext`. Key is
`LIBSODIUM_KEY` (32 bytes as 64 hex chars). Server-only, `typeof window` hard-fails.

Encrypted columns you will meet:

| Table | Encrypted columns |
|---|---|
| `collections.cmd_explorer_rows` | `patient_name`, `member_id`, `group_number` |
| `collections.cmd_charge_census` | `patient_name`, `member_id`, `group_number` (last two nullable — census is the openCount **denominator** and must not drop self-pay charges) |
| `claims.audit_row` | `patient_name_enc`, `patient_dob_enc`, `member_id_enc` |
| `staging.claim_line` | `patient_id_enc`, `patient_name_enc`, `member_id_enc`, `group_number_enc` |
| `staging.era_835_adjustment` | `patient_name_enc`, `member_id_enc` |

### 3.2 Blind indexes — `src/collections/blindIndex.ts`

You cannot search ciphertext. So every searchable PHI identifier also carries a **keyed
HMAC-SHA256 hex token** (`*_bidx`), computed over a **normalized** value. Search computes the
same HMAC over the typed term and equality-matches.

- Key is `INDEX_HMAC_KEY` and **must be a different value from `LIBSODIUM_KEY`** — a leak of
  one must not compromise the other.
- The token is **not PHI** (keyed one-way digest) and is safe to store, index and log. The
  *input* is PHI.
- `member_id_prefix_bidx` is the HMAC of the **first 3 characters** (`ALPHA_PREFIX_LEN`, the
  BCBS alpha-prefix convention). This is the join key the whole Qualify surface runs on.

⚠ **Normalization must match between ingest and query, byte for byte.** There are **two
different `normalizeMemberId` exports** in this repo — `src/normalize.ts` (queries plane: keeps
internal whitespace, strips ONE leading hyphen) and `src/collections/normalize.ts` (collections
plane: strips ALL internal whitespace and ALL leading hyphens). **Every live `*_bidx` token is
minted via `blindIndex.ts`, which imports the collections one.** An HMAC over the wrong form
silently mints tokens that never match: a zero-row join with no diagnostic. This is exactly why
`staging.era_835_adjustment.member_id_bidx` was deferred (see the long comment in
`SQL Schemas/013_*.sql`).

A token can be turned back into its readable 3-character prefix **in-process** by
`src/collections/prefixLabel.ts` — the domain is only 46,656 values (`[A-Z0-9]{3}`), so it
computes the whole token→prefix map once per warm process (~150ms, ~7MB, lazily). No write, no
query. This is ratified; do not replace it with a stored echo.

### 3.3 The summary / PHI split (query library)

The five-function query library (`src/queries/`) enforces a hard split:

```
NL question -> agent (Anthropic tool-calling) -> ONE query fn   runs as
                    | sees summary_stats + query_id only        claims_reader
                    v
               claims.query_log (non-PHI args, drives re-execution)
                    |
UI --(query_id [+ re-supplied identity])--> results route --> PHI rows
     (Server Action, server-side)           re-executes        (allowlisted cols)
```

- Every function returns `QueryResult<NoPhi<S>>`; `NoPhi<T>` collapses to `never` if a `PhiKey`
  appears in a summary. That type is the chokepoint — do not widen it.
- PHI is **never cached at rest**. The results route re-runs the parameterized query from
  `query_log.arguments` on each fetch.
- `src/queries/columns.ts` holds per-function PHI column allowlists; `getColumns()` throws on an
  unknown name.

**PHI never reaches** logs, LLM prompts/transcripts, `summary_stats`, a URL or query string,
browser storage (`localStorage`/cookies), or `query_log`.

The PHI key set (`app/lib/phi.ts`, mirroring `PhiKey` in `src/queries/types.ts`):
`patient_name`, `patient_first`, `patient_last`, `member_id_raw`, `member_id_norm`,
`group_number`, `employer_name`. See §10 for a pending ruling on `employer_name`.

---

## 4. Tenancy

Exactly **two data-bearing tenants**, seeded verbatim from `src/tenants.ts` with canonical UUIDs
that are **never re-minted** (BXR's is already in production data):

| Tenant | `core.business_entity` | CMD account | CMD customers (roster) |
|---|---|---|---|
| BXR Consulting | `af504ab6…` | `475729` | 15 owned / 15 active |
| Indigo Consulting | `141d459c…` | `474623` | 32 owned / **29 active** (3 retired) |

Plus one **derived** surface, "Treat Health" / Consolidated: the read-only aggregation of both,
super-admins only.

> ⚠ **Consolidated is NOT a tenant.** It gets no `business_entity_id`, no row is ever tagged to
> it, and it must never become a `core.business_entity` row. A session proposing a Treat Health
> entity row is re-opening a settled ADR and must stop and ask. (`core.consolidated_summary()` is
> a SECURITY DEFINER function owned by `consolidated_reader` — that's the whole read surface.)

The tenant key is the **6-digit CMD account**. The **8-digit CMD customer** numbers are
facilities *within* an account.

### How scoping is enforced, by plane

- **Veris plane (`staging`/`core`)** — the GUC `app.business_entity_id`, set
  **transaction-locally** via `set_config(..., true)` and read as
  `current_setting('app.business_entity_id')::uuid` in every RLS policy. All tenant-scoped
  writes go through **`src/veris/withTenant.ts`** — one client, one transaction.
  - **Never call `pool.query()` inside the callback** — each call can land on a different pooled
    connection, escaping the transaction and its GUC.
  - **No network calls inside the callback** (Anthropic, `fetch`). Never hold a transaction open
    across an LLM turn.
- **Collections plane** — per-row `business_entity_id` + tenant RLS + writer GUC + reader
  scoping (migrations 0030–0033). Reads take an explicit `entityIds`, derived server-side from
  the RBAC-clamped view (`viewToEntityIds` in `app/lib/views.ts` is the one place the
  view→entity decision lives). **`assertEntityScope()` throws on an empty or malformed scope
  rather than reading** — an empty scope must never silently return every tenant's rows.
- **`ref.*` is global** — RLS-gated read-all (`FOR SELECT USING(true)`). X12/CMS/NPPES/payer
  reference data must **never** be tenant-scoped.

⚠ **A matview cannot carry RLS.** If a matview spans tenants, a `claims_reader` SELECT grant
exposes every tenant's rows. Gate it behind a `security_barrier` view filtering on the GUC, or
read it only through a plain query (which does see the GUC). Revisit every cross-tenant matview
before onboarding a third tenant.

### App-level RBAC (`claims.app_user`)

| Role | `entity` | Sees |
|---|---|---|
| `super_admin` | must be NULL | everything, including Consolidated + Qualify |
| `admin` | `'bxr'` \| `'indigo'` | its entity's Overview, Collections, Claims Audit, Code Reference |
| `user` | `'bxr'` \| `'indigo'` | same, minus admin controls |
| `admissions_seat` | must be NULL | **Qualify only** — cross-tenant by design, and **server-stripped of every dollar field** |

Role/entity coherence is a DB CHECK **and** independently hard-coded in
`claims.upsert_app_user`. Both must move together — a role the table allows but `narrowRole`
(app code) rejects coerces to "unprovisioned = deny", and vice versa.

---

## 5. Product plane, schema by schema

### 5.1 `collections` — the live money path

This is the schema that matters most day to day. It is production-critical: the hourly CMD crons
write it and the Overview/Collections dashboards read it.

**Ingest landing → typed tables**

| Table | Grain | Notes |
|---|---|---|
| `collections_raw` | one row per source row | `shape ∈ {daily, payment_line, rollup, negotiation}`, `unique(source_file_id, source_tab, source_row_num)`. **PHI-bearing and admin-only — `claims_reader` has no SELECT on it.** |
| `daily_collections` | facility × payment_date | checks/EFT/gross. `source_tag ∈ {workbook, deposit_sheet, cmd, manual}` |
| `payment_lines` | charge line | legacy workbook ingest; generated `collection_rate` |
| `negotiation_worklist` | negotiation row | `client_name` is PHI, stored verbatim, never split |
| `rollup_snapshots` | raw rollup blob | jsonb passthrough |

**The Explorer path (the important one)**

| Object | Kind | Notes |
|---|---|---|
| `cmd_explorer_rows` | table | The append-only charge-line landing. `unique(row_fingerprint)`. PHI trio encrypted + three `*_bidx` columns (0036), `patient_name_bidx` (0066), `pull_facility_code` (0084), Feed-2 dimensions (0057). **The fingerprint hashes 18 fields — a comment saying 14 is stale.** |
| `cmd_explorer_charge_rollup` | **matview** | Collapses snapshot rows to **charge grain**. 22 columns; cols 1–18 are byte-identical to the 0050 shape. Refreshed at :45 by `refresh_cmd_explorer_charge_rollup()`. |
| `cmd_explorer_filter_options` | matview | Distinct facility/payer per tenant, for dropdowns (0080 — took the dropdown from 1.9s to 1ms) |
| `cmd_charge_int_facility` | matview | Resolves the facility for `INT`/`INTRST` interest rows |
| `cmd_facility_resolution` | matview | Resolves `'No Facility'` charges; `method ∈ {manual, named, member_inference, vob, tie_break, unresolved}`, in that precedence |
| `facility_assignments` | table | The **human** call on a `'No Facility'` charge (0085). Append-only + supersession; a trigger makes everything except `superseded_*` immutable |

**The `allowed_reliable` tier system (0059) — the single most confusing thing here.**
CMD re-states allowed amounts across snapshots, so the rollup picks a value by tier and records
which tier it used in `allowed_tier`:

| Tier | Meaning |
|---|---|
| `none` | no allowed value at all → `allowed_reliable` is NULL |
| `a` | exactly one distinct allowed value → use it |
| `b` | one distinct value, it's `0`, and insurance paid > 0 → **NULL** (a zero that isn't real) |
| `cd` | the latest snapshot whose allowed reconciles to `insurance_payments + patient_balance_due` within $0.01 |
| `e1` | the netted sum reconciles within $0.01 |
| `e2` | fallback: latest positive value. **Excluded from the Qualify claims factor** — treat as unreliable |

`pct_allowed` and `pct_paid` are derived from `allowed_reliable`, not from `allowed_amount`.

**Dimension + reference**

| Table | Notes |
|---|---|
| `facilities` | `facility_code` PK, name, `care_setting`, `display_acronym`. The roster dimension. |
| `cmd_facility_aliases` | free-text facility label → canonical `facility_code` |
| `business_entities` | tenant mirror inside the product plane (the Veris-plane source of truth is `core.business_entity`) |
| `cmd_payer_facility_monthly` | payer × facility × service month rollup — **see the two-population warning in §9** |

**Qualify tables**

| Table | Notes |
|---|---|
| `qualify_facility_census` | one row per curated monday board facility (23 today: 12 residential + 11 outpatient). **Outpatient rows carry `bed_capacity = null` and `open_beds = 0` because beds do not apply — `0` there is not "full".** `avg_los_days` needs the `los_sample` gate before display (tiny outpatient samples produce 300–373-day "stays"). |
| `qualify_facility_outcomes` | discharge-based LOS/auth averages over a trailing `window_days` |
| `qualify_policy_rating_daily` | the daily rating tape, PK `(as_of_date, member_id_prefix_bidx, primary_payer)`. **`rating` NULL means honestly suppressed (sample floor / no money evidence) — never `0`.** |
| `qualify_rating_run` | run log for the 05:10 cron |
| `qualify_prefix_echo` | **empty, permanently.** See below. |
| `claims.qualify_watcher`, `claims.qualify_recent_search` | per-user Qualify state (0097), FK'd to `claims.app_user` |

**Run logs / ETL state**

| Table | Notes |
|---|---|
| `cmd_census_run`, `qualify_census_run`, `rollup_refresh_run` | per-job run logs; `error_label` is a **label only** — never payloads/URLs/PHI/filter criteria |
| `etl_run` | (0099) generic per-stage run log. A row left `status='running'` with `finished_at` NULL is the "platform-killed mid-run" signal — that is why the start row is INSERTed *before* the work |
| `pipeline_state`, `pipeline_lock` | (0099) the completion-chained pipeline. `last_ok_at` **is** the edge trigger: a dependent becomes due when every dependency's `last_ok_at` is newer than its own. Lock is a **lease expiry**, not a boolean — a boolean held by a killed function never clears |

#### 5.2 Two things in `collections` that look like to-dos and are not

**`qualify_prefix_echo` is permanently empty — do NOT wire `record_qualify_prefix_echo`.** The
problem it was minted for (turning a token back into a readable `GGS` prefix) is solved better
by `src/collections/prefixLabel.ts`, in-process, with no write and no query. The echo seam is
strictly worse on coverage: it can only ever label prefixes somebody already *searched*, so a
tape of the whole book would stay mostly masked for weeks, and it costs a write per search.
Ratified 2026-08-09.

**`'manual'` deposits are ADDITIVE, not a rank participant (0096) — AND THE WRITE PATH IS GONE
(2026-09-04).** Everything in this subsection still describes the VIEW correctly, and the two
historical `'manual'` rows are still there (both soft-deleted, $0 live), so the ranking semantics
below remain worth knowing. What is no longer true is that anything can CREATE such a row: the
Overview form, its three Server Actions and the data-layer writers were deleted after a ruling that
this app is not a system of record for money — "there is nobody manually entering payments through
this platform; the payments land in CollaborateMD already". Operators now record an expected
payment as a FORECAST in `staging.expected_payment_manual`, which this view does not reference and
which therefore cannot reach MTD. `collections.add_manual_deposit` / `remove_manual_deposit` still
exist and `claims_reader` still holds EXECUTE on them — a REVOKE is pending Alec's call — so the
capability is live in Postgres and dead in the application. Do not add a new caller.

**VERIFIED 2026-09-04, and by the method this repo ratified for `claims_reader` specifically:**
`has_function_privilege('claims_reader', …, 'EXECUTE')` returns **true** for both, and
`has_function_privilege('public', …)` returns **false** — so the grant is real and not
world-executable. It is a catalog check rather than an execution test *on purpose*, and the reason
is recorded in CLAUDE.md: **`postgres` cannot `SET ROLE claims_reader`** (no grant — re-confirmed
the same day via `pg_has_role`), so an execution test as that role is not possible from an operator
session, and "the reader's access was proven via `has_table_privilege`/`has_function_privilege`
instead. That is the correct split, not a shortcut."

⚠ AND EXECUTING THESE TWO IN PARTICULAR WOULD BE SELF-DEFEATING: `add_manual_deposit` INSERTs into
`collections.daily_collections`. Proving "nothing may write the ledger" by writing to the ledger
would leave a real row in the money table this whole change exists to protect. `has_function_privilege`
answers the same question and writes nothing.


`collections.daily_collections_resolved` is a three-branch view:

1. `cmd`/`workbook`/`deposit_sheet` — three competing *imports of the same deposits* —
   deduplicated **max-gross-wins**, one row per `(business_entity_id, facility_code, payment_date)`.
2. Lineage-only passthrough for group-code rows with no facility.
3. **`manual` — passes through untouched**, because it is money the machine feeds do not have
   yet, not a competing import.

Folding `manual` into the ranking would let a $32,000 hand-keyed row **replace** a real CMD
deposit on the primary financial surface. Manual rows are soft-deleted (`removed_at`), and the
cron's DELETE policy carries `source_tag <> 'manual'` as a **privilege**, not just a predicate.

### 5.3 `claims`

| Table | Notes |
|---|---|
| `claims_raw` / `claims` | The original 2024 CSV ingest. `collection_rate` is a **stored generated column** — `case when allowed_amount > 0 and abs(paid/allowed) < 100 then paid/allowed else null end` (0002 fixed the 0001 version). Feeds the query library + `mv_payer_gap` / `mv_distribution_count`. |
| `query_log` | Non-PHI args + summary + optional `identity_hash` (constrained to `^[0-9a-f]{64}$`). 1-hour default expiry. |
| `app_user` | RBAC. `user_id` is a **soft ref** to `auth.users.id` — deliberately no cross-schema FK. |
| `access_audit` | Who viewed what. `detail` is **non-PHI request context only**. |
| `user_grid_views` | Saved Explorer column layouts + `hidden_columns` |
| `audit_row` | **The Claims Audit workbench table.** Charge-grain, `unique(business_entity_id, row_fingerprint)`, upserted on `(business_entity_id, charge_debit_id)`. Encrypted patient name/DOB/member id + four blind indexes. `status_category` is a closed enum. `diagnoses` is PHI-free codes as jsonb. |
| `flag_rule` / `flag` | Rule registry + per-row findings. `flag.detail` is **PHI-FREE evidence only**. |
| `payer_alias` / `facility_alias` | Sheet-wording → match rules, and facility code → Office Name/Id |
| `billing_code_decision` | The JT sheet's code decisions; `active` is a generated column (`stopped_on is null`) |
| `audit_ingest_run` | Run log; `per_customer` is a non-PHI outcome array |

`claims.audit_row.facility_code` is a **log label only** — row-level facility attribution comes
from the report's Office Name via `claims.facility_alias`, never from the roster. Same for
`cmd_customer_id` (ingest provenance).

### 5.4 `vob`

`indigo_vob` is the pulled monday.com board, PK `monday_item_id` (a text PK, deliberately, so
there's no sequence and therefore no sequence grant). Benefit attributes are stored as
**verbatim extracted text**, not parsed numerics. Three blind indexes (member, prefix, group)
— nullable, because ~4% of VOBs have no member id.

- `member_benefits_latest` (matview) — `distinct on (member_id_bidx)` ordered by
  `vob_created_at desc`. This is what everything joins to.
- `member_benefits_current` (view), `employer_norm` via `vob.normalize_employer`.
- `sync_state` (one row per source) + `sync_run` (history). The **error split** in `sync_run`
  (`no_pdf` / `download_fail` / `api_missing`) exists because all three used to collapse into one
  counter, which is precisely how a monday API truncation hid inside what looked like a
  PDF-attachment problem.

`0010_vob_ai_foundation.sql` also created a forward-looking set (`benefit_checks`,
`benefit_check_services`, `claim_line_features`, plus `ref.payers`/`plans`/`service_codes`/
`diagnosis_codes`/`denial_codes`, `rag.*`, `audit.ai_*`). Treat that as scaffolding, not the
live VOB path — the live path is `indigo_vob` → `member_benefits_latest`.

> ⚠ Note there are **two `ref` schemas' worth of payer tables** in play: `ref.payers`/`ref.plans`
> from 0010 (product-plane scaffolding) and `ref.payer_identity`/`ref.payer_alias_map` from Veris
> 026 (the real payer-identity work). They live in the same schema and are *not* the same
> lineage. Check the migration number before assuming which one a query means.

### 5.5 `coding` and `code_intel`

- `coding.code_decision` — the coding-decision registry: which HCPCS + revenue code to bill for
  a `(payer_family, plan_alpha, employer_norm, level_of_care, facility_code)` cohort, with a
  lifecycle enum and effective dating + `superseded_by` self-reference. `hcpcs_suppressed` means
  **"NO HCPCS" is a billing method**, not a missing value. `code_decision_audit` records
  create/supersede/lifecycle transitions with before/after jsonb.
- `code_intel.*` — a richer, mostly-unwired policy model: `facility`, `payer`, `payer_plan`,
  `payer_entity_role`, `billing_policy` + `billing_policy_code_rule` + `billing_policy_claim_rule`,
  `policy_source_document`/`_excerpt`, `policy_change_event`, `ref_code` + `ref_code_relationship`.
  Nine PG enums live here (`code_intel.*_enum`). The quarterly CMS HCPCS sync writes `ref_code`
  and appends to `policy_change_event`.

---

## 6. Veris ML plane

**Status: paused, not abandoned.** The brains are off and the claims-facing UI is down.
`staging.*` / `ref.*` / `core.*` are owned by `claims_admin`; `claims_reader` has RLS-scoped
SELECT. `veris-data-notes.md` is the live ledger for this plane.

| Table | Purpose |
|---|---|
| `core.business_entity` | The two tenants. `cmd_account_number ~ '^[0-9]{6}$'`, UNIQUE. Ids seeded verbatim, **no default**. |
| `core.cmd_customer` | 8-digit CMD customer → tenant |
| `staging.payer_dim` | CMD payer dimension per tenant |
| `staging.claim_line` | The big one. Charge/credit grain, `unique(business_entity_id, charge_debit_id, credit_id)`. PHI encrypted. **Type-of-Bill is decomposed at ingest** into `tob_facility_type` / `tob_care_setting` / `tob_frequency`, and `is_training_eligible` is a generated column = `tob_frequency IN (1,3,7)` (excludes void `8` and in-flight interim-first `2`). |
| `staging.era_adjustment` | CARC/RARC per charge, denormalized category |
| `staging.payment_residual` | `residual` and `allowed_gap` are **stored generated columns**. `residual_type ∈ {BALANCE_DUE_INSURANCE, ALLOWED_GAP, MATH_GAP, CLEAN}`. `allowed_gap > 0` is the primary underpayment signal. |
| `staging.era_835_payment` | The X12 835 remittance envelope (BPR/TRN/N1\*PR), `unique(row_fingerprint)`. **This is the money read path — it carries no member id at all.** |
| `staging.era_835_adjustment` | The CAS triplet grain. `adjustment_index` is part of the grain on purpose so two byte-identical CAS triplets stay distinct rows — a sum-critical feed must not lose a real duplicate. |
| `staging.era_835_ingest_run` | Two-axis run log: pull outcomes (transport) vs parse/write outcomes (data). `pulls_failed_by_code` is codes and messages only — **never EDI, never a value**. |
| `staging.expected_payment_override` | Sheet-sourced expected payments. **`is_patient_specific` is the PHI-dropped flag** — the parser discards the client name and stores only whether the cell named an individual. |
| `staging.expected_payment_manual` | Operator `add`/`correct`/`suppress` on top of the sheet, with a per-kind shape CHECK so a "suppress carrying money" row is unrepresentable. |
| `staging.brain1_features` / `brain1_scores` | ML features (submission-time only) and scores. **Labels are explicitly marked "NEVER use as model inputs".** `shap_top_feature` is a feature *name* only, never a PHI value. |
| `staging.brain2_alerts`, `mv_payer_drift` | CARC drift detection (BOCPD / ADWIN / vector cluster shift) |
| `staging.claim_signatures`, `appeal_evidence` | Brain 3 hybrid retrieval — `halfvec(1024)` dense + sparse weights + a generated `fts_vector` |

**`ref` — global reference data, read-all, never tenant-scoped**

`remittance_code` (CARC/RARC + a human-reviewed reconciliation `category`), `carc_code`/
`rarc_code` (+ `*_embeddings`, `halfvec(1024)`), `cms_pfs_rate`, `nppes_provider`,
`payer_alias` (raw→canonical + family), and the payer-identity cluster: `payer_identity`
(`canonical_payer_id ~ '^pi_[a-z0-9_]+$'`), `payer_alias_map`, `payer_identity_never_merge`,
`payer_identity_merge_log`, `payer_brand`, `payer_brand_entity`.

Two constraints in `payer_alias_map` are load-bearing:
- `alias_norm = upper(btrim(alias_norm))` — the join key is **always** stored normalized, so a
  lookup can never silently miss on case/whitespace.
- The relationship↔canonical pairing CHECK makes "we deliberately did not pick a payer"
  unrepresentable as a guess: resolving relationships **must** name a canonical, non-resolving
  ones **must not**.

**`intel` — deliberately non-PHI.** `payer_policy_run` (cost/token/gate observability),
`payer_policy_finding` (the findings themselves + `halfvec(1024)` embedding + generated
`embed_tsv`), `payer_policy_run_check` (no_change / unreachable with a reason code).

⚠ In `payer_policy_finding`, `confidence` and `status` are **orthogonal and must never be
collapsed into one filter**: `confidence` = did the *model* verify the claim (epistemic);
`status` = did *our pipeline* verify the source (provenance). `status='quarantined'` means the
`source_url` was not in the run's retrieved-URL set — retained for audit, **excluded from
retrieval**.

---

## 7. How data actually flows

```
CollaborateMD Web API (one report at a time, per customer)
  │
  ├─ /api/cron/cmd-explorer   :00   ─┐
  ├─ /api/cron/indigo-explorer :30  ─┤→ collections.cmd_explorer_rows  (append-only, fingerprint)
  │                                  │→ collections.daily_collections  (source_tag='cmd',
  │                                  │   per-facility DELETE+INSERT via replaceCmdDailyForFacility)
  │                                  │
  ├─ /api/cron/cmd-census     :15   ─┤→ collections.cmd_charge_census  (upsert on
  ├─ /api/cron/indigo-census  :35   ─┘   (business_entity_id, charge_id))
  │
  ├─ /api/cron/refresh-charge-rollup :45  → REFRESH collections.cmd_explorer_charge_rollup
  │                                          (DB-only, no CMD call) then VACUUM (ANALYZE)
  ├─ /api/cron/era-835        08:50 → staging.era_835_payment + era_835_adjustment
  ├─ /api/cron/refresh-cmd-payer 10:50 → collections.cmd_payer_facility_monthly
  └─ /api/cron/billing-audit-consolidated 02:40/03:10/03:40 → claims.audit_row + claims.flag

monday.com ──→ /api/cron/qualify-census :22 → collections.qualify_facility_census
          └──→ vob-sync (GitHub Action)     → vob.indigo_vob → vob.member_benefits_latest

Google Sheets ─→ /api/cron/upcoming-overrides :55 → staging.expected_payment_override

Reads: app/lib/server.ts (composition root) → src/collections/*Query.ts → claims_reader pool
```

`app/vercel.json` declares **22 cron entries across 20 distinct routes**.

> **The `:41–:59` window is reserved — and the constraint is CMD-API contention, not the clock.**
> Two crons legitimately sit inside it because neither calls CMD: `refresh-charge-rollup` (:45,
> DB-only) and `upcoming-overrides` (:55, Google Sheets). `pipeline-tick` (every 5 min)
> necessarily lands in the band and enforces the rule *per stage*: every stage carries a
> `usesCmdApi` flag and CMD-calling stages are held with reason `cmd_quiet_window`.

⚠ **The ETL DAG is a fork, not the chain the schedule implies.** Verified from
`pg_get_viewdef`: `cmd_explorer_charge_rollup` reads `cmd_explorer_rows` and nothing else, so
**explorers → rollup**. Both census stages write `cmd_charge_census`, which **no stage in the
pipeline reads** — the census stages are *not* upstream of the rollup. Sequencing between CMD
stages is a **resource mutex** (one report at a time), modeled separately from `dependsOn`.

The pipeline is built and shipped **inert** — `/api/cron/pipeline-tick` does nothing without
`ETL_PIPELINE_ENABLED`, and the five standalone cron entries are still the production path.

---

## 8. Migrations

Two directories. **Never put a file in the wrong one.**

| Plane | Directory | Next number (as of 2026-08-12) |
|---|---|---|
| Product (`claims`, `collections`, …) | `supabase/migrations/00NN_*.sql` | **0101** |
| Veris ML (`staging`, `ref`, `core`, `intel`) | `SQL Schemas/0NN_*.sql` | **035** |

### The number is the live ledger, not the file listing

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 10;
```

On 2026-08-10 the qualify-watchers migration was numbered `0096` off a directory listing. While
it sat unapplied, a concurrent session authored and **applied** its own `0096_manual_deposits`,
whose `.sql` was untracked and on no ref — **nothing in git would ever have revealed the clash.**
It was caught only by re-verifying against the ledger immediately before apply, and renumbered
to 0097. Also: **`0095` consumed its slot with no file at all** (a one-shot retention job,
ledger `20260809073608`, applied and dropped in the same session). A version number is consumed
the moment it lands in the ledger — **never reuse one**, even when it left no file.

So: query the ledger **and** grep every worktree for untracked `.sql`.

### Required file shape

Every migration ships with a sibling `*_rollback.sql` and a header block:

```sql
-- 00NN — <one-line what>
--
-- WHY: <the reason, with MEASURED evidence where it is a perf change>
-- PHI DISCIPLINE: <what this does or does not expose>
-- OWNERSHIP: <who owns the created objects>
-- IDEMPOTENT: <why re-running is safe>
-- DEPENDENCY: <what must be applied first>
-- Rollback: 00NN_..._rollback.sql
```

Numbered section banners in the body; end with a commented
`-- N. Verification (run manually after apply)` block.

### Idempotency

- `IF NOT EXISTS` on tables and indexes.
- `DROP POLICY IF EXISTS` before `CREATE POLICY` — otherwise SQLSTATE 42710.
- **Never `DROP ROLE`.** CREATE-if-absent, then unconditional REVOKE/GRANT.
- Passwords stay out of band (`.env`), never in a migration.

### Ownership — the trap that costs two failed applies

`apply_migration` runs as `postgres`, a **non-superuser with BYPASSRLS**.
`GRANT claims_admin TO postgres WITH SET TRUE` is the intended standing posture, and `claims`
migrations create objects **born owned** via `SET ROLE claims_admin` … `RESET ROLE`. Revoking
that grant re-breaks the apply path with 42501 — do not "clean it up".

⚠ **That is true for `claims` ONLY. It is wrong for `collections`.** Every live `collections`
relation is `relowner = postgres` (measured 2026-08-05), so a `SET ROLE claims_admin` there
**downgrades** the applying role from owner to non-owner and fails
`42501: must be owner of table …`. In `collections`: write the plain statement with **no
`SET ROLE`**, and own SECURITY DEFINER functions as `postgres`.

### Conventions

- Money is `numeric(12,2)`, **never float**. Timestamps are `timestamptz`.
- Composite indexes on tenant-scoped tables **lead with `business_entity_id`**.
- After a matview refresh, `VACUUM (ANALYZE)` it so index-only scans stay hot (0069 grants
  MAINTAIN to the writer for exactly this).
- Statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) must be
  applied statement-by-statement via autocommit `execute_sql`, **not** `apply_migration` — see
  0070, 0081, 0092.
- **Merging a migration in a PR does not apply it to prod.** Same-PR code 500s until
  `apply_migration` runs. This has already caused an incident (0056 broke `/admin/user-logs`).

### The verification gate — all five, before any commit

```bash
npm test                    # root hermetic suite   — floor in CLAUDE.md
npm run typecheck           # root tsc (strict: noUncheckedIndexedAccess)
cd app && npm test          # app suite             — floor in CLAUDE.md
cd app && npm run typecheck # app tsc
cd app && npm run build     # catches bundler-only failures tsc cannot
```

⚠ **The pass counts are NOT repeated here, deliberately.** This block used to carry
`>=1439` / `>=831`; both were ratified 2026-08-11 and were **447 root and 207 app
tests low** by 2026-08-30, so a suite that had silently lost 447 tests would still
have "passed" the number printed on this page. CLAUDE.md's *Verification gate* is
the single authority and the only place the floors are re-measured — read them
there. A copy of a tripwire is a tripwire that stops firing.

Root `tsc` is stricter than app `tsc` — a test can be green in `app/` while root `tsc` is red.
The counts are a **tripwire, not a target**: fewer means tests were lost. They are `>=` floors
because suites grow and a hardcoded exact number rots into a false tripwire within days.

---

## 9. Landmines — read before you touch these

1. **`collections.cmd_payer_facility_monthly` holds two different populations, seam at 2026-06.**
   Rows for 2026-05 and earlier came from a 2026-06-25 manual CSV ingest of the Derek History
   Report. Rows from 2026-06 forward are written by `/api/cron/refresh-cmd-payer` from report
   `10093971`, whose filter windows on **payment date, not service date**. Measured live-vs-CSV
   coverage by service month decays monotonically (2026-06: 1202%, 2026-05: 155%, 2026-03: 60%,
   2025-12: 3.6%) — that is the signature of a payment-date window, **not a defect**. The cron's
   3-month trailing window never reaches 2026-05 or earlier, so the CSV history is never
   overwritten. Expect a definitional step at the boundary in the "By Payer" chart.

2. **Index payloads are priced by their widest text column, not their keys.** 0092's INCLUDE
   payload carries `primary_payer` *text*; the estimate priced only the HMAC token and came in
   **12× low** (169 MB vs "10–15 MB"). Settled 2026-08-07: **keep `primary_payer` in both
   payloads** — dropping it reproduces the pre-0092 3,561-buffer bitmap-heap path.

3. **Benchmark a rollup on the same date axis it uses.** 0093's size estimate was 1.4× low
   partly because the pairs/day benchmark was measured on `charge_date` while the table windows
   on `payment_received` — a different, larger population. And **price every text column**,
   including one whose value never varies (a constant `tenant_scope` cost 5 MB; 0094 dropped it).

4. **`SQL Schemas/031_payer_brand_allowlist.sql` is held ON PURPOSE — do not apply it to clear
   the backlog.** It creates `ref.payer_brand` + `payer_brand_entity` and **nothing reads
   either**. Being merged is not a decision to apply. If the wiring isn't coming, **delete 031
   rather than applying it** — an applied table with no caller is schema debt future readers will
   assume is load-bearing.

5. **`SQL Schemas/029`'s `NOT VALID` CHECK is permanent and deliberate.** The 695 pre-029
   confirmed `ref.payer_alias_map` rows are exempt forever, which makes
   `confirmed + reviewed_by IS NULL` a reliable "predates the boundary" marker. **Never
   `VALIDATE` it and never back-fill those 695 with a synthetic reviewer.**

6. **`supabase/migrations/0067_*` looks applicable but is stale as authored** — it drops 0068's
   covering index and 0069's MAINTAIN grant. Leave it alone.

7. **`collections.facility_assignments` is append-only.** A trigger
   (`facility_assignments_guard`) makes every column except the supersession pair immutable.
   Don't UPDATE it.

8. **`TREAT_FRCA` and `LSMH_DMH` are `source_group_code` lineage only — never a `facility_code`.**

9. **Never re-run the workbook ingest for a period CMD covers.** `src/collections/ingest.ts` is
   a frozen manual CLI; max-gross-wins would let a stale legacy import override authoritative CMD
   figures.

10. **`node-pg` returns `bigint` (int8) as a JavaScript *string*** while TypeScript says
    `number`. `Number.isSafeInteger` guards therefore reject and buttons die silently. Two known
    live instances remain (cohort-drilldown Reveal, coding-decision supersede).

11. **`x !== null` is TRUE for an absent field.** Coerce `(x ?? null)` at optional-snapshot
    predicates.

12. **A non-function export from a `'use server'` file passes the entire 5-command gate and then
    500s every Server Action on that page, unlogged.**

13. **Adding a column to the Qualify book-wide KPI query without checking the plan** silently
    drops it from an index-only scan to a heap read. At the 12-month range that is the
    ~8.3s → ~40ms class of regression. Refresh the rollup, then `VACUUM (ANALYZE)`.

---

## 10. Known drift and open questions

Things I found that are stated inconsistently across the repo's own docs. Verify before relying
on either side.

| Item | Status |
|---|---|
| **Indigo roster count** | `src/collections/cmdCustomers.ts` (source of truth) has **32 owned / 29 active** (3 retired: `10035467` 2026-08-06, `10036020` + `10036030` 2026-08-02). `CLAUDE.md` says 30; `.claude/rules/collections-crons.md` says 32. Trust the code. |
| **CMD report/filter ids** | `.claude/rules/collections-crons.md` names BXR `10091971`/`10147530`; `CLAUDE.md` says that pair is **dead** since 2026-07-31 and live is `10093959`/`10148478`. Trust `app/lib/server.ts`, never prose — these turn over fast. |
| **`0100_facility_assignments_guard_search_path.sql`** | **Authored, NOT applied.** Tracked on `fix/qualify-audit-wave1`. Apply is gated. |
| **`SQL Schemas/030`, `031`** | Authored, not applied. 031 is held on purpose (see §9.4). |
| **`employer_name` PHI classification** | Ruled 2026-08-14: non-PHI for Collections display/search (drop from `app/lib/phi.ts`'s `PHI_BASE_COLUMNS`) but **stays in the `PhiKey` union** so it can never reach `summary_stats` or an LLM. **The code on this branch still has it in `PHI_BASE_COLUMNS`** — the ruling has not shipped here. Employ**er** only, never employ**ee**. |
| **`src/collections/cmdExplorer.ts` fingerprint comment** | Says 14 fields; it hashes **18**. |
| **Indigo customer counts in `app/lib/server.ts` (~L1688) and the indigo-explorer route** | Say 36 and 37 respectively. Both stale. |
| **`DEFAULT_MODEL` in `src/agent/agent.ts`** | Still `claude-opus-4-8`. Flag before relying on it for new AI work. |

---

## 11. Where to go next

| You want | Read |
|---|---|
| The live ledger — **wins over this doc** | `veris-data-notes.md` (repo root) |
| Standing rules, verification gate, context map | `CLAUDE.md` |
| PHI boundary + locked query semantics | `.claude/rules/query-library.md` |
| Idempotency, ownership, rollback, grant/RLS gates | `.claude/rules/sql-migrations.md` |
| CMD ingest, filters, fingerprints | `.claude/rules/collections-crons.md` |
| `business_entity_id`, the GUC, fail-closed scope | `.claude/rules/tenancy.md` |
| Server Actions, RBAC, PHI in the UI, build traps | `.claude/rules/nextjs-app.md` |
| Qualify rating model + sample gate | `.claude/rules/qualify.md` |
| Claims Audit scope derivation + row identity | `.claude/rules/billing-audit.md` |

Path-scoped rules in `.claude/rules/` load automatically when you touch matching files — they
are binding for this codebase and outrank any generic plugin skill.
