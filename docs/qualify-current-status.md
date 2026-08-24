# Qualify v2 build plan — verification status

Read-only reconnaissance run 2026-08-03 (UTC; local date 2026-08-02) against
prod `dbpabchpvipipkzkogta` and the working tree on branch `staging`. Nothing was
changed. Every figure below is an aggregate, count, or null-rate — no row, member
id, name, or DOB was read into this report.

**Plan under review:** `qualify-v2-build-plan.md` — at the **repo root**, not
`docs/`. Untracked (`git ls-files` returns nothing for it), as the plan itself
states. The companion `Qualify v2 — design prototype prompt.md` is also at the
root and also untracked.

Marks: **CONFIRMED** · **CHANGED** (old → new) · **WRONG** · **UNVERIFIABLE**
(could not be reached from this session; stated, not glossed).

---

## Headline

The plan's core premise survives intact. The four tables are empty, every column
it depends on exists, and the "backfill project, not a schema-design project"
framing is correct.

What does not survive: **the verification-gate test counts (both wrong by a wide
margin), the VOB catch-up run numbers (23/13, not 48/36), the "0068/0070
covering index" (0068's index no longer exists), and the CMS PFS coverage figure
(55.6%, not ~47%).**

**§3 (monday) has now been fully verified using the deployed
`MONDAY_SECRET_API_KEY`, and two of its three "traps" are wrong.** Lonestar is
not a stripped-down board — it is structurally identical to Nashville. The
`Lost Auth Days` negative-number trap does not exist. The IQ column is not
empty. Details in §D, which replaces the earlier UNVERIFIABLE finding.

---

## A. Prod data — the plan's core premise

### The four empty tables — CONFIRMED

| Table | Plan says | Measured |
|---|---|---|
| `vob.claim_line_features` | 0 | **0** |
| `vob.benefit_checks` | 0 | **0** |
| `vob.benefit_check_services` | 0 | **0** |
| `ref.plans` | 0 | **0** |

Non-null rates are not reportable: all four are empty. Every column the plan
depends on **does exist** (verified via `pg_attribute`, since matview/table
columns were the thing that misled the earlier reading):

- `vob.claim_line_features` — `turnaround_days`, `final_status`,
  `date_of_service`, `allowed_amount`, `patient_responsibility`, `auth_on_file`,
  `denial_code_id` — all present. CONFIRMED.
- `vob.benefit_checks` — `deductible_remaining`, `oop_remaining`,
  `oop_benefits`, `coinsurance_percent`, `auth_required`, `auth_obtained` — all
  present. CONFIRMED.
- `vob.benefit_check_services` — `coverage_status`, `reimbursement_basis`,
  `auth_required`, `medically_necessary` — all present. CONFIRMED.
- `ref.plans` — `network_type` present. CONFIRMED.

`claim_line_features` is keyed on `date_of_service`, not a payment date —
CONFIRMED. The structural argument in §1 holds.

### `member_benefits_latest` vs `member_benefits_current`

| Claim | Status | Evidence |
|---|---|---|
| `latest` is a MATVIEW, `current` is a plain VIEW | CONFIRMED | `pg_class.relkind` = `m` and `v` respectively |
| matview is 14 MB | CONFIRMED | `pg_total_relation_size` 14 MB (heap 9728 kB) |
| built by migration 0063 | CONFIRMED | `0063_vob_member_benefits_matview.sql` |
| 22,903 rows | **CHANGED** | **22,959** (both relations) — +56 |
| 4,057 distinct prefixes | **CHANGED** | **4,066** (both relations) — +9 |
| max `vob_created_at` 2026-07-31 | CONFIRMED | `2026-07-31`, both relations |
| the two agree exactly | CONFIRMED | `except all` in both directions returns **0 rows**; all coverage rates identical |
| app reads the matview at `src/collections/cmdExplorerQuery.ts:138,293` | CONFIRMED | exact lines, both `vob.member_benefits_latest` |

**Naming trap the plan will hit:** there is **no `alpha_prefix` column**. The
prefix column is `member_id_prefix_bidx` — a keyed-HMAC blind index, not a
readable alpha prefix. Any Phase B code that names `alpha_prefix` fails at
runtime, and any comparables logic that assumes it can *read* a prefix value is
wrong: it can only match on the blind index.

**Internal contradiction in the plan.** §1 correctly rules "read the matview."
But §4's schema sketch says `employer_norm ... → joins member_benefits_current`
and §6 says "`member_benefits_current` supports it today." Repo-wide,
`member_benefits_current` has **zero runtime references** — it appears only in
comments, migration files, and `etl/vob/docs/`. Phase B should say
`member_benefits_latest` throughout.

### Coverage rates (§1 table and §6)

Measured on `vob.member_benefits_latest`, n = 22,959. Identical on `_current`.

| Column | Plan says | Measured | Status |
|---|---|---|---|
| `funding` | 97.8% | **97.82%** | CONFIRMED |
| `employer_norm` | 100% | **99.96%** | **CHANGED** (9 nulls) |
| `policy_type` | 99.3% | **99.26%** | CONFIRMED |
| prefix | 100% | **100.00%** | CONFIRMED |

Immaterial to the Phase B argument, but `employer_norm` is not 100% and the plan
leans on that number twice.

### `staging.payer_dim` — CONFIRMED

286 rows; `network_status` is `'Unknown'` for **all 286** (single group, no
nulls, no other value). The plan's "do not source network from `payer_dim`" is
well founded.

### `ref.cms_pfs_rate` — CONFIRMED with one CHANGED figure

- 52 rows / 52 distinct HCPCS — CONFIRMED.
- "manual one-shot script" — CONFIRMED: `src/public_data/cms_pfs_loader.ts`, no
  cron wiring anywhere in `app/app/api/cron/` or `src/routes`.
- "covers ~47% of lines" — **CHANGED: 55.59%.** 272,132 of 489,554
  `collections.cmd_explorer_charge_rollup` lines carry a `cpt_code` present in
  `ref.cms_pfs_rate` (`cpt_code` itself is 100% populated).

The recommendation to retire it is unaffected — but note the loader's own header
says it *writes as `claims_admin`*, which is a standing-rules exception the plan
should name explicitly if it touches that file.

---

## B. The VOB sync narrative (§1)

### Mechanism claims — all CONFIRMED

- `vob.sync_state` holds exactly **1 row**, upserted `on conflict (source)` —
  `etl/vob/vob_cron_sync.py:290`. A missed run leaves no trace. CONFIRMED.
- `no_pdf` retries ignore the watermark — `etl/vob/vob_cron_sync.py:247`
  (`if not url: no_pdf += 1; continue`, commented "retried next run"). CONFIRMED.
- `cmd_rollup_writer` already writes `sync_state` — CONFIRMED:
  `INSERT, SELECT, UPDATE`. (`claims_reader` and `consolidated_reader` hold
  `SELECT` only.)

### The catch-up run numbers — **WRONG**

Plan: *"The catch-up run upserted 48 rows and dropped `errors` 84 → 36."*

Persisted state in `vob.sync_state` (source `indigo_monday_1606316049`):

| Field | Value |
|---|---|
| `last_run_at` | 2026-08-02 23:10:12 UTC |
| `upserted` | **23** |
| `errors` | **13** |
| `note` | `errors=13 no_pdf/0 download_fail` |
| `board_items` | 37,928 |
| `admitted` | 33,467 |

The reconciliation identity the plan itself proposes holds exactly and
independently confirms the figure: `admitted` 33,467 − `vob.indigo_vob` rows
33,454 = **13** = `errors`.

So the run landed 23 upserts and left 13 errors, not 48 and 36. The timestamp
(23:10:12) is consistent with the plan's "dispatched 23:07," so this is the same
run — the numbers are simply misreported. The *argument* is unharmed (the
watermark did not move; max `vob_created_at` is still 2026-07-31, exactly as the
plan predicts). Only the figures need correcting.

Freshness at time of check: `last_run_at` was **6.7 hours** old — inside the
proposed 26h alarm threshold. Healthy right now.

---

## C. INN/OON extraction (§2, Phase D)

| Claim | Status | Evidence |
|---|---|---|
| `network_status` is not extracted from the VOB today | CONFIRMED | `vob.indigo_vob` has 32 columns, none network-related |
| `indigo_vob` and `member_benefits_*` carry `schema_version` + `extraction_flag` | CONFIRMED | both columns present on all three relations |
| "the VOB parser is already versioned — add the field and bump the version" | **CHANGED — materially understated** | see below |

Live `schema_version` distribution across the 22,959 latest rows:

| `schema_version` | `extraction_flag` | Rows | Share |
|---|---|---|---|
| V2 | (null) | 15,050 | 65.6% |
| V1 | (null) | 4,503 | 19.6% |
| **UNKNOWN** | **UNRECOGNIZED_SCHEMA_VERSION** | **2,302** | **10.0%** |
| V3 | (null) | 770 | 3.4% |
| V3 | (empty string) | 334 | 1.5% |

"Bump the version" implies one current parser. There are **three live parser
generations plus a 10% bucket the parser already failed to recognize**. Phase D's
"backfill what is re-parseable" is a three-way backfill with a hard 2,302-row
floor of un-parseable VOBs, and the plan does not budget for it. The V3
`extraction_flag` also splits null vs empty-string, which any flag predicate
has to handle.

---

## D. Monday (§3, Phase G) — VERIFIED

An earlier draft of this report marked §3 unverifiable. That was a tooling
problem on my side, not an access problem, and the conclusion was wrong. Both
the diagnosis and the corrected findings are below.

### Why the first attempt failed

Two different monday identities are in play:

| Path | Identity | Result |
|---|---|---|
| monday MCP connector | **"Treat Admin"** (105905397) | cannot see the boards |
| `MONDAY_SECRET_API_KEY` in root `.env` (deployed) | **Alec Lowi** (106016047), `is_admin: true`, account Indigobilling (9524077) | **full access** |

All three boards are `board_kind: private` in workspace 2613676. The MCP
identity is not a subscriber, so `get_board_info` returned "not found or you
don't have access" — which reads like a wrong board ID but is a permissions
result. The board IDs in the plan were right all along. Verified with the
deployed key (query only; the token was never printed or logged):

| Board | ID | Items |
|---|---|---|
| Nashville MH Admissions Census | 7422342993 | 229 |
| Lonestar MH Admissions Census | 8401390206 | 172 |
| Facility Info | 7475219124 | 23 |

**Security note for Phase G:** the deployed credential is a *personal
admin-scoped* token for `alec@treathealth.ai`. An ingest built on it inherits
full account-admin rights over every monday board — well beyond read access to
27 census boards, and it breaks if Alec's account changes. Phase G should
provision a dedicated service identity with read access to exactly the census
boards and Facility Info. Flagging as a least-privilege gap, not a blocker.

### Column IDs (§3 table) — all CONFIRMED

Every one of the seven column IDs the plan lists for Nashville is exact:
`admit_status___1`, `numeric_mkt2rb5c`, `formula_mkt2dqph`, `formula_mm2x1kew`,
`date_mkt28z4m`, `color_mkvdf5qe`, `color_mkt6dbme`.

Formulas match the plan verbatim:

```
Days in RTC      IF({admit_status___1} = "Discharged",
                    Add(ROUND(DAYS({date4}, {date}), 0), 1),
                    ROUND(DAYS(TODAY(), {date}), 0))
Lost Auth Days   MINUS({numeric_mkt2rb5c}, {formula_mkt2dqph})
```

Label sets are exact:

- **IQ** — `65%+`, `50%+`, `30%+`, `15%+`, `0%`. CONFIRMED.
- **VOB Status** — `Insurance`, `Cash`, `SCA`, `Scholarship`, `Denied`. CONFIRMED.
- **Admit Status** — `Open Bed (Male)`, `Open Bed (Female)`,
  `Open Bed (Either M/F)`, plus `Pending Admit`, `Admitted`, `Discharged`,
  `Holding/Hospital`. CONFIRMED (the plan lists only the three Open Bed values).

### Trap 1 — "board schemas are inconsistent" — **WRONG as stated, right by accident**

Plan: *"Lonestar (8401390206) returns only `admit_status___1` and `payment__1` —
no auth days, no UR date, no IQ."*

Lonestar has **23 columns — the same 23 as Nashville**, same titles, same types,
including `Total Auth Days` (`numeric_mkt2shja`), `Next UR Date`
(`date_mkt2exhh`), `Days in RTC` (`formula_mkt2bdqf`), `Lost Auth Days`
(`formula_mm2xp8bj`) and `IQ` (`color_mkt6jw7y`). It is one of the *fully*
instrumented boards. The chosen counter-example is exactly backwards.

The likely cause of the original error: querying Lonestar with *Nashville's*
column IDs. Monday mints per-board IDs for the same logical column
(`Total Auth Days` has **10 distinct IDs across 27 boards**), so an ID-keyed
fetch silently returns only the handful of legacy shared IDs — of which
`admit_status___1` and `payment__1` are two.

There **is** a real schema split, but it is a clean two-family split, not
per-board chaos. Across all 27 census boards:

| Column | Boards carrying it |
|---|---|
| `Total Auth Days` | **27 / 27** |
| `Next UR Date` | **27 / 27** |
| `VOB Status` | **27 / 27** |
| `Admit Status` · `Days in RTC` · `Lost Auth Days` · `IQ` | **13 / 27** |

The 14 boards missing those four are the **outpatient/telehealth family** (all
`Treat MH *`, both `Telehealth *`, `Modesto`, `AMH`, `FRCA`, `MY Teen`,
`Teen MH Texas`). They aren't uninstrumented — they use a different vocabulary:

- `Status` instead of `Admit Status`
- **`Days in OP`** instead of `Days in RTC` (the LOS concept exists on both)
- an explicit **`LOC`** status column, which the residential family lacks
- no `Lost Auth Days`, no `IQ`

So the plan's "per-board column map plus a conformance report" recommendation is
still correct, and its "auth-fit only for instrumented facilities" caveat is
wrong: `Total Auth Days` is universal. What varies is the LOS denominator
(`Days in RTC` vs `Days in OP`) and whether an IQ band exists.

### Trap 2 — "`Lost Auth Days` lies when `Total Auth Days` is null" — **WRONG**

Plan: *"The formula subtracts from null and yields a confident negative (−17,
−4, −2 observed on admitted patients)."*

Not reproducible on either board:

| Board | Rows | Rows with blank `Total Auth Days` | Their `Lost Auth Days` | Negative values, all rows |
|---|---|---|---|---|
| Nashville | 229 | 94 | **blank in all 94** | **0** |
| Lonestar | 172 | 46 | **blank in all 46** | **0** |

Monday's `MINUS()` propagates blank rather than coercing to zero, which is the
safe behavior. The guard the plan mandates ("treat the factor as null unless
`Total Auth Days IS NOT NULL`") is still *correct defensive practice* and costs
nothing — but it should be described as cheap insurance, not as a fix for an
observed defect, because the defect is not there.

### Trap 3 — "the payer dropdown is not a join key" — **CONFIRMED**

The column is `payment__1` ("Payment"), **53 labels**. Every collision the plan
names is real: bare `BCBS` alongside `BCBS TX` *and* `BCBS of TX`; `Aetna` and
`AETNA`; `UHC` and `United Healthcare`. Also `BCBS of AL` / `BCBS Alabama`,
`BCBS MN` / `BCBS Minnesota`, `Anthem BC of KY` / `Anthem BCBS of KY`.

Worse than the plan says: the list mixes payers with non-payers — `Private Pay`,
`Cash`, `Scholarship`, and `Answered Call` are all labels. Resolving payer
identity from the member-ID prefix instead is the right call.

### "Two things worth stealing"

**IQ bands — CONFIRMED as the right scale, but the plan's premise is WRONG.**

Plan: *"The column is empty — designed and never used."* It is actively in use:

| Board | IQ populated | 65%+ | 50%+ | 30%+ | 15%+ |
|---|---|---|---|---|---|
| Nashville | **86 / 229 (37.6%)** | 14 | 33 | 38 | 1 |
| Lonestar | **68 / 172 (39.5%)** | 14 | 21 | 24 | 9 |

This strengthens the recommendation considerably. Adopting the bands isn't just
borrowing vocabulary — there are ~154 human-assigned labels on these two boards
alone to calibrate or back-test the computed band against. That is a genuine
asset the plan currently writes off.

**Bed capacity — CONFIRMED.** `Facility Info` (7475219124) has `# of Beds`
(`numbers__1`, numeric) and `LOC` (`dropdown__1`) with exactly the five values
claimed: `Detox/Res`, `Residential`, `IOP`, `Adolescent`, `VIOP`, across **23**
items. Group titles encode capacity as claimed — Nashville's groups are
`Pending Admit`, `Broad St (8 Beds COED)`, `Rutland Rd (12 Beds COED)`,
`Discharged`.

Unlisted bonus on Facility Info: a `BH` dropdown (`SUD` / `Mental Health` /
`Eating Disorder`) and `VOB Email` / `UR Email` columns.

### Other §3 figures

| Claim | Status | Measured |
|---|---|---|
| workspace 2613676 "A. Admissions (Main)" | CONFIRMED | exists |
| "~24 census boards" | **CHANGED** | **27** real census boards (62 non-subitem active boards in the workspace) |
| Nashville is a live census board | CONFIRMED | 229 items — but only **18 `Admitted`**; 204 are `Discharged` |
| "roughly half of admitted Nashville rows have no auth days" | **CHANGED** | **4 of 18 = 22.2%** (Lonestar: 1 of 11 = 9.1%) |

`Next UR Date` is populated on 132 / 229 Nashville rows, so the UR banner in §5
has real data behind it.

All monday figures above are aggregates. Item-level queries requested column
values only — no item names were fetched, so no patient identifiers left monday.

---

## E. Registry and migration 0075 (§4)

| Claim | Status | Evidence |
|---|---|---|
| No `coding` schema exists | CONFIRMED | `pg_namespace`: audit, auth, claims, collections, core, cron, extensions, graphql, graphql_public, public, rag, realtime, ref, staging, storage, supabase_migrations, vault, vob |
| `0074` is the latest product migration | CONFIRMED | `0074_audit_row_scope_source.sql` is the highest-numbered file in `supabase/migrations/` |
| `0075` is free | CONFIRMED | no `0075_*` on disk; matches CLAUDE.md's "next: 0075" |
| `0073`/`0074` each have a paired rollback | CONFIRMED | both `_rollback.sql` files present |
| `coding_editor` role does not exist yet | CONFIRMED | roles present: `claims_admin`, `claims_reader`, `cmd_rollup_writer` |

**Sheet contents — UNVERIFIABLE.** The 47 rows / 12 facility blocks / 26
payer-plan labels, the verbatim headers, the seven drift points, the
`PCMH`/`CAMH` clone, the `Test Status` enum values, and every listed ingest
defect come from a Google Sheet not reachable from this session. None of §4's
data claims were checked.

**Unflagged hazard for whoever writes 0075.** The applied-migration ledger is
not a reliable picture of what is live. `supabase_migrations.schema_migrations`
shows `0072` (applied 2026-08-02) and `0073`/`0074` (2026-07-29), but **0067
through 0071 are absent from it entirely** — while 0070's index *is* live in
`pg_indexes`. Some migrations were applied outside the ledger. Do not use that
table to decide what still needs applying.

---

## F. Rating v2 and data confidence (§5, §6)

| Claim | Status | Evidence |
|---|---|---|
| App invents Strong/Watch/Weak at 50/30 | CONFIRMED | `app/lib/qualify/rating.ts:37` `RATING_OK_MIN = 50`, `:39` `RATING_WARN_MIN = 30`, `:47` labels `Strong / Watch / Weak` |
| `sampleGate.ts` thresholds are 3/10 | CONFIRMED | `app/lib/qualify/sampleGate.ts:27` `QUALIFY_RATING_MIN_PATIENTS = 3`, `:32` `QUALIFY_RATING_CONFIDENT_PATIENTS = 10` |
| "must stay inside the 0068/0070 covering index" | **CHANGED** | see below |

**There is only one covering index, not two.** `0070` line 68 explicitly runs
`drop index concurrently if exists collections.cmd_charge_rollup_entity_payment_cov;`
and its own header (line 59) states 0068's `_cov` "is SUPERSEDED by `_cov_m` and
is dropped below." Live `pg_indexes` on `collections.cmd_explorer_charge_rollup`:

```
cmd_charge_rollup_entity_payer_payment
cmd_charge_rollup_entity_payment
cmd_charge_rollup_entity_payment_cov_m     <- the only covering index
cmd_charge_rollup_group
cmd_charge_rollup_id
cmd_charge_rollup_member
cmd_charge_rollup_prefix
```

`cmd_charge_rollup_entity_payment_cov` is **absent**. §6's constraint should read
"must stay inside 0070's `cmd_charge_rollup_entity_payment_cov_m`."

Also absent: `cmd_explorer_patient_name_bidx` (0066/0067) — consistent with the
Client Name feature still being gated off.

---

## G. Phase 0 and Phase H code references (§7)

| Claim | Status | Evidence |
|---|---|---|
| `QUALIFY_MAINTENANCE` kill switch exists, on by default | CONFIRMED | `app/lib/qualify/maintenance.ts:6,15` |
| Agent still defaults to `claude-opus-4-8` | CONFIRMED | `src/agent/agent.ts:44` `export const DEFAULT_MODEL = 'claude-opus-4-8';` |
| `streamCollectionsAiAnalysis` pattern at `app/lib/actions.ts:1364` | **CHANGED** (minor) | the `ReadableStream<string>` result type is at **1366–1368**; the call site is at **1395**; the import alias at **46**. Cite 1366 or 1395. |

---

## H. Verification gate (§9) — both counts **WRONG**

| Suite | Plan says | **Actual (HEAD `a1ddfae`)** |
|---|---|---|
| root `npm test` | 697 pass / 0 fail | **889 pass / 0 fail** |
| `cd app && npm test` | 127 pass / 0 fail | **176 pass / 0 fail** |

Root `npm run typecheck` is clean (`tsc --noEmit`, no output).

These are tripwire numbers — a plan that tells a future session to expect 697
will make a session that sees 889 think something is wrong, and worse, will mask
a genuine loss of ~190 tests. Correct them to **889 / 176**.

**The root count moved during this review.** The first pass measured **880** at
`a44b292`, the tree's HEAD when the session began. PR **#65** (staging → main,
merged 2026-08-03 07:17 UTC) then landed the deposit-reconciliation work, adding
`test/cmdDailyAggregate.test.ts` and `test/reconcileDeposits.test.ts` — +9 tests,
880 → 889. Both figures were correct for their tree; only 889 is current.

That PR also updated `CLAUDE.md`'s tripwire from 869 to **889**, so the earlier
observation in this report that `CLAUDE.md` was 11 tests stale is **superseded —
`CLAUDE.md` is now accurate.** Verified independently: 889 / 176, both green.

Not run (not plan claims, so the baseline is unverified): `cd app && npm run
typecheck`, `cd app && npm run build`.

---

## Items that actually move the plan

1. **§9 test counts** — 697/127 → **889/176**. Highest-confusion, lowest-effort
   fix. (Re-measure before writing it down; the root count moved twice during
   this review.)
2. **§6 index constraint** — "0068/0070" → 0070's `_cov_m` only. 0068's index is
   dropped; a plan-check against a non-existent index proves nothing.
3. **§1 VOB catch-up figures** — 48/36 → 23/13. The argument stands; the numbers
   don't.
4. **§2/Phase D scope** — 10.0% of live VOB rows are already
   `UNRECOGNIZED_SCHEMA_VERSION`, across three parser generations. "Bump the
   version and backfill what is re-parseable" is a bigger piece of work than
   one sentence implies.
5. **§3 traps 1 and 2 are wrong.** Lonestar is fully instrumented, not stripped;
   the real split is residential (13 boards) vs outpatient (14 boards, using
   `Days in OP` and `Status`), and `Total Auth Days` / `Next UR Date` /
   `VOB Status` are universal across all 27. `Lost Auth Days` does not emit
   false negatives — blank propagates. Rewrite both.
6. **§3 "the IQ column is empty" is wrong** — ~38% populated on both boards
   checked (~154 human-assigned labels). It is calibration data, not just a
   naming convention to borrow. This makes the "adopt the IQ bands"
   recommendation stronger than the plan argues.
7. **Phase G credential** — the only working monday token is a personal
   *account-admin* key. Provision a scoped service identity before building the
   ingest.
8. **`alpha_prefix` does not exist** — it is `member_id_prefix_bidx`, a blind
   index. Phase B comparables cannot read prefix values, only match on them.
9. **`member_benefits_current` → `member_benefits_latest`** in §4 and §6, per the
   plan's own §1 ruling. The view has zero runtime callers.
10. **§5 CMS PFS coverage** — ~47% → 55.59%. Doesn't change the "retire it"
    call; does change the stated basis.
11. **Migration ledger is unreliable** — 0067–0071 are missing from
    `schema_migrations` while 0070's index is live. Don't plan 0075 against that
    table.

---

## Concurrent work: PR #65

PR **#65** ("Staging", `alec-treathealth`) merged **staging → main** at
2026-08-03 07:17 UTC as merge commit `1a4037d`, partway through this review. It
is CMD deposit-reconciliation work — unrelated to Qualify — but it was checked
against every claim in this report:

| Question | Answer |
|---|---|
| Does it add a migration? | **No.** No files under `supabase/migrations/` or `SQL Schemas/`. **`0075` and the `coding` schema name remain free.** |
| Does it change the test counts? | **Yes** — +9 root tests, 880 → **889**. §H updated. |
| Does it change the cron surface? | **Yes** — adds `reconcile-deposits`, daily 11:50. `app/vercel.json` now has **16 entries across 14 routes**, verified directly. |
| Does it touch anything Qualify reads? | **No.** Changes land in `src/collections/{cmdExplorer,reconcileDeposits}.ts`, `src/routes/`, `app/lib/server.ts`, and a new cron route. No Qualify, VOB, or `member_benefits_*` path. |
| Does it invalidate any other finding here? | **No.** Prod row counts, index state, coverage rates, and every monday figure were re-confirmed or are untouched by it. |

It also correctly updated `CLAUDE.md` in the same commit — both the test tripwire
(889) and the cron table (16/14). Nothing in this report contradicts it.

Process: #65 followed the documented flow exactly — opened against `staging`,
never `main`. It landed as a two-parent **merge commit**, which is consistent
with the recent history (`#61`, `#62`, `#63` and `#65` all have `parents=2`).
`origin/staging` and `origin/main` currently have **identical trees**, so there
is no rebase hazard and no divergence to reconcile.

---

## Method note

Prod figures came from the Supabase MCP against `dbpabchpvipipkzkogta`. Monday
figures came from `api.monday.com/v2` using `MONDAY_SECRET_API_KEY` read from
root `.env` at call time — the token was never echoed, logged, or written to
disk. Nothing in this session wrote to either system; every query was a read.
Scratch files used for JSON parsing held column values only (no item names) and
were deleted.
