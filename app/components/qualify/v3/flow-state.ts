/**
 * Qualify v3 — THE SHELL'S STATE MACHINE. Eighteen fields, nineteen actions, one place each field
 * is written.
 *
 * Extracted from `resolution-flow-client.tsx` (F3b). The shell was carrying FIFTEEN `useState` hooks
 * — the fourteen fields it then had, plus `trends`, which stays behind (see WHAT IS DELIBERATELY NOT
 * IN HERE) — bound at 58 setter sites: 56 direct calls, of which 2 are `setTrends`, plus 2 raw setters
 * passed as props. They encoded the rules below only by repetition: "a new search clears
 * everything downstream" was twelve adjacent `setX(...)` lines, and the fact that Skip deliberately
 * does NOT clear `windowDays` was legible only by diffing two of those blocks by eye. Every rule in
 * this file was already true; none of it was stated anywhere, and none of it was testable without
 * mounting a component that needs `useActionState`. This module is pure, so it is.
 *
 * ⚠ NAME COLLISION, DELIBERATELY AVOIDED: `app/lib/qualify/v3FlowState.ts` already exports a
 * `V3FlowState` — that is the SERVER ACTION's state (resolution / reason / echo / denied), owned by
 * `useActionState`. This file's state is the CLIENT SHELL's, and is named `ShellState` so the two
 * can never be confused at an import site.
 *
 * ── PURITY CONTRACT ─────────────────────────────────────────────────────────────────────────────
 * No `'use client'`, no React import, no server import, no I/O, no Date/Math/random. The reducer is
 * a total function of (state, action). This is what lets `app/test/qualifyV3FlowState.test.tsx`
 * assert the invariants directly instead of inferring them from rendered markup.
 *
 * ── WHAT IS DELIBERATELY *NOT* IN HERE ──────────────────────────────────────────────────────────
 * · `termRef` — the raw typed identifier. PHI, and JS-memory-only by the IdentityForm discipline
 *   (see the shell's header). Reducer state gets asserted on in unit tests and inspected in
 *   devtools; PHI must never enter it. The guards that READ the ref therefore never live in a
 *   reducer case: the fetch effect's early return stays in the shell, and the refresh's empty-term
 *   check moved into `makeRetryHandler` below — a factory over a GETTER, which keeps the term out of
 *   this module's state while making the guard a behaviour a test can call. That mattered: the
 *   source scan that stood in for it could not fail (S5 fix round, MUT-25).
 * · The `useActionState` triple (`state` / `formAction` / `isPending`) — React's server-action
 *   machinery owns it.
 * · `trends` — the landing ticker. It is a mount-once fetch that no handler and no flow field ever
 *   touches; folding an orthogonal thing into a state machine only makes the machine harder to read.
 *   It stays its own `useState` in the shell.
 * · Everything DERIVED per render: `payerGroups`, `derived`/`stage`, `pickLabel`, `sentOverride`,
 *   `scopeSource`, `answerCandidates`, `narrow`, `scopeKey`, and — most importantly —
 *   `stale` / `refetching` / `staleAfterError`. Those three are computed from
 *   (snapshot, loadedKey, scopeKey, snapshotError) on every render ON PURPOSE: storing them as flags
 *   is the stuck-flag bug class that 7a40728 / bef4c57 fixed, and an extraction that "tidied" them
 *   into the reducer would re-introduce it.
 *
 * ── ACTIONS, AND EXACTLY WHICH FIELDS EACH ONE WRITES ───────────────────────────────────────────
 * Anything not listed for an action is carried through untouched. `retryNonce` and `loadedKey` are
 * absent from every list but `retry_requested` and `snapshot_resolved` respectively — that is the
 * point, not an omission.
 *
 *  1 · search_submitted        — a new identify submit. WRITES FOURTEEN:
 *                                payerPick=null, picked=false, skipped=false,
 *                                filters=NO_ANSWER_FILTERS, planFilter='',
 *                                autoAsk=false, backTo=null, snapshot=null, snapshotError=null,
 *                                payerOverride=null, windowDays=null, area=AREA_ALL,
 *                                facilityNarrow=NO_FACILITY_NARROW, narrowExpanded=false,
 *                                refreshingNonce=null, windowMove=null.
 *                                KEEPS retryNonce, loadedKey.
 *  2 · skipped                 — "skip the questions, answer over the whole footprint". WRITES FOURTEEN:
 *                                skipped=true, picked=false, payerPick=null, planFilter='',
 *                                backTo=null, filters=NO_ANSWER_FILTERS,
 *                                payerOverride=null, snapshot=null, snapshotError=null,
 *                                area=AREA_ALL, facilityNarrow=NO_FACILITY_NARROW,
 *                                narrowExpanded=true (invariant n),
 *                                refreshingNonce=null, windowMove=null.
 *                                KEEPS windowDays, autoAsk, retryNonce, loadedKey (see invariant f).
 *  3 · plan_submitted          — a plan pick. WRITES ELEVEN:
 *                                picked=true, skipped=false, filters=NO_ANSWER_FILTERS,
 *                                backTo=null, snapshot=null, snapshotError=null,
 *                                area=AREA_ALL, facilityNarrow=NO_FACILITY_NARROW,
 *                                narrowExpanded=false (invariant n),
 *                                refreshingNonce=null, windowMove=null.
 *                                KEEPS payerPick, planFilter, payerOverride, windowDays, autoAsk,
 *                                retryNonce, loadedKey (see invariant g).
 *  4 · went_back {target}      — a receipt "Change". WRITES SIXTEEN:
 *                                snapshot=null, snapshotError=null, autoAsk=false,
 *                                payerOverride=null, windowDays=null, picked=false, skipped=false,
 *                                filters=NO_ANSWER_FILTERS, planFilter='', narrowExpanded=false,
 *                                area=AREA_ALL, facilityNarrow=NO_FACILITY_NARROW, backTo=target,
 *                                refreshingNonce=null, windowMove=null,
 *                                and payerPick=null ONLY when target !== 'plan' (the machine's one
 *                                conditional write — invariant h).
 *                                KEEPS retryNonce, loadedKey.
 *  5 · payer_picked {payer}    — WRITES payerPick=payer, backTo=null.
 *  6 · plan_filter_changed {value}     — WRITES planFilter=value.
 *  7 · filter_toggled {facet,value}    — WRITES filters (add/remove `value` in the facet's array;
 *                                        facet 'funding'→funding, 'employer'→employers).
 *                                        ⚠ THERE IS NO 'planType' ARM (2026-08-07). It was not a
 *                                        client-only narrow: `filterCandidates` feeds
 *                                        `employerNarrowFor`, whose employer set IS sent, so a
 *                                        plan-type press could re-rank over a silent employer
 *                                        narrow. See `AnswerFilters` in resolution-flow.tsx.
 *  8 · filters_cleared         — WRITES filters=NO_ANSWER_FILTERS, area=AREA_ALL,
 *                                facilityNarrow=NO_FACILITY_NARROW.
 *                                BOTH grid narrows ride along because "Clear filters" is one button
 *                                and the answer stage has one control surface: a narrow that survived
 *                                it would be a narrow the user believes they just cleared.
 *                                ⚠ IT NO LONGER CLEARS A TYPED EMPLOYER DRAFT, because the machine
 *                                no longer holds one — the shared type-ahead owns its own. Its
 *                                `Clear N` affordance is the picker's, and it walks the selection
 *                                back through `filter_toggled`. The draft still dies on every
 *                                NAVIGATION, structurally rather than by a reducer write: all four
 *                                move the stage, exactly one stage section renders at a time, so
 *                                `StageAnswer` unmounts and the picker's state goes with it.
 *  9 · retry_requested         — WRITES snapshotError=null, retryNonce=prev+1,
 *                                refreshingNonce=prev+1, windowMove=null. NOTHING ELSE, ever — and
 *                                the "nothing else" is what makes it safe to promote from a failure
 *                                banner to a STANDING refresh control (S5, invariant o).
 * 10 · snapshot_requested      — WRITES snapshotError=null. Dispatched at the top of the fetch
 *                                effect so `refetching` can only claim progress while a request is
 *                                genuinely in flight (invariant k).
 * 11 · snapshot_resolved {snapshot, scopeKey}
 *                              — WRITES snapshot=action.snapshot, loadedKey=action.scopeKey,
 *                                refreshingNonce=null, windowMove=<computed, invariant p>.
 *                                THE SCOPE KEY RIDES IN THE PAYLOAD: the old `setLoadedKey(scopeKey)`
 *                                closed over a value computed in render scope, which a reducer
 *                                cannot see. The effect already captures the right one; it passes it.
 * 12 · snapshot_failed         — WRITES snapshotError='failed' and refreshingNonce=null. AND NOTHING
 *                                ELSE — nothing about the CONTENT (invariant e).
 * 13 · ai_armed                — WRITES autoAsk=true.
 * 14 · ai_disarmed             — WRITES autoAsk=false.
 * 15 · payer_override_changed {label} — WRITES payerOverride=label.
 * 16 · window_days_changed {days}     — WRITES windowDays=days.
 * 17 · area_selected {key}            — WRITES area=key. AND NOTHING ELSE — most of all not
 *                                       `snapshot`, `loadedKey` or anything `scopeKeyOf` reads
 *                                       (invariant m). Single-select, the mobile chip model:
 *                                       AREA_ALL | a 2-letter state | AREA_OTHER.
 * 18 · facility_narrow_toggled {value}
 *                              — WRITES facilityNarrow (add/remove `value`). AND NOTHING ELSE — the
 *                                SECOND grid narrow, and the same law as `area_selected` (invariant
 *                                m). MULTI-select, because the shared type-ahead is multi by nature;
 *                                one action in both directions, so the picker's own `Clear N` walks
 *                                the selection back through it rather than earning a second writer.
 * 19 · narrow_toggled          — WRITES narrowExpanded = !narrowExpanded. AND NOTHING ELSE: the
 *                                NARROW SEARCH card is a disclosure, and a disclosure that touched
 *                                `filters` or `snapshot` would be a presentation control silently
 *                                re-issuing a ranking request (invariant n).
 *
 * TWENTY SWITCH ARMS, NINETEEN ACTIONS. The twentieth is `default: return state` — an arm the
 * `ShellAction` union makes unreachable through the type system, kept because the type system is not
 * the only caller: a hot-reloaded action queued against a newer reducer, or a hand-written dispatch
 * in a future test, would otherwise fall off the end and return `undefined` as the whole state. It
 * returns the SAME object, so a stray dispatch cannot even cost a render. Pinned by a test that
 * dispatches a bogus type through a cast. It matches the `windowReducer` precedent
 * (app/lib/qualify/resolution.ts:417).
 *
 * ── INVARIANTS (each one is pinned by a test in app/test/qualifyV3FlowState.test.tsx) ────────────
 * a · A NEW SEARCH CLEARS EVERYTHING DOWNSTREAM. `search_submitted` from ANY prior state lands on
 *     the same thirteen values above — a kept-but-hidden choice is how one client's ranking ends up
 *     scoped to another client's payer.
 * b · ALL FOUR NAVIGATION PATHS CLEAR `snapshot` AND `snapshotError` TOGETHER — search_submitted,
 *     skipped, plan_submitted, went_back. The retry design (invariant c) depends on exactly this.
 * c · `retryNonce` IS MONOTONIC AND IS NEVER RESET BY ANY ACTION. Its only write is the +1 in
 *     `retry_requested`. It is the sole way to re-fire a request whose inputs did not move (the
 *     fetch effect keys on `scopeKey`, which is identical by construction on a retry). Zeroing it
 *     could make a later retry collide with a stale value and silently do nothing.
 * d · `loadedKey` STAMPS ONLY ON SNAPSHOT SUCCESS. One write site: `snapshot_resolved`. No handler
 *     clears it, no failure stamps it — it must keep describing the scope the RENDERED snapshot
 *     actually covers, which is what lets the answer stage tell stale content from current content.
 * e · A FAILED FETCH KEEPS THE SNAPSHOT (F2). `snapshot_failed` writes `snapshotError` and disarms
 *     the in-flight marker, and touches nothing about the CONTENT: the last-known-good answer was
 *     valid a moment ago and is no less valid because a re-scope failed. (Until S5 this read "writes
 *     `snapshotError` alone". The marker had to join it — it is one of the only two terminal
 *     dispatches, and a signal cleared by one of two outcomes is a stuck flag by construction.
 *     Wording amended, substance unchanged: `snapshot` and `loadedKey` are still untouched.)
 * f · SKIP CLEARS THE PICK BUT KEEPS THE TERM — and, asymmetrically, keeps `windowDays` and
 *     `autoAsk`. The term is untouched because it lives in `termRef`, outside this machine.
 * g · CHOOSING A PLAN SUPERSEDES A PRIOR SKIP (`skipped=false`) and blanks the snapshot to the
 *     skeleton, because a new plan is a new population — while preserving the carrier pick, the
 *     plan filter, the billed-under override and the window.
 * h · GOING BACK UN-SKIPS, and keeps the carrier pick ONLY when stepping back to the plan stage.
 *     `went_back` is the only action that ever writes a non-null `backTo`.
 * i · ANY FORWARD SUBMIT OR PAYER PICK CLEARS `backTo`. The receipt's Change can only step BACKWARD
 *     from what is derivable.
 * j · A RE-SCOPE TOUCHES ONLY ITS OWN FIELD. `payer_override_changed` and `window_days_changed`
 *     never null the snapshot: dim-and-progress rides `loadedKey` vs `scopeKey` divergence, so the
 *     content stays on screen instead of collapsing to a skeleton.
 * k · `snapshot_requested` CLEARS THE ERROR AT REQUEST START, so `refetching` (stale && error===null)
 *     cannot animate a progress beam over a dead fetch.
 * l · `autoAsk` IS ONE-SHOT: armed by `ai_armed`, disarmed by `ai_disarmed` / `search_submitted` /
 *     `went_back`. Without the disarm, a re-scope remount re-fires an unrequested, audited, BILLED
 *     LLM call (review Critical 2).
 * m · `area` IS A GRID NARROW, NOT A FETCH NARROW — and it is a SEPARATE FIELD from `filters` for
 *     exactly that reason. Every consumer of `AnswerFilters` is request-facing: `answerFiltersActive`
 *     gates the shell's `narrow` memo, `filterCandidates`/`employerNarrowFor` resolve the employer
 *     set that goes into `market`, `scopeKeyOf` reads `filters.funding`, and `rankingNarrowed`
 *     (resolution-flow.tsx) turns those into the disclosure's "narrowed by your filter selections"
 *     caption. `area` narrows the RENDERED FACILITY LIST — a different object entirely
 *     (`QualifyFacility`, not `OrderedCandidate`) — and must reach none of them. Folding it into
 *     `AnswerFilters` would have flipped `answerFiltersActive` true on an area-only selection, which
 *     prints "Ranking over 311 of 311 plans" over an untouched request. Keeping it beside `filters`
 *     makes the honesty guarantee STRUCTURAL: there is no code path from this field to a request.
 *     It resets wherever `filters` resets (the four navigations + `filters_cleared`) and nowhere
 *     else — notably NOT on the two re-scopes, which keep their content on screen.
 *
 *     ⚠ `facilityNarrow` IS THE SAME FIELD CLASS AND THE SAME LAW (S4, 2026-08-08), and it is the one
 *     where the temptation to break it is real: a facility narrow has an obvious SQL form
 *     (`upper(facility) = any($n::text[])`) and the ranking query would take it. It is a DISPLAY
 *     narrow anyway, for a measured reason rather than a structural one — 86.9% of members bill at
 *     exactly ONE facility in 365 days, so a fetch-shaping facility narrow would empty the screen
 *     ~87% of the time WHILE DISCARDING the very list that makes the empty state useful ("no history
 *     at NASHVILLE; this member billed at LSMH and KWC"). A fetch narrow can say the first clause and
 *     never the second. Both narrows reset at exactly the same five sites, as ONE list, so the answer
 *     stage's two grid narrows can never drift into clearing at different moments.
 * n · `narrowExpanded` IS NAVIGATION-COUPLED, WHICH IS THE ONLY REASON IT IS IN HERE. The admission
 *     test this header sets for itself is the `trends` rule above — "does any handler or flow field
 *     touch it" — and two navigations must write this one: a Skip lands the NARROW SEARCH card OPEN
 *     (the fields are the operator's next move, and the skip reveal needs rows to stagger), a plan
 *     pick lands it CLOSED (the search is already narrow; the card states what it resolved to). The
 *     other two navigations close it under invariant (a): a card left open over a state the user has
 *     left is the same kept-but-hidden class, at lower stakes. `filters_cleared` deliberately does
 *     NOT write it — that button is a filter reset pressed from inside the card's own summary, not a
 *     navigation, and moving the surface the operator is standing on is not a default either way.
 *     THE BIT IS PRESENTATION AND MUST STAY PRESENTATION: nothing in `scopeKeyOf` reads it, so like
 *     `area` it is structurally unable to reach a request. What it must never become is a gate on
 *     the ON/OFF inventory — the card's SUMMARY carries that in both states, and only the CONTROLS
 *     live behind the disclosure.
 * o · `refreshingNonce` IS ARMED IN ONE PLACE AND CLEARED IN SIX — the stuck-flag post-mortem, run
 *     deliberately in reverse (S5, 2026-08-08). The refresh needs a progress signal that the derived
 *     trio structurally cannot give it: `stale`/`refetching`/`staleAfterError` all hang off
 *     `loadedKey !== scopeKey`, which on a SAME-SCOPE re-run is false for the whole in-flight period
 *     by construction, and `showSkeleton` needs `snapshot === null`. So without a signal of its own
 *     the screen does not move for the 1-2s the request takes and the operator presses again —
 *     each press writing a `SEARCH_QUALIFY_PHI` row into a compliance log.
 *
 *     ARMED BY: `retry_requested`, and nothing else — most of all NOT `snapshot_requested`, which
 *     fires at the top of every fetch including first loads and re-scopes, both of which already
 *     carry their own treatment.
 *     CLEARED BY: both TERMINAL dispatches (`snapshot_resolved`, `snapshot_failed`) — the only two
 *     outcomes a fetch has — plus all four navigations, which abandon the request the marker
 *     describes. Six clears against one arm is the inverse of the `refetching` boolean that was set
 *     in four places and cleared in one.
 *
 *     ⚠ IT CARRIES THE NONCE, NOT A BOOLEAN, so a reader can say WHICH request is in flight rather
 *     than only that one is. The residual risk is a dispatch with no fetch behind it, and the fetch
 *     effect's four early returns are each closed elsewhere: `term === ''` by the shell's own
 *     `onRetrySnapshot` guard (it returns BEFORE dispatching), `isPending` by the control being
 *     disabled while the server action runs, and `stage !== 'answer'` / `predicateId === null` by
 *     the four navigation clears above — those are the only ways to leave the answer stage.
 * p · `windowMove` IS THE ONE SILENT SCOPE CHANGE THIS SURFACE COULD STILL MAKE, MADE LOUD.
 *     `scopeKeyOf` serializes the automatic window as the literal string `'auto'` and NOT as the
 *     ladder's chosen days. So a refresh under Automatic — the default — can re-run the sufficiency
 *     ladder, land on a different rung, and produce an IDENTICAL key: `loadedKey === scopeKey`,
 *     every staleness flag reads "nothing changed", and `windowSentence` quietly renders a different
 *     number. Both directions are reachable (new rows crossing the 10-patient floor NARROW it; rows
 *     ageing out, or an America/Los_Angeles civil-day roll, WIDEN it).
 *
 *     Written by `snapshot_resolved` ALONE, set-or-clear on every resolve, and only when BOTH the
 *     in-flight marker was armed (this really was a refresh) AND `loadedKey === action.scopeKey`
 *     (the request identity did not move). A re-scope is excluded on purpose: the operator changed
 *     something, the key moved with it, and the dim + beam already marked it.
 *
 *     ⚠ THE MARKER CONDITION IS NOT REDUNDANT, though it looks it. `scopeKeyOf` carries no
 *     identifier at all, so a NEW member's first resolve can serialize identically to the previous
 *     member's — and the key test alone was safe only because the four navigations happen to null
 *     the snapshot, i.e. a guarantee held by a neighbouring field rather than by this rule.
 *
 *     ⚠ BOTH LADDERS ARE COERCED WITH `?? null` BEFORE COMPARISON. A manual window returns no
 *     ladder at all, and `undefined !== null` would turn "no ladder before, no ladder after" into a
 *     window move. A ladder ARRIVING where there was none is also not a move — there is no "from"
 *     to name — so both sides must be present.
 *
 *     ⚠ `memberCount` MOVING ON A REFRESH IS DELIBERATELY NOT ANNOUNCED, and this is the record of
 *     that decision rather than an omission. It is the SAME claim over fresher data, and the preface
 *     sentence re-renders with the new number in both the visible and the spoken channel. The window
 *     is different in kind: it changes what PERIOD the ranking covers while every sentence on screen
 *     goes on reading "automatic". Hence a `windowMove` and no `memberCountMove`.
 *
 * The asymmetries in (f), (g) and (h) are OBSERVED BEHAVIOR carried over verbatim, not oversights to
 * normalize. Changing one is a product decision, not a refactor.
 *
 * ── REFERENTIAL BAIL-OUT — AND THE ONE RESPECT IN WHICH IT IS *NOT* WHAT useState DID ───────────
 * A naive reducer returns `{...state}` on every dispatch, so every dispatch re-renders. Where the
 * old shell had a genuine no-op — the fetch effect's request-start clear when `snapshotError` was
 * already null, a chip click that re-sends the value already set — that would now cost a full
 * subtree render. `bailIfUnchanged` prevents it: when every field of the next state is `Object.is`
 * to the previous one it returns the PREVIOUS OBJECT, and React's render-phase check bails out of
 * reconciling children and of re-running effects.
 *
 * ⚠ BUT IT IS NOT THE SAME BAIL. `useState` has an EAGER path: with an empty update queue and an
 * `Object.is`-identical next value, React never schedules the update at all and the component body
 * does not re-run. `useReducer` has no such path — `dispatchReducerAction` always schedules, the
 * body re-runs ONCE, and only then does the returned-same-object check stop the work. So a no-op
 * dispatch costs one extra body invocation that the pre-F3b shell did not pay. That is
 * consequence-free HERE (the body is pure, every memo hits on unchanged deps, no effect re-fires)
 * and it is the honest residual of the extraction — do not describe this guard as reproducing
 * `useState` exactly, because it does not.
 *
 * ONE ACTION BYPASSES THE GUARD ENTIRELY: `retry_requested`, which returns a fresh object
 * unconditionally. The nonce always moves by construction, so the comparison could only ever cost
 * time — and a retry that bailed would be the exact dead-stage bug the nonce exists to prevent.
 *
 * This is also why `filters` is reset to the shared `NO_ANSWER_FILTERS` constant rather than a fresh
 * literal — identity is load-bearing for the `narrow` memo downstream, and a fresh-but-equal object
 * would invalidate it on every navigation. Pinned per nav action in the test file, by reference and
 * not by `deepEqual` (which is reference-blind, and left that rule silently unpinned until MUT-F).
 */
import type { QualifySnapshot, QualifyTrailingDays } from '../../../lib/qualify/contract';
// ONE 'all' sentinel across both Qualify surfaces, imported rather than redeclared: the desktop
// answer stage and the mobile deck now speak the same area vocabulary (AREA_ALL | state | 'other'),
// and two constants that merely happen to both be 'all' is how they stop being the same vocabulary.
import { AREA_ALL } from '../m/area-chips';
// ⚠ `WindowMove` IS DEFINED IN resolution-flow.tsx AND IMPORTED HERE, NOT THE REVERSE. This module
// already depends on that one (NO_ANSWER_FILTERS, AnswerFilters, FlowStage); defining the shape here
// and importing it back would make the presentation module depend on the machine and close a cycle.
// The copy that reads it (`windowMoveNotice`) lives beside the render, so the type does too.
import {
  NO_ANSWER_FILTERS,
  NO_FACILITY_NARROW,
  type AnswerFilters,
  type FlowStage,
  type WindowMove,
} from './resolution-flow';

/** The eighteen fields the staged flow moves between screens. No PHI: the term lives in a ref.
 *  (Sixteen until 2026-08-07: `employerQuery` went with the hand-rolled employer tag-search it fed —
 *  the shared `MultiSelectTagPicker` that replaced it owns its own typed draft, and a machine field
 *  nothing reads is a field the next reader wires something to. Eighteen since S5, 2026-08-08:
 *  `refreshingNonce` + `windowMove`, invariants o and p.) */
export interface ShellState {
  /** The carrier the user picked on stage 2, in VOB vocabulary. */
  payerPick: string | null;
  /** A plan was chosen on stage 3. */
  picked: boolean;
  /** The user's own escape hatch: answer over the WHOLE footprint. Declining to choose is a
   *  different claim from choosing, and the answer stage says which. */
  skipped: boolean;
  filters: AnswerFilters;
  planFilter: string;
  /** One-shot arm for the AI panel — see invariant (l). */
  autoAsk: boolean;
  /** The receipt's backward escape hatch; null means "wherever deriveStage says". */
  backTo: FlowStage | null;
  snapshot: QualifySnapshot | null;
  /** Only ever null | 'failed'. */
  snapshotError: string | null;
  /** Monotonic. Never reset — see invariant (c). */
  retryNonce: number;
  payerOverride: string | null;
  windowDays: QualifyTrailingDays | null;
  /** What scope the RENDERED snapshot describes — see invariant (d). */
  loadedKey: string | null;
  /**
   * The answer stage's AREA facet: AREA_ALL | a 2-letter state | AREA_OTHER (unmapped facilities,
   * never dropped). Restores the facility/location narrow the v3 cutover lost. Deliberately NOT a
   * member of `filters` — see invariant (m); it narrows the rendered grid and reaches no request.
   * Non-PHI (facility city/state only) and never persisted to the URL.
   */
  area: string;
  /**
   * The answer stage's FACILITY narrow — canonical picker values from `qualifyFacilityOptions`,
   * MULTI-select, empty = no restriction (never "match nothing"). The restored v2 facility
   * type-ahead, rendered beside the grid with the AREA row.
   *
   * NAMED `facilityNarrow`, NOT `facilities`, on purpose: `QualifySnapshot.facilities` is the ranked
   * list this field narrows, and two adjacent call sites spelling different things the same way is
   * exactly the drift the `payerCount`/`solePayer` class is made of.
   *
   * Deliberately NOT a member of `filters` — see invariant (m). Non-PHI (facility names already
   * render on every card) and never persisted to the URL: v3 writes no URL at all, and the
   * `employer_norm`-in-a-URL posture is still unresolved, so adding one here would be a new surface
   * rather than a restoration.
   */
  facilityNarrow: readonly string[];
  /**
   * Is the answer stage's NARROW SEARCH card showing its FIELDS? See invariant (n) for why a
   * presentation bit lives in the machine at all. It gates the CONTROLS only — the card's summary
   * states the resolved scope and every facet's ON/OFF state in both positions, because "at the end
   * show which filters are ON and which are OFF" is the ratified promise and a click is not allowed
   * to stand in front of it.
   */
  narrowExpanded: boolean;
  /**
   * The REFRESH'S OWN IN-FLIGHT SIGNAL (S5) — the `retryNonce` of the request currently running, or
   * null when nothing is. See invariant (o) for why this is a nonce rather than a boolean, why it is
   * armed in one place and cleared in six, and why the three DERIVED progress signals structurally
   * cannot cover this case.
   *
   * Non-PHI: an integer. It never reaches the wire — `scopeKeyOf` does not read it, so like `area`
   * and `narrowExpanded` it is structurally unable to shape a request.
   */
  refreshingNonce: number | null;
  /**
   * THE AUTOMATIC WINDOW MOVED UNDER AN UNCHANGED REQUEST IDENTITY (S5), or null. Invariant (p) owns
   * the rule; the short version is that `scopeKeyOf` serializes the auto case as the literal `'auto'`
   * and not the chosen days, so this is the one scope change on this surface that no staleness flag
   * can see. Cleared on the next resolve, on a new refresh, and on every navigation.
   */
  windowMove: WindowMove | null;
}

export type ShellAction =
  | { type: 'search_submitted' }
  | { type: 'skipped' }
  | { type: 'plan_submitted' }
  | { type: 'went_back'; target: 'identify' | 'payer' | 'plan' }
  | { type: 'payer_picked'; payer: string }
  | { type: 'plan_filter_changed'; value: string }
  | { type: 'filter_toggled'; facet: 'funding' | 'employer'; value: string }
  | { type: 'filters_cleared' }
  | { type: 'retry_requested' }
  | { type: 'snapshot_requested' }
  | { type: 'snapshot_resolved'; snapshot: QualifySnapshot; scopeKey: string }
  | { type: 'snapshot_failed' }
  | { type: 'ai_armed' }
  | { type: 'ai_disarmed' }
  | { type: 'payer_override_changed'; label: string | null }
  | { type: 'window_days_changed'; days: QualifyTrailingDays | null }
  | { type: 'area_selected'; key: string }
  | { type: 'facility_narrow_toggled'; value: string }
  | { type: 'narrow_toggled' };

export const INITIAL_SHELL_STATE: ShellState = {
  payerPick: null,
  picked: false,
  skipped: false,
  filters: NO_ANSWER_FILTERS,
  planFilter: '',
  autoAsk: false,
  backTo: null,
  snapshot: null,
  snapshotError: null,
  retryNonce: 0,
  payerOverride: null,
  windowDays: null,
  loadedKey: null,
  area: AREA_ALL,
  facilityNarrow: NO_FACILITY_NARROW,
  narrowExpanded: false,
  refreshingNonce: null,
  windowMove: null,
};

/**
 * Restore `useState`'s bail-out. Keyed off `Object.keys(next)` rather than a hand-listed field set,
 * so adding a nineteenth field cannot silently make two different states compare equal.
 * ("Nineteenth" = one more than today's eighteen — the field-write table's header comment in
 * qualifyV3FlowState.test.tsx uses this same one-more-than-today rule, not by coincidence.)
 */
function bailIfUnchanged(prev: ShellState, next: ShellState): ShellState {
  for (const k of Object.keys(next) as (keyof ShellState)[]) {
    if (!Object.is(prev[k], next[k])) return next;
  }
  return prev;
}

/**
 * ── THE TWO GUARDS THAT STAND BETWEEN A PRESS AND THE MARKER (S5 fix round) ──────────────────────
 *
 * The refresh handler, as a factory over injected getters, so both guards are BEHAVIOUR a test can
 * call rather than lines a source scan has to recognise. That distinction is not academic: the scan
 * written for the empty-term guard asserted
 * `body.indexOf("termRef.current === ''") < body.indexOf('retry_requested')`, and `indexOf` returns
 * -1 for an absent needle — so DELETING the guard made it `-1 < positive`, i.e. TRUE. The mutation
 * ran a full green suite.
 *
 * ⚠ THE PHI STILL LIVES IN THE SHELL'S REF. This takes a GETTER and never stores what it reads,
 * which is what lets the guard leave its inline closure without leaving the discipline this module's
 * header sets: the term must not enter reducer state, and it does not — no action carries it, and
 * nothing here retains it past the call.
 *
 * ⚠ WHY THE REDUCER CANNOT HOLD EITHER GUARD. The empty-term one reads the PHI ref, which the
 * reducer is forbidden to touch. The busy one reads `isPending`, which belongs to `useActionState`
 * and is not machine state at all. Both are shell facts; this is the shell's smallest testable piece.
 *
 * `isBusy` — a refresh already in flight, or the resolve's server action pending. It refuses for the
 * reason the DOM's `disabled` attribute used to: every press writes one `SEARCH_QUALIFY_PHI` row,
 * because the core audits BEFORE any data. The attribute itself is gone (it drops keyboard focus to
 * `<body>` the moment it lands, and a disabled control's state change is not reliably announced);
 * the render layer carries `aria-disabled` and the REFUSAL lives here.
 *
 * `getTerm` — empty means nothing is held (a hot-reload mid-flow). A press there must dispatch
 * NOTHING: the fetch effect has the same early return, so a nonce dispatched here would arm
 * `refreshingNonce` with no request behind it and neither terminal dispatch would ever run. The card
 * would lock at "Refreshing the ranking…" permanently — the stuck-flag class, reached around the
 * reducer rather than through it.
 */
export function makeRetryHandler(deps: {
  getTerm: () => string;
  isBusy: () => boolean;
  dispatch: (action: ShellAction) => void;
}): () => void {
  return () => {
    if (deps.isBusy()) return;
    if (deps.getTerm() === '') return;
    deps.dispatch({ type: 'retry_requested' });
  };
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    // A new identify submit invalidates every downstream choice. retryNonce and loadedKey survive.
    case 'search_submitted':
      return bailIfUnchanged(state, {
        ...state,
        payerPick: null,
        picked: false,
        skipped: false,
        filters: NO_ANSWER_FILTERS,
        planFilter: '',
        autoAsk: false,
        backTo: null,
        snapshot: null,
        snapshotError: null,
        payerOverride: null,
        windowDays: null,
        area: AREA_ALL,
        facilityNarrow: NO_FACILITY_NARROW,
        narrowExpanded: false,
        // A navigation ABANDONS an in-flight refresh (invariant o) and any notice about a window
        // that moved under a screen the operator has since left (invariant p).
        refreshingNonce: null,
        windowMove: null,
      });

    // Straight to the answer over the whole footprint. Clears any half-made narrowing so the general
    // search is genuinely general — but KEEPS windowDays and autoAsk (invariant f).
    case 'skipped':
      return bailIfUnchanged(state, {
        ...state,
        skipped: true,
        picked: false,
        payerPick: null,
        planFilter: '',
        backTo: null,
        filters: NO_ANSWER_FILTERS,
        payerOverride: null,
        snapshot: null,
        snapshotError: null,
        area: AREA_ALL,
        facilityNarrow: NO_FACILITY_NARROW,
        // A skip has just made the search as WIDE as it goes, so narrowing is the next move — and
        // the skip reveal needs the fields present to have anything to stagger (invariant n).
        narrowExpanded: true,
        refreshingNonce: null,
        windowMove: null,
      });

    // A NEW plan is a new population — a genuine first load, so the snapshot blanks to the skeleton
    // (unlike a re-scope, which keeps stale content dimmed).
    case 'plan_submitted':
      return bailIfUnchanged(state, {
        ...state,
        picked: true,
        skipped: false, // choosing a plan supersedes a prior skip
        filters: NO_ANSWER_FILTERS,
        backTo: null,
        snapshot: null,
        snapshotError: null,
        area: AREA_ALL,
        facilityNarrow: NO_FACILITY_NARROW,
        narrowExpanded: false,
        refreshingNonce: null,
        windowMove: null,
      });

    // Going back CLEARS what was decided at and after that stage — a kept-but-hidden choice is how
    // one client's ranking ends up scoped to another's payer.
    case 'went_back':
      return bailIfUnchanged(state, {
        ...state,
        snapshot: null,
        snapshotError: null,
        autoAsk: false,
        payerOverride: null,
        windowDays: null,
        picked: false,
        skipped: false, // stepping back into the funnel un-skips it
        filters: NO_ANSWER_FILTERS,
        payerPick: action.target !== 'plan' ? null : state.payerPick,
        planFilter: '',
        backTo: action.target,
        area: AREA_ALL,
        facilityNarrow: NO_FACILITY_NARROW,
        narrowExpanded: false,
        refreshingNonce: null,
        windowMove: null,
      });

    case 'payer_picked':
      return bailIfUnchanged(state, { ...state, payerPick: action.payer, backTo: null });

    case 'plan_filter_changed':
      return bailIfUnchanged(state, { ...state, planFilter: action.value });

    case 'filter_toggled': {
      // Exhaustive over the union above — the removed 'planType' arm used to sit in front of this
      // ternary, and the union is what stops a future third facet from silently landing in
      // `employers` instead of failing to compile.
      const key = action.facet === 'funding' ? 'funding' : 'employers';
      const cur = state.filters[key];
      const next = cur.includes(action.value)
        ? cur.filter((v) => v !== action.value)
        : [...cur, action.value];
      return bailIfUnchanged(state, { ...state, filters: { ...state.filters, [key]: next } });
    }

    // "Clear filters" is one button over one control surface, so it clears BOTH grid narrows too — a
    // narrow that outlived the button that claims to clear it is the kept-but-hidden choice this
    // machine exists to prevent.
    case 'filters_cleared':
      return bailIfUnchanged(state, {
        ...state,
        filters: NO_ANSWER_FILTERS,
        area: AREA_ALL,
        facilityNarrow: NO_FACILITY_NARROW,
      });

    /* The ONLY write to retryNonce in the whole machine, and it only ever goes up (invariant c).
     *
     * S5 PROMOTED THIS FROM FAILURE RECOVERY TO A STANDING CONTROL, and it needed no new refetch
     * path to do it: this is already the one case that bypasses `bailIfUnchanged` and returns a
     * fresh object unconditionally, so it moves the fetch effect's dependency array with no error
     * present and no input changed. What it gained is the in-flight MARKER (invariant o) — armed
     * here and nowhere else, carrying the nonce it just minted — and a clear of any window-move
     * notice from the PREVIOUS refresh, because a sentence about a window that moved a minute ago
     * must not stand over the request replacing it.
     *
     * The NON-writes are what make the promotion safe: nothing here touches payerPick / picked /
     * skipped / backTo / filters, so a refresh cannot re-enter `resolveCoverageAction` — which
     * would write sixteen fields and drop the operator back to the payer stage. */
    case 'retry_requested': {
      const nonce = state.retryNonce + 1;
      return { ...state, snapshotError: null, retryNonce: nonce, refreshingNonce: nonce, windowMove: null };
    }

    case 'snapshot_requested':
      return bailIfUnchanged(state, { ...state, snapshotError: null });

    /* The scope key rides in the payload because the reducer cannot see the effect's render scope.
     *
     * A TERMINAL DISPATCH, so it disarms the refresh marker (invariant o) — and it is the SOLE
     * writer of `windowMove` (invariant p), set-or-clear on every resolve.
     *
     * ⚠ THE `bailIfUnchanged` GUARD STILL APPLIES, AND THAT IS SAFE ONLY BECAUSE THE MARKER IS PART
     * OF THE COMPARISON. An hourly pipeline usually returns byte-identical data, so the refresh
     * whose result changes NOTHING is the refresh most likely to happen — and a bail there would
     * leave the marker armed with no request behind it, i.e. the stuck flag arrived at through the
     * guard rather than through a handler. Because `refreshingNonce` moves from a number to null on
     * exactly that path, the guard sees a change and returns the new object. */
    case 'snapshot_resolved': {
      /* BOTH SIDES COERCED WITH `?? null` — `undefined !== null` would read "no ladder before, no
       * ladder after" as a window move, which is every manual-window resolve. */
      const from = state.snapshot?.ladder?.chosenDays ?? null;
      const to = action.snapshot.ladder?.chosenDays ?? null;
      /* ⚠ TWO CONDITIONS, AND THE SECOND USED TO BE INCIDENTAL (S5 fix round, M1). "Same request
       * identity" is necessary but not sufficient: `scopeKeyOf` carries NO identifier at all, so a
       * NEW member's first resolve can serialize identically to the previous member's (same payer
       * label, same auto window, no filters). The old rule was safe only because the four
       * navigations null the snapshot, which made `from` null — i.e. a guarantee held by a
       * NEIGHBOURING field's behaviour rather than by this arm. The reducer already holds the marker
       * that answers "was this a refresh" directly, so it asks it directly. */
      const sameScope = state.loadedKey !== null && state.loadedKey === action.scopeKey;
      const wasRefresh = state.refreshingNonce !== null;
      return bailIfUnchanged(state, {
        ...state,
        snapshot: action.snapshot,
        loadedKey: action.scopeKey,
        refreshingNonce: null,
        windowMove: wasRefresh && sameScope && from !== null && to !== null && from !== to ? { from, to } : null,
      });
    }

    // KEEP the last-known-good snapshot, and do NOT stamp loadedKey (invariants d, e). The SECOND
    // terminal dispatch, so it disarms the refresh marker too: a signal cleared by one of a fetch's
    // two outcomes is a stuck flag by construction (invariant o).
    case 'snapshot_failed':
      return bailIfUnchanged(state, { ...state, snapshotError: 'failed', refreshingNonce: null });

    case 'ai_armed':
      return bailIfUnchanged(state, { ...state, autoAsk: true });

    case 'ai_disarmed':
      return bailIfUnchanged(state, { ...state, autoAsk: false });

    // Re-scopes are REFETCHES of content already on screen: they touch their own field and nothing
    // else — never the snapshot (invariant j).
    case 'payer_override_changed':
      return bailIfUnchanged(state, { ...state, payerOverride: action.label });

    case 'window_days_changed':
      return bailIfUnchanged(state, { ...state, windowDays: action.days });

    // A GRID narrow, not a re-scope: it writes one field that nothing in `scopeKeyOf` reads, so the
    // fetch effect cannot see it and no request is issued (invariant m).
    case 'area_selected':
      return bailIfUnchanged(state, { ...state, area: action.key });

    // The SECOND grid narrow, under the same law (invariant m). MULTI-select and its own inverse, so
    // the shared picker's `Clear N` walks the selection back through this one action — a second
    // "clear the facilities" action would be a second writer of the field, which is the shape
    // `scopeKeyOf`'s header is a post-mortem of.
    //
    // ⚠ EMPTIES TO THE SHARED CONSTANT, not to a fresh `[]`. Identity is load-bearing for the memo
    // chain the narrow feeds, and toggling the last chip off is exactly when a fresh-but-equal array
    // would silently start invalidating it on every render.
    case 'facility_narrow_toggled': {
      const cur = state.facilityNarrow;
      const next = cur.includes(action.value)
        ? cur.filter((v) => v !== action.value)
        : [...cur, action.value];
      return bailIfUnchanged(state, {
        ...state,
        facilityNarrow: next.length === 0 ? NO_FACILITY_NARROW : next,
      });
    }

    // A DISCLOSURE, not a re-scope: it writes the one presentation bit and nothing `scopeKeyOf`
    // reads, so no request can follow from opening or closing the card (invariant n).
    case 'narrow_toggled':
      return bailIfUnchanged(state, { ...state, narrowExpanded: !state.narrowExpanded });

    default:
      return state;
  }
}
