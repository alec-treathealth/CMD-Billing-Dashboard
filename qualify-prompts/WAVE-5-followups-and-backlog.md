ultracode

# Qualify — Follow-ups: structural cleanups + the unwaved backlog

Two distinct bodies of work, deliberately kept out of Waves 1–4:

- **Part A — three structural cleanups.** Named as out-of-scope in the audit precisely because each is large, each touches a lot of surface, and each is **its own PR**. Do not batch them with each other or with a wave.
- **Part B — seven P1 findings that no wave claimed.** The audit's sequencing skipped them. They are real, they are evidenced, and leaving them unnamed is how they rot. **This is the honest accounting of the gap, not a dumping ground.**

**⚠ Part A is sequenced AFTER Waves 1–4.** Deleting a code path or splitting a file before the behaviour in it is correct means you are refactoring a bug into a new shape. **Do not start Part A until Wave 4 has merged.** Part B can run any time after Wave 2.

---

## 0. GROUND RULES

Read: `CLAUDE.md` → `veris-data-notes.md` (§ qualify) → `.claude/rules/qualify.md` → `.claude/rules/nextjs-app.md` → `.claude/rules/query-library.md`. Those outrank this prompt; conflict → surface and stop.

- **PHI never** reaches logs, LLM prompts, a URL, browser storage, or `query_log`.
- **Parameterized queries only**; identifiers are fixed literals. Never `SELECT *`.
- **Reads as `claims_reader`; writes as the narrow writer role.** No service-role key, no `claims_admin` on the app path.
- **`admissions_seat` dollar-stripping** has a single choke point and must stay that way.
- **Tests hermetic** — `node:test` only, no new test-runner deps.
- **Never add a `Co-Authored-By` trailer.** HOLD before commit/push/deploy. `gh pr create --base main`. (⚠ `staging` was DELETED 2026-08-14 (ruled poor dev practice) — branch off `main`, PR to `main`.)

**Verification gate — all five, green, per PR:**

```bash
npm test                    # floor in CLAUDE.md (NOT restated here — see below)
npm run typecheck
cd app && npm test          # floor in CLAUDE.md
cd app && npm run typecheck
cd app && npm run build
```

⚠ **The pass-count floors are deliberately NOT written here.** This block used to name
`>=1439` / `>=831`; those were ratified 2026-08-11 and were **447 root and 207 app tests
low** by 2026-08-30, so a session running this prompt would have checked a suite that had
lost 447 tests against a number it still passed. CLAUDE.md's *Verification gate* is the only
place the floors are re-measured. Read them there; do not copy them back into this file.

Counts are floors. **On a deletion PR this matters more than usual** — a dropped test suite is exactly what a large delete produces, and it will look like a clean pass. **If the count falls, the PR is wrong.**

---

## 1. ORCHESTRATION

```
phase('Inventory') → for each Part A item: parallel readers establish the FULL
                     reference graph before anything is touched. What imports it,
                     what tests cover it, what a flag can still route to it.
                     Deletion without a complete graph is not a cleanup, it's a gamble.
phase('Propose')   → one migration plan per item. Bring me all three. STOP.
phase('Execute')   → one PR per item, sequentially, never in parallel.
                     isolation:'worktree'.
phase('Verify')    → adversarial: "what still reaches the deleted path? what flag
                     value resurrects it? what test silently stopped running?"
phase('Gate')      → five commands, exact counts, per PR.
```

Part B is an ordinary pipeline; the seven items are independent.

---

# PART A — structural cleanups (one PR each, sequential)

## A-1 · Delete the v2 `qualify-tab.tsx` path

**Current state:** three rating generations and three renderers ship simultaneously.

- **v1** `rating.ts:1-105` — `qualifyRating(pctAllowed) = clamp0to100(pctAllowed)`, buckets 50/30. **Still exported and still consumed** at `core.ts:632` as a comparator tiebreak. `.claude/rules/qualify.md` is explicit that v1 is **"not dead and not current"**.
- **v2** `qualify-tab.tsx` — **1,528 lines / 89 KB**, reachable only via `QUALIFY_V3_FLOW=off` (`v3Flags.ts:6-8` guarantees it stays "fully reachable and unmodified").
- **v3** `resolution-flow.tsx` — **4,856 lines / 308 KB**, default ON since 2026-08-06.

**Why it matters beyond tidiness:** the repo carries **two URL-state policies** (v2 writes `employer` to the query string — Wave 1 P0-4 — v3 deliberately does not, and `page.tsx:56` carries a comment explaining that a `searchParams.term` read would put a member ID in browser history), **two window-anchor policies** (Wave 1 P1-1), and **two employer-forwarding policies** for one surface. Every one of those divergences is a bug that only exists because both paths ship.

**What this PR must establish before deleting anything:**

1. Is `QUALIFY_V3_FLOW=off` ever set, anywhere — Vercel prod, preview, any local `.env`? **Verify against the live Vercel project, not from memory.**
2. What does the mobile route use? `m/qualify-mobile-app.tsx` is the **v2 model** and does not import `qualify-tab.tsx` — but it shares `contract.ts` types and `m/colors.ts` grades on v1 buckets (`:34`). **Deleting v2 must not break mobile.** This is the trap in this PR.
3. Which of the **16 unreferenced Server Actions** (see A-3) exist only to serve v2? That overlap determines whether A-1 and A-3 are one PR or two.
4. Which tests cover v2 only? Removing them **lowers the app suite floor** — that is legitimate here, and it means **the floor in `CLAUDE.md` must be re-measured and updated in the same diff**, on a clean detached checkout of `origin/main` per the provenance rule.
5. Does v1 `rating.ts` survive? `core.ts:632` still uses it as a tiebreak. **`.claude/rules/qualify.md` says do not treat v1 as dead and do not treat it as current** — so a decision is required, not an assumption.

**⚠ HOLD:** bring me the reference graph and the answers to 1–5 before deleting a line. Also update `.claude/rules/qualify.md` and `v3Flags.ts` in the same diff — a kill switch that no longer switches anything is worse than no kill switch.

## A-2 · Split `v3/resolution-flow.tsx`

**4,856 lines, 308 KB, one file.** It is the single largest artifact on the surface and it forces every parallel agent working on Qualify to serialize.

**Do not split it by line count.** Split along the seams the file already has:

- the **stage components** (`StageAnswer` and siblings)
- the **verdict card** (`:3608-4079` — which Wave 4 item 29 may already have decomposed; **check what Wave 4 did before planning this**)
- the **caption/sentence builders** (`billedUnderCaption`'s nine arms at `:2490-2530`, `windowSentence` at `:1777-1789`, `rebuiltAtSentence` at `:1818-1852`, `gridNarrowEmptyCopy`) — these are **pure and highly testable** and are the most valuable extraction in the file
- the **book-led / grid rendering** (`:4218-4227`)
- the **debug/provenance drawer** (`:4396-4507` — Wave 4 item 18 gates it to `super_admin`; a gated subtree is a natural module boundary)

**The real prize is testability, not file size.** The audit found repeatedly that behaviour in this file **cannot be covered by a hermetic test** because the module can't be imported by the test harness — `aiPayload.ts:5-9`, `externalAsk.ts:5-10`, `bookPlacement.ts` and `scopeLabel.ts:56-59` each say so in their headers, and each records **a real defect that shipped green** because of it (a deleted `bedState` mapping; an inverted placement ternary). `aiPayload.ts:76` puts it bluntly: *"NOTHING BUT A TEST HOLDS THIS LINE IN PLACE."*

**So the success criterion is: how many previously-untestable behaviours now have tests.** A split that moves 4,856 lines into six files and adds zero tests has achieved nothing. Report that number.

**Two specific gaps to close while you're in there:**

- **The snapshot fetch effect's supersede/abort behaviour** — `resolution-flow-client.tsx:645-681`. This is the surface's central race: `alive`, the `scopeKey` dependency, `isPending` gating, and the deliberate omission of `retryNonce` from anything but the dep array. It is untested. `flow-state.ts:490-497` extracted `makeRetryHandler` precisely because a source-scan stand-in *"could not fail"* — **the same reasoning applies here and the extraction was never done.**
- **Wiring coverage.** The extraction pattern already used in this repo covers the pure decisions but not **which extracted function each call site actually calls**. Assert the wiring.

**⚠ HOLD:** bring me the proposed module boundaries and the list of behaviours that become testable. Do not start with a mechanical split.

## A-3 · Retire the 16 unreferenced Server Actions

With `QUALIFY_V3_FLOW` and `QUALIFY_SMOKE_SHELL` both defaulting ON, the live path imports four: `resolveCoverageAction`, `getQualifySnapshot`, `getQualifyFacilityTrends`, `loadQualifyDataFreshness` (`resolution-flow-client.tsx:52-61`), plus the board/watcher actions via the shell.

`actions.ts` exports **sixteen more** that remain remotely-callable POST endpoints reachable only through UIs nothing renders: `getQualifySnapshotByPayer`, `getQualifySnapshotByName`, `getQualifyFacilityCases`, `getQualifyMatchSummary`, `getQualifyComposedCases`, `getQualifyPayerEverBilled`, `getQualifyResolvePayer`, `getQualifyMovers`, `getQualifyInitial`, `getQualifyBookKpis`, `getQualifyOverview`, `getQualifyPatientCohort`, `revealQualifyRow`, `revealQualifyRows`, `loadQualifyEmployers`, `loadQualifyPayerOptions`.

**All are gated** — `requireQualifyPrincipal` before data, every core re-gating as a backstop. **This is attack surface and maintenance cost, not a hole.** Do not present it as a vulnerability.

**But two of them carry real weight and must be handled deliberately, not swept:**

- **`getQualifySnapshotByName`** is the patient-name PHI search of Wave 1 P0-3. **If Wave 1's ruling was "delete the endpoint", it is deleted there, not here.** Check what Wave 1 did first.
- **`revealQualifyRow` / `revealQualifyRows`** are the PHI reveal path, **used by mobile** (`m/qualify-mobile-app.tsx`). They are **not** unreferenced. Do not delete them on a desktop-only reference scan.

**Sequencing:** this PR is coupled to A-1 — several of the sixteen exist only to serve v2. Establish the overlap in A-1's reference graph and then decide whether these are one PR or two. **Say which, and why.**

---

# PART B — the unwaved P1 backlog

These seven were evidenced in the audit and assigned to no wave. Each is independent and small. **They can go in one PR together** — unlike Part A.

**B-1 · `chosenBy: 'user'` is asserted for a choice the server made.**
`resolutionService.ts:309-312, 375-381`. `chosenIndex` falls back to `0` when `input.chosenIndex` is absent, then `chosenBy = groups.length === 1 ? 'sole_candidate' : 'user'` — **with no reference to whether the user actually supplied an index**. The module header states the rule it breaks: *"pre-selecting is fine, PRETENDING no choice was made is not."* Same defect on `window.chosenBy: 'user'` (`:357`), hardcoded even when the window is the 365-day server default the operator never selected.
**Failure:** first search on a 6-candidate prefix — the server pre-selects `groups[0]`, `wasAmbiguous` fires, but any consumer branching on provenance attributes a heuristic pick to the operator. `ResolvedCandidates.chosenBy` exists for exactly that branching.

**B-2 · Candidate selection is a positional index into a live-data-ordered list.**
`resolution-flow.tsx:1701` submits `<input type="hidden" name="candidate" value={String(c.index)} />`; `resolveCoverage` re-runs both candidate queries and takes `groups[chosenIndex]`. Ordering is `count(distinct member_id_bidx) desc` with a full tiebreak chain — deterministic **for a fixed dataset**, but a function of live data, not of identity.
**Failure:** a VOB refresh or ingest lands between render and click and moves a group's member count past a neighbour's. The operator's press silently resolves a **different plan** — and B-1 then labels it `'user'`. **`canonicalPayerId + employerLabel` is a stable key; the index is not.** Fix B-1 and B-2 together; they compound.

**B-3 · A failed resolve has no in-flow state and destroys the session.**
`v3-actions.ts:88-98` calls `resolveCoverage` with **no try/catch**, and `V3FlowState` models only `empty | prefix_too_short | no_match | denied` (`v3FlowState.ts:29-37`). A transient DB/pool error rejects the Server Action and unwinds to `app/app/qualify/error.tsx`; `reset()` remounts the route and destroys the held term (`termRef`), the stage, session watchers, session recent searches and any streamed AI answer.
**The asymmetry is the tell:** the *snapshot* fetch has a fully designed failure path with retry (`:3428-3450`). **The identify step, which every session starts with, has none.** Bites on the second search of a shift during any Supabase blip.

**B-4 · `prefixLabelsFor` runs ~46,656 synchronous HMAC-SHA256 calls on the request thread.**
`prefixLabel.ts:62, 69-84, 91-93` — `buildIndex()` is a triple-nested synchronous loop over `36³` candidates, each calling `alphaPrefixBlindIndex`. Called from `board-actions.ts:143` and `watcher-actions.ts:63`. The header's *"~100-150ms, ONCE per warm process, lazily; callers are already async and already fail-soft"* **does not help** — this is uninterruptible CPU on Node's single thread.
**Failure:** a cold Vercel lambda serves its first `getQualifyPolicyTape` or `getQualifyWatchboard`; every request multiplexed onto that instance — **including an in-flight `getQualifySnapshot`** — stalls behind the loop, and 7 MB is retained for the instance's life.
**⚠ Do not "fix" this by wiring `record_qualify_prefix_echo`.** That seam is dead by ratified decision (2026-08-09) and `prefixLabel.ts` is strictly better on coverage. Move the work off the hot path or bound it.

**B-5 · Maintenance mode is a page gate only; all 19 Server Actions stay open.**
`qualifyMaintenanceBlocks` is checked in `page.tsx:42`, `m/page.tsx:72`, `registry/page.tsx:22` — **and nowhere else.** `gate.ts` and `principal.ts` never consult it.
**Failure:** a tab open across a redeploy, or a replayed action id, keeps running every PHI search and audit-writing action while the surface reports it is offline for a rebuild. Not a privilege escalation (Q-A still holds), but stated availability and actual availability disagree.
*(If Wave 2 already landed this as the non-decision half of P0-7, mark it done and move on.)*

**B-6 · Duplicated availability/basis logic between the interactive core and the nightly cron.**
`core.ts:546-624` vs `board.ts:146-188`. `useOutcomes`, `censusFamily`, `basisAuth/Los/Sample`, and the `computeRatingV2` input mapping exist **twice, in full**. `board.ts:14-19` acknowledges it (*"If assembleFacilities' mapping changes, change this in the same diff"*) and pins only "the behaviors that matter".
**Nothing structural prevents the stored nightly rating and the on-screen rating from diverging. The guard is a comment.** Extract the shared mapping.

**B-7 · Small correctness papercuts, batch them.**
- `watcher-actions.ts:90-91` — `threshold < 1 || threshold > 100` **does not reject `NaN`** (both comparisons are false), so a missing/non-numeric `thresholdPts` reaches `$6::int` and surfaces as a Postgres `22P02` reported to the operator as `'failed'` rather than `'invalid'`. Validate at the boundary the way `registry-actions.ts:106` does with zod.
- `resolution-flow-client.tsx:982-986` — `recordedRef.current.add(key)` runs at `:984`, **before** the `if (term === '') return` guard at `:986`. The key is permanently marked recorded for the life of the mount, and nothing on screen says so.
- `core.ts:800, 1215, 1289, 1372-1380` — over-length inputs return `emptySnapshot(...)`, **the same shape as a genuine no-match**, while `resolutionService.ts:171-186` spends 15 lines arguing these states must be distinguishable. Add the fourth state: "that input is too long to accept".
- `v3-actions.ts:61-66, 82-85` — reads a `windowDays` form field **no form sends** (`grep -r 'name="windowDays"' app/components/qualify/` returns nothing). Delete or wire. *(Wave 1 P1-1 may have already done this — check.)*
- `resolution.ts:377-419` — `windowReducer`, `WindowAction` and `ResolvedWindow.frozen` implement the I6 "window does not change except by user action" state machine, and **nothing dispatches a `WindowAction`**; the live path uses `window_days_changed` in `flow-state.ts`. **[SUSPECTED — confirm before acting.]** If confirmed, I6 is asserted by a tested-but-unreachable reducer while the live path enforces it by a different mechanism. Either wire it or delete it and move the invariant's test to where the behaviour lives.
- `shell/lane-progress.tsx:390-394` — the receipt header renders `motion-safe:animate-spin` whenever `settled < total`, so a lane that legitimately ends without settling every step keeps a **perpetual spinner beside a completed answer**. **[SUSPECTED reachable via a step whose `revisit` is open — confirm first.]**

**Also worth a decision, not a fix (bring it to me):** `board.ts:44-51` ships the **raw blind-index token** to the browser on `QualifyPolicyTapeItem`, while `core.ts:760-762` states the opposite invariant for claims (*"the opaque token itself NEVER leaves this function (wire-tested)"*). The tape's header calls it *"doctrine: not PHI, safe on this gated surface"*, and the server **already resolves the readable prefix beside it** (`:264`) — so the token adds no display value while giving a client a stable cross-session correlator for a member-ID prefix. Two modules, two doctrines. Pick one.

---

## 2. DO NOT RE-FILE — checked against production and disproven

| Claim | Reality |
|---|---|
| "`patient_name_bidx` is missing so `getQualifySnapshotByName` fails closed with 42703." | **False.** The column exists on `collections.cmd_explorer_rows` in prod. Relevant to A-3: the endpoint **works**. |
| "`buildCurrentCodingDecisionsQuery` has no LIMIT and scans thousands of rows per search." | **Scale wrong** — `coding.code_decision` holds **42 rows**. The missing `LIMIT` is real hygiene, not a perf fix. |
| "The `qualify-rating-history` cron missed a run." | **False.** `qualify_rating_run` id 242 ran 2026-08-12 05:10:41Z, ok, 1,275 pairs, 4.7 s. `as_of_date` is deliberately run-date minus one. **Healthy.** |
| "`collections.qualify_prefix_echo` is empty and pending." | **Empty on purpose, permanently, by ratified decision (2026-08-09).** Do not wire `record_qualify_prefix_echo` — relevant to B-4 and Wave 4 item 19. |

## 3. CONFIRMED CLEAN — a cleanup PR must not degrade these

- **No SQL injection on any Qualify path**; no `SELECT *`.
- **Gate coverage is complete** — every exported Server Action calls `requireQualifyPrincipal` before data, every core re-gates as a backstop. **A deletion PR must leave this property true for whatever survives.**
- **Dollar-stripping** — single choke point, runs last on every return path.
- **No browser storage anywhere**; the PWA service worker caches only `GET /_next/static/`.
- **Date arithmetic** in `qualifyWindowBounds`, `shiftIsoDays`, `addDaysIso`, `daysBetweenUtc`, `computeLosDays`.

---

## 4. DEFINITION OF DONE

**Part A — per PR:**
1. The **complete reference graph** delivered to me before any deletion, and a HOLD honoured on each of A-1, A-2, A-3.
2. **Exact test counts before and after.** If the floor drops on A-1, the new floor is **re-measured on a clean detached checkout of `origin/main`** per `CLAUDE.md`'s provenance rule and updated **in the same diff** — a shared working tree is not evidence.
3. A-2 reports **how many previously-untestable behaviours now have tests.** That number is the success criterion, not the line count.
4. `.claude/rules/qualify.md`, `v3Flags.ts` and any stale `CLAUDE.md` claim updated in the same diff as the code they describe.
5. One PR per item, sequential, `--base main`, **HOLD before pushing**.

**Part B:**
6. Seven items fixed or returned `stillPresent:false` with evidence. Both `[SUSPECTED]` items (`windowReducer`, the spinner) **confirmed before being touched** — do not fix an unreachable state.
7. Each fix has a hermetic test that fails on the pre-fix code.
8. The token-doctrine conflict brought to me as a decision, not resolved silently.

**Both:**
9. All five gate commands green, **exact counts reported**.
10. No `Co-Authored-By` trailer.
11. Anything discovered outside these lists: **separate follow-up.**
