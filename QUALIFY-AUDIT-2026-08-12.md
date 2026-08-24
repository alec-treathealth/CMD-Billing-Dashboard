# `/qualify` — Full Audit

**Date:** 2026-08-12 · **Auditor:** senior-engineer + ux-researcher-designer + a11y-audit (WCAG 2.2 AA)
**Scope:** `app/app/qualify/**`, `app/lib/qualify/**` (52 files), `app/components/qualify/**` (73 files), `src/collections/qualify*.ts`, live Vercel `prj_vPJxHFny6OS9gU32swXMn3XJsog3`, live Supabase `dbpabchpvipipkzkogta`.
**Size:** 27,906 LOC. Largest single file: `v3/resolution-flow.tsx` at **4,856 lines / 308 KB**.
**No code was changed.**

---

## 0. Read this first — epistemics

Findings are tagged:

- **[LIVE]** — verified against the production database or Vercel error telemetry in this session.
- **[VERIFIED]** — read in the source at the cited `file:line`.
- **[SUSPECTED]** — reasoned from code but not executed or measured. Treat as a hypothesis.

Three claims produced by the sub-audits were **checked and disproven**; they are recorded in §6 so nobody re-files them.

---

## 1. Executive summary

The code quality here is genuinely high — the SQL is fully parameterized, every Server Action goes through one gate, dollar-stripping for `admissions_seat` has a single choke point, and the *narrative* copy (the nine-arm `billedUnderCaption`, the four-diagnosis empty states) is better than most commercial products. **The failures are not in the sentences. They are in the numerals, in the data pipeline behind them, and in the fact that the surface now renders three generations of UI at once.**

The five things that matter:

1. **Two different ratings for one facility, one tap apart, on mobile.** The card shows `ratingV2`; the "why is this rated X?" sheet computes and prints v1. A rep taps "why" on a 56 and is asked to explain a 78.
2. **A patient-name PHI search endpoint is live server-side behind a client-only flag** — and the DB column it needs **exists**, so it works.
3. **The `facility-outcomes` cron has failed every day since 2026-08-07** against a dead hostname. The auth-fit rating factor is frozen on 12 of 48 facilities.
4. **The 30 %-weight `coding` factor is seeded for 42 decisions against a 48-facility roster**, so the headline number is renormalized over a *different* factor set facility-to-facility with nothing on screen saying so.
5. **`admissions_seat` — the single-surface persona — currently has zero reachable screen in the entire product.** Maintenance mode defaults ON, the allowlist is one email, and the notice's two escape buttons both bounce back to the notice.

Counts: **9 P0 · 24 P1 · 31 P2 · 12 P3 · 7 Critical a11y · 14 Major a11y**.

---

## 2. P0 — ship-blocking

### P0-1 · Mobile shows two different ratings for the same facility, one tap apart
**[VERIFIED]** `m/swipe-row.tsx:52-64` renders `facility.ratingV2` (five-factor composite). The "why" button on that same row opens `m/trend-sheet.tsx:45`, which computes `ratingText = String(Math.round(facility.rating))` — **v1**, defined in `contract.ts:544-546` as `clamp0to100(pctAllowedOfBilled)` — and prints it into the heading **"Why is this rated {ratingText}?"** (`m/trend-sheet.tsx:55`). The two agree only when every non-claims factor happens to be unavailable.
**Failure:** rep taps "why" on a card reading 56, is shown an explanation for 78, and has no way to know which is the real number. A decision-support tool contradicting itself in one tap is the worst class of defect this surface can have.

### P0-2 · The composite rating is labelled as a percentage, and a real percentage is rendered identically
**[VERIFIED]** `v3/resolution-flow.tsx:2128-2141` prints `ratingV2` at 3xl with the band pill `Strong · 65%+` (`ratingV2.ts:52-67`). But `ratingV2` is a weighted fold of coding/claims/dataConfidence/ttp/authFit **renormalized over the available set** (`ratingV2.ts:14-31`) — it is a percentage of nothing. Meanwhile `shared/heating-ticker.tsx:229-231` prints `currentRating` at 24px **with a literal `%` suffix**, and that one *is* a real percentage ("reliable allowed % of billed", `contract.ts:1015`). A third, `policy-tape.tsx:161-163`, prints the stored fold bare.
**Failure:** a rep reading "Solid · 50%+" beside 56 will quote it to an admissions call as "they pay about 56 %". Three numbers on one screen, two scales, one visual language.

### P0-3 · Patient-name PHI search is reachable server-side behind a client-only flag
**[VERIFIED + LIVE]** `QUALIFY_CLIENT_NAME_ENABLED` is referenced in exactly four places, **all client components** (`qualify-tab.tsx:78,350,1105,1174`; `landing-hero.tsx:18,57`). The Server Action `getQualifySnapshotByName` (`actions.ts:192`) and the `clientName` narrows in `core.ts:1417-1424` and `core.ts:1525-1530` never consult it. `core.ts:1526` even comments "dormant until QUALIFY_CLIENT_NAME_ENABLED" while nothing server-side makes that true.
**[LIVE] and this is the part that upgrades it:** the target column `collections.cmd_explorer_rows.patient_name_bidx` **exists in production** (verified this session). So the action does not fail closed on a missing column — it **resolves and returns a payer + facility ranking scoped to a named patient**, for any Q-A principal including an `admissions_seat`, on a feature the team believes is off.

### P0-4 · `employer_norm` is written into the URL query string
**[VERIFIED]** `urlState.ts:29,74,88` declares `employers: string[] // employer_norm keys, non-PHI` and does `p.append('employer', v)`; `qualify-tab.tsx:682-690` writes it with `router.replace` on every chip change. Three sibling modules take the **opposite** position on the identical value: `phi.ts:23` lists `employer_name` in `PHI_BASE_COLUMNS`; `core.ts:924-934` calls itself "THE PHI FORWARDING BOUNDARY" and holds employers server-side; `qualifyResolutionQuery.ts:12-15` states "R6 keeps it out of every URL"; `resolution.ts:129` "It must never reach a URL (I7)."
**Failure:** `?employer=<small employer>&facility=<rehab facility>&payer=<carrier>` lands in browser history, the `Referer` header on every outbound asset, and edge/CDN logs. On an OON behavioral-health book that is a re-identification vector. Reachable today whenever `QUALIFY_V3_FLOW=0`, which `v3Flags.ts:6-8` guarantees stays fully reachable.

### P0-5 · `facility-outcomes` cron has failed every day since 2026-08-07
**[LIVE]** Vercel telemetry: `facility-outcomes cron failed (getaddrinfo ENOTFOUND db.khnaconatuspmzkmsfge.supabase.co)` — 6 occurrences, first 2026-08-07T04:10, **last 2026-08-12T04:10**. That host is `EXEC_CENSUS_DATABASE_URL`, the *source* project (`facilityOutcomesSync.ts:24`), not this project — its DNS no longer resolves.
**[LIVE] consequence:** `collections.qualify_facility_outcomes` holds **12 rows for 12 facilities** against a **48-facility roster**, and has not moved in 6 days. The `authFit` factor (10 % weight) and the overrun penalty this sync was built to make possible are running on stale data for a quarter of the book and no data for the rest. Nothing on the surface says so.

### P0-6 · The `coding` factor carries the largest weight and is barely seeded
**[LIVE]** `coding.code_decision` holds **42 rows, all current**, against a **48-facility roster** and a payer×facility×LOC×code decision grain. `coding` is weight **30** — the single largest input to `ratingV2` — and is UNAVAILABLE until the registry is seeded (`.claude/rules/qualify.md`). `ratingV2.ts:14-31` renormalizes over the available weight set.
**Failure:** facility A's 62 is `(claims 25 + dataConfidence 20 + ttp 15 + authFit 10)/70` and facility B's 62 is a different fraction over a different denominator. They are ranked against each other as if commensurable. `availableWeight` exists on the type and is not surfaced as a caveat on the numeral.

### P0-7 · `admissions_seat` has zero reachable surface in the entire product
**[VERIFIED]** `maintenance.ts:12-22` — `maintenanceEnabled()` returns **true unless** the env var is explicitly `0|false|off`, i.e. **default ON**. The bypass allowlist is one email. `rbac.ts:43,63-70` — `allowedViewsFor('admissions_seat') === []` and `QUALIFY_HOME = '/qualify'`, so every protected route redirects the role back to `/qualify`, which renders `<QualifyMaintenanceNotice/>` (`page.tsx:42`, `m/page.tsx:72`). The notice's only two exits are `/dashboard` and `/dashboard/collections` (`qualify-maintenance-notice.tsx:24-36`) — both of which redirect the role straight back. **This is today's live experience for every admissions user.**

### P0-8 · Mobile ranked-list pagination is swipe-only — no keyboard, no button
**[VERIFIED · WCAG 2.1.1 A, 2.5.1 A, 2.5.7 AA — Critical]** `m/facility-list.tsx:113-131,142-157,189-193`. `onPageNext`/`onPagePrev` are invoked **only** from `onUp()` inside the pointer-drag pipeline. No Next/Prev control, no `onKeyDown`. The page dots at `:177-186` are `aria-hidden` spans.
**Blocks:** keyboard-only, switch, screen-reader, tremor and limited-dexterity users reach page 1 and nothing else. Everything past facility #5 is unreachable.

### P0-9 · All three mobile bottom sheets are modals with no dialog semantics or focus management
**[VERIFIED · WCAG 1.3.1 A, 2.1.1 A, 2.4.3 A, 4.1.2 A — Critical]** `m/detail-sheet.tsx:125-129`, `m/trend-sheet.tsx:48-52`, `m/claim-detail-sheet.tsx:169-173`. None imports `useDialog`. Missing on all three: `role="dialog"`, `aria-modal`, accessible name (titles are plain `<div>`s), initial focus, focus trap, focus restore, Escape-to-close, background `inert`. `ClaimDetailSheet` (z-60) stacks on `DetailSheet` (z-50) with **both fully in the tab order**.

---

## 3. P1 — fix this sprint

### Correctness & data integrity

| # | Finding | Evidence |
|---|---|---|
| P1-1 | **The v3 flow anchors "today" to UTC; the shared contract anchors it to business TZ.** `v3-actions.ts:84` does `new Date().toISOString().slice(0,10)`. `contract.ts:1053,1090-1097` deliberately does the opposite and its docblock explains why ("Vercel runs TZ=UTC, so from afternoon-to-midnight Pacific every window silently slides forward a day"). From 17:00–24:00 PT the resolution evidence and the facility ranking beside it describe **different day ranges**, on a surface whose whole thesis is that every number traces to one window. `loaders.ts:288` has the same bug. | [VERIFIED] |
| P1-2 | **The carrier-stage member count is a sum, not a distinct count** — `payerGroupsOf` accumulates `g.members += c.memberCount` (`resolution-flow.tsx:219,240`), `board-zone.tsx:58` sums that again. A member on two plan candidates counts twice. One click later `snapshot.memberCount` — genuinely distinct — is printed with the **same noun**. The tile's accessible name makes it worse: "N **verified** members under this carrier" (`:1498`). | [VERIFIED] + [SUSPECTED] on the double-count |
| P1-3 | **`board.ts:270-271` trusts stored `band_now` over the recomputed band, and the comment claims the opposite** — `// Recompute the band from the number rather than trusting stored text — the two cannot drift.` The code falls back to `iqBandOf` only when the stored value fails to parse. A cron writing `rating_now=51, band_now='30'` renders "51" next to "Watch · 30%+". | [VERIFIED] |
| P1-4 | **`chosenBy: 'user'` is asserted for a choice the server made** — `resolutionService.ts:309-312,375-381`. `chosenIndex` falls back to `0`, then `chosenBy = groups.length===1 ? 'sole_candidate' : 'user'` with no reference to whether the operator supplied one. The module header states the rule being broken: "pre-selecting is fine, PRETENDING no choice was made is not." `window.chosenBy:'user'` (`:357`) is hardcoded even for the 365-day server default. | [VERIFIED] |
| P1-5 | **Candidate selection is a positional index into a freshly re-queried, data-ordered list** — `resolution-flow.tsx:1701` submits `value={c.index}`; `resolveCoverage` re-runs both queries and takes `groups[chosenIndex]`. Ordering is by live member count. An ingest landing between render and click silently resolves a *different plan* — and P1-4 then labels it `'user'`. `canonicalPayerId + employerLabel` is a stable key; the index is not. | [VERIFIED] |
| P1-6 | **A failed resolve has no in-flow state; it destroys the session.** `v3-actions.ts:88-98` calls `resolveCoverage` with no try/catch, and `V3FlowState` models only `empty \| prefix_too_short \| no_match \| denied` (`v3FlowState.ts:29-37`). A transient DB blip unwinds to `app/app/qualify/error.tsx`; `reset()` remounts the route and destroys the term, stage, session watchers, recent searches and any streamed AI answer. The **snapshot** fetch by contrast has a fully designed retry path (`:3428-3450`) — the identify step, which every session begins with, has none. | [VERIFIED] |
| P1-7 | **The v3 resolution pool has no statement, query or connection-acquire timeout.** `resolutionService.ts:64-73` → `db.ts:27-30` sets only `{ssl, max:4, application_name:'collections-ingest'}`. The sibling pool (`src/queries/executor.ts:14-33`) sets `statement_timeout:120s`, `query_timeout:125s`, `connectionTimeoutMillis:10s` **with a comment explaining exactly this hazard**. Four concurrent searches on a pathological prefix pin all 4 connections with no server-side cancel and no acquire timeout → the whole search path hangs. It also mislabels itself `collections-ingest` in `pg_stat_activity`, misdirecting triage. | [VERIFIED] |
| P1-8 | **Candidate resolution is unbounded** — `qualifyResolutionQuery.ts:63-99` and `:113-139` have **no `LIMIT`**. Every group ships to the browser via `candidates.rejected` (`resolution.ts:164-174`), each carrying an `employerLabel`. `CLAUDE.md` records a prefix carrying **300 employers**. The neighbouring spread query *is* capped (`QUALIFY_SPREAD_LIMIT`); this path has no equivalent. | [VERIFIED] |
| P1-9 | **Four Server Actions swallow errors with a bare `catch` and no log** — `actions.ts:234-236, 247-249, 376-378, 439-441`. The sibling action 40 lines up carries a 20-line comment on why swallows must stay discoverable, and `loaders.ts:143-156` restates the 0089 lesson verbatim ("a swallowed 42501 became permanently wrong data instead of a visible failure"). If the reader grant on the facility/payer option source is dropped, the narrow control renders nothing, the payer picker empties, and there is **no server-side evidence anywhere**. | [VERIFIED] |
| P1-10 | **`prefixLabelsFor` runs ~46,656 synchronous HMAC-SHA256 calls on the request thread** — `prefixLabel.ts:62,69-84`, called from `board-actions.ts:143` and `watcher-actions.ts:63`. The header's "callers are already async and already fail-soft" does not help: this is uninterruptible CPU on Node's single thread. On a cold lambda, every co-multiplexed request — including an in-flight `getQualifySnapshot` — stalls behind it, and 7 MB is retained for the instance's life. | [VERIFIED] |
| P1-11 | **Maintenance mode is a page gate only; all 19 Server Actions stay open.** `qualifyMaintenanceBlocks` is checked in three page components and nowhere else; `gate.ts`/`principal.ts` never consult it. Not a privilege escalation (Q-A still holds), but a tab open across a redeploy — or a replayed action id — keeps running every PHI search and audit-writing action while the surface reports it is offline. | [VERIFIED] |
| P1-12 | **Two subsystems independently re-resolve the same identifier on every search.** `resolveCoverageAction` mints the blind index and runs 2 candidate + 2 evidence + labels + ladder queries; `getQualifySnapshot` then mints the token again and runs its own 8-ish legs. ~10 DB round trips across 4 serial legs per search, on two pools. Every window-chip press re-pays the snapshot half. | [VERIFIED] |
| P1-13 | **`collections.facility_assignments_guard` has a mutable `search_path`.** Supabase security advisor, live. A `SECURITY DEFINER`-adjacent function with a role-mutable search path is a privilege-escalation primitive. [remediation](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable) | [LIVE] |

### UX

| # | Finding | Evidence |
|---|---|---|
| P1-14 | **The answer is the third thing in the answer column.** `resolution-flow-client.tsx:1465-1468` renders `<PolicyTapeMount/>` (dark marquee), then `{tickerNode}` (second marquee), then `<ThisSearchZone>` — the actual verdict. The rep answers three questions and must scroll past two auto-scrolling strips of *unrelated book-wide* content to reach the number they asked for. Every search, at the payoff moment. | [VERIFIED] |
| P1-15 | **The brightest, most animated control on screen is the escape hatch.** `SkipStep` (`resolution-flow.tsx:1143-1157`) is a teal900→teal700 gradient with a `.q-skip-spark` shimmer, rendered *above* the question at `:4712-4714`. The stage's primary action is a flat tile. Skipping sends `payerScope:'all'`, producing what the file itself calls "a blend the operator cannot reason about" (`:1075-1106`). The sparkle teaches "press me". | [VERIFIED] |
| P1-16 | **~14 concurrent top-level surfaces for a single-surface persona.** Rail (`lane-rail.tsx:60-104`): 9 blocks in a 416 px column. Board (`resolution-flow-client.tsx:1463-1496`): 5 more, plus 6 inside `StageAnswer`. Nothing is progressively disclosed at page level. | [VERIFIED] |
| P1-17 | **Three renderings of the same progress, stacked, in one 416 px rail.** `LaneStepper`, `LaneReceipt` and `LaneFeed` all render from one `laneSteps()` array, consecutively (`resolution-flow.tsx:4677-4686`). The file's own header admits it: "the mock states the same progress three times." ~30 % of rail height restates what the operator just did. | [VERIFIED] |
| P1-18 | **The census chip's silence carries three meanings.** `resolution-flow.tsx:1966-1967`: `bedState` of `not_applicable` (outpatient — beds don't apply) and `unknown` (no census row) both render **nothing**, and a card with no chips also looks like one with no UR date and no auth headroom. **[LIVE]** only **23 of 48** facilities have a census row (11 of those outpatient with `bed_capacity` null). "Can they physically go there today" — the first question of the job — is answered by an ambiguous absence. | [VERIFIED + LIVE] |
| P1-19 | **Mobile stale-flash is real and indefinite** (the desktop one in the rules doc is now stale — v2 fixed it at `qualify-tab.tsx:651-660`, v3 handles it with `opacity-60` + suppression at `:3452-3462`). `m/qualify-mobile-app.tsx:260-262,294-296` catches a failed resolve, sets a hint, and **leaves the previous member's ranked facilities on screen at full opacity** — `dimmed={isPending}` has already ended. No scope banner contradicts it. | [VERIFIED] |
| P1-20 | **Mobile error is a 12 px amber sentence with no role, no live region, no retry, at 2.82:1.** `m/qualify-mobile-app.tsx:864` renders `hint` as a plain `<div style={{fontSize:12,color:'#C9881E'}}>` on `#FBF8F4`. Carries real errors ("Qualify is unavailable right now"). No `role="alert"`, no `aria-describedby`/`aria-invalid` link to the input at `:667`. Stale results below it. | [VERIFIED · WCAG 3.3.1 A, 4.1.3 AA, 1.4.3 AA] |
| P1-21 | **"Loaded and empty" is byte-identical to "the fetch failed"** in both strips. `resolution-flow-client.tsx` `.catch(() => setTrends([]))` → `heating-ticker.tsx:143` `if (trends.length===0) return null`. `policy-tape-mount.tsx:293-304` collapses `ok:false` (read failed), `available:false` (relation missing) and `items:[]` into one `return null`. The day the query breaks, the page just looks calmer and nobody reports it. | [VERIFIED] |
| P1-22 | **~30 novel concepts before a new rep can read one screen**, with no glossary, tooltip index or first-run help anywhere in `app/components/qualify/**`: prefix / alpha prefix · carrier · payer · billed-under label · plan sponsor · funding · plan type · VOB · IQ band · the five factors · volume floor · reliability floor · ladder / rungs · the book / book-led / book-wide · tape · momentum / Δ pts · lane / locked to · skip / un-blend · predicate · provenance · trendwatcher vs patient watcher · masked echo · token · auth headroom · UR · LOS · slots only. | [VERIFIED] |
| P1-23 | **Three words for one thing, on one screen.** The same payer entity is "carrier" at `:1440`, "payer" in the identity line and AI header (`qualify-ai-panel.tsx:261`), and "BILLED UNDER"/"label" in the verdict facets (`:3792, :4064`). Likewise plan / policy / plan sponsor / employer are interchangeable — the tile at `:1698` is headed by the *employer* and the receipt calls the same value "Plan". | [VERIFIED] |
| P1-24 | **The maintenance interstitial is a closed loop** — see P0-7. `qualify-maintenance-notice.tsx:24-36`. The component's own comment admits it. | [VERIFIED] |

### Accessibility — Critical

| # | Finding | WCAG |
|---|---|---|
| A-C2 | **Employer type-ahead options are unreachable by keyboard.** `m/market-filter.tsx:119-203`: `onBlur={() => setTimeout(() => setOpen(false),150)}` unmounts the option button that just received focus, dumping focus to `<body>`. The `onMouseDown` preventDefault guard is **pointer-only**. No `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete`, no `role="listbox"`/`option`, no arrow keys, no live region. Keyboard and SR users **cannot apply an employer filter at all**. | 2.1.1 A · 4.1.2 A · 4.1.3 AA |
| A-C4 | **Policy-tape rating numbers use light-surface band hexes on the dark tape.** `policy-tape.tsx:161-163` paints `IQ_BAND_HEX[band]` on `bg-teal900 #0E3A3A` at 15 px/600: band 65 `#2E8B6F` **2.99**, band 50 `#1C8B82` **3.01**, band 30 `#C9881E` **4.17**, band 15 `#E2674F` **3.73**, band 0 `#C0453B` **2.47**. This is the exact mistake `tokens.ts:76-84` warns against in a ⚠ block. Only `TAPE_PALETTE.up/down` are measured for that surface. | 1.4.3 AA |
| A-C5 | **`.q-pct`/`.q-pctcell` paint bucket hexes as 12.5 px body text.** `globals.css:210-227` → `cases-table.tsx:210,312`. On white: ok **4.17**, warn **2.99**, neutral **4.44**, band50 **4.15**, band15 **3.34**. On their own `.q-heat` wash: ok **3.63**, warn **2.67**, danger **4.25**, band50 **3.70**, band15 **2.93**. Amber at 2.67 is the worst — and amber is the *estimate/reversal* tell. (`facility-panel.tsx:412` renders the same class at 38–52 px and legitimately passes as large text.) | 1.4.3 AA |
| A-C6 | **Focus indicator removed with no replacement on both mobile text inputs.** `m/qualify-mobile-app.tsx:673` and `m/market-filter.tsx:130-140` set inline `outline:'none'`. There is **no global focus fallback in `globals.css`** (verified — the only `focus` hit in that file is a comment at line 552). The primary search field of the mobile app gives zero indication it is focused. | 2.4.7 AA |
| A-C7 | see P1-20. | 3.3.1 A · 4.1.3 AA · 1.4.3 AA |

---

## 4. P2 — next two sprints

### Accessibility — Major

- **M1 · Auto-scrolling tickers have no pause/stop/hide control** (`useMarquee.ts:139-192`, `policy-tape.tsx:225-231`, `heating-ticker.tsx:276-282`). rAF loop at 32 px/s runs indefinitely; pauses only on hover/focus/gesture. `prefers-reduced-motion` is honoured but is a UA setting, **not a mechanism in the content**, and it is read **once at effect setup with no `change` listener**. Worse: when `onExplain` is undefined the tape's items render as `<span>` (`policy-tape.tsx:200`), so the scroll container has **no focusable descendants** — a keyboard user can neither pause it nor scroll it, and overflowing content is unreachable. **Two of these are stacked above the answer.** — *SC 2.2.2 A, 2.1.1 A*
- **M2 · The mobile PWA has no `<main>`, no `<h1>`, and no heading element at all.** Grep across `m/*` returns zero `<h1>`–`<h6>` and zero `<main>`; `m/layout.tsx` adds no landmark. Every section header, page title and all three sheet titles are styled `<div>`/`<span>`. The only landmark on the route is a breadcrumb `<nav>` at `:786`. SR users lose both orientation mechanisms on the densest surface in the app. — *SC 1.3.1 A, 2.4.1 A*
- **M3 · `SwipeRow` nests a real `<button>` inside `role="button"`** (`m/swipe-row.tsx:71-77, 128-137`). Presentational-children violation; JAWS/NVDA browse mode and the VoiceOver rotor commonly flatten the container and drop the nested "why this rating" control — the only path to the coverage explanation on the mobile card. The container's `onKeyDown` also swallows Space/Enter bubbling from inside. — *SC 4.1.2 A*
- **M4 · Rating colours fail 4.5:1 as small text across mobile** — `m/swipe-row.tsx:123-126` (verdict label, 12 px: warn **2.99**, band15 **3.34**), `m/detail-sheet.tsx:190-192, 267` (warn **2.82/2.67**), `m/claim-detail-sheet.tsx:197` (warn **2.82**), `m/trend-sheet.tsx:96` (warn **2.99**), `m/policy-line.tsx:53,55,60` (OON **2.67**, INN **3.68**, VOB-stale **4.35**). The rating *number* at 20 px/700 passes as large text — **the verdict word beneath it does not**. — *SC 1.4.3 AA*
- **M5 · Mobile KPI tile numbers at 2.67:1** (`m/qualify-mobile-app.tsx:851-856`): `#C9881E` on `#FBF1DE` fails even the 3:1 large-text bar. Two of three headline percentages are effectively unreadable. — *SC 1.4.3 AA*
- **M6 · Registry "History" table has no header cells** (`registry-client.tsx:337-355`) — five data columns, no `<thead>`, no `<th>`, no caption, no `aria-label`. — *SC 1.3.1 A*
- **M7 · Coverage micro-bar is colour-only and below non-text contrast** (`m/swipe-row.tsx:118-127`): confirmed vs estimate distinguishable by hue alone; amber-vs-track **2.43**, green-vs-amber **1.39**. `aria-hidden` with **no text equivalent on the card** — unlike `trend-sheet.tsx:70-77` where the same bar sits under explicit counts. — *SC 1.4.1 A, 1.4.11 AA*
- **M8 · `ring-teal500/40` is a 1.67:1 focus ring** — 10 sites (`heating-ticker.tsx:197`, `facility-panel.tsx:329,472`, `qualify-tab.tsx:1065,1087`, `ticker-explainer.tsx:135`, `resolution-flow.tsx:1386`, +3). `focus-visible:outline-none` with nothing else. (The four sites using `/25` also set `focus:border-teal500` at 4.15 and are borderline-OK.) — *SC 2.4.7 AA*
- **M9 · Ticker explainer never returns focus and re-steals it on every prop change** (`ticker-explainer.tsx:106-115`): no opener capture, no restore in cleanup — the exact failure `useDialog.ts:60` was written to prevent. `onClose` is an inline arrow, so the effect re-fires on every parent render and yanks focus back to Close mid-read. — *SC 2.4.3 A*
- **M10 · Two sticky headers with no `scroll-margin-top`** (`resolution-flow.tsx:863-866`, `m/qualify-mobile-app.tsx:620` ~180 px tall). Grep for `scroll-mt`/`scroll-margin` across the whole qualify tree returns **zero hits**. Tabbing to a control just below the fold parks it under the sticky block. — *SC 2.4.11 AA (WCAG 2.2)*
- **M11 · `role="menu"` containing non-menuitem controls** (`window-control.tsx:259-327`): two `<select>`s and two static `<div>`s inside a `role="menu"`; opening does not move focus in; Escape closes without returning focus to the trigger. The mobile twin is the inverse — `m/qualify-mobile-app.tsx:698-702` sets `aria-haspopup="menu"` + `aria-expanded` but the popup at `:719` has **no role at all** and no Escape or click-outside handler. — *SC 4.1.2 A*
- **M12 · Modal overlays don't neutralise the background.** `vob-modal.tsx` correctly uses `role="dialog" aria-modal` + trap but nothing outside is `inert`/`aria-hidden`; `cohort-sheet.tsx:85-91` deliberately runs `{trap:false}` while rendering as a `fixed inset-y-0 right-0 z-50` overlay — visually modal, keyboard-escapable behind. Separately `vob-modal.tsx:70-72` "Start VOB" is a focusable, enabled, primary-styled button **with no handler** — a 4.1.2 value failure regardless of intent. — *SC 4.1.2 A, 2.4.3 A*
- **M13 · Employer chip remove button is ~14 × 9 CSS px** (`m/market-filter.tsx:228-235`): `lineHeight:1` at `fontSize:14` with zero padding. No spacing exception applies. — *SC 2.5.8 AA (WCAG 2.2)*
- **M14 · Low-contrast chip/clause text on the desktop board** — `policy-tape.tsx:160` `text-white/45` on teal900 = **3.81** (this is the "IP · Sacramento, CA" clause the file's own header calls a required disambiguator); `policy-strip.tsx:75` `text-status-warn/80` on white ≈ **2.4**; `m/qualify-mobile-app.tsx:894-903` and `m/market-filter.tsx:89-109` inactive chips at **4.32**. — *SC 1.4.3 AA*

### UX / product

- **The debug drawer ships to end users.** `resolution-flow.tsx:4396-4507` "How this was resolved" exposes `Predicate <hash>` and provenance rows keyed `ranking / policy / ai / KPI tiles` in the admissions rep's only screen. Gate to `super_admin`.
- **Three unreconciled time horizons on one screen** — tape 90-day (`policy-tape.tsx:210-212`), ticker 90-day (`resolution-flow-client.tsx:165`), ranking whatever the ladder chose; `windowSentence` can read "Showing trailing 30 days" twelve inches below both.
- **`—` means five different things** — unrated (`facility-panel.tsx:413`), no trend rating (`heating-ticker.tsx:230`), no watcher rating (`watchers-panel.tsx:125`), no plan class (`recent-searches.tsx:86`), no window (`qualify-ai-panel.tsx:473`). The v3 score card gets it right at `:2145` ("Not enough data to rate — 2 patients in window"); the other five need that sentence.
- **The sparkline auto-scales to its own min/max** (`spark.tsx:319-325`, `range = max-min || 1`, no baseline, no axis) — 61→63 draws identically to 20→80, rendered inside the watcher card *beside* the delta it appears to illustrate.
- **Delta arrow has a dead-band on one strip and not the other** — `heating-ticker.tsx:44-46` treats |Δ|≤0.2 as flat; `policy-tape.tsx:60-68` explicitly has none. Two stacked strips, two definitions of "moved".
- **Detailed evidence lives only in `title` attributes on non-focusable spans** (`resolution-flow.tsx:1954-1958, 2170-2181`) — the census chip's entire quantitative explanation, and the auth-headroom chip's two underlying averages, are invisible to touch and keyboard users and absent from the accessible name.
- **Number formatting is inconsistent within a single pane** — `board-zone.tsx:57-58,101-106` renders raw `{group.memberCount}` while tiles 300 px away use `toLocaleString()` (`resolution-flow.tsx:1500,1704`); same split on `m/swipe-row.tsx:107`.
- **Date formatting has four idioms, two of them raw machine strings** — a careful "Aug 12 at 4:45 PM PDT" (`:1849-1852`) next to `r.searchedAt.slice(0,16).replace('T',' ')` (`recent-searches.tsx:86`, raw UTC, no zone) next to `since {w.since}` (`watchers-panel.tsx:109`) which mixes "since today" with "since 2026-08-11T04:08:52" **in one list**, next to raw ISO census dates (`:1971`).
- **Desktop and mobile are two different products sharing a name.** Desktop is a four-stage resolution flow with watchers, tape, AI panel and composer; mobile (`m/qualify-mobile-app.tsx`) is the v2 model — autosearch, KPI tiles, 5-up deck, sheets, PHI reveal, LOC lens — with no staging, no book-led flip, no watchers, no AI. Mobile also grades **claim rows on v1 50/30 buckets** (`m/colors.ts:34`) and **facility rows on IQ bands** (`:40-47`) in one sheet.
- **Watcher delete is instant, unlabelled, unrecoverable** (`watchers-panel.tsx:135-142`, an `✕` with no confirm/undo); "clear history" is the same for the whole list (`recent-searches.tsx:55-61`).
- **A failed watchboard read tells the user to "Retry" — and offers no retry control** (`watchers-panel.tsx:69-73`).
- **The one modal that fires at the highest-value moment has a dead primary button** — `vob-modal.tsx:68-77` "Start VOB" has no `onClick` and ships a visible `CTA inert · TODO` badge. It opens exactly when a payer has never been billed, i.e. a genuinely new lead.
- **The AI panel's error reads terminal** (`qualify-ai-panel.tsx:196-223, 359`; same in `ticker-explainer.tsx:72-97`) — recovery exists only because re-pressing the chip re-runs, which nothing says.
- **The refresh control looks pressable while it refuses** (`resolution-flow.tsx:3838-3841`, `aria-disabled` + `opacity-60` only, handler no-ops) and never states why.
- **Freshness is unknown-by-default, in the faintest ink on the card** — `rebuiltAtSentence` "Ranking data freshness unknown — the rollup rebuild log could not be read" (`:1818`) at `text-xs text-ink400` (`:3872`). This is the **only** freshness claim on the entire surface.
- **The whole book renders uncapped on the leading grid** — up to 48 `ScoreCard`s each with a `<details>` factor table and census chips (`:4218-4227`). The DOM cost was accepted; the *scanning* cost was not addressed — the only narrows are area and facility and neither is a sort.
- **The verdict card is carrying more claims than one card can carry** — hero numeral, verdict word, basis line, patient count, four facet tags, two controls, window-move notice, four footnote lines, conditional fields well (`:3608-4079`). The in-file comments record **three reversals of its layout ruling in six days**; that churn is the signal.
- **The lock strip and composer speak engineer.** `lane-rail.tsx:84-93` "🔒 Locked to GGS — read as a 3-character member-ID prefix… One search, one lane." — "lane" is a metaphor this shell invented. `composer.tsx:132-137` renders "slots only — free text never reaches the model · template id + slot values are all the server sees" as **permanent 9.5 px mono standing copy** above a control whose own explanation is one line.
- **The policy tape's fallback handle is unreadable by design** — `policy-tape.tsx:87-89` falls back to `⋯${tokenTail.slice(-4)}`; `prefixLabel` only covers `[A-Z0-9]` prefixes, so the meaningless hex tail is still reachable.
- **Three verbs for re-running, three for revisiting** — "Try again" / "Refresh the ranking" / "↻ Re-run"; "Change" / "Pick a plan" / "Pick a carrier".

### Engineering hygiene

- **Over-length inputs silently return "nothing found"** — `core.ts:800, 1215, 1289, 1372-1380` all return `emptySnapshot(...)`, the same shape as a genuine no-match, while `resolutionService.ts:171-186` spends 15 lines arguing these states must be distinguishable.
- **`saveQualifyTrendWatcher`'s range check does not reject `NaN`** — `watcher-actions.ts:90-91`; both comparisons are false for `NaN`, so it reaches `$6::int` and fails as a Postgres `22P02` reported to the operator as "failed" rather than "invalid". Contrast `registry-actions.ts:106`, which zod-parses.
- **Recent-search dedupe key is consumed before the guard that rejects the write** — `resolution-flow-client.tsx:982-986`; the key is permanently marked recorded for the life of the mount.
- **`v3-actions.ts:61-66, 82-85` reads a `windowDays` form field no form sends.** Dead parameter that offers a future caller a way to move the resolution window without moving the ranking window — P1-1's asymmetry, widened.
- **Duplicated availability/basis logic between the interactive core and the nightly cron** — `core.ts:546-624` vs `board.ts:146-188`, in full. `board.ts:14-19` acknowledges it and pins only "the behaviors that matter". The only guard against stored-vs-onscreen rating divergence is a comment.
- **Three rating generations and 19 registered Server Actions ship simultaneously.** v1 `rating.ts` (still a comparator tiebreak at `core.ts:632`), v2 `qualify-tab.tsx` (1,528 lines), v3 `resolution-flow.tsx` (4,856 lines). With both flags defaulting ON, 16 of the 19 actions are remotely-callable POST endpoints reachable only through UIs nothing renders. All gated — attack surface and maintenance cost, not a hole.
- **The tape ships the raw blind-index token to the browser** (`board.ts:44-51`) while `core.ts:760-762` states the opposite invariant for claims ("the opaque token itself NEVER leaves this function"). The server already resolves the readable prefix beside it, so the token adds no display value and gives a client a stable cross-session correlator.
- **`v3/resolution-flow.tsx`'s own stated a11y rules are broken by the newest layer** — the file header (`:20-21`) declares "ONE `aria-live="polite"` region" and "no meaning-bearing text below 12px". In shell mode the answer stage carries **four** live regions plus up to six `role="status"` nodes, and **38** sub-12px meaning-bearing classes across `shell/*` — including the watcher failure notice at 10 px and the lock strip at 10.5 px.

---

## 5. P3 / advisory

- `aria-label` on non-interactive, role-less elements is ignored — `m/facility-list.tsx:173`, `resolution-flow.tsx:1710`. (`policy-tape.tsx:197-199` documents the rule correctly.)
- Mobile page changes are not announced — no live region, no focus move (`m/facility-list.tsx:172-188`). *SC 4.1.3 AA*
- Two controls expose `aria-expanded` for one disclosure, neither with `aria-controls` — `facility-panel.tsx:328, 470`.
- Breadcrumb current item has no `aria-current` — `m/qualify-mobile-app.tsx:806-810`.
- No skip link anywhere. Desktop is covered by landmarks (ARIA11); **on `/qualify/m` this is a real 2.4.1 failure** because there is no `<main>` (M2).
- Text-spacing resilience: fixed pixel heights on text containers — `m/swipe-row.tsx:79` (`height:108`), `m/detail-sheet.tsx:181`, `m/area-chips.tsx:91`, `m/qualify-mobile-app.tsx:673`. Applying the 1.4.12 bookmarklet clips content. *SC 1.4.12 AA*
- `focus:outline-none` on programmatically-focused dialog/stage containers (`vob-modal.tsx:40`, `cohort-sheet.tsx:90`, `resolution-flow.tsx:850-855`) — the only cue to a sighted keyboard user that the stage changed.
- `m/sw-register.tsx:110` "Got it" — `background:none, border:none`, no padding at 12 px; likely under 24 × 24. **Verify in browser.**
- `shell/recent-searches.tsx:55-61, 90-99`, `shell/lane-progress.tsx:272`, `resolution-flow-client.tsx:1400,1409` — `px-2 py-0.5` at 10–11 px. Whether these clear 24 px depends on inherited line-height. **Flagged for browser measurement, not asserted.**
- `search-trace.tsx:22-26,45-47` — ok/note/flag tone carried by an `aria-hidden` glyph plus colour; low impact, the sentence is self-describing.
- The receipt's spinner never stops on a skipped lane — `lane-progress.tsx:390-394` spins whenever `settled < total`. [SUSPECTED reachable]
- `windowReducer` / `ResolvedWindow.frozen` (`resolution.ts:377-419`) appear unwired — nothing dispatches a `WindowAction`; the live path uses `window_days_changed` in `flow-state.ts`. If confirmed, invariant I6 is asserted by a tested-but-unreachable reducer. [SUSPECTED]
- `qualify_prefix_echo` is empty and **permanently so by ratified decision** — `prefixLabel.ts` supersedes it. Do not wire `record_qualify_prefix_echo`. **[LIVE: 0 rows — this is correct, not a defect.]**

---

## 6. Claims checked and **disproven** — do not re-file

| Claim | Reality |
|---|---|
| "`patient_name_bidx` does not exist (mig 0067 unapplied), so `getQualifySnapshotByName` throws 42703 and fails closed." | **FALSE. [LIVE]** The column exists on `collections.cmd_explorer_rows` in production. The endpoint works. This makes P0-3 **more** severe, not less. |
| "`buildCurrentCodingDecisionsQuery` has no LIMIT and will scan thousands of decisions × 48 facilities on every search." | **Scale is wrong. [LIVE]** `coding.code_decision` holds **42** rows. The missing `LIMIT` is real but currently harmless. The genuine problem is the opposite one — see P0-6. |
| "The `qualify-rating-history` cron missed today's run (max `as_of_date` is 2026-08-11)." | **FALSE. [LIVE]** `collections.qualify_rating_run` id 242 ran 2026-08-12 05:10:41 UTC, `ok=true`, 1,275 pairs, 4.7 s. `as_of_date` is deliberately run-date minus one. **This cron is healthy.** |
| "`qualify-census` cron is failing with `permission denied for table facilities`." | **Resolved.** 9 occurrences, last 2026-08-06T07:22 — migration 0089 fixed the writer grant that same day. **[LIVE]** the table now holds 23 fresh rows, last synced 2026-08-12 21:22 UTC. No recurrence. |
| "The desktop stale-flash bug in `.claude/rules/qualify.md` is live." | **Doc rot.** v2 fixed it (`qualify-tab.tsx:651-660`), v3 handles it correctly (`:3452-3462`). The rules doc's "Deferred / known" entry should be deleted. The **mobile** equivalent is live and undocumented — P1-19. |

### Confirmed clean (do not "fix")

- **No SQL injection anywhere on the Qualify path.** Every builder routes values through `paramList()`/`add()`; table/column/GUC names are fixed literals; `buildGroupLadderQuery`'s interpolated rung days are integer-validated (`qualifyResolutionQuery.ts:307-311`). No `SELECT *`.
- **Roles are correct.** All reads run `claims_reader`; writes go through `security definer` calls matching the 0097 design, plus the narrow `coding_editor` pool. No service-role key, no `claims_admin` on the app path.
- **Gate coverage is complete.** Every exported Server Action across all six action modules calls `requireQualifyPrincipal` (or the stricter registry gate) before touching data; every core re-gates as a backstop. `principal.ts:72-78` correctly denies the no-auth staged-rollout fallback.
- **Dollar-stripping holds.** `stripSnapshotAmounts`/`stripClaimsAmounts` are the single choke point and run last on every return path; `ratingV2`, `resolution.ts` and the AI schema are structurally dollar-free; `qualifyAi.ts:597` correctly ORs the client flag with the server principal's (can tighten, never loosen).
- **No browser storage anywhere** in `app/lib/qualify`, `app/components/qualify`, `app/app/qualify`. The PWA service worker caches only `GET /_next/static/`; every Server Action POST is network-only.
- **Date math is correct** in `qualifyWindowBounds` (all three window shapes incl. the month-1 prior-period wrap), `shiftIsoDays`, `addDaysIso`, `daysBetweenUtc`, `computeLosDays`. **The bug is the anchor, not the arithmetic** (P1-1).
- **No division-by-zero or NaN leaks** in `ratingV2` (`clamp01` guards non-finite), `derivePolicyRating:211`, `pct()`, `deltaPct`, `deriveFacilitySpread`.
- **`role="status"` / `role="alert"` do not need explicit `aria-live`** — the scanner's 26 hits on this are false positives, and `resolution-flow.tsx:361-364, 3487, 4198` documents a correctly-reasoned live-region architecture. The real problem is the **count** of concurrent regions in shell mode, not their markup.
- **`registry-client.tsx`'s 11 "unlabelled input" scanner hits are false positives** — every one uses an implicit `<label>` wrapper, which is valid and produces a correct accessible name. Same for `composer.tsx` (`htmlFor`), `slot-chip.tsx` (`aria-label`), and `qualify-ai-panel.tsx:297` (which is inside a comment — there is no `<select>` in that file).
- **Only one `<h1>` can render per route.** The scanner's duplicate-h1 hit is a false positive; the other `<h1>`s are on mutually exclusive branches.

---

## 7. Live production state — snapshot 2026-08-12

| Signal | Value |
|---|---|
| `coding.code_decision` | **42 rows** (all current) vs a **48-facility roster** → `coding` factor (weight 30) mostly UNAVAILABLE |
| `collections.qualify_facility_census` | **23 rows** (11 outpatient, `bed_capacity` null), last sync 2026-08-12 21:22 UTC → **48 % roster coverage** |
| `collections.qualify_facility_outcomes` | **12 rows / 12 facilities**, frozen — sync failing 6 days |
| `collections.qualify_policy_rating_daily` | 217,091 rows, through as_of 2026-08-11 — **healthy** |
| `collections.qualify_prefix_echo` | 0 rows — **correct by ratified decision** |
| `claims.qualify_watcher` | **0 rows** — the watcher feature has never been used successfully in production |
| `claims.qualify_recent_search` | 14 rows |
| Vercel errors touching Qualify (7d) | `facility-outcomes` ENOTFOUND ×6 (**active**); `qualify-census` 42501 ×9 (**resolved 2026-08-06**) |
| Supabase security advisor | 1 WARN — `collections.facility_assignments_guard` mutable `search_path` |

---

## 8. Recommended sequencing

**Wave 1 — correctness & exposure (do not batch with anything else)**
P0-1, P0-2, P0-3, P0-4, P1-1, P1-3, P1-13. These are wrong-number and PHI-exposure defects; each is small and independently verifiable.

**Wave 2 — operational**
P0-5 (repoint or retire `EXEC_CENSUS_DATABASE_URL`), P0-6 (surface `availableWeight` as a visible caveat *and* decide whether an unseeded 30 % factor should suppress the numeral entirely), P0-7 (decide maintenance posture), P1-7, P1-8, P1-9.

**Wave 3 — a11y critical**
P0-8, P0-9, A-C2, A-C4, A-C5, A-C6, then the 14 Majors. The contrast work is a token-level change and should be done **once, in `tokens.ts`/`m/colors.ts`/`globals.css`**, not site-by-site.

**Wave 4 — UX restructure**
P1-14 through P1-24 plus the §4 UX list. This is where the surface stops being three products at once. Treat as a design pass with a written IA decision, not a series of tweaks.

**Explicitly out of scope of any fix wave** (name as separate follow-ups, do not fold in): deleting the v2 `qualify-tab.tsx` path; splitting `resolution-flow.tsx`; retiring the 16 unreferenced Server Actions. Each is a real cleanup and each is its own PR.
