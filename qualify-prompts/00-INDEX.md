# Qualify build program — index & run order

**Curated 2026-08-13.** This folder is the executable build backlog for the CMD-Billing-Dashboard repo. It is two tracks:

- **Track Q — Qualify audit (Waves 1–5).** An audit-derived program to fix the `/qualify` surface, sequenced by dependency. Authored ~2026-08-11/12; re-verified against live data below — still current.
- **Track O — OON reimbursement + denial-recovery (new).** The billing-scoped surface that targets the validated denial leak. Independent of Track Q. Added this pass; see `OON-1-*.md`.

Read a wave's own §0 ground rules before running it. Every wave already encodes: read the convention files first (they outrank the prompt), the 5-command verification gate, PRs against `main`, HOLD before outward-facing actions, no `Co-Authored-By`.

---

## Live-status stamps (verified this session, 2026-08-13)

The waves tell you to verify against live state rather than trust a listing. I did, for the claims I could reach:

- **Migration ledger max = `0099` (`0099_etl_run_pipeline_state`, applied 2026-08-12).** ⚠ **0100 IS NOW CONSUMED** by Wave 1 P1-13 (`0100_facility_assignments_guard_search_path`, merged in #223 but **AUTHORED-NOT-APPLIED** — it is not in the ledger yet). Next product-plane number is **0101**, and Track O's three migrations are **0101/0102/0103**, not the 0100/0101/0102 its prompt still says. Still grep worktrees for untracked `.sql` before you claim one (the 0096 collision rule holds).
- **Wave 1 P1-13: fix AUTHORED, not applied.** The migration exists on `main`; the advisor WARN still fires because applying it needs a `postgres` connection (the guard is postgres-owned; every local URL is `claims_admin`). Apply via the Supabase Dashboard SQL Editor, then INSERT the ledger row — without it a later session re-derives 0100 as free.
- **Wave 2 P0-5: half fixed, half yours.** `collections.qualify_facility_outcomes` still holds **12 rows against the 48-facility roster**, last synced 2026-08-06. The CODE half shipped in #227 (the rows now date themselves and say "stale" past 7 days — `synced_at` was written and never read). The OPS half is a credential: the source host is **alive again** (`SASL authentication failed`, not `ENOTFOUND`), so it is a rotated password, not a dead project. Do not retire the sync.
- **Test floors** in every wave (`≥1439` root / `≥831` app) match CLAUDE.md's ratified counts, but the suites have grown well past them — HEAD of Wave 2 measures **1523 root / 900 app**. Treat the wave numbers as floors, not targets; re-measure on a clean detached `origin/main` checkout before promoting them.
- **Not re-verified this session** (trust the wave's own note, or re-check): the `qualify_rating_run` id-242 healthy claim, `coding.code_decision` = 42 rows (that's the sibling `charlotte-ai`/coding project, not queried here), the Vercel `facility-outcomes` telemetry.

---

## Track Q — run order

The dependency chain is real; don't reorder it. Each wave is one-or-more PRs against `main`.

| Order | Wave | Scope | Findings | PRs | Gated on you (HOLD/decision) | Depends on |
|---|---|---|---|---|---|---|
| 1 | ✅ **WAVE-1** correctness & exposure — **MERGED #223** | wrong numbers + PHI leaks | 7 (P0-1…4, P1-1, P1-3, P1-13) | 1 | 2 HOLDs: P0-2 rating treatment, P1-13 migration; P0-3 endpoint keep/kill | — |
| 2 | 🔵 **WAVE-2** operational — **PR #227 open** | cron/data integrity + hardening | 6 (P0-5/6/7 decisions; P1-7/8/9 fixes) | 1–2 | 3 decisions: facility-outcomes source, coding-suppression rule, admissions_seat surface timing | Wave 1 merged |
| 3 | **WAVE-3** accessibility | WCAG 2.2 A/AA, token-layer contrast | 6 Critical + 14 Major | 1 | 1 recommendation (live-region vs header §5) | independent of 1–2 but land after for stable tokens |
| 4 | **WAVE-4** UX restructure | IA of the single `admissions_seat` screen | 30 | 1 (design) + N | **HARD STOP: IA decision doc approved before any component code** | Waves 1–3 merged |
| 5a | **WAVE-5 Part A** structural cleanups | delete v2 path · split resolution-flow · retire 16 actions | 3 | 3 (sequential, one each) | HOLD: reference graph per item before any delete | **after Wave 4** |
| 5b | **WAVE-5 Part B** unwaved backlog | 7 P1 papercuts | 7 | 1 | 1 decision (token doctrine); confirm 2 `[SUSPECTED]` before touching | after Wave 2 (independent of Part A) |

**Fastest safe path:** 1 → 2 → 3 in order; 5b can slot in any time after 2; 4 gates on 1–3; 5a gates on 4.

### Cross-wave couplings the waves already flag (don't let these fall through)

- **P0-3** (name-search endpoint, Wave 1) ↔ **A-3** `getQualifySnapshotByName` retirement (Wave 5). *If Wave 1's ruling is "delete," it's deleted there — A-3 checks first.*
- **P0-4** (`employer` in URL, Wave 1) ↔ **A-1** v2 path deletion (Wave 5): the URL-state divergence only exists because v2 still ships.
- **P1-1** (UTC window anchor, Wave 1) ↔ the `windowDays` dead field re-appears in **B-7** — same asymmetry.
- **P0-7** (admissions_seat redirect loop, Wave 2 minimum fix) ↔ **item 20** (Wave 4 owns the real interstitial) ↔ **B-5** (maintenance gate in `gate.ts` — mark done if Wave 2 landed it).
- **Stale-flash**: Wave 4 item 5 fixes mobile *and* deletes the stale `.claude/rules/qualify.md` "Deferred/known" entry — Wave 1 §3 and Wave 5 both call that doc-rot.
- **`record_qualify_prefix_echo` is dead by ratified decision (2026-08-09)** — Wave 2, 4 (item 19) and 5 (B-4) all say: do **not** wire it. Honor across the board.

---

## Track O — OON reimbursement + denial-recovery (new)

**`OON-1-reimbursement-and-denial-recovery.md`** — the build that targets the validated leak: OON pricing ($10.0M) + coverage/exhaustion ($4.0M), the 71%+29% of the $14.2M denial book. Not the 0.6% pre-admission-auth sliver.

**Why it's a separate track, not a Qualify wave:** it is inherently dollar-bearing, so it must be a **billing-scoped surface** (super_admin / entity `admin`), *not* a Qualify factor. Qualify's frozen invariant — every rating input is a percentage/count/day, never a dollar, so `admissions_seat` derives an identical rating (`qualifyCoreV2.test.ts`) — forbids folding reimbursement dollars into Qualify's payload. Track O reuses Qualify's *machinery* (daily snapshot, distinct-patient sample gate, confidence/suppression) but never its surface.

- **Depends on:** nothing in Track Q. Runs independently. Uses only owned CMD data + the existing `payment_residual` gap-miner.
- **Full design rationale:** `oon-reimbursement-denial-recovery-design.md` (in the project) and the validation memo (`clearance-thesis-validation-2026-08-13.md`).
- **Migration numbers:** ⚠ **0101/0102/0103**, not 0100/0101/0102 — Wave 1 P1-13 consumed 0100. Re-derive from the live ledger at author time per the same rule the waves use.

---

## Known gap — NOT yet a prompt (blocked on counsel)

The **vob-dashboard RLS + 42 CFR Part 2 / Monday PHI-flow** compliance gate is real (all 6 `vob-dashboard` tables are RLS-enabled-no-policy; `quantum_vobs.person_names` holds SUD-associated patient names; the validation memo §e lists the Part-2/BAA questions). It is deliberately **not written as a build prompt yet** — the remediation shape depends on the counsel answers (Monday Enterprise BAA + HIPAA mode? OpenAI under BAA? consent chain?). Writing DDL before those answers would be guessing. It's tracked here so it isn't lost; promote it to a prompt once counsel rules.

---

## What I did not touch

I did **not** edit the five wave files. They're current, internally consistent, and carefully scoped — curation here is the index, the live-status stamps, and the added Track O prompt, not a rewrite of your work. If you want the waves renamed with numeric prefixes (`01-`…`05-`) to sort with this index, say so and I'll do it without changing their contents.
