ultracode

# Qualify — Wave 1: wrong numbers and PHI exposure

**This is one PR. Nothing else goes in it.** Seven defects, each small and independently verifiable. They are grouped because they share a property: every one of them either **renders a wrong number to a user making an admissions decision** or **puts PHI somewhere it must not be**. Do not batch a refactor, a cleanup, or an a11y fix into this PR.

A three-lens audit produced these findings with file:line evidence. **Your job is to fix them, not to re-audit them.** Confirm each still exists on HEAD, then fix it.

---

## 0. GROUND RULES — read the convention files FIRST

Read, in order, before writing any code: `CLAUDE.md` → `veris-data-notes.md` (§ qualify) → `.claude/rules/qualify.md` → `.claude/rules/nextjs-app.md` → `.claude/rules/query-library.md` → `.claude/rules/tenancy.md`. **Those files outrank anything in this prompt.** If this prompt conflicts with them, surface the conflict and stop — do not silently pick a side.

Hard invariants:

- **PHI never** reaches logs, LLM prompts, `summary_stats`, a URL or query string, browser storage, or `query_log`.
- **Parameterized queries only.** Table/column/GUC names are fixed string literals; only values are `$n`. Never `SELECT *`.
- **Reads run as `claims_reader`; writes as the narrow writer role.** Never the service-role key, never `claims_admin` on the app path.
- **Tests stay hermetic** — `node:test` only, no new test-runner deps, no live LLM/DB in `npm test`.
- **Never add a `Co-Authored-By` trailer** to a commit or PR.
- **Gate outward-facing actions.** Show results and **HOLD** before applying a migration, committing, pushing, or deploying.
- **Do not touch the hourly collections crons.** Out of scope for this wave entirely.
- **PRs open against `main`** — `gh pr create --base main` explicitly. (⚠ this rule was inverted until 2026-08-14: `staging` was DELETED 2026-08-14 (ruled poor dev practice) — branch off `main`, PR to `main`.)

**Verification gate — all five, green, before any commit:**

```bash
npm test                    # root hermetic suite — >=1439 pass / 0 fail
npm run typecheck           # root tsc (strict: noUncheckedIndexedAccess)
cd app && npm test          # app suite — >=831 pass / 0 fail
cd app && npm run typecheck
cd app && npm run build     # the only thing that catches webpack failures
```

Root `tsc` is stricter than app `tsc`. Run both. Counts are **floors, not targets** — if a suite reports fewer, tests were lost; find out why before committing.

**Every fix in this wave ships with a hermetic test that fails on the pre-fix code.** That is the definition of done, not "typecheck passes". These are wrong-number bugs; a fix with no test locking the number in place is not a fix.

---

## 1. ORCHESTRATION

```
phase('Confirm')  → one agent per finding: read the cited file:line, confirm the defect
                    still exists on HEAD, return the precise change surface.
                    An agent that CANNOT reproduce a finding returns
                    {stillPresent:false, evidence:...} — a valid, valuable result.
                    Do not fix what is not broken.
phase('Fix')      → pipeline, one agent per confirmed finding. Each returns a diff plus
                    the test it added. isolation:'worktree' only where two findings
                    touch the same file.
phase('Refute')   → adversarial, independent agent per fix, briefed to REFUTE:
                    "does this change the rendered number for any OTHER input?
                     does it break the admissions_seat dollar-strip?
                     does it move PHI anywhere new?"
                    Default to refuted on uncertainty.
phase('Gate')     → run the five commands. Report exact counts, not 'passing'.
```

**Serialize anything touching `v3/resolution-flow.tsx`** (4,856 lines) into a single agent — parallel worktree merges on that file will conflict.

---

## 2. THE SEVEN FINDINGS

### P0-1 · Mobile shows two different ratings for the same facility, one tap apart

`m/swipe-row.tsx:52-64` renders `facility.ratingV2` — the five-factor composite — with `mobileIqStyle`. The "why" button **on that same row** opens `m/trend-sheet.tsx:45`, which computes:

```ts
ratingText = String(Math.round(facility.rating))
```

`facility.rating` is **v1**: `clamp0to100(pctAllowedOfBilled)` per `contract.ts:544-546`. It is printed into the heading `"Why is this rated {ratingText}?"` at `m/trend-sheet.tsx:55`. The two agree only when every non-claims factor happens to be unavailable.

**Failure:** a rep taps "why" on a card reading 56 and is asked to explain a 78, with no way to know which is the real number.

**Outcome:** the sheet explains the number the card showed. One rating identity per facility across the entire mobile surface. **Test:** assert card numeral === sheet heading numeral against a fixture where v1 and v2 diverge.

**Watch for:** `m/colors.ts` grades **claim rows on v1 50/30 buckets** (`:34`) and **facility rows on IQ bands** (`:40-47`) — two scales in one sheet. That is a related but separate defect; it is Wave 4 item 19. Note it, do not fix it here.

---

### P0-2 · The composite rating wears a `%` label; a real percentage renders identically

Three numbers, two scales, one visual language:

| Where | What it renders | Is it a percentage? |
|---|---|---|
| `resolution-flow.tsx:2128-2141` | `ratingV2` at 3xl with the band pill `Strong · 65%+` (`ratingV2.ts:52-67`) | **No.** A weighted fold of coding/claims/dataConfidence/ttp/authFit, **renormalized over the available weight set** (`ratingV2.ts:14-31`). A percentage of nothing. |
| `shared/heating-ticker.tsx:229-231` | `currentRating` at 24px **with a literal `%` suffix** | **Yes.** "current-window reliable allowed % of billed" (`contract.ts:1015`). |
| `policy-tape.tsx:161-163` | `ratingNow` bare, no suffix, no pill | A stored fold of the composite. |

**Failure:** a rep reading "Solid · 50%+" beside 56 will quote it on an admissions call as "they pay about 56 %."

**Outcome:** the composite **never** wears a `%`. The two scales are visually distinguishable at a glance.

**Do not change the band thresholds.** 65/50/30/15/0 are the billing team's own IQ bands, adopted deliberately from the monday census IQ column (`.claude/rules/qualify.md`). Change the **labelling and the visual treatment**, not the model.

**⚠ HOLD:** bring me the proposed treatment before implementing. This is the numeral the whole product hangs on and I want to see it before it ships.

---

### P0-3 · Patient-name PHI search is live server-side behind a client-only flag

`QUALIFY_CLIENT_NAME_ENABLED` is referenced in exactly four places, **all client components**: `qualify-tab.tsx:78,350,1105,1174` and `landing-hero.tsx:18,57`.

The Server Action `getQualifySnapshotByName` (`actions.ts:192`) and the `clientName` narrows at `core.ts:1417-1424` and `core.ts:1525-1530` **never consult it**. `core.ts:1526` even comments "dormant until QUALIFY_CLIENT_NAME_ENABLED" while nothing server-side makes that true.

**I verified against production this session that `collections.cmd_explorer_rows.patient_name_bidx` EXISTS.** So this does not fail closed on a missing column — the action resolves and returns a payer + facility ranking **scoped to a named patient**, for any Q-A principal including an `admissions_seat`, on a feature the team believes is off.

**Outcome:** the flag is enforced **server-side, inside the gate path, fail-closed**. A wire-level test asserts the action refuses while the flag is false.

**⚠ HOLD:** before implementing, tell me whether this endpoint should exist at all. Enforcing the flag and deleting the endpoint are both valid; that is my call, not yours.

---

### P0-4 · `employer_norm` is written into the URL query string

`urlState.ts:29` declares:

```ts
employers: string[]; // employer_norm keys, non-PHI
```

`:74` does `p.append('employer', v)`, and `qualify-tab.tsx:682-690` writes it via `router.replace` on **every chip change**.

**Four sibling modules take the opposite position on the identical value:**

- `phi.ts:23` — `employer_name` is in `PHI_BASE_COLUMNS`.
- `core.ts:924-934` — calls itself "THE PHI FORWARDING BOUNDARY", filters employer rows out, states they "stay SERVER-SIDE"; only `employer_count` crosses.
- `qualifyResolutionQuery.ts:12-15` — "**R6 keeps it out of every URL**".
- `resolution.ts:129` — "It must never reach a URL (I7)."

**Failure:** `?employer=<small employer>&facility=<rehab facility>&payer=<carrier>` lands in browser history, the `Referer` header on every outbound asset request, and edge/CDN access logs. On an OON behavioral-health book that is a re-identification vector.

**Reachable today** whenever `QUALIFY_V3_FLOW=0`, which `v3Flags.ts:6-8` guarantees stays fully reachable and unmodified.

**Outcome:** no employer value in any URL, on any path, including the v2 tab.

**Also reconcile the contradiction in the comments.** `qualifyResolutionQuery.ts:13-14` records a 2026-08-04 ruling that *displaying* employer to an authenticated principal is acceptable, and `core.ts` was never updated to it — so a reader cannot tell which rule is current. **One current rule, stated once, referenced from the others.** This ambiguity is what P0-4 fell through.

---

### P1-1 · The v3 flow anchors "today" to UTC; the shared contract anchors it to business TZ

`v3-actions.ts:84`:

```ts
const today = new Date().toISOString().slice(0, 10);
```

fed to `trailingWindowFor(today, days)`.

`contract.ts:1053,1090-1097` — `qualifyWindowBounds`, the function every other window on the surface uses — deliberately does the opposite, and its docblock says why: *"Vercel runs TZ=UTC, so from ~afternoon-to-midnight Pacific the raw UTC date is already tomorrow and every window would silently slide forward a day."*

`loaders.ts:288` has the same UTC anchor for the tape's context captions.

**Failure:** between 17:00 and 24:00 Pacific, the resolution's candidate evidence, `claimEvidence`, ladder rungs and `predicateId` are computed over one day range while the facility ranking rendered beside them uses another — on a surface whose stated thesis (`resolution.ts:10-14`) is that every rendered number traces to one window.

**Outcome:** one anchor function, used by both paths.

**Test:** pin both against a fixed `2026-08-12T23:30:00Z` clock. **It fails today.** `resolutionService.ts:465-478` documents a measured off-by-one that was fixed in `trailingWindowFor` by matching `contract.ts`'s half-open convention — the *anchor* was never brought into that same parity check. Extend that test rather than writing a new one beside it.

**While you are here:** `v3-actions.ts:61-66,82-85` reads a `windowDays` form field that **no form sends** (`grep -r 'name="windowDays"' app/components/qualify/` returns nothing). Either delete it or wire it. Leaving it gives a future caller a way to move the resolution window without moving the ranking window — this exact asymmetry, widened.

---

### P1-3 · `board.ts:270-271` trusts stored `band_now` while its comment claims the opposite

```ts
// Recompute the band from the number rather than trusting stored text — the two cannot drift.
bandNow: TAPE_BANDS.has(r.band_now ?? '') ? (r.band_now as QualifyIqBand) : iqBandOf(r.rating_now),
```

The code falls back to `iqBandOf` **only when the stored value fails to parse**. Drift is not merely possible, it is unguarded — and the comment tells the next reader the state is impossible.

**Failure:** a nightly snapshot writes `rating_now = 51, band_now = '30'` (a cron bug, or a row written before a band-threshold change). The tape renders the numeral **51** next to the pill **"Watch · 30%+"**.

**Outcome:** make the code match the comment. Test: a row with `rating_now=51, band_now='30'` renders band 50.

**Related, do not fix here:** `core.ts:546-624` and `board.ts:146-188` duplicate the availability/basis mapping in full, and `board.ts:14-19` acknowledges it with a comment as the only guard against stored-vs-onscreen divergence. That is a real structural problem and it is **not** this PR — name it as a follow-up.

---

### P1-13 · `collections.facility_assignments_guard` has a mutable `search_path`

Live Supabase security advisor, WARN, EXTERNAL-facing. A definer-adjacent function with a role-mutable search path is a privilege-escalation primitive.
[remediation](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)

This needs a migration in the **product plane** (`supabase/migrations/00NN_*.sql`).

**⚠ Deriving the number is the risky part, and this repo has an incident about it.** The next number is believed to be **0100** — but a file listing is **not** the number. Per `.claude/rules/sql-migrations.md`:

1. Query the **live ledger**: `supabase_migrations.schema_migrations`.
2. Check **every worktree** for untracked `.sql` files. On 2026-08-10 a concurrent session authored and applied its own `0096_manual_deposits` whose file lives untracked and on no ref; the collision was caught only because the number was verified against the ledger.
3. A version number is **consumed the moment it lands in the ledger** — never reuse one, even where the migration left no file behind (0095 is exactly that case).

**Ownership:** `collections` objects are owned by `postgres`, **not** `claims_admin`. Do **not** add `SET ROLE claims_admin` to a `collections` migration — it downgrades the applying role from owner to non-owner and fails `42501: must be owner of table`. 0084 and 0085 both hit this.

**⚠ HOLD:** show me the migration and stop. Do not apply it.

---

## 3. DO NOT RE-FILE — checked against production this session and disproven

| Claim | Reality |
|---|---|
| "`patient_name_bidx` is missing (mig 0067 unapplied), so the name search throws 42703 and fails closed." | **False.** The column exists on `collections.cmd_explorer_rows` in prod. The endpoint works. This makes P0-3 **more** severe, not less. |
| "The `qualify-rating-history` cron missed today's run (max `as_of_date` is 2026-08-11)." | **False.** `collections.qualify_rating_run` id 242 ran 2026-08-12 05:10:41 UTC, `ok=true`, 1,275 pairs, 4.7s. `as_of_date` is deliberately run-date minus one. **Healthy — leave it alone.** |
| "The desktop stale-flash in `.claude/rules/qualify.md` is live." | **Doc rot.** v2 fixed it (`qualify-tab.tsx:651-660`), v3 handles it correctly (`:3452-3462`). The **mobile** equivalent is live but it is a Wave 4 item, not this PR. |

## 4. CONFIRMED CLEAN — do not "improve" these while you're in the file

- **No SQL injection on any Qualify path.** Every builder routes values through `paramList()`/`add()`; identifiers are fixed literals; `buildGroupLadderQuery`'s interpolated rung days are integer-validated (`qualifyResolutionQuery.ts:307-311`). No `SELECT *`.
- **Gate coverage is complete.** Every exported Server Action across all six action modules calls `requireQualifyPrincipal` before touching data; every core re-gates as a backstop. `principal.ts:72-78` correctly denies the no-auth staged-rollout fallback.
- **Dollar-stripping holds.** `stripSnapshotAmounts`/`stripClaimsAmounts` are the single choke point and run last on every return path. `qualifyAi.ts:597` correctly ORs the client flag with the server principal's — it can tighten, never loosen. **Every change in this wave must preserve this.**
- **Date arithmetic is correct** — `qualifyWindowBounds` (all three window shapes incl. the month-1 prior-period wrap), `shiftIsoDays`, `addDaysIso`, `daysBetweenUtc`, `computeLosDays`. **P1-1 is the anchor, not the math.** Do not touch the arithmetic.
- **No division-by-zero or NaN leaks** in `ratingV2` (`clamp01` guards non-finite), `derivePolicyRating:211`, `pct()`, `deltaPct`, `deriveFacilitySpread`.
- **No browser storage anywhere** in `app/lib/qualify`, `app/components/qualify`, `app/app/qualify`.

---

## 5. DEFINITION OF DONE

1. Each of the seven is **fixed** or returned as `stillPresent:false` **with the evidence that disproves it**.
2. Each fix has a hermetic test that **fails on the pre-fix code**. State which test covers which finding.
3. All five gate commands green, **exact counts reported** — not "passing". If a count is below the floor, stop and explain.
4. Diff summary: files touched, lines ±, and the three changes you are **least** confident in.
5. Two HOLDs honoured: the P0-2 rating treatment, and the P1-13 migration.
6. `gh pr create --base main` — **and HOLD before pushing.** Show me the PR body first.
7. No `Co-Authored-By` trailer.
8. Anything you discover that is not in this prompt: name it as a **separate follow-up**. Do not fold it in. Scope creep in a PHI-and-numerals PR is how a review misses the thing that mattered.
