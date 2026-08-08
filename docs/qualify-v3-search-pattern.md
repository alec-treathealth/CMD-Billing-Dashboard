# Qualify v3 — the search pattern

Ratified 2026-08-06 from Alec's direction: *"simplify … resolve to a payer, the user should
be able to pick an employer … the VOB tiles should include all possibilities of that policy
after searching, including the choice to drill down on one of them via AI … give the user
more control at each step."* This file is the definition the UI implements. The staged flow
in `app/components/qualify/v3/` is the only surface built from it.

## The principle

**One question per screen.** The v2 tab answered every question at once — search, filters,
KPIs, policy chips, window ladder, trace, payer rail, AI, facilities — and the result was a
wall (the 2026-08-06 screenshots). An admissions rep on a phone call gets exactly one
decision at a time, and every decision the system makes on their behalf is stated where they
can see and reverse it.

## The four stages

| Stage | Question | What renders | Who decides |
|---|---|---|---|
| **1 · Identify** | Who are we looking at? | One input. Nothing else. | User types |
| **2 · Payer** | Which carrier is on the card? | One tile per carrier behind the identifier (VOB candidates grouped by payer), member counts shown. Skipped when only one. | **User picks** |
| **3 · Plan** | Which plan is it? | All policy possibilities under the chosen carrier — employer, funding, plan type, members, claim-evidence note. Type-to-narrow for long tails (a prefix can span 186 employers). Skipped when only one. | **User picks** |
| **4 · Answer** | Does this payer pay us, and where? | Policy rating hero + verdict, ranked facility scorecard, AI chips. Window decision disclosed in one line. Everything else behind expanders. | System states, user can change |

Completed stages collapse into a **receipt** strip (identifier · carrier · plan), each with a
change affordance that returns to that stage. The user is never trapped and never re-types.

## Where the AI layers in

- **Stage 3 → drill-down:** every plan tile carries "Use this plan" *and* "Ask AI" — Ask AI
  selects the plan and lands on the answer stage with the AI panel already streaming the
  suggested question for that policy shape (self-funded plans get the plan-administrator
  question, etc.). One AI surface, reachable one tap earlier.
- **Stage 4 → the explainer:** the preset-chip panel (`qualify-ai-panel`), grounded in the
  exact snapshot on screen. Preset chips only — no free-text box.
- PHI boundary unchanged: `employer_name` is PHI (`app/lib/phi.ts`) — it may render as a
  display label but never reaches a URL, a log, or the model prompt. The AI payload stays the
  strict-zod non-dollar `QualifyAiInput`.

## Window policy

The system decides, visibly. Stage 4 runs the snapshot auto-window ladder (`auto: true`,
10-patient floor) and states the outcome in one line — "Trailing 90 days — needed this far
back to reach a reliable sample" — with the ladder one expander away for manual override.
The resolution stages (2–3) evaluate candidate evidence over a wide fixed window (365d),
because "does this plan have history at all" is a wide question; recency honesty belongs to
the answer stage's ladder.

## What deliberately did NOT survive from v2

- The browse-filter row (payer/employer/funding/group# type-aheads) — stages 2–3 *are* that
  filter, with evidence attached.
- Three KPI tiles above the fold — book-wide numbers outrank the client's answer visually;
  they move behind the answer-stage expander with their ratified "book-wide, not this
  client" caption.
- The always-open trace, notices, ladder tiles, and policy-fact rows — all become collapsed
  disclosures on stage 4. Present, honest, not shouting.

**Not a ruling — a casualty, corrected 2026-08-07.** The 2026-08-06 cutover also dropped two
facility-level affordances — v2's Facility type-ahead in the primary search row, and the
Heating Up ticker's clickable cards — and unlike the three drops above, *neither ever appeared
in this list*: nothing here named them, so nothing tracked the loss, and it took a live gap
report to notice. (The first dark-launch build made the search-box drop worse by promising
"…or a facility name" without building it — typing a city name was HMAC'd down the member-id
blind index and came back a confusing no-match; the fix that shipped deleted the promise
rather than the capability.) Both are now RESTORED, in a v3-native shape rather than a v2 port,
so this doc no longer has a silent gap for the next cutover to repeat:

- **The area facet** (stage 4 only — `AreaLine` in `resolution-flow.tsx`) is what the Facility
  type-ahead became. It narrows the RENDERED scorecard grid alone, never the fetch, over state
  buckets derived from the facilities the ranking already returned — reusing the mobile PWA's
  `deriveAreaChips` / `facilitiesInArea` (an unmapped facility buckets under "Other" and is
  never dropped, never a typed term reaching the blind index).
- **The answer-armed ticker.** Heating Up's cards are clickable again — a click seeds the area
  facet rather than v2's {facility + dominant payer} pivot, because v3 resolves a member and
  re-pivoting the whole surface on a click would throw the member away. That armed/inert split
  is unchanged, but where the strip RENDERS is not: **updated 2026-08-07** (Alec, product
  directive: *"I don't like the tickers on the post-click search page. Need them on all the
  pages."*) — the strip now persists across **all four stages**, as a single mount that survives
  every stage transition (so a click never resets the marquee's scroll position). This overturns
  the sentence that shipped a few hours earlier in this same doc update, which had the strip
  excluding PAYER and PLAN under the "must not compete with the question" rule below. Alec is the
  ratifier of that rule and has overturned it *for the ticker specifically* — the rule itself
  still governs everything else stages 2–3 exclude (see "The principle" and the bullets above).
  Only stage 4, with a snapshot on screen, arms it as a control; IDENTIFY/PAYER/PLAN render it
  `readOnly` — orientation, not a control, because a click on those three still has no honest
  target (v3 has no facility-first resolve path).

## Motion

GSAP stage transitions: outgoing stage clears, incoming slides up 14px/220ms ease-out, tiles
stagger `min(index,3) * 60ms` (capped — long lists must not cascade forever). One easing.
`prefers-reduced-motion` disables all of it. Motion communicates progression through the
stages; it never blocks input.

## RULING REVERSED — 2026-08-07: the Skip ranks the whole radius, not one label

Alec's direction, this date, modelled explicitly on the Collections guided search: *"rank
ALL-PAYERS by default on skip — the identifier's whole footprint, every billed-under label"*,
with the filters becoming *"user-controlled facets"*, and *"when the user chooses Skip, use
streaming motion to cover the entire search, and at the end show which filters are ON and
which are OFF so they can toggle them."*

**What this reverses.** The core ruling that a DIRECT-path ranking is payer-scoped. That was
not an incidental implementation choice — it was load-bearing in three places: `resolvePayer`
picked the single highest-line-count `primary_payer`, `buildFacilityRankingQuery` emitted a
single-label equality, and the builder's fail-closed guard *refused* a null payer without a
market narrow. It is recorded here rather than quietly changed because a reader of the
sections above would otherwise reasonably conclude the old rule still holds.

**Why.** The Skip's own control says "search all plans" and its banner promised "every
facility this member has history at". Measured on a live prefix, it delivered one label of
three: AETNA 5,308 lines ranked, AETNA US HEALTHCARE 1,038 and AETNA - FIRST HEALTH NETWORK 7
excluded — along with the two facilities the member billed at **only** under those labels. The
promise was structurally unkeepable, so PR #165 narrowed the copy to match the behaviour; this
change fixes the behaviour instead.

**Feasibility, measured live 2026-08-07** (as `claims_reader`, busiest prefix = 9,268 rollup
rows, warm): payer+token 30d = 2.05ms / 208 buffers; identifier-wide 30d = 3.2ms / 264
buffers; identifier-wide 365d (the ladder's worst case, and the common skip shape) = 19.4ms /
1,471 buffers. All shared-buffer hits, **no new index**. The token narrow bounds the scan at
least as tightly as the employer semi-join the guard already accepted.

### The three rules this ruling carries

1. **Empty means no restriction, never "match nothing."** Straight from the Collections model
   (`cmdExplorerQuery.ts`): a facet with nothing selected omits its condition entirely. A
   builder that emitted `= any(ARRAY[])` would turn "facets off = whole radius" into zero rows.
   The billed-under scope is the same shape: no chip active *is* the wide state.

2. **A blended percentage is never a payer contract rate.** Under an all-payers ranking a
   facility's `pctAllowedOfBilled` — and therefore its `ratingV2` — is dollar-weighted across
   every label behind its rows. That is an honest answer to *"what did this member's claims
   actually allow here"* and **not** an answer to *"what does payer X pay at facility Y."* Two
   facilities can rank differently purely on payer mix. This is Simpson's paradox on the exact
   surface admissions staff act on, so every card carries `payerCount` and says "blended across
   N payers" above 1, and the BILLED UNDER chips are the one-click un-blend.

3. **The blend disclosure is gated on the SCOPE, not on the count.** Measured live, `payerCount > 1`
   holds on 0 of 14 cards at 30d and 1 of 28 at 365d — so a count gate would have made the ruling
   fire almost never, and left an all-payers card indistinguishable from a payer-scoped one at the
   grain the operator actually reads. Every card under an all-payers ranking states its label count;
   at one label it names the label instead (`max(primary_payer)`, exact at one distinct value, nulled
   by the core above one where it would be arbitrary). Nothing renders on a payer-scoped ranking.
   The disclosure also lives in the **claims-reliability factor's** detail inside "Why this score" —
   that factor carries the blended number, and that expander is where an operator interrogates a
   percentage they do not trust.

4. **The scope is a typed claim, not a display default.** `QualifyResolved.payerName` is
   nullable now, beside an explicit `payerScope: 'payer' | 'all'` discriminator (invariant:
   `'all'` ⟺ `payerName === null`). Nullable *forces* every consumer to confront the case at
   compile time; the discriminator *names* it, so the tempting `?? 'This search'` reads as
   wrong rather than natural. Consumers needing exactly one label go through `scopedPayerOf`,
   which returns null rather than inventing one.

### Two consequences worth stating rather than discovering

- **Ratings shift between the two scopes, and the factor detail says so.** Code decisions are
  payer-keyed, so an all-payers read cannot look one up; the coding factor (weight 30) is
  excluded, which renormalizes the other four. The same facility therefore scores differently
  all-payers than payer-scoped. Its detail reads *"Ranked across every payer this member bills
  under — code decisions are payer-scoped, so this factor is excluded rather than blended.
  Scoping to one label with the BILLED UNDER chips brings it back, and can move the score."*

- **Mobile KPI tiles are hidden, not re-captioned.** `QualifyOrientationScope` has payer,
  facility and window axes and no identifier axis, so "book KPIs for this member's whole
  footprint" does not exist. Falling through to the book-wide numbers would put three
  percentages about the entire book directly above a ranking of one member's facilities. The
  tiles are withheld with the reason stated.

### The Skip reveal

Streaming motion in the flow's **existing** vocabulary — 220ms, `power2.out`, stagger
`min(index,3) × 60ms`, disabled entirely under `prefers-reduced-motion`. It carries the eye
from the stage entrance down through a facet inventory that states, in words, whether each
facet is ON or OFF: window (never off — it says which window instead), plan type, funding,
employers, billed under. Every row is toggleable **in place**: the inventory is the controls,
not a summary beside them.

> **AMENDED 2026-08-07 — two changes. The paragraph above is left as ratified rather than rewritten,
> because what was ratified is worth being able to read.**
>
> 1. **The rows now live inside a NARROW SEARCH card you click to expand.** The promise above is
>    unchanged and is the constraint the card was built under: a collapse may put the TOGGLES behind
>    a click and may **not** put the ON/OFF reading behind one. Collapsed, the card's summary states
>    the resolved scope and carries a named ON/OFF badge per facet plus a tally; expanded, those
>    badges move back beside their own controls. "Toggleable in place" now reads: *once the card is
>    open, every facet's control and its state are in the same markup.*
> 2. **Plan type is no longer one of the facets.** Not a decluttering pass — it reached the server
>    indirectly. `planTypes` was absent from `scopeKeyOf`, which made it look client-only, but
>    `filterCandidates` feeds `employerNarrowFor`, whose employer set **is** sent as
>    `market.employers`. One plan-type press could therefore re-rank the facilities over the
>    employers holding plans of that type, with nothing on screen mentioning employers. Measured on
>    one real search: POS 257 · PPO 30 · EPO 27 · HMO 9 · ASO 1 · OAP 1 — POS (79%) was not a proper
>    subset and changed nothing at all, while ASO collapsed the ranking to a single employer. The
>    plan-type **tag** stayed (plan tiles, resolved identity line); the filter went. The inventory is
>    therefore window · funding · employers · billed under, plus `area` beside the grid.
>
> Employers also stopped being a chip wall behind a `<details>` and became the shared
> `MultiSelectTagPicker` — the same control Collections and the v2 Qualify tab render, in CLIENT
> mode because this surface's vocabulary is already in hand.

One deviation from the tile treatment, and it is the constraint rather than a detail: the
inventory animates plain `opacity`, never `autoAlpha`. `autoAlpha` sets `visibility: hidden`,
which would make live controls genuinely unclickable and drop them out of the accessibility
tree for the length of the stagger. Motion narrates progression; it does not gate input.

**The `area` facet is in the inventory, and it is the interesting one.** PR #164 merged while this
was being built and deliberately placed the area chips **beside the ranked grid**, not on the control
card — because everything on the control card re-issues the ranking request and area does not. That
placement is right and is unchanged. But *"where the control sits"* and *"is this facet restricting
what I am looking at"* are different questions, and the inventory answers the second: area carries a
`FacetState` badge, a `data-v3-facet` hook (the reveal selects across the stage, not inside the
card), and a term in `anyFacetOn`. Without that last part, one click — Skip, then an area chip —
printed *"nothing is narrowing this search"* directly above a lit Area chip.

The same class of bug is why the empty-state sentence names the window explicitly. *"Every switch is
off"* was false one click in: Skip, then "90 days", and the headline denied any narrowing while the
Window row beneath read `On · 90 days`. The window is a real narrowing that can never be turned off,
so the sentence says so — *"No filters are on — apart from the window, nothing is narrowing this
search"* — rather than pretending the screen has no exceptions.

## Census on the answer stage — availability is the first sort tier (2026-08-08)

**Added, not amended.** Nothing above is altered; this records a ruling the answer stage did not
previously implement.

Alec's ruling: *"surfacing facility census is very important"*, and **census SORTS, it never
filters.** The rep on the phone is answering *"where is the best place to send them right now"*, and
the answer stage was silent on the one input to that question — v3 rendered no bed chip, no UR date
and no length-of-stay at all. #163's *"a FULL house says so"* fix had landed only on the v2
`FacilityPanel`, which is behind `QUALIFY_V3_FLOW=off` and therefore invisible to everyone. Census
still moved the rating through the `authFit` factor, so the surface was shaped by a fact it refused
to state.

**The measured context that makes this the first tier, not a decoration.** On 2026-08-08, **6 of the
12 residential facilities had zero open beds**. A ranking that puts a facility with no bed at the top
because it pays well is not answering the question that was asked.

- **Tier 0 — can they physically go there.** An open bed, a facility beds do not apply to
  (outpatient), or **no census reading at all**. Absence of data must not punish: the census cron is
  hourly and fail-soft, so on an outage every row falls to `unknown`, the tier collapses to a
  constant, and the book degrades to exactly the previous rating order instead of reshuffling itself.
- **Tier 1 — confirmed full only.** Residential, a real licensed-bed denominator, zero of it free.
  Within a tier nothing changed: ratingV2 desc, then the value-first pct, then name.

**A full facility stays on screen, greyed, and says why.** The rep is also building a map of where
they could send someone tomorrow. `rank` is stamped after the sort, so a full facility's rank shows
its sunk position — deliberately: rank answers *"where do I send them right now"*, not *"how good is
the paying"*. The card states the reason in words (*"No open beds — ranked below every facility that
can admit today. The rating is unchanged."*) rather than letting appearance carry the claim.

> **The ratified `opacity-60` dim was measured and rejected for this card.** That idiom
> (design-system §Motion) is a TRANSIENT treatment for content about to be replaced. Applied
> persistently to a whole card it composites every text token against the background: ink900 falls
> 14.73:1 → **4.07**, ink600 7.07 → **2.79**, the 30px band numeral 2.99–5.05 → **1.86–2.55** — below
> AA for body text and below AA-large for the numeral, on the row carrying the most operationally
> important sentence on the screen. The sink is expressed instead by dropping the card's IQ-band wash
> for the neutral ground tone, which makes it recede from its coloured neighbours while every text
> token *gains* contrast. Chip text is ink900 for the same reason: `text-status-warn` on its own 10%
> wash measures **2.71:1**, which the v2 chips inherit and which is not something to carry forward.

**Two zeroes, one derivation.** `open_beds = 0` is written for every outpatient row — those boards
carry no "Open Bed" status labels — so it means *"beds do not apply"* there and *"full"* on a
residential board with a real denominator. Eleven of the twenty-three registered facilities are
outpatient, so a naive `openBeds === 0` reading marks half the book at capacity; the inverse mistake
(`openBeds > 0` as the render guard) is what silenced five genuinely full houses before #163. The
disambiguator is `board_family`, which lives on the server row and has never crossed the wire — so
the **server ships the decision** (`bedState`), not the field, and the sort tier, the greying and the
chip copy all read that one value. Same precedent as `payerCount`/`solePayer`: decide once, where the
inputs are.

**Auth headroom.** `avg_auth_days − avg_los_days`, computed server-side from the same basis the
rating selected (completed outcomes beat the census snapshot at a sample of 3+), rendered only when
both halves clear the sample floor. Measured live: NASH 22.6 vs 16.8, LSMH 21.1 vs 12.6 — roughly
6–8 authorized days routinely unused. Shipped **signed**, so an overrun reads as an overrun instead
of being silently dropped.

**One footgun closed on the way.** `avgAuthDays`/`avgLosDays` crossed the wire ungated and
basis-mismatched — always the raw in-progress snapshot, even when the rating had scored completed
outcomes — so `FRCA`'s 373.5-day average over a `los_sample` of **2** reached the client verbatim.
Nothing rendered them, which made it a loaded trap rather than a live defect. S1 gave them a
renderer, so the gate landed in the same change.

## The preface, and the payer's book beside the member's footprint (2026-08-08)

**Added, not amended.** Nothing above is altered. S2 of the search-tree series; the census tier
recorded in the section above is S1, and the prominence flip described at the end here is S3's.

### The measurement that forced it

`.superpowers/sdd/qualify-search-tree.md` §M2, measured live 2026-08-08:

| members behind the prefix | prefixes | % | avg facilities |
|---|---|---|---|
| 1 | 948 | **58.8%** | **1.14** |
| 2–3 | 434 | 26.9% | 2.38 |
| 4–9 | 163 | 10.1% | 4.97 |
| 10–24 | 50 | 3.1% | 8.92 |
| 25+ | 17 | 1.1% | 18.82 |

And §M1: the auto-window ladder never clears its 10-patient floor for **1,545 of 1,612** prefixes,
because **85.7% of prefixes have ≤9 members in total** — no window can reach a floor the population
does not contain. The ladder issues five counted rungs to discover it has no choice.

So the majority of searches were being answered as if they were rankings over a population, in the
same words, on the same screen, as the 4.2% that actually are one. **A ranking is a comparative
claim, and 1.14 facilities is not thin evidence for one — it is the wrong shape of question.**

### The preface — the engine says which world it is in, before it claims anything

One `count(distinct member_id_bidx)` over the token classifies the search. The ladder query has
always computed it (`p365`, the widest rung) and then **threw it away on every path except an auto
prefix search**, because one gate answered two questions at once.

Those two questions are now separate, and the split is the ruling:

- **The COUNT runs for every token kind and every window mode.** "Is this a person or a population"
  is a fact about the IDENTIFIER, so a preface that vanished when an operator pressed a Range chip
  would be telling them the answer depends on the window. It costs one token-scoped scan (~20 ms /
  1,473 buffers at the 365-day worst case) already running in parallel with the policy batch.
- **The WINDOW CHOICE stays gated on `auto && kind === 'prefix'`**, exactly as before. A 10-patient
  floor is meaningless for an N-of-1 member-id search, and the Range menu remains the biller's
  override. Nothing about `window2`, the ladder object or the 365-day fallback moved.

Four buckets, one sentence each — and **two different nothings, which must not collapse**:

| `memberCount` | says |
|---|---|
| `1` | `One member has a paid claim behind this search in the last 12 months — N facilities of history in the window shown.` |
| `2–9` | `N members have a paid claim behind this prefix in the last 12 months. Continue to search across all of them, or refine the prefix.` |
| `10+` | `A population — N members have a paid claim behind this prefix in the last 12 months.` |
| `0` | nothing — the provenance banner already owns "no claims of its own" |
| `null` | nothing — the count was **unavailable**, and a failed query must never render as a fact |

> **EVERY NUMBER STATES THE BASIS IT WAS COUNTED ON, and the first version of this copy did not.**
> `memberCount` is the 365-day rung filtered on `payment_received` — "members with a **paid claim**
> in the last 12 months" — while the facility count is the **chosen window**. Joined by a bare
> em-dash they made one mixed-basis claim, and the contradiction was reachable rather than
> theoretical: a 30-day window on a member last paid 200 days ago rendered *"One member matches this
> search — 0 facilities of history."* beside an empty grid, each half true at its own window and the
> sentence false at both. Fixed in **copy, not in SQL**: an unbounded count would make the classifier
> drift with the window, which is the one property this design exists to protect.

Copy is **unratified**. `memberPreface.ts` owns the bucketing and the words; the visible line, the
receipt chip and the `aria-live` announcement all call the same function, so the seen claim and the
spoken claim cannot be two expressions that merely happen to agree. The announcement **replaces**
the resolution's own facility count rather than sitting beside it: that number is rendered nowhere
on screen, and two facility counts in one spoken sentence leave a screen-reader user unable to tell
which describes the grid in front of them.

The count rides the **SEARCH** entry of the receipt, not a Scope entry of its own. The receipt
records DECISIONS and every entry is revisitable; a member count is a fact *about* the decision on
the Search entry.

**"Pick one of the N members" is DESCOPED, and this is the record of why.** Raw member ids can never
render, so a member picker needs a server-side per-response ordinal enumeration (the `assembleClaims`
`patientKey` precedent) plus a pick-by-ordinal predicate, and it would have to reconcile with
`SKIP_CARRIER_MAX`. "Search across all of them" is the Skip, which already exists — so the 2–9
sentence names the control that is there rather than promising one that is not.

### The payer's book, rendered SECONDARY

`bookFacilities` is the SAME `loadFacilities` dep with token/kind omitted — byte-for-byte the load
`getQualifySnapshotByPayerCore` already makes — added as a fourth element of the existing
`Promise.all`, on the same window as the member ranking so the two lists are comparable. The
payer-wide **floor** applies to it (`QUALIFY_MIN_LINES`) while the identifier's own footprint stays
floorless: two lists, two honest floors.

- **It is null whenever there is no single payer to have a book** — the identifier-wide Skip. The
  ranking builder correctly *throws* on (null payer, no market, no token), and the all-payers whole
  book is the 206–713 ms scan that spills to disk: an hourly cache's job (build order D), never a
  per-search load. Nothing attempts the fetch in that mode.
- **`facilities` was NOT repurposed.** The hero rating, `resolved.totalCharges`/`facilityCount`, the
  area facet, the drill seed, the mobile deck and the AI payload all hang off it, and every one is a
  scope claim about the searched identifier.
- **It carries its own basis label** and borrows none: *"N facilities — every facility {payer} paid
  at in this window, not this member's history."* It renders through the same `ScoreCard`, so S1's
  census chips, the sunk treatment and the rating words cannot fork — with `allPayers={false}`,
  because the book is payer-scoped by construction and `count(distinct primary_payer)` under a payer
  predicate is 1 by the equality that built it. The blend disclosure has nothing to disclose, so it
  says nothing rather than printing "1 payer · AETNA" on every card.
- **The preview cap is stated, never silent.** A secondary section that pushes the answer off the
  screen has stopped being secondary, so the list is capped — and because availability leads the
  sort, the rows a cap removes are systematically the full ones. Both facts ride the same line, the
  notice counts the **whole** book rather than the slice, and an empty book says so in words instead
  of rendering a headed void.

> **MEASURED, 2026-08-08, live against prod.** The book load on the busiest payer (27,669 rows) is
> **~130–230 ms**, served by `cmd_charge_rollup_entity_payer_payment` with a **3.6 MB external-merge
> sort spilling to disk**; typical payers roughly half that. The member ranking beside it is
> **3–20 ms**, and the `Promise.all` is parallel — so on a big-payer search **the book is now the
> critical path**. The wire is bounded by reality (the whole book is 48 facilities), so no core-side
> slice is warranted. **If search p95 regresses, this load is the lever:** lazy-load the section on
> expand via its own action, or a per-`(payer, window, entityIds)` TTL cache — *it does not vary by
> member*, which is what makes both cheap. Neither is built; S3 inherits the decision explicitly.

**Two rankings on screen make "the ranking on screen" identify nothing**, so both AI grounding
captions now name which list the model read. The payload is still `snap.facilities.slice(0, 10)` —
the member ranking — and `bookFacilities` is **not** in it: no schema change, no prompt change, no
new `payerScope` value near the strict-zod firewall.

### What S3 inherits

The book is loaded, rated, sorted, disclosed and **below** the member ranking. S3 flips prominence
for the 1-member case and annotates the book with the member's own history. The preview cap is the
first thing that flip should reconsider.

---

## S3 — THE INVERSION: the book leads, the member's history annotates (2026-08-08)

Alec's ruling, delegated and decided: **the book ranks, member history annotates — and may break a
tie.** S2 loaded the payer's whole book and drew it *below* the member's footprint. S3 turns that
round for the one bucket where the member's footprint cannot carry a ranking at all.

### The rule, and the buckets it fires in

`bookLeadsAnswer(snapshot)` is the one predicate. It is **built on `bookIsOnScreen`, never beside
it** — "is there a book" keeps a single home, including the `?? null` absent-field coercion whose
loss once broke 40 renders — and adds two conditions:

| condition | why |
|---|---|
| `memberBucketOf(memberCount) === 'one'` | 58.8% of prefixes; 1.14 facilities of history. Ranking that is not thin, it is **malformed** — a ranking is a comparative claim and there is nothing to compare. |
| `bookFacilities.length > 0` | **An empty book cannot lead.** `bookIsOnScreen` is deliberately TRUE for an empty book (the secondary section renders a real "nothing cleared the floor" sentence — a state, not an absence), but leading with it would put a void where the answer goes *and* hide the member's own facilities behind it. |

Modes that keep the member-led render, each for its own reason, each pinned by a test: **2–9** and
**10+** (a real population with a real ranking of its own), **`null`** (the engine could not classify
and must not guess), **`0`** (no history to annotate with), the **identifier-wide Skip** (no book
exists — the builder throws), and an **empty book**.

### What follows the flip — **grep for `BOOK-LED`**, do not read a list

> **THE LIST THAT USED TO BE HERE HID A DEFECT, AND THAT IS THE LESSON WORTH KEEPING.** The first
> version of this section — and a matching comment block in `resolution-flow.tsx` — *enumerated* the
> surfaces that re-base and the ones that do not. The scope-honesty banner (a coral `role="status"`
> alarm directly above the grid) was on neither list, so both the author and the reviewer checked the
> **list** instead of the **file**, and it shipped claiming *"the ranking below is this identifier's
> history under {payer}"* over a grid showing that payer's whole book. An index maintained by hand,
> in a different place from the code it describes, rots in exactly one direction: it stays convincing
> while it stops being true.
>
> So the index is now an **instruction**. Every claim surface in `resolution-flow.tsx` carries
> exactly one of `[BOOK-LED SURFACE]` or `[BOOK-LED EXEMPT: <reason>]`, at the site, in its own
> comment. A new surface with neither is the bug. `app/test/qualifyV3Flow.test.tsx` enforces it
> mechanically for every `role="status"` in the file — the loud class, which is the class the missed
> one belonged to — and that test says plainly that `role="status"` is a *proxy* for "claim surface",
> not a definition of one: the non-status surfaces carry markers too, so the grep still enumerates
> the whole set.

The set as it stands (**verify by grep, not by this paragraph**):

- **The ranked grid** becomes the book, with its own heading (*"Where {payer} pays — the whole
  book"*), its own basis line, and `[data-v3-book]` moved onto it — exactly one book section is ever
  on the page. The AREA facet, its counts and the "showing N of M" sentence follow the grid.
- **The HERO.** `derivePolicyRating` now runs over the list that leads and takes an optional
  **basis scope** (`"{payer}'s whole book"`), which reaches the not-rated arm too. A bar that
  patient-weights a list nobody drew breaks the reconciled-by-construction invariant in the one place
  that invariant exists to hold. The scope is *passed*, not derived: `policyRating.ts` cannot tell two
  `QualifyFacility[]`s apart, and a guess there would be the second derivation that drifts.
- **`resolvedScopeSentence`** keeps "ranked under {label}" — the book *is* payer-scoped — and adds the
  population, because the label alone is true of both lists and identifies neither.
- **The skip banner** gains a book-led arm. "Every facility this member has history at under that one
  label" is false of a book-led grid, and Skip-then-billed-under-chip reaches it.
- **`skipProvenance.ranking`** gains a book-led basis; the filter-narrowed arm keeps its wording
  because the same `market` is passed to *both* loads, so a narrow is true of the book too.
- **`skipProvenance.ai` and the AI panel's idle caption.** The panel's prop became a three-state
  `bookPlacement` (`'none' | 'secondary' | 'leading'`) rather than two booleans a call site could set
  to an impossible pair.
- **M8 — the trace panel.** "Facility ranking" was singular over a screen with two. It now says
  *rankings*, names both, and says which leads. The **KPI** row keeps its ratified "book-wide, not
  this client" and appends the one clause the flip requires: that contrast has collapsed, because the
  ranking above is now book-wide as well.
- **`liveSentenceFor`** takes `bookLedPayer` — a NAME, not a boolean, because "the ranking is a whole
  book" leaves a screen-reader user knowing the scope changed and not what to. Suppressed in flight on
  the same condition as the visible claims, and **stage-gated**: the skipped arm returns before every
  stage check, so a held skipped answer plus one step back announced "the ranking below is {payer}'s
  whole book" over the identify screen, with no ranking below it at all.
- **The SCOPE-HONESTY banner** (both arms). Its subject — the pick could not be bridged to a claims
  label — stays true and stays alarming; only the half describing the LIST moves.

**Not following it, deliberately:** the **AI payload** (`buildQualifyAiInput` still maps
`snap.facilities`, unchanged schema — sending the book is a schema + system-prompt + firewall change
and a **separate ruling**, so the captions say what backs the answer instead); **`billedUnderCaption`**
(all nine rows describe how the *label* was arrived at, and the book is scoped to that same label);
the **identity line** (a fact about the resolution, not the ranking); and **`/qualify/m`**.

### The annotation

`QualifyFacility.memberHistory: { lineCount, distinctPatients } | null`, joined server-side on the
**raw rollup `facility` text**. Both loads are the same query over the same rollup with the same
`group by facility`, window and payer predicate, so an exact match is correct — `FACILITY_DIM_JOINS`'
`upper()` enriches the *display name* and never touches the grouping key.

- **A field on the row, not a map on the snapshot.** The comparator needs it at assembly time, and a
  value that travels with its row cannot be mis-joined at a render site.
- **Non-null ONLY on a list that is not itself member-scoped.** On `facilities` it is always null —
  an annotation there is a tautology on every row, and worse, a reader would take the *unmarked* rows
  for facilities the member has never been to.
- **Counts only, and that is a PHI decision.** A count is non-PHI. A member-specific claim **date** is
  individually identifying — permissible in the authorised UI, forbidden in the AI payload — so it is
  not expressible in the shape at all, and a test pins that neither the annotation nor
  `bookFacilities` reaches `buildQualifyAiInput`.
- **The words depend on the bucket** (`memberHistoryChipFor`): *"Seen here before — N claim lines in
  this window"* at one member, *"This search has N claim lines here in this window"* above it, because
  at 2–9 those lines belong to several different people. Every count names its basis — these are the
  **chosen window**, never `memberCount`'s 12 months.

### The tiebreak, and what "equal footing" means

Inside the `assembleFacilities` comparator, **after** S1's availability tier and **after** `ratingV2`:

> **Equal footing = the same availability tier AND the same `ratingV2`** (including both suppressed,
> where the cards show no number and the reader has nothing else to choose on).

So it outranks the v1-rating / pct / alphabetical fallbacks — which decide an order the operator
cannot see a reason for — and is beaten by everything the card displays as its verdict. History
**breaks ties; it never beats a better-paying facility and never floats a full house.** Inert on any
list with no annotations. The card's mark is the *visible reason* for the reorder: without it the grid
would re-sort for a cause nothing on screen states.

### Two decisions worth arguing with

**The book-led grid is NOT capped.** S2's `QUALIFY_BOOK_PREVIEW = 8` stays on the secondary section,
where a list that pushes the answer off screen has stopped being secondary. When the book *is* the
answer that argument inverts: availability leads the sort, so a cap systematically removes the FULL
houses — a filter by omission on the primary grid, which is exactly what "census sorts, it never
filters" forbids. The whole book is ≤48 facilities; up to 48 cards each with a `<details>` and a
factor table is a real DOM cost and the accepted one. The AREA line is the narrow.

**The floor asymmetry leaves a hole, and it is named rather than swallowed.** The member ranking is
floorless and the book applies `QUALIFY_MIN_LINES`, so a facility the member billed 1–2 lines at is in
`facilities` and NOT in `bookFacilities` — and once the member grid stops rendering, its annotation has
nowhere to land. "Its information survives as annotations" would then be false for exactly the rows
where n is smallest. The book-led render names those facilities in words and states the cause; the
floor is the only possible one, because the member's rows are a subset of the book's before it.

### Mobile is EXEMPT, as a decision

`/qualify/m` keeps the member-scoped deck. Three reasons: it is a swipe-through-cards interface with
paging, and 1.14 → 48 facilities is a different interaction rather than a different list; `SwipeRow`
has no chip row, so a book-led deck would render the payer's book with the member's history
**invisible** — strictly worse than today; and every mobile scope sentence is written about the member.
A static-scan test fails if `bookFacilities` / `bookLeadsAnswer` ever reach that module, so the
divergence stays a decision. **Flagged for Alec.**

### Where the book-led decisions live, and why they are not in a component

`app/lib/qualify/bookPlacement.ts` owns `bookIsOnScreen`, `bookLeadsAnswer`, the three-state
`QualifyBookPlacement`, the derivation `bookPlacementFor`, and the AI panel's grounding caption.

**They were extracted because the wiring was invisible to the whole gate.** The placement ternary
lived in `resolution-flow-client.tsx` and the caption in `qualify-ai-panel.tsx` — two `'use client'`
modules whose import graphs reach the `'use server'` action chain, so nothing hermetic imports
either. Measured: **inverting the ternary's arms so `'leading'` is unreachable ships app 557/0 with
both typechecks clean and `next build` green.** Same class as the S1 review's deleted `bedState`
mapping, same fix: the decision moves to a plain lib module with tests, the client keeps only JSX.
`resolution-flow.tsx` re-exports the two predicates, so there is one definition behind two import
paths — never two definitions.

The **order** inside `bookPlacementFor` is itself a decision: `bookLeadsAnswer` is asked first,
because when the book leads it is not "also on screen" — it *is* the grid.

### Two more places the flip reaches

**The ranks strip.** The panel's idle caption (`active === null`) and the strip (`active === 'ranks'`)
are mutually exclusive, so the caption S3 cited as the mitigation *disappears* the moment a reader
asks the ranks question. `qualifyRanksHeading` therefore takes the placement and re-bases its scope
label when the book leads. Its **population** does not move — it describes what the model actually
read, and re-deriving it from the book would put a table on screen the payload never saw.

**The `'No Facility'` bucket is never annotated.** That literal is a real bucket in the rollup —
11,414 charges / $29,081,575.38 at charge grain
(`supabase/migrations/0084_cmd_explorer_pull_facility.sql`) — and it ranks like any other text,
deliberately, because dropping it would hide money. But *"Seen here before"* asserts a **place** the
member was treated, and there is no such place. Suppressed **at the join**, not at the chip, so the
**tiebreak goes with it**: an annotation that silently floated the placeholder above a real facility
at equal footing would be the same fabricated claim expressed as an ordering, with no mark on the
card to explain the move. The row keeps its rank; only the personal claim is withheld.

**All new copy is unratified.**

---

## S4 — THE FACILITY NARROW, beside the grid, with two honest emptinesses (2026-08-08)

v2's tab carried a Facility type-ahead in its primary search row. The 2026-08-06 v3 cutover dropped
it, and — like the AREA facet — the drop is absent from this doc's own deliberate-drops list, so it
was a casualty rather than a ruling. S4 restores it.

### It narrows the FETCHED SET, and that is a measurement, not a convenience

Alec's ruling (2026-08-07): a facility name narrows the fetched set, like AREA. The obvious build is
the other one — the ranking query would take `upper(facility) = any($n::text[])` today, and it
measures **at or below baseline** (13.9ms vs a 19.7ms baseline at 365d on the busiest prefix). It is
still the wrong build, for one measured reason:

> **86.9% of members (3,759 of 4,324) bill at exactly ONE facility in 365 days.** Max is 5.

So a facility narrow on the member search an admissions seat actually runs is a 1-or-0 outcome almost
always — which makes the **empty state the common render, not an edge case**. And a fetch narrow
throws away the very thing that makes that empty state useful. A fetch narrow's empty screen can say
*"no history at NASHVILLE"*. A narrow over the already-fetched set can say **"no history at NASHVILLE
— this member billed at LSMH and KWC"**, because the un-narrowed list is still in hand. Strictly more
information, zero extra round trips, no refetch on toggle.

⚠ **There is a predicate-form trap on the road not taken, and it is recorded so nobody re-discovers
it.** Writing that predicate the obvious way — `facility = any($n::text[])`, byte-identical to
Collections' shared idiom — is **trigram-eligible**, so the planner grabs the 19 MB
`cmd_charge_rollup_facility_trgm` GIN and throws away the token∩window BitmapAnd: **98.1ms / 1,796
buffers against a 19.7ms / 1,473 baseline** on a prefix search at 365 days, and **118×** on a
member-id token. It does **not** do this at 30 days, so it ships green and degrades only on the
auto-ladder's widest rung. If a fetch narrow is ever built, write `upper(facility) = any(…)` and
uppercase the values in JS.

### It renders BESIDE the grid with AREA — never on the NARROW SEARCH card

Controller ruling 2026-08-08, **flagged to Alec**: his earlier "folds into the card" wording yields to
his later fetched-set ruling plus the card's own documented rule — *everything on the control card
re-issues the ranking request, and this does not.* That rule is exactly why AREA was sorted out of the
card and kept out of `cardFacets`; a requestless field inside the card would either break it or force
it to be re-ruled. So the two beside-the-grid narrows share a row, and the card's tally **names** them
rather than absorbing them: *"1 of these 4 switches on · plus the area and facility narrows, beside
the list"*. Enumerated, not counted — "plus 2 narrows" is arithmetically honest and sends an operator
hunting for the second one.

`anyFacetOn` counts it, on the AREA precedent: one click must never produce *"nothing is narrowing
this search"* beside a lit control that is narrowing it.

### The three emptinesses, and which control gets blamed

There are now three, and each names its own fix:

| state | sentence |
|---|---|
| nothing ranked at all | *No facility has claims history under this scope in the window shown.* |
| the AREA emptied it | *No ranked facility is in this area. The N facilities behind this answer are still there — choose All above to see them.* |
| the FACILITY narrow emptied it | four arms, below |

**Which narrow gets blamed is computed, not guessed.** With both on, the facility narrow is asked
*alone*: if rows survive it, the AREA emptied the grid and the area sentence is the honest diagnosis.
Blaming the wrong control sends the operator to clear the wrong one.

`facilityNarrowEmptyCopy` (pure, in `resolution-flow.tsx`, unit-tested) has four arms:

1. **Book-led, and the member HAS billed at some of the picks.** The member ranking is floorless and
   the book applies `QUALIFY_MIN_LINES`, so a facility they billed 1–2 lines at is in `facilities` and
   not in `bookFacilities`. *"No history there"* would be flatly false about the one fact on the screen
   that decides an admission. The floor is the only possible cause, so the sentence names it. Its
   subject is **the picks the member's own footprint actually covers**, never the whole selection —
   see fix round 1 below.
2. **Book-led, and they have not.** The claim is about the payer's **book**; the member's own
   footprint is named separately rather than folded into it.
3. **Member-led, with somewhere else to name.** *"No history at {facility} — this member billed at {A}
   and {B}."* Alec's ruling rationale, verbatim.
4. **Member-led, with nowhere else to name.** Reachable, because `facilitiesElsewhere` strips the
   `No Facility` placeholder — every other row can be a bucket rather than a place. *"This member
   billed at "* with nothing after it would be the fabricated-place claim in its most literal form.

### Two things pinned so they cannot drift

**`No Facility` is not OFFERABLE.** It keeps its rank in every grid (dropping it would hide
$29,081,575.38 of charges, `QUALIFY_NO_FACILITY`), and it is simply absent from the picker's options —
you cannot send a patient to a bucket. Because it can never be picked, the narrow can never *be* the
placeholder, and the empty states never have to defend that claim.

**The SECONDARY book section is NOT narrowed**, which is what AREA does there today: that section
renders `bookFacilities.slice(0, QUALIFY_BOOK_PREVIEW)` straight. It answers a different question
("does this policy pay *anywhere*"), and its value is precisely that it is not scoped to what the
operator is currently looking at — narrowing it would make the *"N facilities — every facility {payer}
paid at"* sentence above it false. Pinned by a test.

### The state, and why it cannot reach a request

`facilityNarrow: readonly string[]` is a **sibling of `filters`, never a member** — flow-state
invariant (m), the same law as `area`, and the field where the temptation to break it is real. It
clears at exactly the five sites `area` clears (four navigations + `filters_cleared`), to the shared
`NO_FACILITY_NARROW` reference, and survives both re-scopes. It is **not in `scopeKeyOf`** and **not
on the wire**; because `resolution-flow-client.tsx` reaches the `'use server'` chain and nothing
hermetic can import it, that is enforced by a **source scan** of the `scopeKeyOf(` and
`getQualifySnapshot(` call arguments — the S3-I1 lesson (inverting a ternary in that file shipped
app 557/0 with a clean build).

The vocabulary (`loadQualifyFacilityOptions` → `qualifyFacilityOptions`, 47 options, `unstable_cache`d
for an hour, tenant-scoped, non-PHI) was **orphaned in v3** — its only caller mounted behind
`QUALIFY_V3_FLOW=off`. It is loaded the way the ticker loads trends: **mount-once and fail-soft**,
never inside the snapshot request. An empty vocabulary renders no control at all.

**Not persisted to the URL.** v3 writes no URL at all, and the `employer_norm`-in-a-URL posture is
still unresolved, so adding one here would be a new surface rather than a restoration.

**All new copy is unratified.**

### Fix round 1 (2026-08-08) — four corrections, and one of them was a truth regression

**The floor arm was fabricating history under multi-select.** *"Has this member been to any picked
facility"* was a boolean, and the sentence rendered **every** picked name as its subject — so picks
`['NASH','KWC']` against a footprint of NASH alone asserted paid claims at a facility with zero rows.
That is the fabricated-history class S3 suppressed the `No Facility` annotation for, reachable through
exactly the *"show me these two houses"* case that justified multi-select in the first place. The
subject is now `picksWithRows` — per pick, variant-aware — the pronoun follows the subject rather than
the selection size, and the picks with **no** rows get their own disclaiming clause instead of being
silently dropped.

**The recovery clause promised a count the other live narrow would not deliver — and it made an
EXISTING sentence false.** Both blamed arms computed *"the N facilities behind this answer"* from the
un-narrowed leading list while instructing the operator to clear **one** control. With
`facility=['PHX']` and `area='TN'`, *"The 3 facilities … choose All above to see them"* resolves to one
row. That string is the **pre-S4 area empty state**, so composing a second grid narrow onto the screen
turned a shipped `role="status"` line into a lie — a truth regression, not merely a loose new claim.
Both arms now come from **one builder** (`gridNarrowEmptyCopy`); splitting the area arm off as an
inline literal is precisely what let it rot. The clause names what clearing **that** control yields,
and names **both** controls when one click cannot reach everything — including the case where each
narrow is independently empty and *"see all 3"* would clear to **zero**.

**A lit area chip claimed to be "showing" over an empty grid.** Pre-S4 the area was the only narrow, so
a lit chip meant rows *by construction*. Composed with a facility narrow, *"All · 2 · showing"* renders
above zero cards. The word stays — I9 requires selection to carry a word, never hue alone — but it
becomes *"· selected"*, which is true, and is already the vocabulary the window chips use. The chip
**counts** deliberately stay over the ranking; their aria-labels say *"ranked"*.

**S3's "Not in this book" line and the floor arm said the identical fact ~340 characters apart**, on
the exact screen the arm exists for. The S3 line is not deleted — it still speaks for member facilities
the empty state is *not* about — its set is **subtracted**, so each facility is named once, by the
sentence that is about it.

Minors in the same round: every arm now names its window (arms 1 and 3 had none while 2 and 4 did);
`facilityCount` pluralises in one place, which also fixes the **pre-existing** *"The 1 facilities behind
this answer"*; a lost vocabulary renders *"1 picked · list unavailable"* rather than *"On · 1 of 0"*;
and the reducer's shared-constant claim on the toggle-to-empty path is now pinned by reference rather
than asserted in a comment.

### The shared picker got its first test, and only then a change

`MultiSelectTagPicker` is rendered by four surfaces and had **zero** direct test coverage — which was
the stated reason not to touch its filter. So: `pickerMatches` is extracted as a pure export and unit
tested in `app/test/multiSelectTagPicker.test.tsx` (`'use client'` is inert under the test loader), and
`PickerOption` gains an optional `searchText?: readonly string[]` folded into the haystack. No existing
caller passes it, and the compatibility claim is asserted rather than reasoned: a query sweep compares
the new predicate against the old display-only expression over a Collections-shaped option list.

Only the facility narrow opts in, passing each option's raw CMD spellings plus its canonical value —
so typing what CMD actually calls a facility finds it, for the 16 of 47 live options whose
`display_acronym` differs from their value. **`display` is deliberately not recomposed** into
`ACRONYM — Full Name`: label parity with the score cards is the whole reason `display_acronym` is
preferred, and the picker echoes `display` back inside the selected tag.

## S5 — THE REFRESH CONTROL: re-run the search, date the data, announce the window (2026-08-08)

Alec ruled **both** a refresh control and the freshness card. The reason is structural rather than
aesthetic: the collections crons write hourly, so a ranking can go stale while a rep is still looking
at it — and until S5 the only re-run affordance on the whole surface was the **"Try again" button
inside the `refreshFailed` error banner**. Refresh existed only as failure recovery.

### The control is a render promotion, not new machinery

`retry_requested` was already a general "re-issue the current request": it is the one reducer case
that bypasses `bailIfUnchanged` and returns a fresh object unconditionally, so it moves the fetch
effect's dependency array with no error present and no input changed. So S5 adds **no second refetch
path** — a second writer of the value the effect keys on is the shape `scopeKeyOf`'s header is a
post-mortem of. One handler (`onRetrySnapshot`), two render sites.

It lives **on the NARROW SEARCH card**, in the header row so it survives the disclosure, and the
card's own rule is what puts it there: *everything on the control card re-issues the ranking request*
— this is the only thing on the card that does nothing but that. The same rule keeps the two grid
narrows (area, facility) **outside** the card; S5 is that rule applied in the other direction. It is
**not** a `cardFacets` entry: a facet has an ON/OFF state the summary must report, and a refresh has
neither.

The wrapper's **empty-term guard is kept, and it matters more now than it did for the banner.** A
failure implies a request implies a term; a standing control renders on every answer stage and can be
pressed after a hot-reload has emptied the PHI ref. It returns **before** dispatching, so a press
there arms nothing — silent no-op, not a nonce with no fetch behind it.

### It needed its own in-flight signal, and it could not be a boolean

Press refresh before S5 and **nothing moved for 1–2 seconds.** All three progress signals derive from
`loadedKey !== scopeKey`, which a same-scope refresh cannot move; `showSkeleton` needs a null
snapshot; `pending` is the *server action's* flag and a refresh does not re-run it. An operator who
sees nothing presses again — and **every press writes one `SEARCH_QUALIFY_PHI` row**, because the
core audits before any data. This repo already treats duplicate audit rows from one user action as a
defect worth its own fix.

The obvious repair — `useState(false)` — is the exact bug class the derived trio exists to prevent
(the `refetching` boolean was set in four places, cleared in one, and permanently suppressed the
answer stage's headline). So `refreshingNonce: number | null` is **armed in ONE place and cleared in
SIX**: both terminal dispatches (`snapshot_resolved`, `snapshot_failed` — the only two outcomes a
fetch has) plus all four navigations, which abandon the request it describes. The fetch effect's four
early returns are each closed elsewhere: `term === ''` by the handler's guard, `isPending` by the
control being disabled, `stage`/`predicateId` by the navigation clears.

⚠ **`bailIfUnchanged` had to be reasoned about, not assumed.** An hourly pipeline usually returns
byte-identical data, so *the refresh whose result changes nothing is the refresh most likely to
happen* — and a bail there would leave the marker armed with no request behind it, i.e. the stuck
flag arrived at through the guard rather than a handler. It is safe only because the marker is part
of the comparison; pinned by a test that asserts the no-op resolve does **not** bail while in flight.

In flight it renders the design system's **re-scope idiom (dim + progress beam), never a skeleton** —
a standing control that blanks the answer on every press makes each refresh feel like a page rebuild.

### "Ranking data rebuilt …" — the one source that means what it says

`collections.rollup_refresh_run.finished_at`, newest ok run. **S5 is that table's first app-path
reader** (0054 shipped writers only). `claims_reader` holds both gates already — grant at 0054:68,
SELECT policy at 0054:89-90, RLS on — verified live as the reader's own privileges rather than read
off the migration text, because 0089 is exactly the case where a grant existed, a policy did not, and
the silent empty result became permanently wrong data behind a fail-soft catch. **No migration.**

Two columns are one word away and both are wrong in the *alarming* direction, so both are pinned out
at the SQL, in `test/rollupFreshnessQuery.test.ts`:

| column | why not |
|---|---|
| `max(ingested_at)` | **first-seen** (`ON CONFLICT DO NOTHING`). Measured 3h25m / 3h54m old across three *successful* hourly refreshes; longest healthy gap over 14 days is **42 hours**. Also a 20,961-buffer parallel seq scan. |
| `rollup_max_payment_date` | reads **into the future** — `FUTURE_PAYMENT_HORIZON_DAYS` is 14, so on 2026-08-07 it read **2026-08-12**. |

The read also refuses `ok IS NULL` / `finished_at IS NULL`: 0054's header says a hard platform timeout
kills the function before the completion UPDATE, and that "started but never finished" state **is** the
failure signal. Ordered by `started_at desc` because that is the indexed column.

**The copy names the rebuild, never the pull.** There is no run-log for `cmd-explorer` /
`indigo-explorer` at all, and that cron's 210s wall-clock budget silently defers un-pulled customers
to the next hour — so "last pulled" is a claim no `SELECT` in this database can back. The lag bound is
derived from the schedule: BXR pulls at :00, Indigo at :30, the rebuild runs at :45, so a BXR row is
invisible for 46 min at best and **1h45m** at worst (Indigo 17 min / 1h16m), before CMD's own posting
lag. Hence *"up to about 2 hours"* and never a single number.

Times render as **`Aug 8 at 4:45 PM PDT`** — a date and a named zone, never a bare HH:MM. This team
spans timezones and the app anchors civil days to `America/Los_Angeles`, and without the date a
stalled cron's twenty-hour-old timestamp reads as today. Built from `formatToParts`, because modern
ICU puts a **narrow no-break space** (U+202F) before the day period and `format()` would ship a string
that renders fine and fails every assertion written with an ordinary space.

⚠ **It is its own action, not a field on `QualifySnapshot`** — a deliberate pick against the brief's
default. The snapshot is a member-scoped, PHI-audited payload; this is a global operational fact with
no tenant, no identifier and no user input. Riding along would make every v2-tab and mobile snapshot
pay for a read neither renders, put an ops lookup inside the one call the surface waits on, and give
the freshness read the *ranking's* failure mode — when the whole point is that it degrades to
"freshness unknown" and leaves the answer untouched. The cost is one effect in the shell, keyed on
`retryNonce` so the time moves when the operator asks for fresher data.

### The window can move under the operator, and nothing said so

`scopeKeyOf` serializes the automatic case as the literal string `'auto'` — **not** the ladder's
chosen days. Automatic is the default. So a refresh re-runs the sufficiency ladder, can land on a
different rung, and produces an **identical** request key: `loadedKey === scopeKey`, every staleness
flag reads "nothing changed", the facet badge still says *"On · automatic"*, and `windowSentence`
quietly renders a different number. On this surface that is a silent scope change.

Both directions are genuinely reachable — new rows crossing the 10-patient floor **narrow** it; rows
ageing out, or an `America/Los_Angeles` civil-day roll, **widen** it. `windowMove` is written by
`snapshot_resolved` alone, set-or-clear on every resolve, and only when `loadedKey ===
action.scopeKey`: a re-scope is a change the operator made, the key moved with it, and the dim + beam
already marked it. Both ladders are coerced with `?? null` before comparison — `undefined !== null`
would turn "no ladder before, no ladder after" into a window move, which is every manual-window
resolve.

The notice is a `role="status"` on the card carrying the S3 marker, and **`liveSentenceFor` announces
the same bytes** — one call to `windowMoveNotice`, not a second sentence that agrees today. Three
render gates, each preventing a different false sentence: `!stale` (RULE 2654416), `windowDays ===
null` (it is a claim about the *automatic* window and would contradict *"— your selection"*), and
`windowMove !== null` — **the negative control.** Most refreshes return the same rung; a notice that
fired on every one would be noise, and noise is how the real one gets ignored. Pinned.

**`memberCount` moving on a refresh is deliberately NOT announced.** Written down because it is a
decision, not an omission: it is the same claim over fresher data, and the preface sentence re-renders
with the new number in both the visible and the spoken channel. The window is different in kind — it
changes what *period* the ranking covers while every sentence on screen goes on reading "automatic",
and no flag can see it. Hence a `windowMove` and no `memberCountMove`.

### The refresh must never re-enter the resolve

Re-running `resolveCoverageAction` means dispatching `identifyAction` → `search_submitted`, which
writes sixteen reducer fields and drops the operator back to the payer stage — i.e. a refresh would
throw away the plan pick every time somebody asked for fresher numbers. Pinned from both sides: a
reducer test that `retry_requested` moves none of the thirteen fields a navigation moves, and a
**source scan** of `resolution-flow-client.tsx` (unimportable by anything hermetic) asserting
`formAction` is called from exactly two places, neither of them the refresh handler. The button is
`type="button"` for the same reason.

**All new copy is unratified.**

### Fix round 1 (2026-08-08) — a guard that could not fail, a basis line that could lie, and a swallow nobody could find

**The empty-term guard was pinned by ORDER, not PRESENCE, so deleting it was invisible.** The scan
asserted `body.indexOf("termRef.current === ''") < body.indexOf('retry_requested')` — and `indexOf`
returns `-1` for an absent needle, so removing the guard made it `-1 < positive`, i.e. **true**. The
mutation ran a full green suite. What it would have shipped is the stuck-flag class reached *around*
the reducer rather than through it: a press on an emptied PHI ref arms `refreshingNonce`, the fetch
effect's own `term === ''` early return fires so no request starts, and therefore **neither terminal
dispatch ever runs** — the card locks at *"Refreshing the ranking…"*, unpressable, until a navigation.

Both guards moved into `makeRetryHandler` (flow-state.ts), a pure factory over injected getters, so
they are **behaviour a test calls** rather than lines a scan has to recognise. The PHI stays in the
shell's ref: the factory takes a `getTerm` **getter** and never stores what it reads. What is left in
the source scan is the *wiring*, which is the only part a hermetic test genuinely cannot reach.

**A refresh whose snapshot failed still advanced the rebuilt-at line.** The freshness effect and the
snapshot effect are independent, both fire on `retryNonce`, and the heavy one is far the likelier to
fail (`statement_timeout` vs a one-row index scan). Sequence: press → freshness succeeds and advances
→ snapshot fails → invariant (e) deliberately retains the **old** grid → the card reads *"Ranking data
rebuilt 5:45 PM PDT"* above a ranking built before that rebuild, and keeps saying so until a retry
succeeds. This is the only **basis** claim on the screen.

Fixed by **captioning, not gating**, and the reason is that a gate cannot make it unrepresentable: the
race runs both ways — the snapshot can fail *after* freshness has committed — so a commit-time check
narrows the window without closing it, while a render-time caption is correct in either ordering.
`rebuiltAtSentence(…, { refreshFailed })` states the timestamp (still true about the *rebuild*) and
stops claiming it describes the grid: *"— but the last refresh failed, so the ranking below may
predate that rebuild."* The CMD lag bound is dropped in that arm; two caveats bury each other, and
this one dominates. The **bounded** sibling — both succeed, freshness landing ~1s early over a dimmed
grid — is left alone.

**The first-ever read of `rollup_refresh_run` failed soft silently.** Correctness was never at risk (a
42501 cannot fabricate a timestamp; the unknown arm carries no digit) — but a bare `catch` made a
**permission** failure indistinguishable from an empty log in the UI *and* the server logs, on a table
whose SELECT policy has never been exercised on the app path. That is the discoverability half of the
0089 rule, and the sibling loader twenty-five lines away already states it: *"the swallow must stay
discoverable in server logs."* The catch now logs the **SQLSTATE only** — the driver's message can
carry query text and answers nothing here.

**Minors.** `windowMove` is now conditioned on `refreshingNonce !== null` as well as the key match:
"same request identity" was doing double duty as "this was a refresh", and `scopeKeyOf` carries **no
identifier at all**, so a new member's first resolve can serialize identically to the previous
member's — safe today only because the navigations happen to null the snapshot, i.e. a guarantee held
by a neighbouring field. `EVERY_ACTION`'s completeness is now **derived from the reducer's own arms**,
so a twentieth action cannot slip the INV o sweep. The refresh control swapped `disabled` for
`aria-disabled`: the real attribute makes the element unfocusable the instant it lands, so the control
the operator is standing on stops being focusable mid-press and focus falls to `<body>` — the exact
regression the shell's focus effect prevents one layer up — and it is not reliably announced; the
refusal moved into `makeRetryHandler` where a second press during flight is a tested no-op.

**And the window notice's copy stopped being anchored to a moment.** It never auto-dismisses and
correctly survives every grid-narrow toggle, so an operator can sit with it on screen for minutes
while *"than it did a moment ago"* quietly stops being true. Fixed in **copy** — it names the refresh
(a durable event) and states the span as a fact about the list in front of them — deliberately **not**
with dismissal machinery: a timer would be new in-flight state on the surface whose whole S5 lesson is
that in-flight state is where the bugs live.

The ICU dependency in `rebuiltAtSentence` is left as-is: a fixed UTC instant, no DST hazard, and it
fails loudly rather than silently on a small-icu runtime.

## S6 — THE PROMINENT SKIP beneath the rail, and the Ask-AI un-submit (2026-08-08)

Alec, verbatim: *"If there is the option to 'skip — search all plans' this button should be very
visible, sparkly with movement just underneath the green timeline."*

### The hoist — three render sites become one, above the animated subtree

`SkipStep` used to render from **three** places inside the stage bodies: `StagePayer` (gated on the
carrier count), and `StagePlan` **twice** — the pinned header, and the empty-cluster early return
that fires when a stale carrier pick leaves no plans under it. It now renders from **one** site in
`ResolutionStages`, directly beneath `<StepRail>`, gated by a new pure `skipOffered(stage,
resolution, groups)`. It dispatches the same `skipped` action; the reducer is untouched.

Three things that follow, none of them cosmetic:

1. **It is CHROME now, not stage content.** Everything above `[data-v3-stage]` sits outside the
   shell's entrance tween, and that tween animates `autoAlpha` — which sets `visibility: hidden`.
   A control that is the loudest thing on the screen must not be unclickable and out of the
   accessibility tree for the first frames of every stage it appears on. This is the same
   `autoAlpha`-vs-`opacity` constraint the skip reveal already documents, arriving from the other
   direction: there, live controls could not take `autoAlpha`; here, the control simply leaves the
   subtree that applies it.
2. **The empty-cluster dead end can no longer lose its escape hatch.** An affordance rendered from
   inside a rarely-taken early return is one refactor away from vanishing exactly where it matters
   most. Pinned by its own test.
3. **It precedes the question in tab order,** which is the point (visibility) and a real
   consequence. The shell focuses the stage's `<h2>` on a stage swap, so a keyboard user now reaches
   the Skip by **shift-tab** from the question rather than by tabbing forward. That is the same
   relationship the receipt strip's "Change" buttons already have — escape and revisit affordances
   live in the chrome above the question — so it is a consistent position rather than a new one.
   The single live region is untouched: it announces the QUESTION, never this control.

### The carrier-count suppression is PRESERVED — and its recorded premise is dead

`SKIP_CARRIER_MAX = 3` still suppresses the Skip on the carrier stage above three clusters, and the
hoisted control carries the identical gate. **But the reasoning ratified on 2026-08-06 no longer
describes this branch, and the ruling was preserved anyway rather than dropped with it.**

The ratified reason was: *"with a dozen carriers behind a prefix, skip resolves the ranking to
whichever payer happens to dominate the identifier's claims, which is ARBITRARY rather than
general."* The **2026-08-07 reversal above** — *the Skip ranks the whole radius, not one label* —
removed that mechanism entirely: `allPayers = skipped && payerOverride === null` becomes
`payerScope: 'all'` on the wire and `QualifyResolved.payerName` is null, so there is no
dominant-payer pick left in the skip path to be arbitrary about.

The gate still has a reason, and it is the reversal's **own rule 2**: an all-payers ranking is
dollar-weighted across every label behind the rows, so `pctAllowedOfBilled` and therefore `ratingV2`
are a blend — Simpson's paradox on the exact surface admissions staff act on. At two carriers that
blend is legible and one BILLED UNDER chip un-blends it. At a dozen it is a blend the operator
cannot reason about, offered as a shortcut past the one question that would have prevented it. S6's
hoist makes that offer **louder**, which strengthens the case for the gate rather than weakening it.

That is a **different argument over the same threshold and the same behaviour**. It is recorded here
and in the constant's own header, and it wants Alec's re-ratification. It did not want a silent drop,
and the ratified paragraph is left readable in both places rather than rewritten.

### The sparkle — and a knowing exception to the motion contract

`.q-skip-spark` in `globals.css` reuses the `.q-beta-badge` idiom: a gradient-clipped shimmer plus a
✦ that twinkles, same 2.6s / 1.9s vocabulary.

> ⚠ **A PERSISTENT SHIMMER CONTRADICTS THE HOUSE MOTION CONTRACT, and it is shipped as a knowing
> exception, not a precedent.** The contract reads *"motion narrates progression; it never gates
> input"* — and a persistent shimmer does not narrate, because narration **ends** and this does not.
> It is the ratifier's explicit request. Nothing else on this surface may borrow it without its own
> ruling.
>
> **The half of the contract about input still holds absolutely.** The control is fully interactive
> from frame zero: no `pointer-events: none` (the badge idiom's one input-gating property — correct
> there, because the badge sits *on* a link and is not itself the control), no `visibility`, no GSAP
> `autoAlpha`, and no motion hook of its own. Pinned by test.

Two things from the badge deliberately did **not** travel, and both are swept at the stylesheet
because the markup sweep only ever sees `text-[Npx]` classes:

- **Its sizes.** The badge is 8px text / 7px star — legitimate for an aria-hidden decoration in the
  nav, and below the 12px floor this surface machine-sweeps. The ✦ here is **13px** beside a
  `text-sm` (15px) label.
- **Its gradient range** — and the correction below is the more useful half of this bullet. The
  sweep is teal200 → white → teal50 → teal200 over the button's `#0E3A3A…#135E5A` fill, and every
  stop clears 4.5:1 against the **lighter** end.

> #### ⚠ CORRECTION (fix round 1, same day) — the first version of that bullet was measurably false
>
> It read *"the stops here are teal50 → white → **coral400** … all ≥ 4.5:1"*. Measured, coral400
> `#f0917c` is **5.37:1 on teal900 but 3.26:1 on teal700** — and the fill runs `from-teal900
> to-teal700`, so most of the label sits at or past the midpoint and the coral band crossed the
> loudest control on the screen **below the floor every 2.6s**. The label is `text-sm` = 15px
> semibold, which is *not* WCAG "large text", so 1.4.3 wants 4.5:1 with no 3:1 arm to fall back on.
>
> **The failure was a transplanted premise, and that is worth more than the fix.** The refusal of
> `#ffe0d5` — *"would carry the words through an illegible phase"* — was reasoned about the badge's
> **light** ground and then applied to a **dark** one, where that same stop measures **6.08:1**. The
> rejected colour was the safer one all along. A rule inherited from a neighbouring surface arrives
> with the neighbour's background baked in.
>
> Corrected sweep, measured against `#135E5A`, the worst case rather than the average:
> **teal200 `#b7dad5` 5.04:1 · white `#ffffff` 7.56:1 · teal50 `#eaf4f2` 6.74:1.** A gradient
> interpolates monotonically per channel and relative luminance is monotonic in each channel, so the
> stops bound the whole sweep — there is no interior colour darker than the darkest stop. The coral
> stays on the **✦ alone**, where 3.26:1 clears 1.4.11's 3:1 for a graphic: a decorative `content`
> glyph, with the accessible name coming from the `aria-label`.
>
> **The arithmetic is a test now**, computed from the tailwind tokens and the CSS declaration
> themselves, with the rejected coral stop kept as the negative control. A contrast claim in prose
> is a claim; a computed one re-verifies itself on every run and survives a token edit. Reach for
> this shape whenever a colour decision is being defended in a comment.

**The transparency sits behind `@supports`.** `color: transparent` is survivable only where
`background-clip: text` actually paints the letters; without it the primary control on the screen
has no visible label at all — while the accessible name survives on the `aria-label`, which is
exactly what would let that ship green past every test that reads markup. The base rule paints a
solid teal50 (6.74:1 on the worst end of the fill) and only the supported branch goes transparent;
the `-webkit-` form is in the condition because it is the only one Safari has ever supported.

Both animations collapse under the global `prefers-reduced-motion` reset, which is a universal
`*` / `*::before` / `*::after` rule and therefore reaches an element and its `::after` alike. That is
**verified rather than assumed**: a test asserts the reset's shape, that both animations hang off
selectors it matches, and that no reduced-motion block in the sheet mentions the sparkle — an
opt-out of its own being the only way to defeat the reset from the component side.

> **Fix round 1 — that scan used to promise more than it delivered.** It was a regex bounded to 400
> characters after the `@media`, under a comment claiming *"the only way"*. An opt-out written past
> the bound passed it, demonstrated: the same mutation returns `false` from the old expression and
> red from the new one. The blocks are now read **in full** by walking brace depth. The lesson is not
> about regexes — it is that a **bounded** mechanism must not carry an **unbounded** comment, because
> the comment is what the next reader trusts.

The **skip reveal** (the GSAP stagger over `[data-v3-facet]`) is unaffected by construction: it
selects inside `stageEl` — `[data-v3-stage]` — and the hoisted button now lives above that element.
Asserted from both ends rather than argued.

### The Ask-AI rider — asking about a plan was picking it

The plan tile's *"✦ Ask AI about this plan"* was `type="submit"` with `onClick={onAskAi}` **inside**
`<form action={planAction}>`. One press therefore fired `ai_armed` **and** the form's own submission:
interrogating a plan committed to it, and the receipt then recorded a *"PLAN &lt;employer&gt;"*
decision the operator never made — the same class of false decision-claim the skip guards exist for,
reached through the one control whose entire purpose is to look *before* committing.

The fix is `type="button"`. It leaves exactly one submit in the tile, so the form also gains a
single unambiguous default submission. The pick path is byte-unchanged and asserted as bytes.

`autoAsk` is one-shot and **survives `plan_submitted`** (flow-state invariant l, unchanged), so
arming here and then picking still auto-asks on the answer stage: the two presses are the flow, not
a regression of it.

> ⚠ **KNOWN CONSEQUENCE, NOT FIXED HERE.** The `QualifyAiPanel` mounts only on the answer stage, so
> pressing Ask-AI on the plan stage now produces **no visible feedback at all** until the operator
> separately picks a plan or skips. That is strictly less harmful than the bug (a silent no-op
> instead of a false decision record) but it is a dead end, and the honest close is either an armed
> state on the tile (`aria-pressed` + a disarm press, which needs `autoAsk` threaded down to
> `StagePlan`) or copy that says what the press actually does. Both are product calls.

### Fix round 1 (2026-08-08) — the pick path was pinned everywhere except where it lives

**The tile's server-action binding was unpinned, and the gap is a property of React 19 rather than
an oversight.** `action` on a `<form>` takes a **function**, and a function prop emits no attribute —
so deleting `action={props.planAction}` renders **byte-identically** to keeping it. The S6 report
claimed the pick path was "byte-unchanged and asserted as bytes", and it was: the assertion covers
the *button*, while nothing at all covered the form. A refactor that dropped the binding would have
shipped the full suite green and made "Use this plan" silently do nothing.

Closed with the same instrument the S5 refresh work already owns — a **structural source scan**,
scoped to `StagePlan`'s own body so a form elsewhere in a 4,000-line module cannot satisfy it. The
scan strips block comments before counting, because the Ask-AI fix's own comment *quotes*
`<form action={planAction}>`: an un-stripped scan counts prose **about** the binding as the binding.
That is the same confusion between a description and the thing described that this branch has now
found in three separate shapes — the enumerated BOOK-LED index, the order-pinned empty-term guard,
and now this.

**The general rule this leaves behind:** `renderToStaticMarkup` can only see what serializes.
Function props, event handlers and action bindings are invisible to it, so any claim about *wiring*
needs a source scan — and any test asserting a control's bytes should be read as covering the
control, never the wiring around it.

**Also in this round.** The un-submit pin and the byte pin on the path it must not disturb were split
into two tests: they were one, so a single deletion removed both halves of a claim that only means
something when the halves are independent. And two comments elsewhere in the module were carrying
premises the 2026-08-07 reversal had already killed — `scopeSource`'s *"'dominant' = the core
resolved the identifier's largest payer"* (a plain Skip also sends no label, and the core answers
that with `payerScope: 'all'`), and `billedUnderCaption`'s header paragraph, which **forbade the
widening that then shipped**. Both are amended in place with the reversal's date, and both quote what
they replace. No behaviour depended on either.
