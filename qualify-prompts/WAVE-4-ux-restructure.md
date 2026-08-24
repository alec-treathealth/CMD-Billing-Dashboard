ultracode

# Qualify — Wave 4: UX restructure

**This is a design pass with a written IA decision, not a series of tweaks.** Read that sentence again before you open an editor.

The findings below are not independent bugs. They are symptoms of one thing: `/qualify` is the **only screen** an `admissions_seat` has, and it currently presents ~14 concurrent top-level surfaces with nothing progressively disclosed at page level, in three overlapping UI generations. **Fixing these piecemeal will produce a worse surface than leaving them alone** — you will end up with a screen that has been locally optimised in fifteen directions.

**⚠ HARD STOP: produce the IA decision document and bring it to me. Do not write component code until I have approved it.**

**Prerequisites:** Waves 1 (numbers/PHI), 2 (operational) and 3 (a11y) should be merged. Several items here depend on Wave 1's rating-labelling ruling and Wave 3's token changes. If they are not merged, say so and stop.

---

## 0. GROUND RULES

Read: `CLAUDE.md` → `veris-data-notes.md` (§ qualify) → `.claude/rules/qualify.md` → `.claude/rules/nextjs-app.md` → `docs/archive/design-system.md` (the TreatHealthOS visual system — **it is LIVE despite the `archive/` path**, `CLAUDE.md` says so explicitly). Those outrank this prompt; conflict → surface and stop.

Invariants that constrain the design, not just the code:

- **PHI never** reaches a URL, browser storage, logs, or an LLM prompt. **A layout change that moves a value into a link or a query string is a PHI change.**
- **`admissions_seat` is server-stripped of every dollar field**, decided in `principal.ts`. **Anything you add to the payload that carries dollars must not reach an `admissions_seat` session.** A new "helpful context" field is exactly how that invariant dies.
- **Every rating input is a percentage, count, day-count, enum or date string — never a dollar amount**, so an `admissions_seat` derives an identical rating, band and factor list. `test/qualifyCoreV2.test.ts` proves it at the wire level. **Keep it that way.**
- **The band thresholds (65/50/30/15/0) are the billing team's own IQ bands**, adopted from the monday census IQ column. Not yours to retune. Adding a sixth factor or changing a weight needs the same sign-off as the v2 model change — it is not a tweak.
- **`contract.ts` semantics are frozen**; rename fields only with sign-off. Desktop and mobile consume it **identically** — that is the point of the file.
- Tests hermetic (`node:test` only). No `Co-Authored-By`. HOLD before commit/push/deploy. `gh pr create --base main`. (⚠ `staging` was DELETED 2026-08-14 (ruled poor dev practice) — branch off `main`, PR to `main`.)

**Verification gate — all five, green:**

```bash
npm test                    # >=1439 pass / 0 fail
npm run typecheck
cd app && npm test          # >=831 pass / 0 fail
cd app && npm run typecheck
cd app && npm run build
```

---

## 1. ORCHESTRATION

```
phase('Map')      → parallel readers, one per zone (rail / board / verdict card /
                    mobile / tickers+tape / vocabulary). Each returns: what renders,
                    when, why, and what the user is trying to do at that moment.
                    NO fixes. This phase produces understanding, not diffs.
phase('Design')   → judge panel: 3 independent IA proposals from different angles —
                    (a) job-first: what does "is this lead worth admitting?" need,
                    (b) persona-first: what does an admissions_seat with no other
                        screen need on day one vs day thirty,
                    (c) subtractive: what is the smallest surface that still answers
                        every question the current one answers.
                    Then parallel judges score them. Synthesize from the winner,
                    grafting the best ideas from the runners-up.
phase('Decide')   → STOP. Write the IA decision doc. Bring it to me. Do not proceed.
phase('Fix')      → only after approval. Serialize everything touching
                    v3/resolution-flow.tsx (4,856 lines) into ONE agent.
phase('Verify')   → adversarial per change: "does this move a dollar field into an
                    admissions_seat payload? does it put a value in a URL? does it
                    change a rendered numeral? does it break contract.ts parity
                    between desktop and mobile?"
phase('Gate')     → five commands, exact counts.
```

---

## 2. WHAT THE IA DECISION DOC MUST CONTAIN

1. **The job statement.** One sentence: what an admissions rep is trying to decide when they open this screen. Everything else is scored against it.
2. **A zone map** — what occupies each region, at each of the five states (landing / identifying / resolving / answered / failed), on desktop and mobile.
3. **A kill list.** What is removed outright, what is demoted behind disclosure, what is gated to `super_admin`. **With the reason per item.**
4. **A vocabulary table** — one noun per concept, and the migration from the current three-words-per-thing state.
5. **The states inventory** — every state that must be visually distinct, especially the ones currently collapsed together (§3 items 4, 6, 7).
6. **What you are NOT changing, and why.** Especially: the narrative copy. See §5.
7. **Day-one vs day-thirty.** An `admissions_seat` has ~30 novel concepts to learn and no glossary. What does the surface do on first run?

---

## 3. THE FINDINGS

### The structural three — these are the wave

**1 · The answer is the third thing in the answer column.** `resolution-flow-client.tsx:1465-1468` renders `<PolicyTapeMount/>` (dark marquee), then `{tickerNode}` (second marquee), then `<ThisSearchZone>` — the actual verdict. The rep answers three questions and must scroll past **two auto-scrolling strips of unrelated book-wide content** to reach the number they asked for. Neither strip is scoped to the search (`scopePayer` stays null by design, `:1207-1211`). **Bites every single search, at the payoff moment.**
**Outcome:** the resolved answer is the top of the board. Both tickers are **landing-state content** — unmount them once a lane is open.

**2 · The brightest, most animated control on screen is the escape hatch.** `SkipStep` (`resolution-flow.tsx:1143-1157`) is a `teal900→teal700` gradient with a `.q-skip-spark` shimmer, rendered **above** the question at `:4712-4714`. The stage's primary action is a flat tile in a grid. Skipping sends `payerScope:'all'`, producing what the file itself calls *"a blend the operator cannot reason about"* (`:1075-1106`).
**Bites:** first-week user, every stage. The sparkle teaches "press me."
**Outcome:** skip becomes a text link; the stage's own question owns the visual weight.

**3 · Three renderings of the same progress, stacked, in one 416 px rail.** `LaneStepper` (four dots + settled values), `LaneReceipt` (the same four questions, struck through, with values **and** Change buttons), and `LaneFeed` (the same events as sentences) all render from **one** `laneSteps()` array, consecutively at `resolution-flow.tsx:4677-4686`. `shell/lane-progress.tsx`'s own header admits it: *"the mock states the same progress three times."* ~30 % of rail height restates what the operator just did.
**Outcome:** one survives. **Keep the receipt** — it carries the revisit control.

### States that are collapsed and must not be

**4 · The census chip's silence carries three meanings.** `resolution-flow.tsx:1966-1967`: `bedState` of `not_applicable` (outpatient — beds genuinely don't apply) and `unknown` (no census row) **both render nothing**, and a card with no chips is also what a facility with no UR date and no auth headroom looks like.
**Live:** only **23 of 48** facilities have a census row; 11 of those are outpatient with `bed_capacity` null and `open_beds` 0 — **0 there is not "full"**.
**"Can they physically go there today" is the first question of the job**, and it is answered by an absence the operator cannot interpret.
**Outcome:** "no census on file" is a visible state, distinct from "outpatient — beds N/A".

**5 · Mobile stale-flash — the previous member's facilities stay on screen at full opacity, indefinitely.** `m/qualify-mobile-app.tsx:260-262, 294-296` catches a failed resolve, sets a hint, and leaves the prior ranking rendered; `dimmed={isPending}` (`m/facility-list.tsx:163`) has already ended by then, and there is no scope banner to contradict it.
Desktop already solved this twice: v2 clears before refetch (`qualify-tab.tsx:651-660`, with the reasoning) and v3 dims to `opacity-60` + beam + **suppresses every categorical sentence** (`:3452-3462`). **Copy v3's approach.**
**Also:** delete the now-stale "Deferred / known — Desktop stale-flash" entry in `.claude/rules/qualify.md`. It is doc rot and it is telling future sessions a fixed bug is live.

**6 · "Loaded and empty" is byte-identical to "the fetch failed"** in both strips. `resolution-flow-client.tsx` `.catch(() => setTrends([]))` → `heating-ticker.tsx:143` `if (trends.length === 0) return null`. Same shape in the tape: `policy-tape-mount.tsx:293-304` collapses `ok:false` (read failed), `available:false` (relation missing) and `items:[]` into one `return null`, and `policy-tape.tsx:141` returns null on empty.
**Bites:** the day the trend query breaks, nobody reports it — **the page just looks calmer.**

**7 · `—` means five different things** — unrated facility (`facility-panel.tsx:413`), no trend rating (`heating-ticker.tsx:230`), no watcher rating yet (`watchers-panel.tsx:125`), no plan class recorded (`recent-searches.tsx:86`), no plan context (`watchers-panel.tsx:167`), no window (`qualify-ai-panel.tsx:473`).
**The v3 score card already gets this right** at `:2145` — *"Not enough data to rate — 2 patients in window"*. **That is the sentence the other five need.** Propagate the pattern, don't invent a new one.

### Numbers that mislead

**8 · The carrier-stage member count is a sum, not a distinct count.** `payerGroupsOf` accumulates `g.members += c.memberCount` per candidate and then sums across cluster members (`resolution-flow.tsx:219, 240`); `shell/board-zone.tsx:58` sums **that** again to print "N plans on file across M members". A member holding two plan candidates contributes twice. One click later, `snapshot.memberCount` — **genuinely distinct** members with a paid claim in 12 months (`:1252-1264`) — is printed with the **same noun**. And the tile's accessible name makes the stronger claim: *"N **verified** members under this carrier"* (`:1498`).
**Outcome:** either make it distinct or rename the noun. Not both nouns for two numbers one click apart.

**9 · Three unreconciled time horizons on one screen** — the tape reports a 90-day delta (`policy-tape.tsx:210-212`), the ticker a 90-day window (`resolution-flow-client.tsx:165`), and the ranking whatever the ladder or the operator chose. `windowSentence` can legitimately read *"Showing trailing 30 days"* (`:1777-1789`) twelve inches below both. **Bites whenever a rep compares a ticker card to a score card.**

**10 · The sparkline auto-scales to its own min/max**, so any wobble looks like a cliff. `spark.tsx:319-325`: `range = max - min || 1`, mapped to the full 26 px height with **no baseline and no axis**. A facility moving 61→63 draws the identical shape to one moving 20→80. It is `aria-hidden` and decorative — but it is rendered inside the watcher card **beside the delta it appears to illustrate** (`watchers-panel.tsx:114-120`).

**11 · The delta arrow has a dead-band on one strip and none on the other** — `heating-ticker.tsx:44-46` treats |Δ| ≤ 0.2 as flat; `policy-tape.tsx:60-68` explicitly has none (*"anything non-zero is real movement"*). Two stacked strips, two definitions of "moved".

**12 · Freshness is unknown-by-default and says so in the faintest ink on the card.** `rebuiltAtSentence` returns *"Ranking data freshness unknown — the rollup rebuild log could not be read"* (`:1818`) rendered at `text-xs text-ink400` (`:3872`). **This is the only freshness claim on the entire surface** — its own comment says so.

**13 · Detailed evidence lives only in `title` attributes on non-focusable spans.** The census chips carry their **entire quantitative explanation** in `title` (*"3 of 12 licensed beds open (25 % free) on the latest census sync"*, `:1954-1958`) on a `<span>` (`:2170-2181`). Touch and keyboard users never see it; it is not in the accessible name. Same for the auth-headroom chip, whose `title` is the only place the two averages behind "~6d auth headroom" appear.

### Cognitive load and vocabulary

**14 · ~30 novel concepts before a new rep can read one screen**, with **no glossary, no tooltip index and no first-run help anywhere** in `app/components/qualify/**`: prefix / alpha prefix · carrier · payer · billed-under label · plan sponsor / employer · funding (Self-Funded / Fully Insured) · plan type (POS/PPO/EPO/HMO/ASO/OAP) · network · VOB · rating out of 100 · IQ band · the five factors and their weights · volume floor · reliability floor / distinct patients · automatic window / ladder / rungs · the book / book-led / book-wide · tape · momentum / Δ pts / NEW · lane / locked to · skip / all plans / all payers / un-blend · blended across N payers · area narrow vs facility narrow vs filters · predicate · provenance · trendwatcher vs patient watcher / threshold pts / masked echo / token · session only · IP/OP/Both · unmapped payer / spellings folded · auth headroom / UR / LOS · slots only.

**15 · Three words for one thing, on one screen.** The same payer entity is **"carrier"** on the stage question (`:1440` "Which carrier is on the card?"), **"payer"** in the identity line and the AI panel header (`qualify-ai-panel.tsx:261`), and **"BILLED UNDER" / "label"** in the verdict card's facets (`:3792`, `:4064`) — `billedUnderCaption` has nine arms, several saying "label". Likewise **plan / policy / plan sponsor / employer** are interchangeable: the tile at `:1698` is headed by the **employer**, and the receipt calls the same value **"Plan"**.

**16 · Engineer voice in user copy.** `shell/lane-rail.tsx:84-93`: *"🔒 Locked to GGS — read as a 3-character member-ID prefix. Answers come only from this lane's matched lines — nothing outside it."* and, empty, *"No lane yet — identify a client below to open one. One search, one lane."* **"Lane" is a metaphor this shell invented**; nothing else in the product uses it.

**17 · Compliance boilerplate outranks task copy in the composer.** `shell/composer.tsx:132-137` renders *"slots only — free text never reaches the model · template id + slot values are all the server sees"* as **permanent 9.5 px mono standing copy**, above a control whose own quiet-state explanation is one line (*"Resolve a search to ask about it."*, `:84`). **The contract belongs in a disclosure, not standing copy** — and it is one of the two sentences on this surface with legal weight, rendered at the smallest size on screen.

**18 · The debug drawer ships to end users.** `resolution-flow.tsx:4396-4507` "How this was resolved" exposes `Predicate <hash>` with the sentence *"panels showing the same value are about the same rows"*, plus provenance rows keyed `ranking / policy / ai / KPI tiles`. That is engineering vocabulary in the admissions rep's only screen. **Gate it to `super_admin`.**

**19 · The policy tape's fallback handle is unreadable by design.** `policy-tape.tsx:87-89` `handleOf` falls back to `⋯${tokenTail.slice(-4)}`. The header records this already being flagged; the fix (`prefixLabel`) covers only `[A-Z0-9]` prefixes, so the meaningless hex tail is still reachable.
**⚠ Do NOT "fix" this by wiring `record_qualify_prefix_echo`.** That seam is dead by ratified decision (2026-08-09) — `src/collections/prefixLabel.ts` supersedes it and is strictly better on coverage. `collections.qualify_prefix_echo` is empty **on purpose** and must stay that way.

### Error recovery and dead ends

**20 · The maintenance interstitial is a closed loop for the persona it locks out.** `qualify-maintenance-notice.tsx:24-36` offers exactly two exits, `/dashboard` and `/dashboard/collections`; `page.tsx:36-38` redirects any non-`super_admin`/`admissions_seat` away, and an `admissions_seat` **has no dashboard** — so both buttons bounce back to this notice. The component's own comment admits it. *(Wave 2 P0-7 lands the minimum fix; this wave owns whatever the notice should actually be.)*

**21 · The one modal that fires at the highest-value moment has a dead primary button.** `vob-modal.tsx:68-77`: "Start VOB" has **no `onClick`**, and the dialog ships a visible `CTA inert · TODO` badge. It opens **exactly when a payer has never been billed** — i.e. a genuinely new lead, the highest-value moment on the surface. *(Wave 3 M12 makes it honest; this wave decides whether it should work.)*

**22 · Destructive actions with no confirm and no undo.** `shell/watchers-panel.tsx:135-142` — an unlabelled `✕` fires `onDelete`, server rows deleted immediately. `shell/recent-searches.tsx:55-61` "clear history" does the same for the whole list.

**23 · "Retry" names an action the panel does not offer.** `shell/watchers-panel.tsx:69-73` handles a failed watchboard read well up to a point — `deriveBoardStatus` keeps four states and the copy says *"a watcher you already saved may exist but be hidden. Retry, or tell an admin"* — **but there is no retry control.**

**24 · Errors that read terminal but aren't.** `qualify-ai-panel.tsx:196-223` sets *"The explainer is unavailable right now."* rendered as a dashed box at `:359`; recovery exists **only** because re-pressing the same chip re-runs, which nothing says. Same in `ticker-explainer.tsx:72-97`. And `:3838-3841` — the Refresh control uses `aria-disabled` with only `opacity-60` (deliberate, to protect focus) so it still **reads pressable** while the handler no-ops, and never states why.

**25 · Three verbs for re-running, three for revisiting.** "Try again" (`:3444`) / "Refresh the ranking" (`:3849`) / "↻ Re-run" (`recent-searches.tsx:98`) all re-issue a query. "Change" (`:1310`) / "Pick a plan" (`:1291`) / "Pick a carrier" (`laneSteps` revisit label) are all the same revisit control under different names depending on which receipt you're looking at.

### Density and parity

**26 · Desktop and mobile are two different products sharing a name.** Desktop: a four-stage resolution flow with book-led ranking, watchers, recent searches, an AI panel and a composer. Mobile (`m/qualify-mobile-app.tsx`): the **v2 model** — autosearch, KPI tiles, heating-up chips, a 5-up paged deck, detail/claim/trend sheets, PHI reveal, LOC lens. No carrier/plan staging, no book-led flip (pinned by test, `:2990`), no watchers, no tape, no AI. **A rep who learns one cannot use the other.** Mobile additionally grades **claim rows on the v1 50/30 buckets** (`m/colors.ts:34`) while grading **facility rows on IQ bands** (`:40-47`) — two scales in one sheet.
**This is the biggest single decision in the wave.** Converge, or declare them different products with different jobs and stop pretending otherwise.

**27 · Number and date formatting is inconsistent within a single pane.** `shell/board-zone.tsx:57-58, 101-106` renders `{group.memberCount}` raw while carrier and plan tiles 300 px away use `toLocaleString()` (`:1500, 1704`); `m/swipe-row.tsx:107` prints `{facility.lineCount} lines` raw where desktop uses `toLocaleString()`. Dates have **four idioms including two raw machine strings**: a careful "Aug 12 at 4:45 PM PDT" with a named zone (`:1849-1852`) · `r.searchedAt.slice(0,16).replace('T',' ')` (raw UTC, no zone, `recent-searches.tsx:86`) · `since {w.since}` straight from the row (`watchers-panel.tsx:109`, `watchers.ts:152`) — **so one list mixes "since today" with "since 2026-08-11T04:08:52"** · raw ISO census dates (`UR {f.nextUrDate}`, `:1971`).

**28 · The whole book renders uncapped on the leading grid.** `:4218-4227`: when the book leads, up to **48 `ScoreCard`s** render, each with a `<details>` factor table and census chips, in a 2-column grid — **the cap was deliberately refused** and the comment accepts the DOM cost. The **scanning** cost is unaddressed: the only narrows are area and facility, both above the fold, and **neither is a sort**.

**29 · The verdict card is carrying more claims than one card can carry.** `:3608-4079` holds the hero numeral, verdict word, basis line, patient count, four ON/OFF facet tags, two controls, the window-move notice, four stacked footnote lines and a conditionally-rendered fields well. **The in-file comments record three reversals of its layout ruling in six days.** That churn is the signal — this is not a layout problem to solve one more time, it is a card that needs to become two things.

**30 · The receipt's spinner never stops on a skipped lane.** `shell/lane-progress.tsx:390-394` renders `motion-safe:animate-spin` whenever `settled < total`; a lane that legitimately ends without settling every step keeps a perpetual spinner beside a completed answer. *(Reachability inferred, not confirmed — verify before fixing.)*

---

## 4. WHAT YOU ARE NOT CHANGING

- **The band thresholds, the five factors, and their weights.** Sign-off class, not a tweak.
- **`contract.ts` field names and semantics.** Frozen; desktop and mobile consume it identically and that is load-bearing.
- **The dollar-strip invariant.** Every rating input stays a percentage, count, day-count, enum or date string. `test/qualifyCoreV2.test.ts` proves it at the wire level.
- **`collections.qualify_prefix_echo`.** Empty on purpose, permanently.
- **The v2 `qualify-tab.tsx` path, splitting `resolution-flow.tsx`, retiring the 16 unreferenced Server Actions.** Real cleanups, each its own PR, explicitly out of scope. Name them, don't do them.

---

## 5. WHAT IS ALREADY GOOD — DO NOT UNDO IT

The **narrative honesty** of this surface is genuinely exceptional and it is the thing most at risk from a restructure. Specifically:

- `billedUnderCaption`'s nine arms (`:2490-2530`) — nine distinct explanations of why a claim is billed under a given label.
- `gridNarrowEmptyCopy`'s four diagnoses — four different reasons a narrow returned nothing, each with its own next action.
- The **book-led re-basing** and its explanatory sentence.
- The **"suppress categorical claims while a fetch is in flight"** rule (`:3452-3462`) — this is the correct answer to stale-flash and it should be the model for item 5.
- The `payerCount === 0` third state.
- `resolutionService.ts:171-186`'s 15-line argument that "you typed nothing", "that prefix is too short", and "that handle matched no plan" are three different screen states.

**The sentences on this surface were audited. The numerals were not.** That is the whole shape of this wave. Do not "simplify" the copy — the copy is the part that works.

---

## 6. DEFINITION OF DONE

1. **The IA decision doc, delivered to me, before any component code.** §2 lists what it must contain.
2. After approval: each of the 30 findings **addressed by the design** or explicitly deferred **with a reason**. "Addressed by the design" is a valid outcome for many of these — they should not all become individual diffs.
3. Tests for every state that must be visually distinct (items 4, 6, 7) and every numeral that changes (items 8, 27). A state that is only distinguishable by eye is not done.
4. All five gate commands green, **exact counts reported**.
5. Diff summary: files touched, lines ±, and the three changes you are **least** confident in.
6. Confirmation, explicitly, that: **no dollar field entered an `admissions_seat` payload**, **no value entered a URL**, and **no rendered numeral changed except the ones item 8 and item 27 intend to change**.
7. `.claude/rules/qualify.md`'s stale "Deferred / known" desktop stale-flash entry deleted (item 5).
8. `gh pr create --base main` — **HOLD before pushing**, show me the PR body.
9. No `Co-Authored-By` trailer.
10. Anything discovered outside this list: **separate follow-up**. In a design pass, scope creep is how you ship a surface nobody agreed to.
