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

3. **The scope is a typed claim, not a display default.** `QualifyResolved.payerName` is
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

One deviation from the tile treatment, and it is the constraint rather than a detail: the
inventory animates plain `opacity`, never `autoAlpha`. `autoAlpha` sets `visibility: hidden`,
which would make live controls genuinely unclickable and drop them out of the accessibility
tree for the length of the stagger. Motion narrates progression; it does not gate input.

> **Not in this repo yet: the `area` facet.** Alec's inventory list names it, and PR #164
> (`feat/qualify-v3-location-facet`) adds it — unmerged as of this date. When it lands it needs
> its own `data-v3-facet` row and `FacetState` badge, or the inventory's claim to list *every*
> facet quietly stops being true.
