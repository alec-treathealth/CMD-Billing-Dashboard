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
- **The answer-armed ticker.** Heating Up's cards are clickable again on IDENTIFY *and* stage
  4, but a click now seeds the area facet rather than v2's {facility + dominant payer} pivot —
  v3 resolves a member, and re-pivoting the whole surface on a click would throw the member
  away. The strip stays inert (`readOnly`) on PAYER and PLAN, where a click would compete with
  the question those stages are asking.

## Motion

GSAP stage transitions: outgoing stage clears, incoming slides up 14px/220ms ease-out, tiles
stagger `min(index,3) * 60ms` (capped — long lists must not cascade forever). One easing.
`prefers-reduced-motion` disables all of it. Motion communicates progression through the
stages; it never blocks input.
