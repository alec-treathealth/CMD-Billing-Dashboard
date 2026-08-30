ultracode

# Qualify — Wave 2: operational integrity

Six findings. **Three of them are decisions, not code changes** — P0-5, P0-6 and P0-7 each need a ruling from me before anything ships. Bring me the options with the data; do not decide them yourself and do not implement past the ruling.

The other three (P1-7, P1-8, P1-9) are straightforward hardening and can proceed independently.

A three-lens audit produced these with file:line evidence and live production verification. **Your job is to fix them, not to re-audit them.**

**Prerequisite:** Wave 1 (wrong numbers and PHI exposure) should be merged before this wave starts. If it is not, say so and stop — several of these findings sit in files Wave 1 touches.

---

## 0. GROUND RULES — read the convention files FIRST

Read, in order: `CLAUDE.md` → `veris-data-notes.md` (§ qualify) → `.claude/rules/qualify.md` → `.claude/rules/collections-crons.md` → `.claude/rules/nextjs-app.md` → `.claude/rules/query-library.md`. **Those files outrank anything in this prompt.** Conflict → surface it and stop.

Hard invariants:

- **PHI never** reaches logs, LLM prompts, `summary_stats`, a URL or query string, browser storage, or `query_log`.
- **Parameterized queries only.** Identifiers are fixed literals; only values are `$n`. Never `SELECT *`.
- **Reads run as `claims_reader`; writes as the narrow writer role** (`cmd_rollup_writer` for collections). Never the service-role key, never `claims_admin` on the app path.
- **Secrets from env only.** No `NEXT_PUBLIC_*` for anything server-side. **Never log a connection string**, in full or in part.
- **Verify-full TLS stays on** (`src/ssl.ts`). Never reintroduce `rejectUnauthorized: false`. Never put `sslmode` in a DB URL — it silently drops the CA.
- **Supavisor transaction pooler (port 6543) forbids named prepared statements** — `pool.query(sql, params)` only.
- **Tests stay hermetic** — `node:test` only, no live LLM/DB in `npm test`.
- **Never add a `Co-Authored-By` trailer.**
- **Gate outward-facing actions.** Show results and **HOLD** before applying a migration, committing, pushing, deploying, or changing a Vercel env var.
- **PRs open against `main`** — `gh pr create --base main`. (⚠ `staging` was DELETED 2026-08-14 (ruled poor dev practice) — branch off `main`, PR to `main`.)

**⚠ The hourly collections crons are production-critical.** Don't touch their routes, schedules, Vercel env, writer grants, or the `collections.*` tables they write. P0-5 concerns `facility-outcomes` (daily 04:10), which is **not** one of the hourly crons — but the same care applies. **After any push that deploys, verify the next scheduled run logs success.**

**Verification gate — all five, green, before any commit:**

```bash
npm test                    # floor in CLAUDE.md (NOT restated here — see below)
npm run typecheck           # root tsc (strict)
cd app && npm test          # floor in CLAUDE.md
cd app && npm run typecheck
cd app && npm run build
```

⚠ **The pass-count floors are deliberately NOT written here.** This block used to name
`>=1439` / `>=831`; those were ratified 2026-08-11 and were **447 root and 207 app tests
low** by 2026-08-30, so a session running this prompt would have checked a suite that had
lost 447 tests against a number it still passed. CLAUDE.md's *Verification gate* is the only
place the floors are re-measured. Read them there; do not copy them back into this file.

Counts are **floors, not targets**. Fewer means tests were lost — find out why before committing.

---

## 1. ORCHESTRATION

```
phase('Confirm')  → one agent per finding: confirm the defect on HEAD, return the change
                    surface. For the three DECISION findings, the agent's job is to return
                    OPTIONS WITH DATA, not a fix. {stillPresent:false} is a valid result.
phase('Decide')   → STOP. Report to me. Do not proceed past this on P0-5/P0-6/P0-7.
phase('Fix')      → pipeline over P1-7/P1-8/P1-9 (independent, can run during 'Decide'),
                    then the decided items once I have ruled.
phase('Refute')   → adversarial per fix: "does this change ingest behaviour? does it
                    swallow an error it should surface? does it widen a credential's
                    reach?" Default to refuted on uncertainty.
phase('Gate')     → five commands, exact counts.
```

---

## 2. THE THREE DECISIONS

### P0-5 · `facility-outcomes` cron has failed every day since 2026-08-07

**Live Vercel telemetry:** `facility-outcomes cron failed (getaddrinfo ENOTFOUND db.khnaconatuspmzkmsfge.supabase.co)` — 6 occurrences, first `2026-08-07T04:10:19Z`, **last `2026-08-12T04:10:14Z`**.

That hostname is `EXEC_CENSUS_DATABASE_URL`, the **source** project — not this project. `facilityOutcomesSync.ts:24` documents the two-database design: *"reads come from the source project over EXEC_CENSUS_DATABASE_URL; writes go to THIS project's collections plane as cmd_rollup_writer."* The source host's DNS no longer resolves.

**Live consequence:** `collections.qualify_facility_outcomes` holds **12 rows for 12 facilities** against a **48-facility roster**, and has not moved in six days. The `authFit` factor (weight 10) and the **overrun penalty this sync exists to make possible** are running on stale data for a quarter of the book and no data for the rest.

The sync's own header explains why it was built: measured 2026-08-06, reading LOS off the monday census snapshot put all twelve residential facilities *below* their authorization (0.69–0.96), so the overrun penalty could never fire for anyone. Completed-stay data put four at or over it. **That correction is currently frozen.**

**What I need from you, before any code:**

1. Is the source project gone, renamed, paused, or is this a stale credential? Determine which. Do **not** guess.
2. Options with cost: repoint the credential · re-home the source aggregate into this project · retire the sync and drop `authFit` to unavailable.
3. **Regardless of which we pick:** a failing cron must not silently degrade into stale ratings. This is the **0089 lesson** — a swallowed 42501 became permanently wrong data instead of a visible failure, and `loaders.ts:143-156` restates it. The surface needs a state for *"this factor's source is stale"*, and the rating needs to know its own inputs are old.

**⚠ HOLD after step 2.** Changing a Vercel env var is an outward-facing action.

**PHI constraint, load-bearing, do not "optimize":** the `GROUP BY` runs **in the source database**; only facility-grain counts and day-averages cross the wire. The source table is patient-grain and facility + admit date + discharge date is a limited data set. Copying it row-level would multiply PHI surface across a project boundary for nothing this factor needs. `facilityOutcomesSync.ts` says this in a box — respect it.

---

### P0-6 · The 30 %-weight `coding` factor is barely seeded

**Live:** `coding.code_decision` holds **42 rows, all current**, against a **48-facility roster**, at a payer × facility × LOC × code decision grain.

`coding` is weight **30** — the single largest input to `ratingV2` — and is UNAVAILABLE until the registry is seeded (`.claude/rules/qualify.md`). `ratingV2.ts:14-31` **renormalizes over the available weight set**.

**So facility A's 62 is `(claims 25 + dataConfidence 20 + ttp 15 + authFit 10) / 70` and facility B's 62 is a different fraction over a different denominator — and they are ranked against each other as if commensurable.** `availableWeight` already exists on the type and is not surfaced anywhere on the numeral.

**Two parts, and they are different in kind:**

**(a) Code change — surface the denominator.** `availableWeight` becomes visible on the numeral. A facility rated on 70 % of the model must say so. The v3 score card already has the right sentence pattern at `:2145` — *"Not enough data to rate — 2 patients in window"* — this needs its sibling.

**(b) Product ruling — mine, not yours.** Should a rating with the 30 % factor missing be **shown at all**, or **suppressed** the way `sampleGate.ts` suppresses below-floor facilities?

Bring me:
- the distribution of `availableWeight` across the current book;
- how many facilities would be suppressed under a "coding required" rule;
- what the ranking looks like with and without.

**⚠ HOLD.** Do not implement (b) before I rule.

**Do not change the weights or add a sixth factor.** `.claude/rules/qualify.md` is explicit: that is the same class of decision as the v2 model change and needs the same sign-off. It is not a tweak.

**Corrected scale note:** an earlier pass claimed `buildCurrentCodingDecisionsQuery` (`codingRegistryQuery.ts:75-83`) would scan thousands of decisions × 48 facilities per search. **That is wrong — there are 42 rows.** The missing `LIMIT` is real and currently harmless. Add the cap for hygiene; do not present it as a performance fix.

---

### P0-7 · `admissions_seat` currently has zero reachable screen in the entire product

- `maintenance.ts:12-22` — `maintenanceEnabled()` returns **true unless** the env var is explicitly `0|false|off`. **Default ON.** Bypass allowlist is a single email.
- `rbac.ts:43,63-70` — `allowedViewsFor('admissions_seat') === []` and `QUALIFY_HOME = '/qualify'`, so every protected route redirects the role back to `/qualify`.
- `page.tsx:42` / `m/page.tsx:72` — which renders `<QualifyMaintenanceNotice/>`.
- `qualify-maintenance-notice.tsx:24-36` — the notice's only two exits are `/dashboard` and `/dashboard/collections`. An `admissions_seat` has neither. **Both bounce straight back to the notice.** The component's own comment admits it.

**This is today's live experience for every admissions user.** They sign in and land in a redirect loop terminating in a "being rebuilt" page.

**Minimum fix (do this regardless of the ruling):** the notice is a terminal state an `admissions_seat` can sit in without a redirect loop, with a working sign-out.

**Ruling I need:** when do we intend to lift maintenance, and does `admissions_seat` get the surface before or after Waves 3–4 land? That is a product call.

**Related, in scope, and NOT a decision — fix it:** `qualifyMaintenanceBlocks` is checked in **three page components and nowhere else**. `gate.ts` and `principal.ts` never consult it. So all 19 Server Actions stay live while the surface reports it is offline — a tab open across a redeploy, or a replayed action id, keeps running every PHI search and audit-writing action. Not a privilege escalation (the Q-A gate still holds), but the surface's stated availability and its actual availability disagree. **Make the gate consult it.**

---

## 3. THE THREE HARDENING FIXES

### P1-7 · The v3 resolution pool has no statement, query or connection-acquire timeout

`resolutionService.ts:64-73` builds its pool with `makeClient()` (`db.ts:27-30`), which sets only:

```ts
{ ssl, max: 4, application_name: 'collections-ingest' }
```

The sibling pool used by `loaders.ts` — `src/queries/executor.ts:14-33` — sets `statement_timeout: 120_000`, `query_timeout: 125_000`, `connectionTimeoutMillis: 10_000`, **with a comment explaining exactly this hazard**: *"a runaway/stalled read can't pin a connection … a saturated {max:4} pool otherwise blocks unrelated app reads … with NO upper bound."*

Every v3 search runs four serial DB legs on this pool (`resolutionService.ts:221-224, 235, 319, 346, 351`), including the uncapped candidate queries of P1-8.

**Failure:** four concurrent searches on a pathological prefix each pin a connection with no server-side cancel; the pool saturates and every subsequent `resolveCoverageAction` hangs on `pool.connect()` with **no acquire timeout**. The whole Qualify search path stops responding until Postgres gives up.

**Outcome:** match the executor's ceilings. **Also fix `application_name`** — it currently reports as `collections-ingest` in `pg_stat_activity`, so this load is attributed to the ingest during triage. That misdirection is its own small bug.

### P1-8 · Candidate resolution is unbounded

`qualifyResolutionQuery.ts:63-99` (VOB path) and `:113-139` (claims-only path) both `group by` payer × employer × funding × plan_type × policy_type with **no `LIMIT`**.

Every resulting group becomes a `CoverageGroup`, and every **non-chosen** one is serialized into `candidates.rejected` and shipped to the browser (`resolution.ts:164-174`), each carrying an `employerLabel`.

`CLAUDE.md` records that the pathological prefix carries **300 employers**. A search on it builds 300+ candidate objects server-side, ships 299 rejected summaries to the client, and renders 300 plan tiles.

The neighbouring spread query **is** capped (`QUALIFY_SPREAD_LIMIT`). This path has no equivalent.

**Outcome:** a cap, with an explicit **"N more not shown"** state. **Never a silent truncation** — a truncated list that looks complete is worse than an uncapped one on a surface whose thesis is that every number traces to a population.

### P1-9 · Four Server Actions swallow errors with a bare `catch` and no log

`actions.ts:234-236, 247-249, 376-378, 439-441` — `loadQualifyFacilityOptions`, `loadQualifyPayerOptions`, `getQualifyPayerEverBilled`, `getQualifyResolvePayer` all end:

```ts
} catch { return { ok: false }; }
```

No SQLSTATE, no message, nothing in the server log. The sibling action 40 lines up (`loadQualifyDataFreshness`, `:408-431`) carries a **20-line comment** explaining why a swallow in this repo must stay discoverable, and `loaders.ts:143-156, 310-326` restates the 0089 lesson verbatim: *"a swallowed 42501 became permanently wrong data instead of a visible failure."*

**Failure:** the `claims_reader` grant or an RLS policy on the facility/payer option source is dropped. The facility narrow control silently renders nothing, the payer picker empties, and **there is no server-side evidence of a permission error anywhere.**

**Outcome:** every swallow logs SQLSTATE plus a **non-PHI** context string. And `resolution-flow-client.tsx:270` treats `[]` as **both** "not loaded yet" **and** "load failed" — and therefore "renders NO control" for both. Split those states.

---

## 4. EXPLICITLY NOT IN THIS WAVE

Name these as follow-ups if you touch adjacent code. **Do not fold them in.**

- `resolutionService.ts:309-312,375-381` — `chosenBy:'user'` asserted for a server-made pick.
- `resolution-flow.tsx:1701` — positional index into a live-data-ordered list as the candidate key.
- `v3-actions.ts:88-98` — no try/catch, no failure state in `V3FlowState`.
- `prefixLabel.ts:62,69-84` — ~46,656 synchronous HMACs on the request thread.
- `core.ts:546-624` vs `board.ts:146-188` — duplicated availability/basis mapping.
- The 16 unreferenced Server Actions, the v2 `qualify-tab.tsx` path, and splitting `resolution-flow.tsx`.

---

## 5. DO NOT RE-FILE — checked against production and disproven

| Claim | Reality |
|---|---|
| "`qualify-census` is failing with `permission denied for table facilities`." | **Resolved.** 9 occurrences, last `2026-08-06T07:22`; migration 0089 fixed the writer grant that same day. Live: 23 fresh rows, last sync `2026-08-12 21:22 UTC`. No recurrence. |
| "The `qualify-rating-history` cron missed today's run." | **False.** `collections.qualify_rating_run` id 242 ran `2026-08-12 05:10:41Z`, ok, 1,275 pairs, 4.7s. `as_of_date` is deliberately run-date minus one. **Healthy.** |
| "`buildCurrentCodingDecisionsQuery` will scan thousands of rows per search." | **Scale wrong** — 42 rows. See P0-6. |
| "`collections.qualify_prefix_echo` being empty is a pending to-do." | **False, and permanent by ratified decision (2026-08-09).** `src/collections/prefixLabel.ts` supersedes the echo seam. **Do not wire `record_qualify_prefix_echo`.** |

## 6. CONFIRMED CLEAN — do not "improve"

- **Roles are correct** — all Qualify reads run `claims_reader`; the only writes are `security definer` calls matching the 0097 design, plus the narrow `coding_editor` pool. No service-role key, no `claims_admin` on the app path.
- **No SQL injection**; no `SELECT *` on any Qualify path.
- **The PWA service worker caches only `GET /_next/static/`** (`swCachePolicy.ts`, `sw.js/route.ts`). Every Server Action POST is network-only. Leave it.
- **Dollar-stripping holds** — single choke point, runs last on every return path. Preserve it.

---

## 7. DEFINITION OF DONE

1. P0-5, P0-6, P0-7 returned to me as **options with data**, and **stopped there** pending my ruling.
2. P1-7, P1-8, P1-9 fixed, each with a hermetic test that fails on the pre-fix code.
3. The maintenance-gate-in-`gate.ts` fix landed (the non-decision half of P0-7).
4. All five gate commands green, **exact counts reported**.
5. Diff summary: files touched, lines ±, the three changes you are **least** confident in.
6. **No Vercel env var changed, no migration applied, nothing pushed** without an explicit HOLD to me first.
7. `gh pr create --base main` — HOLD before pushing; show me the PR body.
8. No `Co-Authored-By` trailer.
9. **If this PR deploys, verify the next scheduled `facility-outcomes` run logs success** and report the result.
