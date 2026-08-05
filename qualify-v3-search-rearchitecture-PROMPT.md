# Qualify v3 — search re-architecture

**A prompt for Claude Code. Authored 2026-08-04 from a live pass on production `main` @ `964ba2c`.**

> **Read this section first.** This document exists because Qualify's search is built on an
> abstraction that the data does not support. The fix is not a UI polish pass and not a bug list —
> it is a change to *what the app thinks a search is*. Everything in §3 is **measured**, not
> asserted. Do not re-derive it, do not re-litigate it, and do not start writing UI until §5 is
> settled. If you disagree with a measurement, re-run its query and say so before proceeding.

---

## 1. What you are being asked to do

Re-architect the Qualify search — data model first, then UI — so that:

1. **A search resolves to exactly one population, and the user can see what it is.** Today four
   panels on one screen describe four different populations and nothing says so.
2. **Ambiguity is surfaced as a question, never resolved by a hidden heuristic.** Today the app
   silently picks a "dominant payer" out of as many as 50 and prints it as *the* policy on file.
3. **The flow is a guided walkthrough**, not a grid of filters the user has to compose correctly by
   luck. Alec's words: *"I'm trying to avoid searching randomness and resolving windows by things
   that can't be seen."*
4. **The intelligence is in the resolution, not in the chrome.** The search engine should be
   genuinely smart about identity; the screen should be simple.

You are **not** being asked to preserve the current compose-bar model. It is the thing being replaced.

---

## 2. Non-negotiables (carried forward — these do not change)

- Read `CLAUDE.md` and `veris-data-notes.md` first. Surface conflicts; never silently resolve one.
- **PHI never** reaches logs, LLM prompts, `summary_stats`, a URL or query string, browser storage, or
  `query_log`. Every row in the product plane is PHI.
- Reads run as `claims_reader`. Parameterized queries only; table/column names are fixed literals.
  Never `SELECT *`.
- `admissions_seat` is **server-stripped of every dollar field**. Any new derivation must be non-dollar
  and produce **byte-identical output** for blind and sighted roles. This is the constraint that most
  often gets quietly broken — check it on every new field.
- Surgical `git add <file>`. Never `-A`. Never a `Co-Authored-By` trailer.
- PRs open against `staging`, never `main`.
- The five-command gate is the bar for "verified": root `npm test`, root `npm run typecheck`,
  `cd app && npm test`, `cd app && npm run typecheck`, `cd app && npm run build`.
- `/qualify` is behind `QUALIFY_MAINTENANCE` for everyone except `alec@treathealth.ai`. **Use that.**
  Build v3 behind the flag and leave v2 reachable until v3 is better on every axis.
- Qualify is the deliberate cross-tenant exception in this app: CoverageGroup, the D1
  crosswalk, and D2 resolution read across BXR (`af504ab6-3dcd-4aa4-a93c-27bc58de4088`)
  and Indigo (`141d459c-f371-4229-9a92-ace198e940bb`) together — unchanged from the
  existing Qualify design. Do not apply the single-`business_entity_id` pattern used
  elsewhere in the app to this feature. If any query in D1/D2 needs to be scoped to one
  entity, that's a deviation from ratified design — stop and say so, don't just write it.
---

## 3. Ground truth — measured 2026-08-04

All figures are from PHI-safe aggregate queries (counts of blind-index tokens and non-PHI text; no
identifier was projected). Queries are reproducible against
`vob.member_benefits_latest` and `collections.cmd_explorer_charge_rollup`.

### 3a. A 3-character prefix is **not** a policy

The UI's central claim — *"XDP identifies itself — nothing to re-type"*, *"the prefix IS the policy"* —
is false for the overwhelming majority of real lookups.

| Measure | Value |
|---|---|
| Distinct 3-char prefixes in VOB | 4,072 |
| Prefixes spanning **more than one payer** (`payer_id` spine) | **1,467 (36.0%)** — worst case **29 payers** |
| Prefixes spanning **more than one employer** | 1,508 (37.0%) — worst case **300 employers** |
| Prefixes spanning more than one plan type | 686 (16.8%) |
| **Members** sitting on a multi-payer prefix (`payer_id` spine) | **17,994 of 23,035 = 78.1%** |
| **Members** sitting on a multi-employer prefix | 18,538 = **80.5%** |
| Members on a prefix with >1 plan type | 52.3% |

**Read that again: ~78% of the time, a prefix search is ambiguous at the payer level.** The rep is not
sampling prefixes uniformly — they type the prefix on the card in front of them — so the
member-weighted figure is the one that describes real use.

> **Which basis, and why it matters** (re-measured 2026-08-04). Payer ambiguity reads differently
> depending on what you call "one payer", and the three answers diverge:
>
> | Basis | multi-payer prefixes | worst | members ambiguous |
> |---|---|---|---|
> | raw `insurance_co` | 1,737 (42.7%) | 50 | 19,993 = 86.8% |
> | upper/trimmed `insurance_co` | 1,618 (39.7%) | 42 | 17,558 = 76.2% |
> | **`payer_id` — the D1 spine** | **1,467 (36.0%)** | **29** | **17,994 = 78.1%** |
>
> The table above now quotes the **`payer_id` basis**, because that is the spine D1 builds on and
> therefore the ambiguity v3 actually has to resolve. The earlier 86.8% figure was measured on *raw*
> `insurance_co`, which counts case and whitespace variants of one company as separate payers (1,391
> case-distinct VOB names collapse to 1,120 upper-cased — 271 are pure case noise).
>
> Note the spine figure (78.1%) is **higher** than the normalized-name figure (76.2%) even though it
> has far fewer distinct values (380 ids vs 1,120 names). That is not a contradiction: **367 names span
> multiple `payer_id`s**, so the id spine *splits* what name-normalization merges — one string like
> "Blue Cross Blue Shield" legitimately covers several distinct regional carriers. Collapsing on name
> would therefore *under*-count real ambiguity. The conclusion is unchanged and if anything firmer:
> ambiguity is the main path, not an edge case.

Ambiguity is also where the volume is: **82.1% of all claim lines** sit under a prefix that maps to two
or more payers (1,195 of 2,662 prefixes with claims).

The `buildResolvePayerQuery` "dominant payer" heuristic (most charges, unwindowed) covers **85.8%** of a
prefix's lines on average and is an outright **minority in 6.4%** of prefixes. So it is usually
directionally right and *never* announced as a choice. That combination — usually right, silently
chosen, presented as fact — is the worst of the three options.

### 3b. And the reverse: one employer+payer spans several prefixes

This is Alec's observation ("*if I search the same Payer + Employer … the claims have different
prefixes*"), confirmed:

| Measure | Value |
|---|---|
| (payer, employer) pairs in VOB | 13,500 |
| Pairs spanning **more than one prefix** | 1,109 (8.2%) — worst case **49 prefixes** |
| Pairs with more than one plan type | 610 |
| Pairs with more than one funding type | 373 |

8.2% sounds small until you notice it is concentrated in **large employers** — precisely the ones a rep
searches. Southwest Airlines on Aetna is one of them.

**Conclusion: the prefix↔policy relationship is many-to-many in both directions.** Neither a prefix nor
an (employer, payer) pair identifies a plan.

### 3c. There are two payer vocabularies and no crosswalk between them

The policy card names the payer from VOB (`insurance_co`). The facility ranking is fetched by
`claims.primary_payer`. These are different strings for the same companies — screenshot 1 shows
**"Anthem BCBS of California"** on the policy card and **"ANTHEM BLUE CROSS CALIFORNIA"** in the
ranking header, on one screen, about one payer.

| Measure | Value |
|---|---|
| Distinct payer names in VOB | 1,120 |
| Distinct payer names in claims | 465 |
| **Exact (upper/trimmed) matches** | **191** |
| Share of VOB names present in claims | **17.1%** |

**There is no join.** The two halves of the screen have never been about the same payer except by
coincidence.

**The good news — the crosswalk has an anchor.** `vob.payer_id` is populated on **99.9%** of VOB rows
and collapses 1,120 dirty names into **380 ids**. It is not perfectly clean (163 ids carry multiple
names; 367 names span multiple ids) but it is the right spine to build on.

### 3d. One in three searched clients has no policy row at all

| Measure | Value |
|---|---|
| Claim lines in the rollup | 491,087 |
| Lines whose member has a VOB row | 68.1% |
| Distinct members in claims | 10,588 |
| Members with a VOB row | 6,890 = **65.1%** |

The "policy on file" path — the whole premise of the identified search — is unavailable for ~35% of
members. v3 must treat *no policy on file* as a **first-class, designed state**, not a fallback.

### 3e. A proven code defect that explains the screenshots exactly

Two functions in `app/lib/qualify/contract.ts` classify the same input differently:

```ts
// L715 — CLIENT, drives the compose filter (the count + the grid)
export function classifyQualifyIdentifier(raw: string) {
  if (/^[A-Za-z]{1,3}$/.test(v)) return { memberId: '', alphaPrefix: v };  // letters ONLY
  return { memberId: v, alphaPrefix: '' };                                 // ← "W26" lands here
}

// L316 — SERVER, drives the policy card, the window ladder, the payer resolve, the ranking
export function sniffQualifyKind(query: string): QualifyMatchKind {
  return query.trim().length <= 3 ? 'prefix' : 'member_id';                 // ← "W26" is a PREFIX
}
```

`"W26"` contains digits, so the client calls it a **full member ID** and mints an exact
`member_id_bidx` token — which matches **nothing**, because no member's complete ID is `W26`. The
server calls it a **prefix** and resolves a policy, a ladder, a payer and a 28-facility ranking.

That is screenshots 2 and 4 precisely: a fully populated policy card, a 12-patient window ladder and a
policy rating of 34, sitting beside **"0 charge lines match · 0 clients · no matches yet."**

It also explains why `XDP` and `XQH` (letters only) behave correctly and `W26` / `W27` do not. **Real
payer prefixes are overwhelmingly alphanumeric**, so this breaks for most actual cards.

Do not fix this in isolation. It is a symptom of having two identifier authorities; §5 removes the
second one.

### 3f. Every panel runs its own filter, so the screen contradicts itself

Observed on screenshot 1 (`XDP`), one screen, four different answers to "what is allowed of billed":

| Element | Value | Population it actually describes |
|---|---|---|
| KPI tile | **31%** | book-wide, all payers, all facilities (caption says "book-wide") |
| Context line | **45%** | the composed match (prefix ∩ window) |
| Top facility card | **49%** | that facility × the resolved payer, payer-wide |
| Policy rating | **40** | patient-weighted mean over 19 rated facilities |

Each is individually defensible. Together they are noise. Contributing causes, all live in code today:

- **KPI tiles** (`getQualifyBookKpis`) are scoped by **payer and facility chips only** — never by the
  prefix. Screenshot 4 shows `33% / 97% / 32%` captioned "AETNA · 1 facility" directly above a context
  line reading **"$0 billed · allowed — of billed."**
- **The window ladder** (`buildQualifyWindowRungsQuery`) counts `count(distinct member_id_bidx)` over
  *everyone sharing the prefix*, across all payers — a third population, and the one that silently
  **changes the window** for every other panel.
- **The ranking** is payer-wide by construction and never prefix-scoped.
- **The AI panel** reads whichever snapshot resolved, which may be a fourth population again.

### 3g. Accessibility debt (WCAG 2.2 AA, current state)

- **Text below legible size**: flank labels at `8.5px`, flank values `9.5px`, several captions
  `10–10.5px`. Anything under ~12px fails in practice for the target user (a rep on a laptop, on a
  call). SC 1.4.4 is about resize, but the design should not *start* there.
- **The hero numeral has no accessible name** — a bare number in a `<span>`. A screen reader announces
  "77" with no indication it is a reimbursement rating out of 100.
- **Duplicate controls, same target**: after PR #100 the card body and the "Why this score" button both
  toggle the same disclosure. One target, two tab stops.
- **Colour-carried meaning**: `factors disagree`, direction arrows ▲/▼, and the IQ band pills lean on
  hue. The coverage bar is colour-only with no text equivalent per segment.
- **Motion**: the Heating-Up marquee auto-scrolls. `prefers-reduced-motion` is handled — verify it
  still is after any rework, and give it a visible pause control (SC 2.2.2).
- **No heading structure for the flow**: everything is one `<h1>` plus card `<h2>`s. A step flow needs
  a landmark and heading per step so AT users can navigate it.
- **Live region is too terse**: `"1,358 charge lines match"` is announced, but a *resolution change*
  (payer resolved, window auto-changed) is not announced at all — and that is the event that
  invalidates everything on screen.
- **Focus management**: nothing moves focus when the flow advances or when a resolution changes.

---

## 4. The diagnosis in one paragraph

Qualify models a search as **a set of AND-composed filters over charge lines**, and then tries to
reverse-engineer a *policy* out of whatever the filters happened to match. The data will not support
that: an identifier is a weak hint (§3a/3b), the two payer vocabularies do not join (§3c), a third of
members have no policy row (§3d), the client and server disagree about what the user even typed (§3e),
and each panel re-derives its own population (§3f). The result is a screen that is *confidently wrong* —
which this surface has repeatedly held to be worse than an honest "not enough data", and which is
exactly what a rep quoting a family on the phone cannot afford.

---

## 5. The new model — resolve a **Coverage Group**, then answer one question about it

### 5a. The unit

Replace "prefix / member ID / filter set" with a single first-class server-side concept:

```
CoverageGroup
  canonicalPayerId      -- from the new payer crosswalk (§6, D1). NOT a raw name.
  employerKey           -- normalized plan sponsor, nullable
  funding               -- Self-Funded | Fully Insured | null
  planType, policyType  -- PPO / POS / ASO / HMO / …, nullable
  network               -- INN | OON | null (always null today — VOB gap, keep it visible)
  memberCount           -- distinct members in VOB on this group
  claimEvidence         -- distinct members / lines / distinct facilities in the claims rollup
```

A **resolution** is then: CoverageGroup is cross-tenant by construction — `memberCount` and `claimEvidence` count across BOTH BXR and Indigo, not per-entity. This is the same explicit exception the rest
of Qualify already runs on, not a new decision..

The chosen group is the *only* population on screen. Every panel derives from it. If a panel cannot
be scoped to it, that panel does not render.

### 5b. The rule that replaces the dominant-payer heuristic

> **When the candidate set has more than one member, the user picks. The app never picks silently.**

At 78.1% member-weighted ambiguity on the `payer_id` spine (§3a) this is not an edge case — **it is the
main path**, and it is the step the current UI is missing. Ranking candidates by member count and pre-selecting the top one is
fine; *hiding that a choice was made* is not.

### 5c. One windowing and population authority

Create a single server-derived object — call it `QualifyResolution` — that carries:

- the chosen `CoverageGroup`
- the exact window (`from`, `to`, and **why** that window: user-chosen, or ladder-chosen with the rung
  counts attached)
- the exact row predicate, expressed once
- per-panel evidence counts, so each panel can say what it is built on

Then: **every number on screen must be traceable to this one object**, and each panel renders a short
provenance line naming the subset it used. No panel constructs its own filter. This is the structural
fix for §3f — the honesty problem stops being something you remember to caption and becomes something
the type system makes hard to get wrong.

`QualifyResolution` must be **non-dollar** in every field a blind role can see, so blind and sighted
sessions derive identical provenance strings.

### 5d. The window stops moving on its own

The ladder currently auto-changes the window based on a count the user never sees. Either:

- (preferred) the ladder **proposes** and the user confirms it as a visible step, or
- the window is explicit and the ladder is advisory only.

Never both, and never a silent re-window after results are on screen.

---

## 6. Data workstreams

Do these in order. **D1 gates everything else** — without it, no two panels can be about the same payer.

### D1 — `ref.payer_identity`: the payer crosswalk (blocking)

One row per real-world payer. Anchor on `vob.payer_id` (99.9% coverage, 380 ids). Carry:

- `canonical_payer_id` (surrogate), `display_name`
- alias sets from **both** vocabularies: VOB `insurance_co` strings, claims `primary_payer` strings
- provenance + confidence per alias, and a `needs_review` flag

Bootstrap: the 191 exact matches, then trigram/token similarity to propose the rest, then **a
human-reviewed remainder**. Do not auto-accept fuzzy matches into production — a wrong payer merge is
a confidently-wrong answer at the worst possible layer. Ship the reviewed subset and treat unmatched
claims payers as *unmapped* (a visible state), never as a silent miss.

Non-PHI: payer identity is public information. This table can live in `ref` / `intel` and be readable
without PHI concerns — confirm against `SQL Schemas/025_*.sql` posture before choosing the schema.

**Deliverable**: a migration (re-derive the next number per `.claude/rules/sql-migrations.md`; product
plane is at **0083** and the Veris plane at **026** as of 2026-08-04 — cross-check the live applied
state, do not trust the file order), plus a coverage report: what share of claim volume and VOB members
map to a canonical payer.

### D2 — `CoverageGroup` resolution service

Server-side, one module. Given a handle (prefix, member ID, facility, or employer), return the ranked
candidate set with evidence counts. Pure query + assembly; no UI concerns. Must:

- use the D1 crosswalk on both sides
- return **candidates**, never a single collapsed answer
- attach, per candidate, the claim evidence that will back the eventual ranking, so the UI can warn
  *before* the user picks something with no history
- treat "no VOB row" as a valid candidate shape (claims-only coverage group) — §3d

### D3 — Kill the second identifier authority

Delete one of `classifyQualifyIdentifier` / `sniffQualifyKind` and route both client and server through
the survivor. Requirements:

- alphanumeric handles (`W26`) classify identically on both paths
- the classifier's output is part of `QualifyResolution`, so the screen can state *how* it read the
  input ("read as a 3-character prefix")
- a test enumerating real-shaped handles: `XDP`, `W26`, `W291408212`, `XQH`, `2 chars`, mixed case,
  whitespace, and a full ID that happens to be 3 characters

### D4 — One windowing authority

`QualifyResolution` owns `from`/`to`. The ladder becomes a *proposal* attached to the resolution, with
its rung counts, and the ladder's population must be **the chosen coverage group** — not everyone who
shares a prefix (§3f).

### D5 — Retire the per-panel queries

`getQualifyBookKpis`, `getQualifySnapshotByPayer`, `getQualifySnapshot`, `getQualifyMatchSummary` and
the trend query currently each own a population. Re-point them at the resolution, or replace them. The
KPI tiles in particular must either be scoped to the resolution or be explicitly labelled book-wide
context that is *not* about this client — pick one and make it structural.

---

## 7. UI — the guided resolution flow

Same page, progressive disclosure, one question per step. Steps stay visible and revisitable once
passed (this is a walkthrough, not a wizard that traps you).

### S0 · Start — "Who are we looking at?"

One input, one purpose. Accepts a prefix, a full member ID, or a facility name; says which it read.
No filter grid on screen at this stage. `canRevealPhi`-gated exactly as today; the term stays in
component state and never reaches the URL.

### S1 · Resolve — "Which plan is this?"

The step that does not exist today and fixes the most.

Show the candidate coverage groups from D2 as a short, ranked, **selectable** list — payer · employer ·
funding · plan type, with member count and a claim-evidence badge. Pre-select the top candidate;
require a confirm. When there is exactly one candidate, say so and auto-advance — but *state* that it
was unambiguous, because that is real information.

When a candidate has **no claim evidence**, mark it before the user picks it, so they never reach a
ranking that turns out to be about nothing.

This is also where the AI's first job lives (§8): turn "4 payers, 12 employers" into a question a rep
can answer from the card in their hand.

### S2 · Window — "How far back should we look?"

Show the ladder's proposal *and its rung counts*, scoped to the chosen group. The user confirms or
overrides. After this step the window does not change unless the user changes it.

### S3 · Answer — "Where should this client go?"

Now, and only now, render the ranking — full width, one column (the claim-line grid is gone and stays
gone, per the 2026-08-04 ruling). Every panel carries a provenance line derived from
`QualifyResolution`. The KPI tiles either scope to the resolution or are labelled as book-wide context.

### S4 · Ask — the AI explainer

Grounded strictly in `QualifyResolution`. Preset questions only, generated from resolved facts.

### a11y requirements — these are acceptance criteria, not polish

- Each step is a `<section>` with an `<h2>`; the flow is a landmark. Steps expose completion state.
- **Focus moves to the newly revealed step's heading** on advance. Focus never moves on a keystroke.
- A **single** `aria-live="polite"` region announces resolution changes in plain language: *"Resolved:
  Aetna · Southwest Airlines Co. · Self-funded. 28 facilities, 30-day window."* Not just the count.
- **Minimum 12px** for any text carrying meaning; 14px+ for body. Retire the 8.5/9.5px flank labels.
- The hero numeral gets an accessible name (`aria-label="Reimbursement rating 77 of 100, Strong"`).
- Every colour-carried state gets a text or shape equivalent — `factors disagree`, band pills,
  direction arrows, coverage-bar segments.
- **One control per target.** Remove the duplicate card-body/"Why this score" disclosure pair.
- Contrast ≥ 4.5:1 on the dark readout bar, including the muted `white/55` and `white/60` captions,
  which currently do not clear it.
- The marquee gets a visible pause/play control; verify `prefers-reduced-motion` still disables motion.
- Full keyboard path from S0 to S4 with no trap; tab order follows visual order.
- Test with `renderToStaticMarkup` assertions for names/roles/headings, as the existing suites do.

---

## 8. The AI's two jobs (and its one hard boundary)

1. **Disambiguator (S1).** Given the candidate set and their counts, produce the *question* that
   fastest narrows it, phrased against what the rep physically has: the insurance card, the employer
   the client named, the plan letters. This is where "searching randomness" dies.
2. **Explainer (S4).** Read the resolved facts and the ranking; explain the recommendation and what
   would change it.

**Boundary, unchanged and structural:** the model receives `QualifyAiInput`, a `.strict()` Zod schema
with **no field** for a member ID, a name, an employer, a group number, or a dollar amount. Extend that
schema only with non-PHI, non-dollar aggregates, and keep the blind-role scrubber
(`createBlindLineScrubber`) in place. The model never picks the coverage group — it only helps the
human pick. A model-chosen population would reintroduce exactly the silent-heuristic problem §5b exists
to remove.

---

## 9. Invariants, and the tests that must prove them

Write these as tests **before** the implementation they guard. Each is a real failure that has already
shipped at least once.

| # | Invariant | Test shape |
|---|---|---|
| I1 | Every rendered number traces to one `QualifyResolution`; no panel builds its own predicate. | Source-level assertion that panels receive the resolution and do not import query builders. |
| I2 | One identifier authority: `W26` classifies identically on client and server. | Table test over real-shaped handles (§D3). |
| I3 | Ambiguity is never silently collapsed — a >1 candidate set always reaches the UI as a choice. | Resolution service returns candidates; a test asserts no code path takes `[0]` implicitly. |
| I4 | Blind and sighted roles derive **identical** provenance strings, captions, ratings and flanks. | Run every derivation twice, once with amounts stripped; deep-equal the non-dollar output. |
| I5 | A null percentage is never rendered as 0%; "cannot say" and "zero" stay distinct. | Existing `settledNoMatches` pattern, extended to every derived figure. |
| I6 | The window never changes after results render, except by user action. | State-machine test on the resolution reducer. |
| I7 | No PHI in the URL, logs, or the model prompt — including `employer_norm` (see §11). | Extend the existing `urlState` and `QualifyAiInput` strictness tests. |
| I8 | A payer that does not map through the D1 crosswalk renders as *unmapped*, never as a match. | Crosswalk fixture with a deliberately unmapped claims payer. |
| I9 | Keyboard + AT: every step reachable, named, announced; one control per target. | `renderToStaticMarkup` role/name/heading assertions per step. |

---

## 10. Phasing — each phase ships behind `QUALIFY_MAINTENANCE` and passes the five-command gate

| Phase | Content | Gate to pass before moving on |
|---|---|---|
| **P0** | D1 payer crosswalk + coverage report. No UI. | Coverage report reviewed by Alec. Migration applied live and recorded in `veris-data-notes.md`. |
| **P1** | D3 one identifier authority + I2 tests. Smallest independently valuable fix — it alone stops the `W26` contradiction. | Five gates. Manual check: `W26` and `XDP` behave identically in kind. |
| **P2** | D2 resolution service + `QualifyResolution` + I1/I3/I4 tests. Still no new UI. | Five gates + a resolution-fixture suite. |
| **P3** | S0–S2 (start, resolve, window) behind the flag, v2 still reachable. | Five gates + a11y assertions. **Browser pass by Alec** — this has been owed since PR #90 and cannot be discharged by an agent: there is no headless browser in the repo and unauthenticated `/qualify` renders the maintenance notice. |
| **P4** | S3–S4 re-pointed at the resolution; retire the v2 compose bar. | Five gates + I1–I9. Browser pass. |
| **P5** | Delete v2 paths and the orphaned components (`cases-table.tsx`, `cohort-sheet.tsx` — currently retained-but-unmounted, Alec's call). | Five gates; test counts accounted for, not merely lower. |

> **P1 does not depend on P0 — the numbering is priority, not a dependency chain.** D3 (one
> identifier authority) is a pure client/server classification fix: it deletes one of
> `classifyQualifyIdentifier` / `sniffQualifyKind` and routes both paths through the survivor. It
> touches no payer data, reads nothing from the D1 crosswalk, and needs no migration. D1 (the payer
> crosswalk) is data-only and touches no identifier logic. There is **no data dependency, no schema
> dependency and no shared code path between them.**
>
> Both gate P2 — which needs the crosswalk *and* a single identifier authority — but they do **not**
> have to run in series. **If capacity allows, P1 can start in parallel with P0's review and soak
> rather than waiting for P0 to close.** That is worth doing: P0's gate is a human review of the
> coverage report plus a live apply, so it has real wall-clock latency in which P1 sits idle for no
> reason, and P1 is the smallest independently valuable fix in the whole plan — on its own it stops the
> `W26` contradiction where a populated policy card, a 12-patient ladder and a rating of 34 sit beside
> "0 charge lines match".
>
> The one coordination cost is mechanical, not logical: both phases open PRs against `staging`, so
> whichever lands second rebases. Keep them in separate PRs (`P0` = migration + coverage report, `P1` =
> classifier + I2 tests) so the crosswalk review is never blocked on classifier review or vice versa.

Open a PR per phase against `staging`. Nothing merges to `main` except via a `staging → main`
promotion PR. **A merged migration is not an applied migration** — code that depends on one 500s until
`apply_migration` runs.

---

## 11. Decisions Alec still owes (do not guess these)

1. **`employer_norm` in the URL.** `buildQualifySearchParams` writes it to the query string, so it
   reaches browser history, `Referer` and edge logs. `app/lib/phi.ts` lists `employer_name` in
   `PHI_BASE_COLUMNS`, and `employer_norm` is its normalization. `urlState.ts:29` asserts
   "employer_norm keys, non-PHI", which contradicts `phi.ts` — and `phi.ts` is the documented source of
   truth. Display to an authenticated principal was **ruled acceptable** on 2026-08-04; the URL was
   explicitly **not** covered. Pre-existing and already on prod. **v3 must not carry it forward without
   a ruling.**
2. **The orphaned components.** Keep or delete `cases-table.tsx` / `cohort-sheet.tsx`.
3. **Whether S1 may auto-advance** on a single candidate, or must always require a click.
4. **`/qualify/m`.** The mobile PWA has its own container and still renders claim views. Does v3 apply
   there, or does mobile stay on v2? This changes the blast radius substantially.

---

## 12. Explicitly out of scope / do not do

- **Do not** re-add the claim-line grid, the standalone red scope banner, the global PHI unmask toggle,
  or click-a-facility-to-filter. All four were removed by ruling on 2026-08-04; the reasoning is in the
  `qualify-tab.tsx` header.
- **Do not** touch the hourly collections crons, their routes, schedules, grants, or the
  `collections.*` tables they write. Production-critical and out of this session's scope.
- **Do not** author a migration numbered `0077`–`0082` (product) or edit `023`/`024`/`025` (Veris) —
  all applied live.
- **Do not** widen `QualifyAiInput` to carry PHI or dollars "temporarily".
- **Do not** ship a fuzzy payer merge without human review (§6 D1).
- **Do not** report a phase complete without all five gates green *and* the test counts accounted for.

---

## 13. Start here

1. Read `CLAUDE.md`, `veris-data-notes.md`, `.claude/rules/qualify.md` (**note: that rule file
   still documents the v1 rating and is stale — shipped `main` uses `ratingV2`; fix it as you go**).
2. Re-run two or three of the §3 queries yourself to confirm the ground truth still
   holds. `collections.cmd_explorer_charge_rollup` is a `collections.*` object — use the
   Supabase MCP tool, not the dashboard SQL editor, which throws `42P01` on that schema.
   A tool error here is not the same as "the ground truth doesn't hold" — don't conflate them.
3. Come back with **P0's crosswalk design and coverage estimate**, and a written statement of what you
   believe `CoverageGroup` and `QualifyResolution` should contain. **Stop there and wait for Alec.**
   Do not begin UI work until the unit of search is agreed.
