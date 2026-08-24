# Qualify v2 — Build Plan

Supersedes the six-factor scorecard in `Qualify v2 — design prototype prompt.md`
and the phase order in the prior gap analysis. Written 2026-08-02 after probing
prod, monday.com, and the billing team's working sheet.

**Untracked on purpose.** Adding this to git requires adding the path to the
Canonical Context Set table in `CLAUDE.md`, or `scripts/check-context-map.ts`
stays green while this file rots. Promote it deliberately.

---

## 1. The headline finding

You asked how to get the right data structure in first. **The structure is
already there and it is empty.**

| Table | Rows | Holds |
|---|---|---|
| `vob.claim_line_features` | **0** | `turnaround_days`, `final_status`, `allowed_amount`, `patient_responsibility`, `auth_on_file`, `denial_code_id`, `date_of_service` |
| `vob.benefit_checks` | **0** | `deductible_remaining`, `oop_remaining`, `oop_benefits`, `coinsurance_percent`, `auth_required`, `auth_obtained` |
| `vob.benefit_check_services` | **0** | `coverage_status`, `reimbursement_basis`, `auth_required`, `medically_necessary` |
| `ref.plans` | **0** | `network_type` |
| `vob.member_benefits_current` | **22,903** | funding 97.8%, employer_norm 100%, policy_type 99.3%, prefix 100% |
| `staging.payer_dim` | 286 | `network_status` — **100% `'Unknown'`** |

Somebody already modelled almost every KPI the billing manager listed. No
pipeline fills those four tables. So this is not a schema-design project; it is a
**backfill project plus one genuinely new table.**

That reorders everything. The prior plan's "Phase C migration" to get claim
status onto a charge-date axis is largely unnecessary — `claim_line_features` is
already keyed on `date_of_service`, not `payment_received`, which was the exact
structural objection that made claim-status-mix look blocked.

### Corrections to the earlier gap analysis

- **"Operational fit — no data anywhere — recommend cutting."** Wrong. Auth days
  are live in monday (§3).
- **"Claim-status mix is structurally blocked by the payment window."** Wrong for
  `claim_line_features`; right only for the rollup.
- **"`network` does not exist in any table."** It exists in two places
  (`ref.plans.network_type`, `staging.payer_dim.network_status`) and both are
  empty/`Unknown`. It is an extraction gap, not an absence.
- **"`vob.member_benefits_latest`."** The gap analysis was right and my first
  reading was wrong. Both exist: `member_benefits_latest` is a **materialized
  view** (14 MB, 22,903 rows, migration 0063) and is what the app actually reads
  (`src/collections/cmdExplorerQuery.ts:138,293`). `member_benefits_current` is a
  plain view that recomputes latest-per-member live. Matviews do not appear in
  `information_schema.columns`, which is what misled me. Verified 2026-08-02: the
  two agree exactly (22,903 rows / 4,057 prefixes / max `vob_created_at`
  2026-07-31), so the refresh path is healthy — but **read the matview, and treat
  its freshness as gated on the VOB sync** (see below).

### VOB sync failed silently for a day — resolved 2026-08-02, but read this

`GET /api/cron/vob-sync` returned **502 `github_dispatch_failed_422`** at
2026-08-02 09:17:07 UTC. Root cause: the GitHub workflow was set to
`disabled_manually` at 2026-08-01 18:09:41 UTC, roughly nine hours after the last
good run. Vercel kept firing on schedule; GitHub refused every dispatch.

Re-enabled and dispatched 2026-08-02 23:07 UTC. The catch-up run upserted 48 rows
and dropped `errors` 84 → 36 — all 48 were previously-failing `no_pdf` items that
had since had their VOB attached, which is why they landed without any watermark
movement (`no_pdf` retries ignore the watermark, `vob_cron_sync.py:247`).

**Why it went unnoticed for a day, and why that matters more than the outage:**

- A disabled workflow emits no GitHub notification.
- `vob.sync_state` upserts `on conflict (source)` — one row, overwritten each run.
  A missed day leaves no trace, only an unchanged timestamp.
- The Vercel route reports dispatch acceptance only; the ETL's real outcome is
  invisible to the control plane.

Phase B (provenance/comparables) and Phase D (INN/OON) both read
`member_benefits_latest`. A silent VOB stall does not break Qualify — it makes
Qualify **confidently wrong**, scoring against stale policy data with no
provenance signal that anything is off. That is the failure mode this plan is
most exposed to, so treat the fixes in Phase 0 as load-bearing, not chores.

Do the `network_status` extraction in the same pass as any ETL work — same file.

---

## 2. INN/OON is a gate, not a factor

Per Alec: if the policy is in-network, we already know what we get. The complex
decision only exists for OON.

So network status short-circuits the flow rather than contributing a weight:

```
resolve policy
  ├── network = INN  → show contracted expectation, skip the scorecard entirely
  ├── network = OON  → run the full model (§4)
  └── network = null → run the model, banner: "network not captured on this VOB"
```

Building a 100-point scorecard for an INN policy is wasted screen and invites the
rep to distrust the OON score. Two outcomes, one of which is cheap.

**The work:** `network_status` is not extracted from the VOB today.
`vob.indigo_vob` and `member_benefits_current` both carry `schema_version` and
`extraction_flag`, so the VOB parser is already versioned — add the field there
and bump the version. Do not source it from `payer_dim`; network is a
policy-level fact and the payer-level column is 100% `Unknown` anyway.

---

## 3. What monday actually gives us

Probed `A. Admissions (Main)` (workspace 2613676), ~24 census boards.

**Real and populated** (Nashville MH board 7422342993):

| Column | ID | Use |
|---|---|---|
| Admit Status | `admit_status___1` | Open Bed (Male/Female/Either) → KPI #2 |
| Total Auth Days | `numeric_mkt2rb5c` | authorized days |
| Days in RTC | `formula_mkt2dqph` | LOS (`TODAY − ADM`, or `DC − ADM + 1`) |
| Lost Auth Days | `formula_mm2x1kew` | `Total Auth − Days in RTC` |
| Next UR Date | `date_mkt28z4m` | the auth/audit-period flag → KPI #3 |
| VOB Status | `color_mkvdf5qe` | Insurance / Cash / SCA / Scholarship / Denied |
| IQ | `color_mkt6dbme` | 5 bands: 65%+ / 50%+ / 30%+ / 15%+ / 0% |

### Three traps

**Board schemas are inconsistent.** Nashville returns all eight columns. Lonestar
(8401390206) returns only `admit_status___1` and `payment__1` — no auth days, no
UR date, no IQ. Any ingest needs a per-board column map plus a conformance
report, and the auth-fit factor is only available for instrumented facilities.
Do not assume a uniform census schema.

**`Lost Auth Days` lies when `Total Auth Days` is null.** The formula subtracts
from null and yields a confident negative (−17, −4, −2 observed on admitted
patients). Roughly half of admitted Nashville rows have no auth days set. Treat
the factor as null unless `Total Auth Days IS NOT NULL` — never surface the raw
formula.

**The payer dropdown is not a join key.** Most Nashville rows are bare `"BCBS"`
with no state. The board also carries `BCBS TX` and `BCBS of TX`, `Aetna` and
`AETNA`, `UHC` and `United Healthcare`. Keep resolving payer identity from the
member-ID alpha prefix against `member_benefits_current`; treat monday's payer as
a weak hint only.

### Two things worth stealing

**Adopt the IQ bands as the verdict scale.** The column is empty — designed and
never used — but 65/50/30/15/0 is the billing team's own vocabulary for expected
reimbursement. The app currently invents Strong/Watch/Weak at 50/30. Align to
theirs instead of teaching two scales. Later, consider writing the computed band
back to monday so UR and admissions see one number.

**Bed capacity lives in two places.** `Facility Info` (board 7475219124) has a
clean `# of Beds` number column and `LOC` (Detox/Res, Residential, IOP,
Adolescent, VIOP) across 23 facilities — use it for capacity. Census group titles
encode capacity too (`Broad St (8 Beds COED)`, `Rutland Rd (12 Beds COED)`) but
that is a parsed string; use it only to reconcile. Occupancy comes from counting
census items, where open beds are literal placeholder items named "Open Bed".

---

## 4. The code decision registry — the one genuinely new thing

The sheet tab you pointed at **is** the matrix, and it is not what either doc
assumed. 47 rows, 12 facility blocks, 26 payer/plan labels.

Headers, verbatim: `Facility / Carrier` · `Date Code Decision Finalized` ·
`Codes Utilizing` · `Additional Billing Rules` · two unlabelled trailing columns.

### It is a decision log, not a fee schedule

**There are no allowed amounts in it.** One row says `Allowing $2924`; everything
else is prose. The dollar evidence lives in a *different* tab as unstructured
per-member text (`allowed 57,950.00 - allowed in full per diem 5795`,
`per diem 2589.66`, `allowed 4,875.10 coins 451.38 ded 3,972.34 paid 451.38`).

So the manager's "monthly transparency-of-payments feed" is a **separate future
dataset**. This table's actual job today is: *which code combo do we bill for
this payer at this facility, when did we decide that, and is the decision
confirmed or still under test.* Build that. Do not model it as a rate matrix —
you would ship 47 mostly-null price columns.

### What has to be decomposed

`Codes Utilizing` is a packed string with a sentinel: `H0017/0158`,
`NO HCPCS / 1001`, `HCPCS/REV`. `NO HCPCS` means *suppress the HCPCS line and
submit the revenue code alone* — that is a billing method, not a missing value.

`Additional Billing Rules` conflates at least seven orthogonal axes:

| Axis | Observed values |
|---|---|
| DOS batching | `Single DOS`, `2-3 DOS per claim`, `10-11 DOS Per Claim`, `Bulk 5 DOS`, `7 DOS Bulked` |
| HCPCS suppression | `NO HCPCS`, `REV ONLY 0124`, vs `HCPCS/REV` |
| Type of bill | `86X TOB`, `863`, `TOB 133`, `TOB 117`, `763` |
| Interim vs admit-through-DC | `admit-DC`, `denied for interim` |
| Adjunct elements | `add DRG 951`, `Add Condition code 92`, `remove admitting Dx code`, `admit type "2" urgent`, `removing GT mod` |
| Units | `3 units per code (PER HOUR)`, `12 units` |
| Test lifecycle | `TEST FOR TWO MONTHS`, `Might be discontinued`, `CONFIRMED CODES`, `DISCONTINUE - DID NOT WORK` |

The lifecycle enum already exists cleanly on a third tab (`Test Status`):
`CONFIRMED CODES` · `FINALIZED CODES` · `CONTINUE TESTS` · `OPEN TEST` ·
`UPCOMING TEST` · `DISCONTINUED` · `DISCONTINUE - DID NOT WORK` · `CLOSED`.
Model that as a real enum — it is the highest-value single field in the sheet,
because it tells the rep whether a code decision is trustworthy.

### Change history does not exist and is already lost

One `Date Code Decision Finalized` per row, one `Date We Stopped Code` populated
exactly once across the whole sheet. The matrix is destructively overwritten.

Two copies of the matrix exist on different tabs and they have **already drifted
in seven places** — a payer row split into ZGP-ALPHA and NON-ZGP-ALPHA variants,
a `STILL PENDING` that became a real date, `2 DOS` vs `2-3 DOS` for the same
payer at two facilities. That drift is the argument for the DB owning versioning:
you cannot reconstruct why a decision changed from the sheet, and you will want
to when a payer disputes.

Also: the `PCMH` block is a byte-for-byte clone of `CAMH` except one typo, and
`LSMH`/`DMH` differ only in one date and `2` vs `2-3 DOS`. Facility rules are
being copy-pasted. Model a `rule_set` with facility inheritance rather than 47
independent rows, or you institutionalize the copy-paste.

### Schema sketch — product plane, migration `0075`

New `coding` schema. Values are `$n` bound params; table and column names are
fixed literals (`CLAUDE.md` standing rules).

```sql
-- coding.code_decision: current + historical, never destructively updated
--   payer_family        text  -- 'BCBS', 'Cigna', 'UHC/UMR/Optum', 'GEHA', 'Highmark'
--   payer_variant_label text  -- verbatim sheet label, kept for traceability
--   plan_alpha          text  -- 'ZGP' / 'NON-ZGP' / null
--   employer_norm       text  -- 'Walmart' / null   → joins member_benefits_current
--   level_of_care       text  -- 'DTX'|'RTC'|'IP'|'IOP'|'OP'
--   facility_code       text  -- forward-filled from the block header
--   hcpcs_code          text  -- null when suppressed
--   revenue_code        text  -- not null
--   hcpcs_suppressed    boolean not null
--   dos_batch_min/max   int
--   type_of_bill        text
--   drg_code            text
--   condition_codes     text[]
--   modifiers_removed   text[]
--   units_per_dos       numeric
--   billing_span        text  -- 'admit_dc' | 'interim' | null
--   lifecycle           text  -- the Test Status enum above
--   decided_on          date  not null
--   effective_from      date  not null
--   effective_to        date        -- null = current
--   superseded_by       bigint      -- self-FK
--   notes               text
--
-- coding.code_decision_audit: append-only, who/what/when/before/after
```

**No PHI in either table** — payer, employer, facility, codes only. Keep it that
way; it is what lets the registry be editable by the billing team without an
audit-reveal path, and what lets its contents into an LLM prompt.

Writer role `coding_editor`, granted `INSERT`/`UPDATE` on these two tables only.
Not `claims_admin`, not the service-role key.

Ship `0075_coding_decision_registry.sql` **and**
`0075_coding_decision_registry_rollback.sql` — every migration in this plane has a
paired rollback (see `0073`/`0074`). Verified 2026-08-02: `0074` is the latest
product migration and no `coding` schema exists yet, so `0075` and the schema name
are both free.

### Ingest defects to handle on seed

`0714/2026` (corrupt date, Cigna/Treat NV) · `STILL PENDING` in a date column ·
`04/07/2026 Single DOS per CB as of 6/10` in a date column ·
`Anthem BCBS (ALL OTHER)` vs `(ALL OTHERS)` · `Trat TX` ·
mixed `5/21/2026` and `05/21/2026` · facility long-forms needing an alias table
(`KY Wellness` → `KWC`, `Nashville MH` → `NMH`).

At 47 rows, **seed this by hand or with a one-time reviewed script.** Do not
build a Sheets sync. The team edits in the app after seeding; the sheet becomes
the historical record. A two-way sync here buys nothing and creates a second
source of truth for the exact field where drift already bit you.

---

## 5. Rating v2

Five factors, renormalized to 100. Every one expressible without dollar inputs so
`admissions_seat` derives the identical badge (`rating.ts` invariant holds).

| Factor | Wt | Source | Status |
|---|---|---|---|
| Coding decision confidence | 30 | `coding.code_decision.lifecycle` + `decided_on` age | after seed |
| Claims reliability | 25 | `pct_allowed` on `allowed_reliable`, tier e2 excluded | **ships today** |
| Data confidence | 20 | sample × age × provenance (§6) | half ships today |
| Time to payment | 15 | `claim_line_features.turnaround_days` | needs backfill |
| Auth / LOS fit | 10 | monday `Total Auth Days` vs `Days in RTC` | needs ingest |

Not weights:

- **Self-funded** → a modifier and a banner, not a factor. `funding` is 97.8%
  populated so this is free.
- **Next UR date inside the window** → banner. "This facility has a UR review due
  in 2 days; auth may change." The manager asked for it as *a thing to consider*,
  which is a banner, not a number.
- **Patient responsibility remaining** → display-only, never scored. He was
  explicit. `deductible_remaining` / `oop_remaining` on `benefit_checks` once
  backfilled. Hide entirely for `admissions_seat`.

**Coding decision confidence, v1 vs v2.** v1 needs only the registry: a
`CONFIRMED`/`FINALIZED` decision made 3 weeks ago scores high; `OPEN TEST` or a
decision 14 months stale scores low; no row for this payer+facility scores zero
and says so. That is computable the day the seed lands, with no join. v2 adds the
compliance join — did we actually bill this payer's claims with the current
combo — which needs HCPCS/rev on the rollup lines. Ship v1 first; it is most of
the value and none of the risk.

**Drop permanently:** market position vs CMS fee schedule. `ref.cms_pfs_rate` has
52 rows from a manual one-shot script, covers ~47% of lines, and is structurally
zero for IP per-diem. The registry supersedes the intent. Retire the loader
rather than leaving a half-populated reference table that looks authoritative.

---

## 6. Data confidence, and comparables

This replaces both "sample confidence" and the auto-window ladder. Three inputs
multiply into one 0–20 factor, and each is disclosed:

1. **Sample** — distinct patients (existing `sampleGate.ts` thresholds, 3/10).
2. **Age** — how far back the window had to reach. A rating built on 300-day-old
   claims is penalized and says so. This is the manager's KPI #3 as a score
   rather than a hidden window setting.
3. **Provenance** — new field on the rating contract:

```
direct                     this exact policy/prefix
comparable:employer        same employer_norm, different members
comparable:state+funding   same state + fully/self-funded
none                       nothing to say
```

Provenance is the highest-value unblocked item in the whole plan. The manager was
explicit: *"If I see an employee policy from Missouri, but there's data on it,
likely it'll behave the same."* `member_benefits_current` supports it today —
`employer_norm` 100%, `funding` 97.8%, 22,903 rows.

It converts the honest-restraint card from a dead end into an answer: not "not
enough data to rate" but **"estimated from 14 similar Missouri self-funded
policies — directional, not confirmed."** Keep the prototype's colorless
restraint styling for `none`; give `comparable:*` its own visual tier so nobody
mistakes it for `direct`.

**Window mechanics.** Per Alec: auto-generated range, streamed, widening until
the policy clears the decision threshold. So the ladder returns as a *streaming
sufficiency loop* rather than a fixed five-rung sequence, and the age penalty —
not a removed menu — is what stops a rep manufacturing a flattering rating from
two claims. The existing Range menu stays for billers.

Implementation constraint: compute rungs as **one query bucketing distinct
patients by age band**, not five sequential `count(distinct …)` round-trips. Any
new column must stay inside the 0068/0070 covering index or the 12-month rung
degrades to a heap read. Stream the rungs to the UI as they resolve so the
widening is visible; that was the good instinct in the prototype and it survives.

---

## 7. Phases

**0 — Data health, so the rest can be trusted.** Small, and it gates everything
downstream. Three items:

- **`vob.sync_state` append-only** with a `run_id` and no `on conflict` upsert, so
  a missed run is a missing row rather than an unchanged timestamp. Small product
  migration; keep the writer grant narrow (`cmd_rollup_writer` already writes it).
- **Freshness assertion.** A `last_run_at` older than 26h is an alarm. An interim
  version runs now as a daily scheduled check at 11:00 local
  (`~/Claude/Scheduled/qualify-data-health-check/`) covering sync freshness,
  matview-vs-view divergence, the `admitted − rows = errors` reconciliation, and
  `funding`/`employer_norm`/`policy_type` coverage floors. Fold it into the app as
  a real monitor when convenient; the scheduled task is a stopgap, not the answer.
- **Surface freshness in the Qualify UI.** The rating already discloses sample and
  age; it should also disclose *data recency*. A verdict computed on VOB data more
  than 48h stale should say so on the card. This is the cheapest defence against
  the confidently-wrong failure mode above, and it fits the provenance tier work
  in Phase B rather than being separate.

**A — Registry.** `coding` schema, migration 0075, seed 47 rows, CRUD + audit
log, `coding_editor` role. The manager's #1. No dependency on anything else.

**B — Provenance + policy resolution.** Prefix → `{payer, employer, funding,
group, policy_type}` from `member_benefits_current`. Comparables fallback,
provenance on the contract, the estimated-card treatment. No migration. Biggest
visible win.

**C — Coding factor v1 + rating v2 shape.** Registry metadata into the score.
Verdict scale realigned to the IQ bands. Scorecard card shape, weight bar,
insufficient/estimated states.

**D — INN/OON gate.** Add `network_status` to the VOB extraction, bump
`schema_version`, backfill what is re-parseable. Then the two-path flow.

**E — Streaming window loop.** One bucketed query, plan-checked, streamed UI.

**F — Backfill `claim_line_features`.** Unblocks TTP (15) and claim-status
honestly, on a `date_of_service` axis. This is the real migration-scale work and
it is *fourth in value*, not first — which is the main scheduling change from the
prior plan.

**G — Monday ingest.** Per-board column map, conformance report, auth-fit factor,
UR banner, open beds. New PHI boundary: census items are full patient names —
hash on the way in exactly like `member_id_bidx`, and never log the raw name.

**H — AI explainer.** On the `streamCollectionsAiAnalysis` pattern
(`app/lib/actions.ts:1364`) — `ReadableStream<string>` from a Server Action behind a
strict-zod PHI firewall. Chips derived from the resolved policy. For
`admissions_seat`, dollars absent from the *prompt*, not filtered from the
output. Flag: the agent still defaults to `claude-opus-4-8` in
`src/agent/agent.ts`.

**I — Mobile parity** (`qualify-mobile-app.tsx` consumes `contract.ts`
identically), then `QUALIFY_MAINTENANCE=off`.

---

## 8. Decisions still open

1. **Does the registry replace the sheet, or mirror it?** Recommend replace after
   seed — the drift between two tabs is the argument. But the team has to agree to
   stop editing the sheet, and that is an org decision.
2. **Does Qualify write the IQ band back to monday?** Reading their scale is free.
   Writing to it makes this app a source of truth for a board UR also edits.
3. **Level of care is never stated in the sheet** — it is inferable only from
   facility + revenue code (`0124/0128/0158/1001` → IP/RTC/DTX; `0905/0912/0915`
   → OP/IOP). Confirm that mapping with billing before encoding it, because it
   silently determines which registry row a search matches.
4. **Compose bar** — recommend policy-first as the default surface with the
   existing 4-picker compose behind an "Advanced" disclosure. Deleting shipped
   capability to match a prototype is the wrong trade.

---

## 9. Verification

Every phase, before commit:

```bash
npm test                    # root hermetic — 697 pass / 0 fail
npm run typecheck           # root tsc, stricter than app
cd app && npm test          # 127 pass / 0 fail
cd app && npm run typecheck
cd app && npm run build     # only thing that catches webpack failures
```

Invariants this plan must not break: no PHI in logs / prompts / `summary_stats` /
URLs / browser storage / `query_log`; parameterized queries with literal
identifiers and no `SELECT *`; reads as `claims_reader`; verify-full TLS; no named
prepared statements on the 6543 pooler. PRs open against `staging`, never `main`.
No `Co-Authored-By` trailer.

Two specific hazards in this plan: the monday ingest is a **new PHI boundary**
(patient names), and the registry is the repo's **first editable write surface** —
everything else is read-only over ingested data. Both deserve their own review
pass rather than riding along in a feature PR.
