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
