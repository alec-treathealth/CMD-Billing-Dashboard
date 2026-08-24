# CMD AR Automation — Build Doc v2

**Repo:** `alec-treathealth/CMD-Billing-Dashboard` · **Prepared for:** Alec Lowi / Treat Health
**Supersedes:** "Qualify v2 Build Doc.md" (v1) · **Date:** July 27, 2026
**Audience:** Claude Code, executing inside the repo · **Status:** plan only — nothing in here has been applied

---

## 0. How to use this doc

This is a **build doc, not a spec handoff**. It is written to be executed by Claude Code in the repo, one phase at a time, with a human HOLD gate between phases (the same cadence as `docs/qualify-build-series.md`).

**Before writing any code, read in this order:**

1. The root `CLAUDE.md` — the operating rules. Read in full; "Standing rules" and "Verification gate" are non-negotiable. Then the matching `.claude/rules/*.md` for the files you touch (here: `sql-migrations.md`, `collections-crons.md`).
2. `veris-data-notes.md` — the live tribal-knowledge ledger. **When it conflicts with CLAUDE.md, veris-data-notes wins** (it is updated per-apply).

> §8 below audited the OLD `docs/CLAUDE.md` (914 lines, 234 commits stale). That file was
> rewritten and split on 2026-07-28 into the root `CLAUDE.md` + `.claude/rules/`; every drift
> §8 lists is now fixed there. §8 is retained as the audit trail. The old file is frozen at
> `docs/archive/CLAUDE-2026-07-06.md`.
3. `supabase/migrations/0058_cmd_charge_census.sql` — the canonical new-table template.
4. `src/collections/cmdCensus.ts` + `cmdCensusCron.ts` — the canonical feed template.

**Where v1 was wrong, this doc says so explicitly.** v1 was written from the five Excel workbooks plus a read of the repo. Several of its load-bearing claims did not survive verification against the code. Those corrections are in §2 and they change the plan materially — the ETL work is roughly a third of what v1 implied, and the part v1 deferred to "Phase 4, a product decision" is the part that actually delivers the value.

---

## 1. The reframe (read this before the phase plan)

v1's thesis: *five manual spreadsheets exist because three ETL gaps exist; close the gaps, the spreadsheets go away.*

The evidence does not support that thesis. Measured directly from the workbooks:

| Workbook | Rows | What it actually is |
|---|---|---|
| NASH-AR.xlsx | **45** claims | A **worklist** — claims a human is actively chasing, with call-log notes |
| PCMH-AR.xlsx | **15** claims + 26 med-rec rows | Same, smaller |
| AR-Claims-Spreadsheet-Alec.xlsx | 4,105 rows → **673 distinct** → 324 patients | A **raw CMD export**, ~6× fanned out, run ad hoc |
| Master-Facility-Profile.xlsx | 17 facility tabs | A **hand-curated reference document**, not an export of anything |
| AR-Cheat-Sheet.docx | — | Static glossary |

Two of these are not reports at all. NASH-AR and PCMH-AR are 45 and 15 rows — a rep's active follow-up queue, where the *Notes* column (rep name, reference number, check number, callback date) is the payload and the CMD columns are just context. v1 correctly noticed that Notes "isn't a CMD export field" and then deferred it to Phase 4 as "a product decision, not an ETL one."

That is backwards. **The notes are the product.** If Phases 1–3 ship and Phase 4 doesn't, NASH and PCMH keep their spreadsheets — because a read-only dashboard doesn't replace a worklist, it just adds a sixth place to look.

Meanwhile the ETL half is much cheaper than v1 assumed:

- The "90-day cap" that v1 says forces a new `cmd_ar_aging` table **does not exist in the codebase**. It is a property of a CMD-side saved filter. Widening the window is a filter change, not a schema change.
- `Charge Fromdate Age` is a **real, verified CMD column** — it is sitting in sample data already in the repo. v1 flagged it as unverified and made Phase 0 a blocker.
- `collections.cmd_charge_census` already has 19 of the ~23 columns an AR aging table needs, and **currently has zero readers** — it is a write-only table waiting for a consumer.

**Revised thesis:** the AR aging feed is a small extension of an existing table plus one saved filter. Ship that in Phase 1, then spend the real effort on the worklist + notes layer, which is where the manual work actually lives. Treat the Master Facility Profile as a separate, low-urgency data-curation project — not an ETL phase.

**What we are optimizing for:** number of humans who stop opening CMD and pasting into Excel. Not number of tables shipped.

---

## 2. Corrections to v1 (verified against the repo)

Each item below was checked against code, migrations, or the source workbooks. Cited by file and line where it matters.

### 2.1 ❌ "The census is capped at a trailing 90-day window"

**False as stated.** There is no 90-day constant, no `interval '90 days'`, no date predicate anywhere in `src/collections/cmdCensus.ts`, `cmdCensusCron.ts`, `app/lib/server.ts`, or `supabase/migrations/0058_*`. The only "90" is prose in two header comments (`cmdCensus.ts:7`, `0058_cmd_charge_census.sql:7`).

The window lives entirely in the CMD **saved filter**, selected by env with no default (`app/lib/server.ts:1305-1319`):

```ts
function requiredCensusFilterId(envVar: 'CMD_BXR_CENSUS_FILTER_ID' | 'CMD_INDIGO_CENSUS_FILTER_ID'): string {
  const v = process.env[envVar]?.trim();
  if (!v) throw new Error(`Missing ${envVar} (the CMD census saved-filter id; set in env, no default)`);
  return v;
}
```

Filter IDs appear only in a comment (`cmdCensusCron.ts:7`): BXR `10148130` / Indigo `10148129`. They are **not** in `.env`, `.env.local`, or `.env.example` — they are Vercel-only.

The table itself is unbounded and grows monotonically (UPSERT on `(business_entity_id, charge_id)`, `last_seen_at` bumped, **no DELETE or TRUNCATE grant to anyone** — `0058:120`).

**Consequence:** v1's Gap 1 does not require a new table. It requires (a) a wider CMD saved filter and (b) ~4 new columns on `cmd_charge_census`. See §4.

### 2.2 ✅ `Charge Fromdate Age` is real and already in the repo — but not in any mapped feed

`grep "Charge Fromdate Age"` returns zero hits in `src/`, `app/`, `supabase/`, `SQL Schemas/`. Confirmed gap in the *mapping*.

But the column exists verbatim in sample data already committed:
`data/cmd_batch_20260621_092220/<customerId>/BATCH TEST 2.csv`, **column 152**, for all 16 sampled BXR customers. That export is **report `10091573` / filter `10147140`** (`data/cmd_batch_20260621_092220/manifest.json`), 187 columns, ~33k rows/customer.

The eight bucket values are a closed set, confirmed identical across NASH-AR, PCMH-AR, and Alec's export:

```
a) Less than 30 days   b) 31 to 60 days     c) 61 to 90 days     d) 91 to 120 days
e) 121 to 150 days     f) 151 to 180 days   g) 181 to 365 days   h) Over 1 year
```

**Consequence:** Phase 0 shrinks from "probe CMD to find out if this column exists" to "confirm the census saved filter can select it." Most of the risk is already retired offline.

### 2.3 ⚠️ `Facility NPI` is NOT on report 10091573 — v1 assumed it comes from CMD

Report 10091573's 187 columns contain `Claim Facility ID` (col 103) but **no `Facility NPI`, no `Facility Name`, no `Facility Address 1`**. Alec's export *does* have all three (header row 6) — so Alec's export is a **different saved report**, not 10091573.

Also note `src/public_data/nppes_loader.ts:5-9`, which explicitly warns against exactly this assumption:

> *"INTERNAL facility ids (8-digit, e.g. '10272308'), NOT NPIs. The build spec assumed facility_id = NPI — false. There is no facility→NPI crosswalk in the data."*

**Consequence:** don't map `Facility NPI` from the feed. There are 20 distinct facility NPIs across 17 entities (some have two locations) — that is a **dimension**, not a fact. It belongs in the facility reference table (§6), sourced from the `ServicingMailing` tab, joined at read time. This removes a column from Phase 1 and moves it to Phase 3.

### 2.4 ✅ The 20-entity coverage question is fully resolved — and it exposes a live bug

v1 Risk #2 asked whether Alec's 20 named entities reconcile against `BXR_CUSTOMERS` (15) / `INDIGO_CUSTOMERS` (32). They do, exactly:

**Alec's 20 = BXR's 15 active + the 5 accounts `cmdCustomers.ts:28-35` deliberately excludes** (Billing Service Account `10030472`, Teen Mental Health Texas `10035166`, Treat MH Colorado `10035974`, Wellness Recovery Center `10033951`, Houston Mental Health `10035976`). **Zero Indigo involvement.** This is a BXR-only build.

Of those 5, only one has AR. Facility distribution in Alec's export (16 real facilities + `No Facility`):

| Facility | Rows | In `BXR_CUSTOMERS`? |
|---|---|---|
| TREAT MENTAL HEALTH NEVADA LLC | 465 | ✅ |
| TELEHEALTH MH LLC | 400 | ✅ |
| TREAT MENTAL HEALTH CALIFORNIA LLC | 383 | ✅ |
| LONESTAR MENTAL HEALTH | 312 | ✅ |
| TREAT MENTAL HEALTH WASHINGTON LLC | 307 | ✅ |
| KENTUCKY WELLNESS CENTER LLC | 284 | ✅ |
| NASHVILLE MENTAL HEALTH LLC | 277 | ✅ |
| TREAT MENTAL HEALTH TEXAS LLC | 271 | ✅ |
| TENNESSEE BEHAVIORAL HEALTH LLC | 252 | ✅ |
| CALIFORNIA MENTAL HEALTH LLC | 230 | ✅ |
| DALLAS MENTAL HEALTH LLC | 230 | ✅ |
| **TEEN MENTAL HEALTH TEXAS LLC** | **192** | ❌ **excluded from the roster** |
| PACIFIC COAST MENTAL HEALTH LLC | 174 | ✅ |
| TREAT MENTAL HEALTH TENNESSEE LLC | 115 | ✅ |
| LOS ANGELES MENTAL HEALTH LLC | 104 | ✅ |
| FIRST RESPONDERS OF CALIFORNIA LLC | 89 | ✅ |
| `No Facility` | 19 | n/a |

Billing Service Account, Houston MH, Treat MH Colorado, and Wellness Recovery produce **zero rows** — they can stay excluded.

> ### 🚩 Live data-integrity defect: the Teen MH TX alias is wrong
>
> `supabase/migrations/0042_cmd_facility_aliases.sql:67` (applied to prod 2026-07-10) maps:
>
> ```sql
> ('TEEN MENTAL HEALTH TEXAS LLC', 'TREAT_TX')  -- owner-confirmed typo of TREAT MENTAL HEALTH TEXAS
> ```
>
> The Master Facility Profile contradicts this. Teen MH TX has its **own NPI (`1124973086`)**, its own tab (`TEEM MH`), its own remittance address, and its own CMD customer account (`10035166`, which has working sample data in `data/cmd_batch_20260621_092220/10035166/`). Treat MH Texas is NPI `1316718554`.
>
> Two separate legal entities are currently being merged into one `facility_code` on every surface that joins through `cmd_facility_aliases`. **192 AR rows** are affected.
>
> **This is a HOLD item for Alec, not a decision for Claude Code.** Do not silently change the alias. Confirm with the owner who called it a typo, then either (a) add `TEEN_MH_TX` to `collections.facilities` + `BXR_CUSTOMERS` and repoint the alias, or (b) document why the merge is intentional. Whichever way it goes, it must be settled *before* Phase 1 — an AR worklist that attributes 192 claims to the wrong entity is worse than a spreadsheet.

### 2.5 🚩 The export is ~6× fanned out — v1's row counts are misleading

`AR Claims Spreadsheet - Alec.xlsx`, sheet 1: **4,105 data rows, 673 distinct row-tuples, 324 distinct patients, 121 distinct claim statuses.** Adjacent rows are frequently exact duplicates (rows 7/8 and 4109/4110 are byte-identical).

This is a charge-line-grain export with join fan-out (likely across credits/adjustments — report 10091573 has 99 `Adjustment Amount by Code X` columns, and `SQL Schemas/002_cmd_etl_ingest.ts` already unpivots exactly that shape).

Sheet 2's `$16,983,972.58` primary balance is a **CMD server-side aggregate**. Whether CMD summed the deduplicated charge grain or the fanned grain is unverified.

**Acceptance gate for Phase 3:** the new rollup must reconcile against `$16,983,972.58 / $690,249.03 / $0.00` for the same filter window, **or** the discrepancy must be explained in writing before anyone trusts the number. Do not ship a payer-priority view that quietly disagrees with the spreadsheet by 6×.

### 2.6 ⚠️ The payer-priority rollup needs three columns that exist in no mapped feed

Sheet 2's headers are `Charge Primary Balance (Sum)`, `Charge Secondary Balance (Sum)`, `Charge Tertiary Balance (Sum)`. None appear in report 10091573 (which has `Charge Balance Due Ins`, `Charge Balance Due Pat`, `Charge Balance At Collections`, `Charge Primary Paid`, `Charge Secondary Paid`) or in `cmdExplorer.ts`'s `HEADERS` map.

Sheet 2 carries the same run-date and filter header as sheet 1, which means CMD returned **both sheets from one report run**. The transport already supports this — `readZip` in `cmdPayer.ts:223-270` returns all CSV entries, and `describeReportZip` (`cmdPayer.ts:358-368`) enumerates them. Every current consumer takes only the first entry.

**Consequence:** the rollup may come free with the detail pull. Confirm in Phase 0 whether the census/AR filter's zip carries a second summary CSV.

### 2.7 ⚠️ Master Facility Profile tabs are heterogeneous — v1 generalized from one tab

v1 says each facility tab has "two side-by-side blocks," confirmed against NASH. That is true of NASH. It is **not** true of the workbook:

- **NASH tab:** Facility Name / TIN / NPI ×2 / Service Address ×2 / Remittance / Doctor+NPI / bed count / carrier-phone list / contacts — plus a clean `HCPCS/CPT → Billed Amount → Description` table and a `REV CODE → Billed Amount → Description` table. Parseable.
- **TMH TX tab:** no code/rate tables at all. Instead a free-text `Contracts-Payer/Effective Date | LOC/Rates/Terms` block (`"Aetna 8/15/2024" → "IOP $275.00 / BPS $189.00 / OP 105..."`), plus a `Payment Status` block (`BCBS → EFT`, `Beacon → Checks`) that exists on no other tab.
- **ServicingMailing tab:** 993 rows, one *NPI* per row not one facility per row (CAMH has 2, NASH has 2, LSMH has 2, TREAT_TN has 2, TREAT_CA has 2), sparse blank spacer rows, and free-text annotations in ID fields (`"1124842620 (not servicing)"`, `"missing facility profile"` for Houston MH).

**Consequence:** "a one-time load script, 17 facilities × 3–6 codes each — small enough to hand-verify" understates this by a lot. Parsing free-text contract terms into `billing_policy_code_rule` is an NLP-ish extraction with no ground truth. See §6 for a much smaller v1.

### 2.8 ✅ `code_intel` (0043–0045) is still unapplied — v1 is right, and it should stay that way for now

Confirmed: `docs/code-intel-AUDIT.md:3` still reads *"migrations NOT applied"*, its §7 pre-rollout checklist has **every box unchecked**, and `git log` shows exactly one commit (`d58d4b7`, 2026-07-10) with no follow-up. No mention in `veris-data-notes.md` (the apply ledger, updated 2026-07-27), which every other applied migration gets.

Two corrections to v1's description: 0043 defines **12 tables**, not 7 (v1 omits `ref_code`, `ref_code_relationship`, `payer_entity_role`, `billing_policy_claim_rule`, `policy_change_event`). And `code_intel.facility` is confirmed 8 columns with no TIN/address/bed_count/contacts.

**Recommendation:** do not make the facility reference master depend on applying 0043. Applying a 12-table unaudited schema to get a 17-row lookup table is the wrong trade. See §6.

### 2.9 ✅ `cmd_charge_census` has zero readers today

Every reference is a write path or a comment (`cmdCensus.ts`, `cmdCensusCron.ts`, the two cron routes, `app/lib/server.ts:725`). `qualifyQuery.ts` reads `cmd_explorer_charge_rollup`, not the census.

This is good news: extending the census carries no read-side regression risk. It also means the census's row quality has never been exercised by a user. **Phase 1 must include a data-quality pass**, not just a schema change.

Census mapper policy worth knowing (`cmdCensus.ts:115-150`): only `charge_id` and `patient_name` gate a row; every other field is lenient (blank/unparseable → NULL). Skip labels are `'charge_id: missing'` / `'patient_name: missing'`. `BATCH = 500`.

### 2.10 Minor corrections

- `staging.*` RLS is **not** "scoped by business_entity_id via a `claims_reader` role." The isolation policies have no `TO` clause (`001:132-133`); `claims_reader` is granted SELECT separately. Two independent mechanisms.
- `ref.remittance_code` is deliberately **not** tenant-scoped (`001:89`, "codes are universal (X12 standard)"). The 98 codes are seeded by `SQL Schemas/000_seed_remittance_codes.ts`, not by the DDL.
- 0042 was applied to prod under the name `0039_cmd_facility_aliases` (version `20260710073420`) and renumbered in the file. Don't reuse 0039–0041.
- `'No Facility'` is **deliberately absent** from the alias table (`0042:22-24`). 19 rows in Alec's export carry it. Any join must handle it — LEFT JOIN, resolve to `'Other'`, never INNER JOIN.

---

## 3. Ground truth: the stack as it actually is

Claude Code must match these. They are not suggestions.

### 3.1 Layering (`cmdCensusCron.ts:40-43`)

```
src/collections/*        pure, injectable, transport-agnostic.
                         No next/cache. No env reads. No secrets.
app/lib/server.ts        composition root. Reads env, builds pools, does auth,
                         injects roster + fetch + writer + transforms.
app/app/api/**/route.ts  ~15-line adapter. Zero logic.
```

A new feed that reads `process.env` inside `src/collections/` is wrong even if it works.

### 3.2 Cron route template (copy verbatim)

`app/app/api/cron/cmd-census/route.ts` in full:

```ts
import { handleCmdCensusCron } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function route(req: Request): Promise<Response> {
  const { status, body } = await handleCmdCensusCron({
    method: req.method,
    authorization: req.headers.get('authorization'),
  });
  return Response.json(body, {
    status,
    headers: status === 405 ? { Allow: 'GET' } : { 'Cache-Control': 'no-store' },
  });
}

export const GET = route;
```

Auth is `CRON_SECRET` bearer, constant-time (`src/bearerAuth.ts`), GET-only, checked in `app/lib/server.ts`. `!secret` → 401 (fails closed).

### 3.3 Cron slots — `app/vercel.json`

Hourly slots **taken**: `:00` cmd-explorer, `:15` cmd-census, `:30` indigo-explorer, `:35` indigo-census, `:45` refresh-charge-rollup. Daily: `02:10`, `02:20`, `02:40`, `09:17`.

Staggering is deliberate — **CMD allows one report at a time per account**. A new hourly cron must take a free slot (`:05` or `:50`) and must not overlap a BXR pull. If Phase 1 rides the existing census cron (recommended), no new slot is needed.

> `docs/CLAUDE.md` §7 claims the CMD cron "is the ONLY scheduled writer (the single entry in `app/vercel.json` crons)." There are **10 crons**. CLAUDE.md is stale here — see §8.

### 3.4 Migration conventions

- Dashboard plane: `supabase/migrations/00NN_<snake_slug>.sql`. Highest is **0070** → **next is `0071`**.
- Veris plane is separate: `SQL Schemas/0NN_*` (next `021`). Never mix directories.
- **Rollback goes beside the migration** (`0071_<slug>_rollback.sql`), not in `supabase/rollbacks/` — that moved at 0049.
- Header comment block is mandatory and long: `-- 00NN — <what>`, then `WHY:` (with measured evidence), `PHI DISCIPLINE (docs/CLAUDE.md §2):`, `OWNERSHIP:`, `IDEMPOTENT:`, `DEPENDENCY:`, `Rollback:`. Numbered section banners in the body. A trailing commented `-- N. Verification (run manually after apply)` block.
- **Applied via the Supabase MCP `apply_migration` tool as `postgres`, after a human HOLD gate.** Not the Supabase CLI, not a script — there is no migrate script in `package.json`. `apply_migration` is transactional, so `CREATE INDEX CONCURRENTLY` and `VACUUM` cannot go through it.
- Ownership at apply time: `collections.cmd_charge_census` is **postgres-owned** → plain DDL, no `set role`.

### 3.5 RLS + grants idiom (from `0058:54-63, 119-163`)

```sql
revoke all on collections.<t> from public, anon, authenticated, service_role, cmd_rollup_writer;
grant select, insert, update on collections.<t> to cmd_rollup_writer;
grant select                 on collections.<t> to claims_reader;

alter table collections.<t> enable row level security;   -- ENABLE, never FORCE

-- READER: PERMISSIVE. Never GUC-scope a reader policy.
create policy <t>_reader_select on collections.<t> for select to claims_reader using (true);

-- WRITER: GUC-scoped, 1-arg current_setting (RAISES fail-closed if unset)
create policy <t>_writer_update on collections.<t> for update to cmd_rollup_writer
  using      (business_entity_id = current_setting('app.business_entity_id')::uuid)
  with check (business_entity_id = current_setting('app.business_entity_id')::uuid);
```

Four rules, all load-bearing:
1. **ENABLE, not FORCE** — the writer is a non-owner without BYPASSRLS; FORCE would subject the apply path to the policies with no admin carve-out.
2. **Reader policies stay `USING (true)`** — cross-tenant reads scope app-side via `business_entity_id = any($ent::uuid[])`. A GUC-scoped reader policy returns zero rows. `0033:124-136` actively asserts this post-flip.
3. **1-arg `current_setting`** deliberately — it RAISES when unset, so an unscoped write can't slip through.
4. Every index leads with `business_entity_id`.

Tenant UUIDs (never re-mint): BXR = `af504ab6-3dcd-4aa4-a93c-27bc58de4088`. Indigo = `141d459c-f371-4229-9a92-ace198e940bb`.

All tenant-scoped writes go through `withTenant()` (`src/veris/withTenant.ts`) → txn-local `set_config('app.business_entity_id', $1, true)` with GUC read-back verification. Never call `pool.query()` inside the callback. No network calls inside the callback.

### 3.6 PHI

- Encryption: libsodium `crypto_secretbox_easy`, stored as `nonce ‖ ciphertext` bytea. `encryptPhi` / `decryptPhi` from `src/collections/phiCrypto.ts`. Key `LIBSODIUM_KEY` (64 hex chars).
- `phiCrypto` must be loaded via `createRequire` (libsodium-wrappers ships a broken ESM build) and **throws if it reaches the browser**.
- Blind indexes: keyed HMAC-SHA256 with a **separate** `INDEX_HMAC_KEY`. **Ingest paths use the `…Safe` variants** (all-null if key unset — never break the money path); query paths use the throwing variants.
- Census writer pattern to copy: `cmdCensus.ts:192-207` (`buildCensusParams`).
- UI: `app/lib/phi.ts` `PHI_BASE_COLUMNS` / `isPhiColumn()` / `displayCell()`. Renders `••••••` by default; reveal is per-row, explicit, gated on `canRevealPhi`, audited to `claims.access_audit`. Nothing persisted to `localStorage` or cookies.

### 3.7 The verification gate (all five, before any commit)

```bash
npm run typecheck            # root — differs from app on noUncheckedIndexedAccess
cd app && npm run typecheck
npm test                     # root, hermetic node:test
cd app && npm test           # .tsx only — a .ts test in app/test/ silently never runs
cd app && npm run build
```

Plus two build-only traps from `docs/CLAUDE.md` §15:
- Any route pulling in `phiCrypto` needs `serverExternalPackages` — webpack must not bundle libsodium.
- **Run `next build` with `.env` moved aside** before any push that adds an env-dependent import. Local builds with `.env` present mask Vercel-only bundler failures, and `tsc` will not catch this class.

Show results and **HOLD** before any migration, commit, push, or deploy. Never add a `Co-Authored-By` trailer.

### 3.8 UI conventions

- Tokens in `app/tailwind.config.ts`. Dashboard chrome uses `var(--brand-bar/-ink/-accent/-soft)`, not hardcoded teal.
- Wide grids use `max-w-[1800px]` (the Collections page width), not the doc's `max-w-5xl`.
- Grid: `app/components/data-grid.tsx` (`SELECT_CLASS`, `ControlSelect`, `useColumnDnD`, `ColumnsPanel`, `SortHeaderCell`, `Pager`). Charts: **recharts only**.
- Motion: `ease-out`, `duration-150` fast / `animate-ths-reveal` 0.22s panel. Refetch of visible content → `opacity-60`, **never collapse to a skeleton**.
- Pagination is **keyset**, never OFFSET.

### 3.9 Saved grid views — reuse, don't rebuild

`claims.user_grid_views` (0046/0047) is generic. An AR grid reuses it with **no migration**:

```ts
const COLUMNS = [...];                                   // {key,label,phi?,numeric?}
const IS_PHI = new Set(COLUMNS.filter(c => c.phi).map(c => c.key));
const DEFAULT_ORDER = COLUMNS.map(c => c.key);
function deriveLayout(v: GridViewRow) { return deriveGridLayout(v, DEFAULT_ORDER, IS_PHI); }
```

Then reuse `listGridViews` / `saveGridView` / `setDefaultGridView` / `deleteGridView` verbatim, seeded from the page via `Promise.all`.

> **HOLD item:** saved views are keyed `(app_user_id, view_name)` with **no surface discriminator**. An AR view named "Default" collides with a Collections view of the same name. `deriveGridLayout` degrades safely (falls back to default order) rather than breaking, so this is cosmetic — but if per-surface separation is wanted, it needs a migration adding a `surface` column. Ask; don't decide.

---

## 4. Phase plan

Each phase ends at a HOLD. Nothing proceeds without the verification gate green and Alec's sign-off.

### Phase 0 — Resolve the four blockers (no code)

Three of v1's Phase 0 questions are already answered (§2.2, §2.4, §2.6). What remains:

| # | Question | How to answer | Blocks |
|---|---|---|---|
| 0.1 | **Teen MH TX: separate entity or typo?** | Ask the owner who confirmed the typo in 0042. Evidence for "separate": distinct NPI `1124973086`, own CMD account `10035166`, own profile tab, own remittance address. | Phase 1 |
| 0.2 | Can the census saved filter (`10148130`) select `Charge Fromdate Age`, and can its date window be widened to full history? | CMD UI, or `npm run probe:cmd` with the census filter id. Probe prints **structure only** — headers + row counts, never values. | Phase 1 |
| 0.3 | Does the census zip carry a **second** summary CSV with `Charge Primary/Secondary/Tertiary Balance (Sum)`? | `describeReportZip` already enumerates every entry — the probe will show it. | Phase 3 |
| 0.4 | What is the row-count and runtime cost of full history vs. the current window? | From the probe's row counts. Alec's full-history pull was 4,105 rows for 20 entities; the census is per-customer and unbounded — estimate before widening. | Phase 1 sizing |

**Deliberately deferred:** the 835 ERA contract (`cmd835.ts`) is unverified but blocks nothing here. Bulk historical export via CMD professional services is not needed — the per-customer report path already in production covers it.

**Deliverable:** a short findings note appended to `veris-data-notes.md`. No code.

---

### Phase 1 — AR aging on the existing census

**Goal:** every open charge across all BXR facilities, with its age bucket, queryable — replacing Alec's ad-hoc export and the *data* half of NASH-AR / PCMH-AR.

**Not a new table.** Extend `collections.cmd_charge_census`.

**1a — Migration `0071_cmd_charge_census_aging.sql`** (+ `0071_cmd_charge_census_aging_rollback.sql`)

```sql
alter table collections.cmd_charge_census
  add column if not exists age_bucket_raw text,      -- 'g) 181 to 365 days' verbatim
  add column if not exists age_days_min   smallint,  -- parsed, sortable
  add column if not exists age_days_max   smallint,  -- NULL for 'h) Over 1 year'
  add column if not exists charge_balance numeric(12,2);

alter table collections.cmd_charge_census
  add constraint cmd_charge_census_age_bucket_ck
  check (age_bucket_raw is null or age_bucket_raw ~ '^[a-h]\) ');

create index if not exists cmd_charge_census_ent_age
  on collections.cmd_charge_census (business_entity_id, age_days_min desc nulls last);
```

Follow the §3.4 header format and the §3.5 grant/RLS idiom. Existing grants already cover `cmd_rollup_writer` / `claims_reader` on the table — reapply unconditionally for idempotence. Non-PHI columns, so no crypto change.

`charge_balance` is included on the bet that the AR filter exposes a balance column. **If Phase 0.2 shows it doesn't, drop it from 0071** rather than shipping a column nothing writes.

**1b — Bucket parser** — new pure module `src/collections/ageBucket.ts`:

```ts
export interface AgeBucket { raw: string; minDays: number; maxDays: number | null; }
export function parseAgeBucket(raw: string | null | undefined): AgeBucket | null;
```

Closed set of 8 (§2.2). Unknown input → `null`, not a throw — matches the census mapper's lenient policy (`cmdCensus.ts:115-150`). Pure and dependency-free so it unit-tests in isolation and can be imported client-side for labels.

Test `test/ageBucket.test.ts`: all 8 known strings, unknown string, null, empty, whitespace/case variants.

**1c — Mapper + writer** — extend `src/collections/cmdCensus.ts`:
- Add `'Charge Fromdate Age'` to the header map (exact string, verified §2.2).
- Add the 4 columns to `INSERT_COLS` and `REFRESH_COLS`.
- Derive `age_days_min` / `age_days_max` via `parseAgeBucket`.
- **Do not add `Facility NPI`** (§2.3) — it's a dimension, Phase 3.

**1d — Widen the filter.** Point `CMD_BXR_CENSUS_FILTER_ID` at the full-history filter. Env change only, no code. **Watch the first scheduled run** — `docs/CLAUDE.md` §2 requires verifying the next cron logs success after any change touching the production ingest path.

**1e — Data-quality pass.** The census has never been read (§2.9). Before building UI, run and report:
- Row count per `(facility, age_bucket)` vs. Alec's export distribution.
- Skip-label counts from the run log (`charge_id: missing`, `patient_name: missing`).
- Duplicate/fan-out check: does the census's `(business_entity_id, charge_id)` UPSERT grain collapse the ~6× fan-out (§2.5)? It should. **Prove it.**
- `No Facility` row count and how it resolves through `cmd_facility_aliases` (LEFT JOIN, never INNER).

**Acceptance criteria**

- [ ] `0071` applied to a branch DB first, then prod, via `apply_migration` after HOLD.
- [ ] Census run completes green for all BXR customers; `collections.cmd_census_run` shows `status='ok'`.
- [ ] `age_bucket_raw` non-null on ≥ 99% of rows carrying a `Charge Fromdate Age` value.
- [ ] Distinct `age_bucket_raw` values ⊆ the 8-value closed set.
- [ ] Facility coverage = 16 (or 17 if 0.1 resolves to "separate entity") + `No Facility`.
- [ ] Distinct charge count reconciles with Alec's 673-distinct figure within a stated tolerance, **or** the gap is explained.
- [ ] All five verification commands green.

---

### Phase 2 — The AR worklist (the actual product)

**This is the phase that retires spreadsheets.** Phases 1 and 3 produce numbers; Phase 2 produces a place to work.

Scope: a filterable AR grid at `/dashboard/ar` (or as a Collections view — Alec's call) where a rep can filter to their facility, sort by age, and **leave a note on a claim**.

**2a — Notes table, migration `0072`**

```sql
create table if not exists collections.cmd_ar_note (
  id                 bigint generated always as identity primary key,
  business_entity_id uuid not null,
  charge_id          text not null,
  note_enc           bytea not null,           -- libsodium, PHI posture
  author_user_id     uuid not null references claims.app_user (user_id),
  created_at         timestamptz not null default now()
);
```

**Append-only. No UPDATE, no DELETE grant.** A call log is an audit trail; editing history is the wrong affordance and the wrong compliance posture.

`note_enc` is encrypted because rep notes routinely carry incidental PHI — the NASH sheet's own notes contain patient-adjacent reference and check numbers. `0043`'s comments flagged exactly this: *"an AR/issue tracker that carries member initials + DOS is PHI... must follow the existing encrypt-identifiers + blind-index pattern."* No blind index needed unless notes must be searchable — **do not build note search in v1.**

Writes go through a `SECURITY DEFINER` function owned by `claims_admin`, taking the **server-resolved** user id — copy the `claims.save_grid_view` pattern from `0046` exactly. The app (`claims_reader`) gets no direct DML.

**2b — UI.** Reuse `app/components/data-grid.tsx` + saved grid views (§3.9). Notes render as a per-row expandable thread. Follow the §3.8 conventions; `max-w-[1800px]`.

**2c — Migration** — one-time load of the ~60 existing notes from NASH-AR and PCMH-AR, keyed by charge. If the historical notes can't be reliably keyed to a `charge_id`, **don't force it** — load them as a read-only archive attachment on the facility instead, and start the log clean.

**Acceptance criteria**

- [ ] A NASH AR rep can complete a full follow-up cycle — filter, sort by age, read, add note — without opening CMD or Excel.
- [ ] Notes are encrypted at rest; no note text in logs, URLs, `summary_stats`, or `query_log`.
- [ ] Note writes are attributed server-side and cannot be forged client-side.
- [ ] PHI columns render masked by default; reveal is audited to `claims.access_audit`.
- [ ] **The real gate:** NASH and PCMH stop maintaining their spreadsheets. If they don't, the phase isn't done — find out why before building more.

---

### Phase 3 — Payer-priority rollup + facility dimension

**3a — Rollup.** If Phase 0.3 found a second summary CSV, map it. Otherwise compute from census `charge_balance` × `Charge Current Payer Priority`. Either way, **reconcile against `$16,983,972.58 / $690,249.03 / $0.00`** (§2.5) before it ships. A number that silently disagrees with the spreadsheet by 6× is worse than no number.

**3b — Facility dimension.** Add NPI / TIN / addresses to `collections.facilities` (a small `alter table`, ~17 rows), hand-loaded from the `ServicingMailing` tab. Handle the multi-NPI entities (CAMH, NASH, LSMH, TREAT_TN, TREAT_CA each have two) with a child `collections.facility_npi` table, not a second column. This is what makes `Facility NPI` available on the AR view (§2.3) — as a join, not a feed column.

**Explicitly out of scope:** `code_intel` / migration 0043. See §6.

---

### Phase 4 — Medical Records cross-reference

Smallest item, and v1 is right: DOS ↔ claim number is derivable from the census (`charge_date` + `charge_id` + patient) once Phase 1 lands. A view or a grid filter, not an ingest path. Confirm with PCMH that the derived version actually matches what they track by hand before deleting their tab — the 26 rows may encode something the export doesn't.

---

## 5. What we are deliberately NOT building

Naming these prevents them from creeping back in.

| Not building | Why |
|---|---|
| A new `collections.cmd_ar_aging` table | The census already is it (§2.1). A second charge-grain table is a second source of truth. |
| `Facility NPI` as a feed column | It's a dimension with 20 values across 17 entities. Join it (§2.3). |
| Applying `code_intel` 0043–0045 | 12 unaudited tables to get a 17-row lookup. Wrong trade (§6). |
| Parsing free-text contract terms into `billing_policy_code_rule` | No ground truth, heterogeneous source (§2.7). Manual curation with a script assist. |
| Login credentials in any table | Password manager. v1 got this right. |
| Note full-text search | Encrypted-at-rest notes need a blind index to search. Not v1. |
| 835 ERA work | Unverified contract, blocks nothing here. |
| Anything Indigo | This is BXR-only (§2.4). |

---

## 6. On the Master Facility Profile — a smaller recommendation

v1 proposes applying `0043_bh_billing_code_intelligence.sql`, extending `code_intel.facility`, and backfilling the workbook. Three problems:

1. **The dependency is oversized.** 0043 is 12 tables, 377 lines, unaudited, with an untouched pre-rollout checklist. The immediate need is a 17-row facility lookup.
2. **The source doesn't parse.** NASH has clean code/rate tables; TMH TX has free-text contract terms and a payment-status block (§2.7). "17 facilities × 3–6 codes" describes NASH, not the workbook.
3. **It doesn't solve the stated problem.** v1's own Risk #7 is the real one: *who owns updates once it's a table?* An effective-dated schema without a write process is a second place rates drift, not a fix.

**Recommended instead — two steps, in this order:**

**Step 1 (Phase 3b, cheap):** extend `collections.facilities` with TIN / addresses / bed count, plus a `collections.facility_npi` child table. ~17 rows, hand-loaded, hand-verified. Solves the "who is this facility, what's the NPI, where do remits go" question — which is what the AR view and the ServicingMailing tab actually need.

**Step 2 (separate initiative, not this build):** the billed-rate and contract-terms side. Before any schema work, answer: *who edits a rate, through what interface, and what makes their edit authoritative?* If the answer is "Alec edits the spreadsheet," a database table is strictly worse than the spreadsheet — same drift, more friction. Only when there's a real owner and a real workflow does `billing_policy` earn its 12 tables.

That is a product question, not an engineering one, and it should not gate the AR work.

---

## 7. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Teen MH TX merged into TREAT_TX** — 192 AR rows attributed to the wrong legal entity | 🔴 High | Phase 0.1. Owner decision, not a code change. Blocks Phase 1. |
| 2 | Widening the census filter changes production ingest volume/runtime; CMD is one-report-at-a-time | 🔴 High | Estimate row counts in Phase 0.4 first. Watch the first scheduled run. `maxDuration = 300` is the ceiling. |
| 3 | The $16.98M rollup can't be reproduced (fan-out, §2.5) | 🟠 Med | Hard acceptance gate on Phase 3a. Explain or don't ship. |
| 4 | Notes carry incidental PHI | 🟠 Med | Encrypted at rest from day one (2a). Non-negotiable. |
| 5 | Census has never been read; unknown data quality | 🟠 Med | Phase 1e is a gate, not a nice-to-have. |
| 6 | Reps don't adopt the worklist and keep the spreadsheets | 🟠 Med | Phase 2's acceptance criterion is adoption, not deployment. Watch for a month. |
| 7 | `docs/CLAUDE.md` is stale in ≥6 places (§8) — Claude Code follows a wrong rule | 🟡 Low | Read `veris-data-notes.md` alongside it. Surface conflicts, never silently resolve. |
| 8 | Migration `0067` looks applicable but is **STALE** — drops 0068's covering index + 0069's MAINTAIN grant | 🟡 Low | `app/lib/qualify/contract.ts:283` says do not apply as-authored. Leave it alone. |
| 9 | Saved grid view name collision across surfaces (§3.9) | 🟢 Cosmetic | Degrades safely. Ask before adding a `surface` column. |
| 10 | `No Facility` rows (19) break a naive facility join | 🟢 Low | LEFT JOIN, resolve to `'Other'`. Never INNER. |

---

## 8. `docs/CLAUDE.md` staleness — read with care

CLAUDE.md is the stated source of truth and is right about all the standing rules. It has drifted on facts:

| CLAUDE.md says | Reality |
|---|---|
| CMD cron is "the ONLY scheduled writer (the single entry in `app/vercel.json` crons)" | **10 crons** |
| "239 tests pass" | 71 root `.test.ts` files + 8 app `.test.tsx`; count unverified |
| `/claims` Claims Explorer is live | `app/app/claims/page.tsx` is a `redirect('/')` stub since 2026-07-15 |
| 0027/0028 "shelved and uncommitted" | Committed (`77cc3be`); collections plane is multi-tenant (0030–0033 landed) |
| Migrations "0001–0011" / "0006–0022" | Runs through **0070** |
| Dashboard nav = three tabs (Overview / Payers / Collections) | Two tabs + a separate top-level `/qualify` |
| Next Veris migration = 020 | 020 exists → next is **021** |

Also stale in code comments, don't propagate: `app/lib/server.ts:701` and `:1277` and `indigo-explorer/route.ts:7` say 37/36 Indigo customers — the array is **32**. `cmdExplorer.ts:189,195` reference filter `10147499` — the live one is `10147530`. `cmdExplorer.ts:57` says the row fingerprint hashes 14 fields — it hashes 18.

**Rule for Claude Code: surface every conflict in the session output. Never silently pick a side.**

---

## 9. Naming note

The uploaded v1 was filed as `Qualify v2 Build Doc.md`. **Qualify is a different feature** — a cross-tenant admissions lead-qualification surface (`/qualify`, `app/lib/qualify/*`, role `admissions_seat`), currently behind a maintenance gate with an `alec@treathealth.ai` bypass.

The overlap is real but narrow: "Qualify v2" is the *feed* series, and its Feed 2 is `collections.cmd_charge_census` — the same table this build extends. That's why the AR work is cheap. But the surfaces are unrelated, and mixing the names will cause a future session to touch the wrong thing.

Filed here as **CMD AR Automation**.

---

## 10. Source ledger

**Verified in repo** (file:line cited inline):
`src/collections/` — `cmdPayer.ts`, `cmdCustomers.ts`, `cmdExplorer.ts`, `cmdExplorerSeed.ts`, `cmdCensus.ts`, `cmdCensusCron.ts`, `cmd835.ts`, `cmdProbe.ts`, `claimStatus.ts`, `phiCrypto.ts`, `blindIndex.ts`, `entityScope.ts`, `facilities.ts`, `gridViewLayout.ts`, `qualifyQuery.ts` · `src/bearerAuth.ts`, `src/tenants.ts`, `src/veris/withTenant.ts`, `src/public_data/nppes_loader.ts` · `app/lib/server.ts`, `app/lib/actions.ts`, `app/lib/access.ts`, `app/lib/phi.ts`, `app/lib/qualify/contract.ts`, `app/middleware.ts`, `app/vercel.json` · `supabase/migrations/` — `0006`, `0027`, `0030`, `0033`, `0042`, `0043`, `0044`, `0045`, `0046`, `0047`, `0050`, `0055`, `0057`, `0058`, `0067`, `0068`, `0069`, `0070` · `SQL Schemas/001`, `002`, `000_seed_remittance_codes.ts` · `docs/CLAUDE.md`, `docs/code-intel-AUDIT.md`, `docs/design-system.md`, `docs/qualify-build-series.md`, `veris-data-notes.md`, `docs/veris-runbook.md` · `package.json` (root + app), `tsconfig.json`

**Verified sample data:** `data/cmd_batch_20260621_092220/manifest.json` and `<customerId>/BATCH TEST 2.csv` (report 10091573 / filter 10147140, 187 columns, 16 BXR customers)

**Verified workbooks** (read directly, cell-level): `AR Claims Spreadsheet - Alec.xlsx`, `NASH AR.xlsx`, `PCMH AR .xlsx`, `Master Facility Profile.xlsx`

**External** (unverified this pass, carried from v1): CollaborateMD [HL7 API](https://www.collaboratemd.com/legal/hl7/) · [Partners / Web API](https://www.collaboratemd.com/partners/) · [migration guidance](https://medibilling.app/migration/collaboratemd)
