# Qualify v3 follow-ups — handoff

Paste this whole file as your first message in a new Claude Code session in
`/Users/aleclowi/CMD-Billing-Dashboard`.

## Context you need before touching anything

Read, in this order: `CLAUDE.md`, `.claude/rules/qualify.md`,
`.claude/rules/nextjs-app.md`, `docs/qualify-v3-search-pattern.md`. The last
one is the spec for the staged flow these follow-ups sit on top of.

The staged flow (`app/components/qualify/v3/`) shipped in four commits, now
all on `main`: `41fcf55` (design pass — motion/colour/density/ScrollTrigger),
`6f639d3` (Skip escape hatch + visible filter lines), `7c86709` (skip-honesty
fixes — a skipped search must not claim a plan the user declined to pick),
and `bef4c57` (Qodo's refetch-flag fix, landed via cherry-pick after PR #126
merged at a stale head — see F6 below, that gap-detection pattern matters
here too). `git log --oneline -6 origin/main` to confirm you're looking at
current state before starting.

Six independent follow-ups below, each with its own verification bar. Do them
in any order except where noted; don't bundle more than one into a single PR
unless they touch the same file for the same reason. Every code follow-up
(F1-F4) ends with the standard five-command gate:

```bash
npm test                      # root — floor is whatever F5 measures, see below
npm run typecheck              # root tsc, stricter than app tsc
cd app && npm test              # app
cd app && npm run typecheck
cd app && npm run build         # only thing that catches webpack-only failures
```

PRs go against `staging` per the documented flow (`gh pr create --base
staging`) — EXCEPT staging is currently broken (F6). Read F6 first if you're
about to open a PR and staging still hasn't been fixed; you may need to
target `main` directly as this branch's predecessors did, and say so
explicitly in the PR description.

No `Co-Authored-By` trailer, ever.

---

## F1 — server-side latency: `getQualifySnapshot` + the auto-window ladder

**Symptom, as reported by Alec:** the answer stage's initial wait — after a
Skip or a window change — feels slow. This is almost certainly NOT the
client-side typing lag (that was fixed with `useMemo` in `7c86709`/the
follow-on commit); it's a server round-trip.

**Where to look first:** `app/lib/qualify/core.ts`, function
`getQualifySnapshotCore` (the real work behind `getQualifySnapshot` in
`actions.ts:161`). Verified serial structure as of `bef4c57`:

1. `deps.requirePrincipal()` (~line 553)
2. `deps.recordAccess(...)` (~line 572) — audit write, must stay before any
   data read, do not reorder for performance
3. **Phase E, the auto-window ladder** (~line 579-614): when
   `input.auto === true && kind === 'prefix'`, this awaits
   `deps.loadWindowRungs(...)` — ONE bucketed query across 5 trailing-window
   rungs (30/60/90/180/365) — and blocks everything after it. This is the
   prime suspect: it's a full serial round-trip before the parallel batch
   even starts.
4. **Then** a `Promise.all` of 5 more queries (~line 621): `resolvePayer`,
   `loadPolicy`, `loadVobFreshness`, `loadPayerSpread`, `loadPolicySpread`.
5. **Then** more `Promise.all` phases downstream for the ranking/facilities
   read (~line 715, ~line 781) — confirm exact count by re-reading, this
   summary is not exhaustive past that point.

So there are at least 3 serial legs: ladder → phase-B/0 batch → ranking
batch. Each is 1 network round-trip to Postgres at minimum; if any query
plan has degraded (a missing index, a cold cache, a sequential scan) that's
where it shows up.

**What "its own EXPLAIN session" means, concretely:**
1. Reproduce the exact query shapes `loadWindowRungs`, `resolvePayer`,
   `loadPolicySpread` etc. generate (find them via `deps` — the real
   implementations are injected in `app/lib/server.ts`, follow the wiring).
2. Run `EXPLAIN (ANALYZE, BUFFERS)` on each against the live `claims_reader`
   role (see `.claude/rules/sql-migrations.md` and `veris-data-notes.md` for
   how prior latency work in this repo did this — the 13s→0.6s KPI fix and
   the movers-query fix are the precedent; `git log --oneline --all
   --grep="perf(qualify)"` to find them).
3. Look specifically for: `count(distinct x)` forcing a sort instead of a
   hash aggregate (this repo's #1 recurring cause per `CLAUDE.md`'s
   "Standing rules" section and `.claude/rules/qualify.md`'s Performance
   section); a missing covering index on `cmd_explorer_charge_rollup` for
   whatever predicate `loadWindowRungs` filters on; whether the ladder query
   could be merged into the phase-B/0 batch (they don't appear to have a data
   dependency on each other — the ladder result feeds `window2`, which
   feeds `qualifyWindowBounds` calls used by phase B/0's queries, so check
   whether that's a REAL dependency or an incidental one that could be
   restructured to run them concurrently).
4. State the root cause in writing (per the `senior-engineer` skill's
   bug-fixing workflow: reproduce → diagnose → state → fix minimally →
   prove it) before changing any query. Do not guess-and-check on a
   production query plan.

**Guardrails:** reads stay `claims_reader`. No `SELECT *`. Parameterized
queries only — table/column names are fixed literals. If you find a missing
index, that's a new migration under `supabase/migrations/00NN_*.sql` (check
`CLAUDE.md`'s migration table for the next number, and re-derive it —
the file says it may be stale) — author it, but per the standing rule, HOLD
before `apply_migration`; show the plan improvement and ask.

---

## F2 — answer stage blanks on a refetch FAILURE, no retry affordance

**Where:** `app/components/qualify/v3/resolution-flow.tsx`, `StageAnswer`,
around line 1213-1224 (line numbers as of `bef4c57` — re-grep
`snapshotError` to confirm, this file has moved before).

**Current behavior:** if a re-scope (window chip, billed-under chip, a
filter toggle) fails — `getQualifySnapshot` rejects — the client sets
`snapshotError` and the answer stage renders:

> "The facility ranking could not be loaded. The plan resolution above
> still stands — try again, or change the window."

Two problems:
1. **The stale content is gone.** Unlike a successful refetch (which keeps
   the old snapshot dimmed under a progress beam per the "stale-sentence"
   rule from `7c86709`), a FAILED refetch drops straight to this error
   banner — the user loses whatever ranking was on screen a moment ago,
   even though it's still just as valid as it was before they clicked.
2. **"try again" is not a button.** There's no retry affordance — the user
   has to click the exact same chip a second time, and per the
   `scopeKeyOf`/`isRefetching` mechanism added in `bef4c57`, re-clicking the
   SAME chip is a no-op (the scope key doesn't change), so it may not even
   re-fire the fetch. Check this specifically — it may itself be a small
   bug worth fixing alongside the UI: does the shell's fetch effect in
   `resolution-flow-client.tsx` retry on an unchanged `scopeKey` after a
   prior failure, or does it need `loadedKey` to NOT be stamped on failure
   (confirm it currently isn't — check the `.catch` block) so the key
   mismatch persists and a later dependency change (e.g. `stage`) could
   retrigger it, but a literal same-chip re-click currently can't?

**Fix shape (proposal, verify against the file before committing to it):**
- On fetch failure, do NOT null the snapshot if one is already on screen —
  keep rendering the last-known-good ranking, dimmed, same as the
  in-flight-refetch treatment, with the error banner appended rather than
  replacing everything.
- Add an explicit "Retry" button in the error banner that re-issues the
  exact same request (same `sentOverride`/`windowDays`/`filters` — i.e.
  force the effect to re-run even though the scope key is unchanged; this
  is the one place a manual re-trigger belongs, since it's a genuinely new
  attempt at the same request, not a no-op click).
- On a genuine FIRST load failure (no prior snapshot at all), the current
  full-blank error state is fine — there's nothing to preserve.

Add a test in `app/test/qualifyV3Flow.test.tsx` pinning: (a) a refetch
failure with a prior snapshot keeps the scorecard grid rendered, (b) a
first-load failure shows the plain error state, (c) the retry control exists
and is a real `<button>`.

---

## F3 — `deriveStage`/`liveSentenceFor` still self-derive `payerGroupsOf`;
extract the shell into a testable reducer

Two related-but-separable pieces of work; do the memo one first (small,
mechanical), the reducer one second (larger, needs its own review).

### F3a — the remaining un-memoized `payerGroupsOf` calls

`clusterCarriers` (which `payerGroupsOf` wraps) is O(n²) over the candidate
set — a real 311-plan prefix is not free to run four times per render. The
`bef4c57`/prior commits memoized it in the CLIENT SHELL
(`resolution-flow-client.tsx`) and threaded the result down as a
`payerGroups` prop to the rail, receipt, and both tile stages. But these four
call sites in `resolution-flow.tsx` still self-derive when the prop isn't
passed (verify against current line numbers, these shift):

- `deriveStage` (~line 198): `payerGroupsOf(r).length > 1 && ...`
- `liveSentenceFor` (~line 348): `` `${payerGroupsOf(resolution).length} carriers...` ``
- `StagePlan`'s stale-fallback branch (~line 435):
  `(groups ?? payerGroupsOf(resolution)).length <= 1`
- `FlowReceipt`'s fallback (~line 576): `payerGroups ?? payerGroupsOf(resolution)`

The last two already accept an optional pre-computed `payerGroups` and only
fall back to a fresh derive when it's absent (which today is never, in
practice, since the shell always passes it) — those are LOW risk, arguably
fine as-is (defensive fallback for a prop that's always supplied).

`deriveStage` and `liveSentenceFor` are the real gap: they're PURE functions
that don't currently accept a pre-computed `payerGroups` at all, so they
always self-derive. Fixing this means widening their signatures to accept an
optional `payerGroups?: PayerGroup[]` param (mirroring the pattern already
used by `StagePayer`/`StagePlan`/`FlowReceipt`) and having the shell pass its
memoized value in. This is a signature change to two exported pure
functions — check `app/test/qualifyV3Flow.test.tsx` for every call site of
both (there are several, across many tests) and make sure none breaks; the
new param should be optional so existing calls compile unchanged.

### F3b — extract the shell's state machine into a reducer

`resolution-flow-client.tsx` currently manages ~10 `useState` calls
(`payerPick`, `picked`, `skipped`, `filters`, `employerQuery`, `planFilter`,
`autoAsk`, `backTo`, `snapshot`, `snapshotError`, `payerOverride`,
`windowDays`, `loadedKey`, `trends`) with hand-written clearing logic
repeated across `identifyAction`, `onSkip`, `planAction`, and `onChange` —
each has to remember to reset the same dozen-odd fields to keep the state
machine honest (e.g. "going back clears the skip", "a new search clears
everything downstream"). This repetition is exactly the class of bug the
`bef4c57` refetch-flag fix was about: state that four different call sites
must independently keep in sync is a bug waiting to happen.

**Proposed shape:** a single `useReducer` with actions like
`{type: 'search_submitted'}`, `{type: 'carrier_picked', payer}`,
`{type: 'plan_picked'}`, `{type: 'skipped'}`,
`{type: 'filter_toggled', facet, value}`, `{type: 'went_back', target}`,
`{type: 'snapshot_requested'}`, `{type: 'snapshot_resolved', scopeKey,
snapshot}`, `{type: 'snapshot_failed'}` — one reducer function, testable in
isolation with `node:test` (no React needed to test a reducer), pinning
exactly which fields each action resets. This is the harness that would have
caught the F1-adjacent stuck-flag class of bug by construction rather than
by a manually-written test per scenario.

**This is a bigger change than it sounds** — touches the whole shell file.
Do it as its OWN PR, reviewed on its own, not bundled with F3a or anything
else. Read the current file in full before starting; do not attempt this
without first writing down (in the PR description or a design comment) the
full list of actions and exactly which state fields each one touches, cross-
checked against every existing `set*` call in the current file so nothing is
dropped silently.

---

## F4 — `heating-ticker.tsx` sub-12px text, invisible to the invariant suite

**Where:** `app/components/qualify/shared/heating-ticker.tsx`. Verified
current offenders:

- line 141: `text-[10px]` — the `#{i+1}` rank ordinal
- line 144: `text-[9px]` — the IP/OP/BOTH care-setting pill
- line 169: `text-[10px]` — the "N claim lines · {range}" caption
- line 184: `text-[10px]` — the "Trending · {range} · {scope}" header
- line 214: `text-[10px]` — the loading-skeleton header text

**Why the suite doesn't catch it:** `app/test/qualifyV3Flow.test.tsx`'s
12px-floor invariant test renders `ResolutionStages` with `ticker: null` in
every single case (the `props()` test helper defaults `ticker` to `null` and
no test overrides it with a real `<HeatingUpCards>`), so the ticker's markup
never appears in the HTML the assertion scans.

**Fix is two parts:**
1. Bring the five call sites up to the 12px floor (`text-xs` is 12px in this
   Tailwind config, per the design system doc). This is a real user-facing
   readability issue independent of test coverage — the ticker is real
   content on a real phone-call rep's screen.
2. Close the test gap: add (or extend) a test that renders the identify
   stage with an ACTUAL `<HeatingUpCards trends={...} window={...}
   readOnly />` as the `ticker` prop (not `null`), so the 12px-floor
   assertion actually walks its markup. Otherwise this regressed once and
   will regress again silently.

Verify against `docs/archive/design-system.md` for the exact floor rule
before changing classes — don't just find-replace to `text-xs` without
confirming that's the right size for each element (a rank ordinal and a
"Trending" label may deserve different treatment).

---

## F5 — `CLAUDE.md` gate floors are stale (1110/259) vs. current reality

**Do NOT edit `CLAUDE.md` directly as a drive-by.** Per its own text:

> Provenance of the current floors (read before trusting them). ... Only
> counts measured on a clean detached checkout of `origin/main` are
> trustworthy — a shared working tree with other sessions' edits is not
> evidence. Re-measure on a clean checkout when you next have one, and
> promote the number then.

The floors currently written (1110 root / 259 app) are stale — this
session's shared working tree measured 1284 root / 382 app on `bef4c57`, but
per the rule above that's not itself promotable evidence; it needs a clean
checkout to count.

**What to actually do:**
```bash
git worktree add /tmp/clean-main origin/main
cd /tmp/clean-main
npm test 2>&1 | tail -5                    # root count
npm run typecheck
cd app && npm ci && npm test 2>&1 | tail -5  # app count
npm run typecheck
npm run build
```
Take the exact pass counts from that clean run, then edit `CLAUDE.md`'s
Verification Gate section to update the two numbers AND the provenance note
(who/when/which commit measured them — follow the existing format in that
section exactly, it already models this once). Clean up the worktree after:
`git worktree remove /tmp/clean-main`.

This is a documentation-only PR. Small, low-risk, but do not skip the clean-
checkout step — measuring in your own working tree (which may have
uncommitted changes from other work) reproduces the exact mistake the
provenance note is warning against.

---

## F6 — staging is 2 merges behind main and NOT fast-forwardable

**Verified current state** (re-check before acting, this drifts):
```
origin/main:    bef4c57 (refetch-flag fix)
                81e3665 (Merge PR #126 — the v3 design pass line)
                7c86709 ...
origin/staging: 58a0510 (test: parse the use-server guard instead of
                          regexing it, Qodo #116)
                b50ddfc (Merge PR #116)
                bbb15e0 (Merge PR #117 — v3-crosswalk-through-p3)
```
Neither branch is an ancestor of the other — `git merge-base --is-ancestor
origin/staging origin/main` and the reverse both fail. Staging has one
commit (`58a0510`) that main lacks; main has the entire v3 design-pass line
plus the refetch fix that staging lacks. This inverts the documented flow in
`CLAUDE.md` ("PRs open against staging ... main only receives a PR from
staging after Vercel and Qodo checks pass") — right now staging is BEHIND
main, not ahead of it, because PR #125 and #126 were both opened directly
against `main` (a deliberate, repeatedly-confirmed exception in this
specific work stream, not a mistake to re-litigate) and the `refetch-flag`
fix was cherry-picked straight onto `main` after a stale-head merge.

**This is a decision for Alec, not something to resolve unilaterally.**
Options, in order of how closely each restores the documented flow:

1. **Merge `main` into `staging`** (not fast-forward — a real merge commit,
   since staging has `58a0510` which main lacks). This is the standard fix:
   `git checkout staging && git merge origin/main` (or via a PR:
   `gh pr create --base staging --head main` won't work directly since
   GitHub PRs need a branch, not main-into-itself — more likely: create a
   branch off staging, merge main into it, PR that branch back into
   staging). After this, staging becomes a strict superset of both prior
   histories and future PRs can go against staging normally again.
2. Cherry-pick just `58a0510` onto main and retire staging as the working
   branch going forward — only if Alec says staging is no longer the
   intended flow for this work.

**Do not force-push, do not rebase either branch, do not silently pick one
without asking.** State the divergence plainly (as above) and ask which
option before touching either ref. This is exactly the class of git-history
mistake `[[pr-merge-dropped-a-commit]]` and `[[staging-merge-is-not-a-
deploy]]` (prior session memories, worth `grep`-ing your project memory
files for if you have access) warn about.
