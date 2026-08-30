ultracode

# OON-1: expected-reimbursement engine + denial-recovery worklist

**This is a build, not an audit-fix — and it is NOT a Qualify wave.** It stands up a new **billing-scoped** surface that targets the one validated revenue leak: out-of-network **pricing** ($10.0M) and **coverage/exhaustion** ($4.0M) — 100% of the $14.2M denial book except the $91K (0.6%) pre-admission-auth sliver. Do not build an authorization-clearance gate; the data says that is the wrong leak (validation memo, item 6).

Two surfaces, both dollar-bearing, both gated to `super_admin` / entity `admin`, both **kept out of `admissions_seat`**:

- **Surface A — Expected Reimbursement:** realized OON $/unit ranges per canonical-payer × LOC × code, with CV + confidence + honest suppression.
- **Surface B — Denial-Recovery Worklist:** open recoverable dollars ranked off the existing gap-miner, prioritized by mechanism.

Full design + rationale: `oon-reimbursement-denial-recovery-design.md`. This prompt is the executable version.

---

## 0. GROUND RULES — read the convention files FIRST

Read, in order, before writing any code: `CLAUDE.md` → `veris-data-notes.md` → `.claude/rules/sql-migrations.md` → `.claude/rules/collections-crons.md` → `.claude/rules/qualify.md` → `.claude/rules/query-library.md` → `.claude/rules/nextjs-app.md`. **Those files outrank anything in this prompt.** Conflict → surface it and stop.

Hard invariants:

- **PHI never** reaches logs, LLM prompts, `summary_stats`, a URL or query string, browser storage, or `query_log`.
- **Parameterized queries only.** Identifiers are fixed string literals; only values are `$n`. Never `SELECT *`.
- **Reads run as `claims_reader`; the snapshot cron writes as `cmd_rollup_writer`.** Never the service-role key, never `claims_admin` on the app path.
- **Money is `numeric(12,2)`, never float. Timestamps `timestamptz`.** Tenant-scoped composite indexes lead with `business_entity_id`. Every text column gets a length `CHECK`.
- **`collections` and `ref` objects are owned by `postgres`.** Do **not** add `SET ROLE claims_admin` to a migration in these planes — it downgrades the applier and fails `42501: must be owner`. Own SECURITY DEFINER functions as `postgres`.
- **A cron reading a new `collections.*` table needs BOTH a `has_table_privilege` GRANT and an RLS policy for its role** — a missing policy returns an empty table, not an error (the 0089/0090 lesson). Verify `pg_policies` directly, not as `postgres` (which bypasses RLS).
- **Tests stay hermetic** — `node:test` only, no new test-runner deps, no live LLM/DB in `npm test`.
- **Never add a `Co-Authored-By` trailer.** PRs open against **`main`** — `gh pr create --base main`. (⚠ `staging` was DELETED 2026-08-14 (ruled poor dev practice) — branch off `main`, PR to `main`.)
- **Gate outward-facing actions.** Show results and **HOLD** before applying a migration, committing, pushing, or deploying.

**⚠ THE ONE BOUNDARY THAT DEFINES THIS BUILD — do not cross it.** This surface is dollars. Qualify's frozen invariant is that every rating input is a percentage/count/day-count/enum/date, **never a dollar**, so a dollar-stripped `admissions_seat` derives an identical rating (`test/qualifyCoreV2.test.ts` proves it at the wire). **Nothing you build here may add a dollar field to a Qualify payload, become a sixth Qualify factor, or be reachable by an `admissions_seat` session.** Reuse Qualify's machinery; never its surface.

**DO NOT BUILD (validated kills — honor them):**
- No QPA estimator, computed or stored. QPA is a payer-side 2019 median; a provider-rate proxy is invalid.
- No ML for anything. Percentiles + rules only, auditable.
- No payer-portal scraping, no new PHI vendor surface, nothing written to Monday.
- No auto-approve / auto-submit / auto-reserve / ability-to-pay screen. Surface A is a reference range shown to a human; Surface B proposes and ranks. A person acts.
- **Range + confidence + n, never a point estimate.** Residential per-diem CV is 0.31–0.76 — a single number lies.

**Verification gate — all five, green, before any commit:**

```bash
npm test                    # floor in CLAUDE.md (NOT restated here — see below)
npm run typecheck           # root tsc (strict: noUncheckedIndexedAccess)
cd app && npm test          # floor in CLAUDE.md
cd app && npm run typecheck
cd app && npm run build     # the only thing that catches webpack failures
```

⚠ **The pass-count floors are deliberately NOT written here.** This block used to name
`>=1439` / `>=831`; those were ratified 2026-08-11 and were **447 root and 207 app tests
low** by 2026-08-30, so a session running this prompt would have checked a suite that had
lost 447 tests against a number it still passed. CLAUDE.md's *Verification gate* is the only
place the floors are re-measured. Read them there; do not copy them back into this file.

Counts are floors, not targets. Fewer means tests were lost — find out why before committing.

---

## 1. MIGRATION NUMBERING — re-derive, do not trust this line

⚠ **THIS LINE WAS ALREADY STALE WHEN YOU READ IT — which is the point of the rule below.** Ledger max was `0099` on 2026-08-13, but Wave 1 P1-13 has since taken **0100** (`0100_facility_assignments_guard_search_path`, merged in #223, authored-not-applied — a number is consumed by the FILE as well as by the ledger row, or two branches collide). This build's three migrations are therefore **0101 / 0102 / 0103**. But per `.claude/rules/sql-migrations.md`: query `supabase_migrations.schema_migrations` **and** grep every worktree for untracked `.sql` before you claim a number — the 0096 collision happened exactly this way. A number is consumed the moment it lands in the ledger; never reuse. Every migration ships a sibling `*_rollback.sql` and the header block (WHY / PHI DISCIPLINE / OWNERSHIP / IDEMPOTENT / DEPENDENCY / Rollback) with a manual verification section.

---

## 2. ORCHESTRATION

```
phase('Confirm')  → parallel readers verify the reuse targets are shaped as the design assumes,
                    on HEAD: staging.payment_residual (residual_type, dominant_carc,
                    balance_due_insurance), staging.era_adjustment (category, carc_code,
                    adjustment_amount), staging.claim_line (insurance_paid_amount, units,
                    canonical_primary_payer_family), ref.payer_identity/payer_alias_map,
                    app/lib/qualify/sampleGate.ts (distinct-patient floors 3/10). Return the
                    exact column/function surfaces. A target that differs from the design is a
                    STOP, not a silent adaptation.
phase('Build')    → pipeline, in dependency order (each step ends at the 5-command gate):
                    ref dims → oon_reimbursement_daily → compute+cron → denial_recovery_item
                    → PHI-boundary read fn → UI. Serialize the migrations.
phase('Refute')   → adversarial, independent agent per surface, briefed to REFUTE:
                    "does any dollar field reach an admissions_seat payload or a Qualify type?
                     does the worklist board carry a patient identifier?
                     does the cron read a collections table its writer has no RLS policy on?
                     did scope creep add an auth-clearance / auto-approve behavior?"
                    Default to refuted on uncertainty.
phase('Gate')     → five commands, exact counts, per PR.
```

---

## 3. THE BUILD

### Step 1 — Reference dimensions (migration 0101): `ref.loc_code_map`, `ref.carc_mechanism`

Promote the two heuristics the validation used from ad-hoc `CASE` logic into maintained, reviewable dimensions.

- **`ref.loc_code_map`** — `(code_system CHECK in ('HCPCS','REV'), code, loc CHECK in ('RESIDENTIAL','DETOX','PHP','IOP','OP_THERAPY','OTHER'), is_per_diem bool, notes, reviewed_by, reviewed_at, created_at)`, PK `(code_system, code)`. Seed from the validated distribution: HCPCS H0018/H0019/H0017/H2036/T2048 → RESIDENTIAL (per_diem); H0010/H0008-H0014 → DETOX; S9480/H0015/H0005 → IOP; H2018/H0035/S0201 → PHP; 90853/90837/90834/90791/H0006 → OP_THERAPY. REV 1001/1002/1000/0100/0101/0124/0114/0154/0158/0118 → RESIDENTIAL; 0116/0126/0136/0128 → DETOX; 0905/0906 → IOP; 0912/0913 → PHP; 0914/0915/0916/0918 → OP_THERAPY. **Seed with `reviewed_by = NULL`** and surface an "unreviewed" flag until the billing team signs each row — same honesty as `payer_alias_map.needs_review`.
- **`ref.carc_mechanism`** — `(carc_code PK references ref.carc_code, mechanism CHECK in ('OON_PRICING','NONCOVERED','BENEFIT_EXHAUSTION','PRE_ADMISSION_AUTH','CONCURRENT_AUTH','MEDICAL_NECESSITY','COB_INFO','PATIENT_RESPONSIBILITY','CONTRACTUAL','OTHER'), recoverability CHECK in ('HIGH','MEDIUM','LOW','NONE'), default_action)`. Seed: 147/242/279 → OON_PRICING/HIGH; 96/204 → NONCOVERED/MEDIUM; 119/35 → BENEFIT_EXHAUSTION/LOW; 197/15/39 → PRE_ADMISSION_AUTH/MEDIUM; 198 → CONCURRENT_AUTH; 50/B7 → MEDICAL_NECESSITY.

Owned `postgres`, no `SET ROLE`. `claims_reader` SELECT.

**⚠ HOLD:** show me the migration + the full seed rows and stop. The LOC and mechanism maps are the semantic core; I want to see them before they land.

### Step 2 — Surface A snapshot (migration 0102): `collections.oon_reimbursement_daily`

Mirror `collections.qualify_policy_rating_daily`'s shape. One row per `(as_of_date, canonical_payer_id, loc, code_system, code, window_days)`. Columns: `n_lines`, `distinct_patients`, `paid_per_unit_{median,p25,p75,min,max}` `numeric(12,2)`, `cv numeric(6,3)`, `pct_allowed`, `pct_paid_of_billed`, `confidence_band CHECK in ('HIGH','MEDIUM','LOW')`, `suppressed bool`, `computed_at`. FK `canonical_payer_id → ref.payer_identity`. Cross-tenant book (the pinned `[BXR, Indigo]` population Qualify uses); facility is a later drill-down, not a partition (see open decision O-1 below). Enable RLS; add the `cmd_rollup_writer` write policy and `claims_reader` read policy (**grant + policy, verified in `pg_policies`**).

### Step 3 — Compute + cron (`src/collections/oonReimbursement.ts` + `/api/cron/oon-reimbursement`)

DB-only (no CMD API — so no `:41–:59` quiet-band concern; pattern-match `qualify-rating-history`, daily ~05:xx). Compute: canonicalize `primary_payer` via `payer_alias_map`; map code→loc via `loc_code_map`; realized per-unit = `insurance_paid_amount / nullif(units,0)` on paid lines (`>0`), bounded units; `percentile_cont` for the quartiles, `stddev_samp/avg` for CV; apply the **distinct-patient** sample gate (reuse `sampleGate.ts` floors 3/10 — do not invent a third) → `confidence_band` + `suppressed`; upsert for `as_of = yesterday`. Suppression is honest: below floor → NULL metrics + `suppressed=true`, never 0. Injectable `refresh()` dep, hermetic unit tests. Run-log row before work; fail-soft observability, fatal on the write that records "this ran."

**⚠ HOLD before deploying the cron.** A new scheduled route is an outward-facing action; and after it deploys, verify its first run logs success.

### Step 4 — Surface B worklist (migration 0103): `collections.denial_recovery_item`

State table only — the dollars stay in the source rows. Columns: `id`, `business_entity_id` (index leads with it), `claim_line_id bigint` (surrogate FK into `staging.claim_line` — **NOT PHI**), `payment_residual_id`, `mechanism`, `open_amount numeric(12,2)`, `expected_recoverable numeric(12,2)`, `status CHECK in ('NEW','IN_PROGRESS','SUBMITTED','WON','LOST','WRITEOFF')`, `assigned_to` (app_user, not a name), `outcome_amount`, `created_at/by`, `updated_at/by`. `UNIQUE (business_entity_id, claim_line_id, mechanism)` for idempotent re-seed. Index `(business_entity_id, status, expected_recoverable desc)`.

Seed from `payment_residual where residual_type='BALANCE_DUE_INSURANCE' and balance_due_insurance > $threshold`, joined to `ref.carc_mechanism` on `dominant_carc`. Rank: `expected_recoverable = open_amount × recoverability_weight(mechanism) × payer_gap_factor` (payer_gap from Surface A — are we below this payer's own median for this LOC/code). So OON-pricing underpayments float up; benefit-exhaustion write-offs sink. **No patient identifier on this table** — the board is non-PHI.

### Step 5 — PHI-boundary read for worklist detail

When a biller opens an item, patient/member come **only** through the existing two-shape boundary: a new query fn returning `summary_stats` + `query_id` (via `finalize()`, `columns.ts` allowlist, `NoPhi<S>`), then POST `/api/results` re-executes with re-supplied identity. Reuse the `client_history` identity-hash pattern. No PHI in `denial_recovery_item`, in logs, or to any LLM.

### Step 6 — UI (billing workspace, NOT Qualify)

Two screens under the billing/RCM surface, gated by a `principal.ts`-style billing check (fail-closed; `admissions_seat` denied outright): (a) Expected-Reimbursement lookup — payer × LOC × code → range + confidence + n, with the "unreviewed LOC map" and "suppressed: below sample floor" states visible; (b) the Recovery Worklist board — ranked queue with status workflow, no patient identifiers until a detail open goes through Step 5.

---

## 4. OPEN DECISIONS FOR ME — bring options, do not decide

- **O-1 · Cross-tenant vs per-facility ranges.** Surface A is keyed cross-tenant (more n, payer behavior generalizes). If charge masters/rates differ enough by facility that a blended range misleads a biller, `facility_code` joins the PK and sample density drops. Bring the `distinct_patients` distribution both ways before I rule.
- **O-2 · Per-unit denominator for IOP/PHP/OP.** Residential per-diem normalizes cleanly by `units`; mixed per-diem/per-encounter codes do not. `is_per_diem` on `loc_code_map` handles it — but the billing team confirms which codes are billed per-day vs per-session before you trust the `/units` division there.
- **O-3 · Recoverability weights.** I set HIGH .7 / MED .4 / LOW .1 / NONE 0 as a starting point. These drive the queue order and are a business call, not a code detail — surface them as config and bring me the ranking under the defaults.

---

## 5. DEFINITION OF DONE

1. Reuse targets confirmed on HEAD; any drift from the design reported, not silently adapted.
2. Three migrations authored with rollback + header + manual verification, numbers re-derived from the live ledger. **HOLD honored on Step 1 (seed rows) and before any apply.**
3. `oon_reimbursement_daily` populated by a hermetically-tested compute; cron deployed only after a HOLD, and its first run's success verified.
4. `denial_recovery_item` seeded and ranked; the board carries **no patient identifier**; detail goes through the two-shape boundary.
5. **Refute pass green:** no dollar field in any Qualify type or `admissions_seat` payload; no auth-clearance/auto-approve behavior; cron writer has grant **and** RLS policy; worklist non-PHI.
6. All five gate commands green, **exact counts reported**.
7. Diff summary: files touched, lines ±, and the three changes you are least confident in.
8. `gh pr create --base main` — **HOLD before pushing.** Show me the PR body.
9. No `Co-Authored-By` trailer.
10. Anything discovered outside this list: **separate follow-up.** Do not fold it in.
