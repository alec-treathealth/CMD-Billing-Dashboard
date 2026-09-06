# Claims Desk → claim-grain work queue — design

**Date:** 2026-09-03 · **Status:** DRAFT, awaiting rulings on decisions (a)–(g) in §9 · **Author:** design session, read-only against the repo and the live DB

> ✔ **REGISTERED 2026-09-05 — Canonical Context Set read-order 10.** This file was authored
> deliberately untracked, on the reasoning that `scripts/check-context-map.ts` (root `npm test`)
> sweeps the **git index** for `*.md` and fails on any tracked doc absent from CLAUDE.md's table.
> Alec ruled the other way: untracked is not a state a doc gets to stay in, and registering is
> reversible where deleting an uncommitted file is not. So it is tracked and listed, and the
> §10 step 1 choice below is **settled — register, not delete.** Its `ALLOWLIST_BASELINE_2026_08_30`
> warning still stands for anyone tempted by the third option: that array is digest-pinned and
> adding a path to it is a rule violation.
>
> ⚠ **Registration ratified the RECON, not the PROPOSAL.** Decisions (a)–(g) in §9 remain
> unruled, and §9(c) still asks to reverse a recorded PHI-surface reduction. Nothing here is
> authorised to be built by the fact that this doc is now committed.

> **No code, schema, migration, cron, env var or commit was produced by the 2026-09-03 design
> session that wrote this file.** (It has since been committed and registered — see the banner
> above; that commit added no code either.) Everything
> below is a proposal. The one artifact outside this file is a read-only probe script
> (`/Users/aleclowi/CMD API Scripts/probeCmdReport.mjs`) and its structural output, in the other
> project, at mode 0600.

**Epistemic key**, used on every claim in this document:
`OBSERVED` — measured this session against the repo or the live database.
`INFERRED` — a reading of observed evidence that could be wrong.
`ASSUMED` — not derivable from available data at all.

---

## 1. Verdict

The Claims Desk already has the work-queue slot designed, wired into the UI, and empty. `claims.flag`
and `claims.flag_rule` exist with 8 seeded rules and **0 rows**; the "Flag Queue" subtab renders a
hardcoded `PHASE 3 · NOT YET ACTIVATED` empty state; `0049_billing_audit_plane.sql:59-62` explicitly
deferred the user acknowledge/resolve/dismiss write path to "a future SECURITY DEFINER function" that
was never written. There is **no owner, assignee, disposition, due-date or app-notes column anywhere
in either plane**. `OBSERVED`

So this is not a greenfield build and not a rewrite. It is: (1) finish the deferred disposition write
path, (2) add a claim-grain queue projection above the existing charge-grain worklist, (3) join in the
835 denial facts that already land nightly but that nothing reads, (4) ingest the one CMD report that
still carries AR age and rep notes, and (5) rebuild the tab's UI to Collections' standard.

The blocking problem is **identity**: nothing in the repo joins the 835 world to the CMD-report world,
and the natural keys do not match. §4.3 measures this and §9(b) proposes the fix, which is two column
additions on your side in CMD's report designer — not code.

---

## 2. How to read the numbers in this document

Two different books are measured here and they must not be conflated:

| figure set | source | scope |
|---|---|---|
| Denial/collection figures, CARC distributions, lane split | local 835 extract, `/Users/aleclowi/CMD API Scripts/out/parsed/` | **Indigo**, customer 10024431 (Mental Health Center of San Diego), BPR16 window 2025-08-14 .. 2026-08-14, 2,878 payments / 18,564 claims |
| `audit_row` / `era_835_*` / join-rate figures | live Supabase `dbpabchpvipipkzkogta` | **BXR** (af504ab6…) unless stated, all history present in those tables |
| AR report row/note counts | CMD probe, 2026-09-03 10:41–10:45 UTC | **BXR**, 19 customers swept |

The extract window figures reproduce `reconciliation.txt` to the cent — 2,878 payments,
$18,665,325.79, 18,564 claims, 26,161 adjustments. `OBSERVED`

---

## 3. What exists today

### 3.1 The CMD-report plane (`claims.*`) — live, nightly

`claims.audit_row`: **33,927 rows**, charge-line grain, BXR only, 9 distinct `cmd_customer_id`, last
ingest 2026-09-03 02:43 UTC. `OBSERVED`

| audit_scope / status_category | rows | charge |
|---|---|---|
| OP / BALANCE_DUE_PATIENT | 7,188 | $20,159,166 |
| OP / PAID | 5,905 | $15,654,295 |
| IP / AT_PAYER | 5,533 | $36,826,840 |
| IP / PAID | 4,829 | $31,298,710 |
| OP / AT_PAYER | 3,699 | $10,759,544 |
| IP / BALANCE_DUE_PATIENT | 3,286 | $20,756,500 |
| IP / NEEDS_RENEGOTIATING | 790 | $4,967,015 |
| IP / APPROVED_HIGHER | 750 | $4,581,220 |
| OP / NEEDS_RENEGOTIATING | 681 | $2,051,700 |
| OP / OTHER, IP / OTHER, ON_HOLD ×2, OP / APPROVED_HIGHER | 1,266 | $6,923,438 |

Three feeds write it: consolidated (report `10064394`, filters B `10148376` / C `10148377`, three
nightly passes at 02:40/03:10/03:40), the legacy OP pair (`10073210`/`10147817`, 02:20, still live
pending a 5-clean-night soak), and the Sheets-driven `billing-code-decisions` (02:40). `OBSERVED`

**Key population caveat:** `charge_debit_id` — the consolidated feed's conflict key — is non-null on
only **8,065 distinct values** against 33,927 rows, because legacy rows predate it and were
fingerprint-backfilled. `cmd_claim_id` is populated everywhere: **23,413 distinct**, all length 9,
≈1.45 charge lines per claim. A queue keyed on `charge_debit_id` would silently exclude most history;
a queue keyed on `cmd_claim_id` would not. `OBSERVED`

### 3.2 The 835 plane (`staging.era_835_*`) — live, daily, both tenants, unread

`era_835_payment` **2,763 rows**; `era_835_adjustment` **23,786 rows**. Both tenants present: BXR 15
customers (2026-04 → 2026-09), Indigo including 10024431 itself (139 payments, $1,048,418.50).
`OBSERVED`

CAS group split, live, by level:

| tenant | CLAIM/CO | LINE/CO | CLAIM/PR | LINE/PR | CLAIM/PI | LINE/PI | CLAIM/OA | LINE/OA |
|---|---|---|---|---|---|---|---|---|
| BXR | 168 / $685,996 | 2,737 / $8,466,180 | 1,249 / $4,632,646 | 4,633 / $7,318,848 | 32 / −$5,723 | 624 / $1,441,210 | 20 / $162,613 | 231 / $34,355 |
| Indigo | 223 / $810,457 | 5,805 / $14,760,966 | 1,078 / $3,097,426 | 5,722 / $8,465,267 | 102 / $244,589 | 1,018 / $1,027,551 | 114 / $358,292 | 307 / $559,060 |

CLP02 status codes are stored and populated (1, 2, 4, 19, 22 all present in both tenants). **Nothing
in `src/` or `app/` reads `era_835_adjustment`** — the only 835 reader in production is the Overview
upcoming-payments tile over `era_835_payment`. `OBSERVED`

Two structural limits of this store, both by design and both documented in `SQL Schemas/013`:

- **Adjustment grain.** A claim with zero surviving CAS triplets leaves no row anywhere but its
  remit's payment row. In the local extract, **514 of 18,564 windowed claims (2.77%) have no CAS row
  at all**, carrying **$2,507,059.48 of paid — 13.41% of all windowed paid dollars**. All 514 have
  `paid == charge` exactly (492 are CLP02=1, 19 are reversals, 3 are CLP02=2): clean-paid claims.
  `OBSERVED`. For a **work queue** this is harmless — a clean-paid claim is never work. For any
  **rate** computed from this table it is not.
- **No PLB, no RARC, no raw EDI.** `era835Parser.ts` has no `PLB` case; LQ remark codes are counted
  and dropped; only the download-time filename is kept. In the extract this shows up as claim-level
  paid exceeding banked BPR02 by **$25,813.60 across 123 of 2,878 payments**, 33 of which carry
  BPR02 = $0.00 against non-zero claim activity. `OBSERVED` (the gap) / `INFERRED` (that unparsed
  provider-level adjustment is the cause).

### 3.3 Reference vocabulary — seeded and unused

`ref.carc_code` **455 rows**, `ref.rarc_code` **1,192 rows**, `ref.remittance_code` **98 rows** with
a category taxonomy already designed for exactly this purpose:
`CONTRACTUAL_EXPECTED | PATIENT_RESPONSIBILITY | DENIAL_OR_MISS | NEEDS_INFO | INFO_ACTIONABLE | INFO | OTHER_REVIEW`
plus an `is_miss_candidate` boolean. All 47 CARCs from the extract's top-code list resolve. Spot
check: `45 → CONTRACTUAL_EXPECTED, miss=false`; `242 → DENIAL_OR_MISS, miss=true`;
`16/226/252 → NEEDS_INFO, miss=true`; `18 → OTHER_REVIEW`. `OBSERVED`

`era_835_adjustment` already carries `category` and `is_miss_candidate` columns for this join.
**Both are NULL on every row** — `013` reserved them and the ingest never populated them. `OBSERVED`

This means the denial taxonomy this project needs **already exists in the database, curated, and has
never been switched on**. It should be populated, not re-invented.

---

## 4. The five findings that shape the design

### 4.1 Your billing-audit filter is not a drop-in for the production feed

Report `10064394` + your filter `10149360`, customer 10027973, probed 2026-09-03 09:41 UTC: HTTP 200,
**440 rows, 40 columns**. The 40 are a strict subset of the 43-column `CONSOLIDATED_HEADERS` contract
in `auditRowMap.ts`, in identical order, missing exactly **`Claim Remark 1`, `Claim Remark 2`,
`Claim Remark 3`**. `OBSERVED`

Tonight's consolidated run ingested 12,508 rows with `valid=12508`, so production's filters still
return all 43. `OBSERVED` Therefore **a CMD saved filter carries its own column selection, not just
its row criteria** `INFERRED`, and filter `10149360` pointed at the existing ingest would be
**rejected whole** by `resolveConsolidatedHeader`'s name-set check (header drift rejects the customer,
by design). Its window is `Charge From Date` 02/01–08/30/2026 with 16 distinct `Claim Status` values
and no PAID or BALANCE-DUE — a B-like slice.

**Consequence:** no new ingest is needed for billing-audit data — the production feed already lands
it. Filter `10149360` is useful for probing and for a narrower operator view, but it is not the
production projection and must not be swapped in.

### 4.2 The AR report is the only live source of rep notes and AR age — and notes are sparser than one facility suggests

Report `10051337` + filter `10149361`, swept across all 19 BXR customers 2026-09-03 10:41–10:45 UTC.
17 columns including `Charge Fromdate Age`, four age-in-days columns, `Last Public FU Note` and its
create date. `OBSERVED`

| outcome | customers |
|---|---|
| returned data | **15** — 2,261 open AR rows |
| SUCCESS-empty (WRC, TREAT_CO, HOUSTON_MH — the three known not-yet-open accounts) | 3 |
| INVALID CRITERIA (10030472, the billing umbrella account — expected, same class as the collections exclusions) | 1 |
| transient `fetch failed` *after* a valid run identifier (10033690 LAMH) | 1 — re-probe; not a filter problem |

**Notes are concentrated, not general: 301 of 2,261 rows (13.3%) carry a note, and nine of the
fifteen facilities have zero notes on any open claim.** `OBSERVED`

| customer | rows | with note | fill | avg note len |
|---|---|---|---|---|
| 10030471 PCMH | 95 | 87 | 92% | 395 |
| 10027973 CAMH | 120 | 91 | 76% | 266 |
| 10032340 FRCA | 30 | 20 | 67% | 257 |
| 10035166 TEEN_MH_TX | 126 | 49 | 39% | 112 |
| 10029722 TREAT_TX | 157 | 33 | 21% | 46 |
| 10030101 TREAT_CA | 197 | 15 | 8% | 119 |
| 10034671 TREAT_NV | 228 | 6 | 3% | 35 |
| 9 others (LSMH, TBH, TELEHEALTH_MH, DMH, TREAT_WA, KWC, NASH, TREAT_TN, +) | 1,308 | 0 | 0% | — |

Age buckets on this filter run **`c) 61 to 90 days` through `h) Over 1 year`** — nothing under 60
days. This is an **aged-AR view, not all open AR**. `OBSERVED`

Two consequences. First, **the desk loses notes entirely when the legacy OP feed decommissions**:
`last_fu_note` is populated on 486 rows and *only* from report `10073210`; the consolidated projection
carries no note column and `auditRowMap.ts:683` hardcodes `last_fu_note: null`. `OBSERVED` Second,
because the imported corpus is ~300 notes across five facilities, **the desk's own append-only notes
will dominate within weeks** — which argues for building the in-app thread as the system of record and
treating the CMD import as a one-time-plus-nightly seed.

Re-introducing free-text notes reverses a ruling: the FU-note column's removal from the consolidated
projection was recorded on 2026-07-29 as "a PHI-surface REDUCTION." `OBSERVED` See §9(c).

### 4.3 The 835 and the CMD-report planes do not share a key — measured, not assumed

`CLP01` (the 835's patient control number) equals the 837's `CLM01` almost perfectly: **11,606 of
14,080 distinct values (82.4%)** in the local extract, the remainder predating the 837 window. Its
shape is `9A999-9999999999` (9,676) or bare `9999999999` (4,330). `OBSERVED`

It matches **nothing** on the CMD-report side. Live against BXR, 4,488 distinct `CLP01` values tested
against 23,413 `cmd_claim_id`, 8,065 `charge_debit_id` and 1,152 `cmd_patient_id`:

| test | matches |
|---|---|
| `CLP01` = `cmd_claim_id` / `charge_debit_id` / `cmd_patient_id` | **0 / 0 / 0** |
| any embedded 9-digit run = `cmd_claim_id` or `charge_debit_id` | **0 / 0** |
| any embedded 8-digit run = `cmd_patient_id` | **0** |
| 10-digit tail, left-9 or right-9 = `cmd_claim_id` / `charge_debit_id` | **0 / 0 / 0 / 0** |

The numeric ranges are disjoint: `CLP01` 10-digit tails span 1338118903–1542374601, while
`cmd_claim_id` spans 262045030–309268222 and `charge_debit_id` 645127718–698319574. These are
different id spaces, not a formatting difference. `OBSERVED`

A composite bridge was then measured — `(business_entity_id, member_id_bidx)` + `charge_from_date` =
line `service_date` + `charge_amount_cents` = line charge — because both tables mint `member_id_bidx`
from the same `INDEX_HMAC_KEY` and the same `normalizeMemberId`:

| | count | of |
|---|---|---|
| BXR 835 claims with line-level context | 2,969 | — |
| …of those, carrying `member_id_bidx` | 1,452 | 48.9% |
| matched by member + DOS + amount | **827** | 56.9% of those with a member id |
| matched by payer + DOS + amount (member id absent) | **288** | — |
| **total matched** | **1,115** | **37.6% of 2,969** |
| ambiguous (one 835 line → >1 audit claim) | 6 | excluded, never guessed |
| **CLP02=4 denied claims matched** | **17 of 142** | **12.0%** |

**37.6% overall and 12% on the population that matters is too weak to build a queue on.** `OBSERVED`

The fix is not code. The Indigo AR report already in the repo's output
(`out/reports/ar_10024431_2026-09-02.csv`, report `10094539`) **does carry `Charge Claim ID`**, which
proves the field is available in CMD's report designer. `OBSERVED` Two column additions — see §9(b) —
make both joins exact.

### 4.4 The ruled denial taxonomy holds, and it produces a lane split

From the Phase-A analysis of the Indigo extract, ratified over four rounds:

- **denominator** = CLP02 ∈ {1,2,4,19} = **15,746** claims; CLP02=22 reversals (**2,818**) excluded
  from denial math and netted into collections.
- **numerator** = CLP02=4 (all 1,279, every one pays $0.00) + zero-paid CLP02 ∈ {1,2,19} zeroed ≥99%
  by CAS CO or PI (**532**) = **1,811** claims / **$10,350,123.28**.
- **denial rate 11.50%**; the broader "every zero-paid claim is denied" reading gives **20.25%** and
  is published beside it because it counts patient deductible as denial.
- not denied: **1,262** PR-dominant zero-paid claims / **$7,514,749** — a *patient balance* queue, a
  different desk.
- ambiguous: **116** OA-dominant (COB / duplicate routing), counted in neither direction.
- `payer_collection_rate` 39.95%, `net_collection_rate` 38.48%, net paid $18,691,139.39. `OBSERVED`

Applying a draft CARC→lane map to the 1,811 denied claims (assignment = largest-dollar non-PR CAS row;
CLP02=4 claims often carry PR-only rows and fall back to those):

| lane | claims | charge |
|---|---|---|
| Fix & resubmit (billing ops) | 839 | $4,743,684 |
| Clinical / benefit (appeal or write-off) | 383 | $2,051,950 |
| COB / eligibility routing | 266 | $1,172,059 |
| Coding / bundling review | 190 | $1,481,540 |
| Contractual rate (no desk action) | 88 | $673,820 |
| Unmapped | 45 | $227,070 |
| **desk-actionable (first three + coding)** | **1,295** | **$7,397,283** |

`OBSERVED` for the arithmetic; **`INFERRED` and known-imperfect for the mapping**: `B11` (43 claims)
sits in Coding but belongs in COB; `129` (93) is in Coding but is arguably Fix; `243` (167) is in
Clinical but is an authorization problem; `PR:45` landing in "contractual rate" is simply wrong — under
PR that is a patient balance-bill. With 45 unmapped and **73 of 1,811 (4.0%) spanning multiple lanes**,
roughly 15% of assignments are shaky. **The map must be a versioned, editable table reviewed by a
biller, not a constant in code.** See §6.4.

### 4.5 CARC alone cannot identify a financial event

CARC 45 is 33.4% of all adjustment rows and 50.7% of all adjustment dollars, and it appears under
**both** groups: **PR $16,978,225 (3,732 claims) and CO $9,485,298 (3,614 claims)** — the same reason
code describing a patient receivable in one row and a contractual write-off in the next. 25 of 63
CARCs are multi-group. `OBSERVED`

Every reason-keyed surface in the queue must key on **(group_code, CARC)**. A CARC-only rollup may be
offered but must be labelled as collapsing opposite financial events.

---

## 5. Approaches considered

**A — Activate the designed Flag Queue as specified in 0049.** Build the rule engine over `audit_row`,
write `claims.flag`, add the disposition definer, light up the existing tab. Smallest delta, perfectly
aligned with the repo's own plan, reuses a table with policies already in place.
*Rejected as the primary shape:* the grain is (charge line × rule), so one claim with 10 charge lines
and 3 firing rules is 30 queue items; and the 8 seeded rules are code-decision/auth audits, not denial
or AR work. A biller works a claim.

**B — Claim-grain queue, rules as evidence. RECOMMENDED.** One desk item per (tenant, claim),
recomputed nightly from CMD audit rows + 835 CAS/CLP02 facts + AR age/notes + decision registry,
carrying lane, priority, PHI-free evidence, and a disposition (status, assignee, due date, resolution)
with an append-only event log and encrypted notes. The flag engine still runs; flags become evidence
attached to a claim rather than the queue grain itself.
*Why:* it matches how the work is actually organised — CMD's FU notes are claim-level, the AR report is
claim-level, and one row is what you assign to a person.

**C — Resume the AR Build Doc's Phase 2 worklist** at `/dashboard/ar` over `collections.cmd_charge_census`.
Age buckets (`ageBucket.ts`) and query builders (`arAging.ts`) already exist, are tested, and have no
consumer.
*Rejected:* collections plane, charge grain, sits on a production-critical census table the rules say
not to touch unless explicitly scoped, BXR-only, no 835 link, and it splits the desk across two tabs.
It is a different product, and its two genuinely reusable pieces are consumed by B as inputs.

---

## 6. The design (approach B)

### 6.1 Grain and identity

One row per **(business_entity_id, claim_key)**.

`claim_key` = `cmd_claim_id` while §9(b) is outstanding (populated on 100% of audit rows, unlike
`charge_debit_id`). 835 evidence attaches through the §4.3 composite where unambiguous; the 6
ambiguous cases are excluded and counted, never guessed. **Unmatched 835 denials appear in their own
`835-only` lane keyed by CLP01 and labelled as unjoined** — so a denied claim is never silently
dropped, and the join rate is visible on the tab rather than hidden in a doc. When the two CMD columns
land, `claim_key` becomes the shared control number, the composite retires, and the `835-only` lane
should empty.

### 6.2 Sources

| source | state | contributes |
|---|---|---|
| `claims.audit_row` | live nightly | CMD status + at-payer, payer, CPT/rev, TOB, auth #, DOS, facility, charge cents |
| `staging.era_835_adjustment` / `_payment` | live daily, both tenants, unread | CLP02, CAS (group, CARC, signed amount) at claim and line level, paid, BPR16, PR/CO/PI/OA split |
| AR report `10051337` | **new ingest** | `Last Public FU Note` + date, `Charge Fromdate Age`, 4 age-in-days columns |
| `claims.flag` + `flag_rule` | tables exist, engine new | rule evidence (missing auth, stale at-payer, aged on-hold, code mismatch, stopped-code-billed) |
| `ref.remittance_code` / `carc_code` / `rarc_code` | seeded, unused | category taxonomy + descriptions; populate the dormant `category`/`is_miss_candidate` columns |
| `claims.billing_code_decision` via `decisionResolver` | live sync, resolver landed, no caller | code-decision mismatch evidence |
| `claims.payer_alias` via `resolvePayerAlias` | applied (0051 header's "DRAFT" is stale) | payer display normalization — **no new normalizer** |

### 6.3 Schema — product plane `claims`, migration **0108** + paired rollback

Number re-derived from `supabase_migrations.schema_migrations` immediately before apply; the file floor
is 0107 and CLAUDE.md's "next 0107" is stale. `OBSERVED`

- **`claims.desk_item`** — one per (tenant, claim_key).
  *Computed, owned by the classifier:* lane, lane_reason, priority, denial_class (denied /
  zero_paid_co_pi / patient_balance / ambiguous_oa / paid / reversal), cmd_status rollup, clp02,
  charge_cents, paid_cents, pr_cents, co_cents, pi_cents, oa_cents, dos_from/to, age_bucket, age_days,
  last_note_at, `sources text[]`, `evidence jsonb` (PHI-free: group:CARC pairs, rule codes, counts,
  match method + confidence), `rule_version`, `classified_at`.
  *Disposition, owned by humans:* status (open / assigned / in_progress / waiting_payer / resolved /
  dismissed), assignee, due_at, resolution_code, resolved_by, resolved_at.
  **Invariant: the nightly classifier never writes a disposition column, and a human action never
  writes a computed column.** Enforced by column-scoped grants, not by convention.
- **`claims.desk_note`** — append-only. `note_enc bytea` (libsodium), `source` (`cmd_fu` | `user`),
  author, created_at, cmd_note_date. **No UPDATE, no DELETE grant to any role.** This is the AR Build
  Doc's already-ruled `cmd_ar_note` shape, relocated to the claims plane and keyed to a claim.
- **`claims.desk_event`** — append-only transition log: item, actor, from→to status, assignee change,
  PHI-free detail. Work-product provenance, distinct from `claims.access_audit` (which stays the PHI
  reveal log).
- **`claims.desk_lane_rule`** — the (group_code, CARC) → lane map as a **versioned, editable, global**
  table (the `flag_rule` shape), seeded from §4.4's draft with every row I know to be shaky carrying
  `needs_review = true`.
- **`claims.desk_ingest_run`** — run history, copied from `claims.audit_ingest_run`.
- **`claims.flag_rule`** gains denial rules at ids 9+ via `ON CONFLICT DO NOTHING` (never re-seeding
  live-tuned params).

**Roles.** Cron writes reuse **`claims_audit_writer`** — same plane, same GUC-scoped RLS discipline
(0049 declined to widen `cmd_rollup_writer`, not this role). Human writes go through
**`claims_admin`-owned SECURITY DEFINER functions** with pinned `search_path`, server-resolved actor
id, and `EXECUTE` to `claims_reader` — the shape 0049 reserved and `collections.save_facility_assignments`
(0085) already demonstrates on this very tab. Reads as `claims_reader` with the tenant pin
`business_entity_id = any($n::uuid[])`. 835 reads use the existing reader pool, so **no cross-plane
grant is required**.

Standard migration discipline: correct plane directory, full header block (WHY / PHI DISCIPLINE /
OWNERSHIP / IDEMPOTENT / DEPENDENCY / Rollback), `IF NOT EXISTS`, `DROP POLICY IF EXISTS`, never
`DROP ROLE`, `SET ROLE claims_admin` (required in `claims`, fatal in `collections`), indexes leading
with `business_entity_id`, money `numeric(12,2)` or cents `bigint`, both a GRANT **and** a policy per
role, and `SELECT` on the conflict key for every `INSERT … ON CONFLICT`.

### 6.4 Classification — one tested pure function

`src/billingAudit/deskClassifier.ts`, transport-agnostic and env-free per the composition-root pattern.
Inputs: the claim's audit rows, its 835 facts, its AR facts, its resolved decision, and the lane-rule
table. Output: `{ lane, lane_reason, priority, denial_class, evidence, rule_version }`.

Table-driven `node:test` cases seeded directly from the ratified cohorts: CLP02=4 → denied; zero-paid
CO ≥99% → denied; zero-paid PI ≥99% → denied; PR ≥99% → patient_balance; MIXED PR+CO → patient_balance;
OA ≥99% → ambiguous; CLP02=22 → reversal; zero-charge → the documented fallback (which **never fired**
in 18,564 windowed claims and must stay covered anyway).

`priority` is a documented function of dollars, age and lane — written down in the file header and
surfaced on hover in the UI, because a priority nobody can re-derive is a priority nobody trusts.

`rule_version` is stamped on every row so a reclassification is auditable and a rule change can be
diffed rather than argued.

### 6.5 Ingestion — Vercel crons, repo template verbatim

`pg_cron` is installed in the cluster but unused by this repo; calling CMD from inside Postgres would
break the credential and PHI posture. Two new routes, thin GET-only adapters delegating to
`app/lib/server.ts` handlers, constant-time `CRON_SECRET`, 405-before-401, generic 500.

- **`/api/cron/claims-desk-ar`** — AR report per BXR roster customer, **env-only** `CMD_AR_REPORT_ID` /
  `CMD_AR_FILTER_ID` with no fallback, locked header contract checked before any write, notes encrypted
  in-process outside the transaction, sequential with a wall-clock budget, per-customer failure
  isolation, expected-empty allowlist (WRC + the two not-yet-open accounts + the billing umbrella),
  `hasPriorRows` honest-empty detection, fail-soft run row. Measured cost: **~19 pulls in 4m16s**,
  comfortably inside `maxDuration = 300`. `OBSERVED`
- **`/api/cron/claims-desk-classify`** — DB-only: rebuild items from all sources, run the flag engine,
  preserve dispositions, populate `category`/`is_miss_candidate`, write the run row,
  `revalidateTag('billing-audit')`.

**Slots: 05:05 and 05:35 UTC.** Outside the `:41–:59` CMD probe band, clear of the 02:20–03:50 audit
block, 04:10 facility-outcomes, 05:10 qualify-rating-history, 07:52 catch-up and the 08:50/09:50/10:50/
11:50 dailies. `INFERRED` free — to be confirmed against `collections.etl_run` and
`collections.cmd_census_run` before scheduling, because **there is no CMD mutex in production**
(`pipeline_lock` guards only the disabled tick) and an overlapping run steals a neighbour's results
poll. Desk is fresh by ~22:40 Pacific.

Indigo: 835-only items in v1, so the existing Indigo tab stops resolving to an empty workbench. Indigo
AR notes once its report/filter pair is confirmed per customer.

### 6.6 UI

Route and label unchanged (`/billing-audit`, "Claims Desk"); drop `isBeta` in `nav-model.ts` when it
leaves beta. The full gate order is preserved verbatim: `dashboardAccess` → login redirect /
`UnprovisionedNotice` → `isQualifyOnlyRole` redirect → empty `allowedViews` fail-closed →
`claimsAuditMaintenanceBlocks` **before any PHI fetch** → `resolveClaimsDeskView` (BXR+Indigo only,
default BXR, `consolidated` clamps) → redirect if `urlView` differs → `Promise.all` seed → `TenantTabs`.
Chrome stays teal (Qodo #308 ruling). The maintenance gate stays on, so you and Ryan verify on the
branch's own preview URL while everyone else still sees the notice.

Tabs: **Queue** (new default) · IP Audit · OP Audit · Billable Days. Queue replaces the inert Flag
Queue placeholder.

Queue tab adopts the Collections grid idiom — viewport-bounded `flex h-[calc(100dvh-3.5rem)]` with a
`min-h-0 flex-1` chain, one focusable `role="region"` scrollport, sticky `<th>` cells at `h-8`, four
sibling edge fades on an rAF-coalesced ResizeObserver, footprint-matched skeletons, `opacity-60`
refresh dimming instead of re-skeletoning, `animate-ths-reveal` panels, the 12px type floor, AA tokens:

- **KPI strip** — open items, dollars in queue, denied this week, median age, assigned to me, overdue.
  Each carries its definition on hover.
- **Lane chips** with counts + a "Mine" toggle.
- **Filter panel** — the shared `MultiSelectTagPicker` (not the duplicated `billing-audit/tag-picker.tsx`):
  facility, payer, disposition, assignee, (group, CARC), age bucket, dollar range, denial class, and a
  window from `src/businessWindow.ts` — **retiring `date-presets.ts`'s raw UTC arithmetic**, which is
  the exact ~17:00–24:00 Pacific off-by-one `businessWindow` exists to eliminate.
- **Grid** — masked patient · facility · payer · lane + reason (CARC pill, description on hover) · CMD
  status chip · 835 status · charge · paid · age · last note · assignee · disposition · priority.
  Allowlisted sorts, keyset paging (`{id, value}` cursors, reset on filter change), saved column views
  namespaced `desk:`.
- **Claim workspace** — a focus-trapped `useDialog` slide-over: the 835 CAS breakdown with descriptions
  and categories, CMD charge lines, age, firing flags, the notes thread (imported CMD notes + user
  notes, append-only, newest first), and the actions — assign, set status, due date, resolution, add
  note. PHI reveal is the existing gated + audited action, unchanged.
- Bulk assign / bulk status. Freshness line from the two run tables (page-local `ingested_at` age plus
  last successful run). Filter state in component memory; **only `?view=` in the URL**.

**Tokens: stay on v1** (Collections parity). `ths-v2` is Overview-only and documented as ported
deliberately per surface; mixing it with the shared grid primitives puts two spacing and radius scales
on one screen.

### 6.7 Compliance posture

Reads as `claims_reader` with the tenant pin and an explicit column allowlist, `$n` params only, no
`SELECT *`. Human writes only through definers with a server-resolved actor. Notes and identifiers
libsodium-encrypted at rest, encrypted outside any pooled transaction. `desk_event` records every
transition; `access_audit` records every reveal, written **before** PHI is returned. No PHI in logs,
`evidence` JSON, URLs, browser storage, client bundles, LLM prompts or test fixtures. Hermetic
`node:test` only — classifier tables, SQL-shape assertions, fake-`Db` cron loops, pure-leaf render
tests, one jsdom focus test for the slide-over. The five-command gate before any commit; HOLD before
migration, commit, push, deploy.

---

## 7. Deliberately not built

| not building | why |
|---|---|
| Claim-grain 835 table + `PLB` parser + RARC persistence | touches the production 835 ingest path and two locked fingerprint field sets; a follow-on with its own gate. §9(g) |
| Any collection-rate / NCR metric on this tab | 835 carries no patient payments; these are payer rates and belong with the artifact-8/9 work, not a work queue |
| A fourth payer normalizer | at least five payer-identity mechanisms already exist; the queue consumes `claims.payer_alias` for display |
| A third decision registry | `claims.billing_code_decision` and `coding.code_decision` already disagree; the queue picks one per rule and says which |
| Note full-text search | encrypted at rest; searching needs a blind index. Not v1 (the AR doc ruled the same way) |
| Billable Days persistence | separate Kipu work with four unresolved blockers |
| Indigo AR notes | report/filter pair unconfirmed per customer |
| Widening `status_category` | the 7-value CHECK is shared with `normalizeStatus`; disposition is a new column, not a widening |

---

## 8. Risks and open technical questions

1. **`audit_row` is a worklist, not claim-state truth.** Filter B excludes PAID and filter C covers
   ~90 days of patient balance, so a claim that pays or ages out **freezes at its last status forever**.
   The queue must never infer PAID from absence, and must show row age. `OBSERVED`
2. **Two feeds co-write `audit_row`** (legacy OP fingerprint arbiter, consolidated key arbiter) until
   `CMD_AUDIT_CONSOLIDATED_OP_WRITE` cutover. The queue inherits both. Cutover state is env-only and
   was not read.
3. **No CMD mutex in production.** Slot choice is the only serialization. §6.5.
4. **`customers_processed` counts customers that did not throw, not customers that returned rows** — the
   signature of the 2026-08-17 eleven-hour explorer outage. The new crons must record honest-empty.
5. **835 join rate is 37.6% until §9(b) lands**, and 12% on denied claims. The `835-only` lane makes
   this visible rather than silent, but it is the single biggest weakness in v1.
6. Rebuilding the tab **breaks two source-scanning tests** (`billingAuditViewRemount.test.tsx` splits
   `workbench.tsx` on `<ScopePanel` and requires exactly two `key={view}` blocks;
   `billableDaysEntityScope.test.tsx` pins `TenantTabs` on `page.tsx`). They must be updated in the
   same change, not deleted.
7. **Local `origin/main` is behind the remote** (`dba1e90..40c98f9`). Branch only after a real fetch.
8. Doc/code contradictions found this session, worth fixing opportunistically but **not** as drive-bys:
   `.claude/rules/billing-audit.md` says facility attribution comes from Office Name via
   `claims.facility_alias` — code stamps it from the roster and nothing reads `facility_alias`; the same
   file's title still says "Claims Audit"; `0051`'s header says DRAFT/NOT APPLIED but the ledger
   records it applied; `indigo-era-835/route.ts` says "do NOT add the vercel.json entry" and
   `vercel.json` schedules it.

---

## 9. Decisions required (nothing proceeds without these)

**(a) Approach.** B — claim-grain queue with rules as evidence — using A's engine as a component and
C's age-bucket parser as an input?

**(b) Two CMD report-designer edits, on your side.** (i) Add `Charge Claim ID` to report `10051337`'s
projection so AR notes and age key to a claim instead of a patient. (ii) Add the field carrying the
`1A234-1338118903`-style value to report `10064394` so the 835 join becomes exact. `INFERRED` that (ii)
exists as a selectable column — the 837 is generated from it, and the Indigo AR report already exposes
`Charge Claim ID`, proving the class of field is available. Until both land: notes attach at patient
grain and unmatched 835 denials sit in the labelled `835-only` lane.

**(c) Notes are back in scope — this reverses the 2026-07-29 PHI-surface reduction.** Proposal:
encrypted at rest, never rendered in the grid, revealed only through the existing gated + audited
action, append-only, no search in v1. §4.2 shows the imported corpus is ~300 notes across five
facilities, so the in-app thread becomes the system of record quickly. **Needs your explicit ruling.**

**(d) Who may disposition and assign?** Recommendation: entity `admin` + `super_admin` only — working a
claim requires PHI, which a plain `user` cannot see. Alternative: allow `user` to assign but not reveal.

**(e) Saved views.** Namespace `desk:` inside the existing `claims.user_grid_views` (no migration;
recommended) versus adding a surface-key column. Note `sanitizeGridColumns` is bound to
`CmdExplorerColumnKey` and needs a desk allowlist either way.

**(f) The maintenance notice promises "an AI system."** Proposal: the classifier is **rule-based** and
is the truth — re-derivable, testable, diffable, and arguable line by line. An AI assist (summarize a
claim's evidence into a suggested next action) can follow, running over **de-identified evidence only**,
because `pr_compliance_checklist.yaml` rule 1 forbids PHI in prompts. Scope that in v1, or after?

**(g) Defer** the claim-grain 835 table, `PLB` parsing and RARC persistence to a follow-on with its own
gate?

---

## 10. If approved, the next steps in order

1. ~~Register this doc in CLAUDE.md's Canonical Context Set (read-order 10) or delete it~~ — **DONE 2026-09-05**, registered at read-order 10. See the registration banner at the top of this file.
2. Confirm the two cron slots against `etl_run` / `cmd_census_run` measurements.
3. Re-probe 10033690 LAMH (transient `fetch failed`, not a filter fault).
4. Write the implementation plan (`writing-plans`), phased with a gate per phase.
5. Phase 1 — migration 0108 authored + rollback, HELD for apply; `deskClassifier.ts` + tests; no UI.
6. Phase 2 — AR ingest cron + classify cron, verified on preview with `curl` + `CRON_SECRET`.
7. Phase 3 — Queue tab, workspace slide-over, disposition definers.
8. Phase 4 — flag engine rules 9+, `category` backfill, `835-only` lane retirement once §9(b) lands.

---

## Appendix — figures cited, with provenance

| figure | value | source |
|---|---|---|
| Extract tie-out | 2,878 payments / $18,665,325.79 / 18,564 claims / 26,161 adjustments | `reconciliation.txt`, reproduced to the cent |
| CLP02 windowed | 1: 13,924 · 22: 2,818 · 4: 1,279 · 2: 536 · 19: 7 | local extract |
| Denial rate (ruled) | 11.50% = 1,811 / 15,746; $10,350,123.28 | local extract |
| Denial rate (broad) | 20.25% | local extract |
| payer_collection_rate / net_collection_rate | 39.95% / 38.48% | local extract |
| CARC 45 group split | PR $16,978,225 / CO $9,485,298 | local extract |
| X12 balance residual | −$242.35, CLP02=2 only | local extract |
| BPR02 vs sum(CLP04) | $25,813.60 over 123 of 2,878 payments | local extract |
| Zero-CAS claims | 514 (2.77%), $2,507,059.48 paid = 13.41% | local extract |
| `audit_row` | 33,927 rows; 23,413 distinct `cmd_claim_id`; 8,065 distinct `charge_debit_id` | live DB |
| `era_835_payment` / `_adjustment` | 2,763 / 23,786 rows, both tenants | live DB |
| `claims.flag` / `flag_rule` | 0 rows / 8 rules (7 enabled) | live DB |
| FU notes in DB | 486 rows, all from report 10073210 | live DB |
| CLP01 ↔ CMD key match | 0 on every variant tested | live DB |
| Composite join rate | 1,115 / 2,969 = 37.6%; denied 17 / 142 = 12.0%; 6 ambiguous | live DB |
| CLP01 ↔ 837 CLM01 | 11,606 / 14,080 = 82.4% | local extract |
| Billing-audit probe | 440 rows, 40 of 43 contract columns | CMD, 2026-09-03 09:41 UTC |
| AR sweep | 15 of 19 customers with data, 2,261 rows, 301 notes (13.3%), 9 facilities with zero | CMD, 2026-09-03 10:41–10:45 UTC |
| AR ages present | `c) 61 to 90 days` .. `h) Over 1 year` | CMD probe |
| Reference vocabulary | `carc_code` 455 · `rarc_code` 1,192 · `remittance_code` 98 · `category`/`is_miss_candidate` NULL on all 835 rows | live DB |
| Payer names | 52 raw → 47 normalized (5 confident merges) | local extract |
