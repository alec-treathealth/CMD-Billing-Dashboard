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

### What follows the flip — and what deliberately does not

Every claim surface either re-bases or states the split. This is where the review lives, so the list
is exhaustive:

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
  the same condition as the visible claims.

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

**All new copy is unratified.**
