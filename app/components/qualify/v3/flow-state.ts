/**
 * Qualify v3 — THE SHELL'S STATE MACHINE. Fourteen fields, seventeen actions, one place each field
 * is written.
 *
 * Extracted from `resolution-flow-client.tsx` (F3b). The shell was carrying FIFTEEN `useState` hooks
 * — the fourteen fields below, plus `trends`, which stays behind (see WHAT IS DELIBERATELY NOT IN
 * HERE) — bound at 58 setter sites: 56 direct calls, of which 2 are `setTrends`, plus 2 raw setters
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
 *   devtools; PHI must never enter it. The guards that READ the ref (retry's empty-term check, the
 *   effect's early return) therefore stay in the shell's handler wrappers, not in a reducer case.
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
 *  1 · search_submitted        — a new identify submit. WRITES TWELVE:
 *                                payerPick=null, picked=false, skipped=false,
 *                                filters=NO_ANSWER_FILTERS, employerQuery='', planFilter='',
 *                                autoAsk=false, backTo=null, snapshot=null, snapshotError=null,
 *                                payerOverride=null, windowDays=null.
 *                                KEEPS retryNonce, loadedKey.
 *  2 · skipped                 — "skip the questions, answer over the whole footprint". WRITES TEN:
 *                                skipped=true, picked=false, payerPick=null, planFilter='',
 *                                backTo=null, filters=NO_ANSWER_FILTERS, employerQuery='',
 *                                payerOverride=null, snapshot=null, snapshotError=null.
 *                                KEEPS windowDays, autoAsk, retryNonce, loadedKey (see invariant f).
 *  3 · plan_submitted          — a plan pick. WRITES SEVEN:
 *                                picked=true, skipped=false, filters=NO_ANSWER_FILTERS,
 *                                employerQuery='', backTo=null, snapshot=null, snapshotError=null.
 *                                KEEPS payerPick, planFilter, payerOverride, windowDays, autoAsk,
 *                                retryNonce, loadedKey (see invariant g).
 *  4 · went_back {target}      — a receipt "Change". WRITES TWELVE:
 *                                snapshot=null, snapshotError=null, autoAsk=false,
 *                                payerOverride=null, windowDays=null, picked=false, skipped=false,
 *                                filters=NO_ANSWER_FILTERS, employerQuery='', planFilter='',
 *                                backTo=target, and payerPick=null ONLY when target !== 'plan'
 *                                (the machine's one conditional write — invariant h).
 *                                KEEPS retryNonce, loadedKey.
 *  5 · payer_picked {payer}    — WRITES payerPick=payer, backTo=null.
 *  6 · plan_filter_changed {value}     — WRITES planFilter=value.
 *  7 · employer_query_changed {value}  — WRITES employerQuery=value.
 *  8 · filter_toggled {facet,value}    — WRITES filters (add/remove `value` in the facet's array;
 *                                        facet 'planType'→planTypes, 'funding'→funding,
 *                                        'employer'→employers).
 *  9 · filters_cleared         — WRITES filters=NO_ANSWER_FILTERS, employerQuery=''.
 * 10 · retry_requested         — WRITES snapshotError=null, retryNonce=prev+1. NOTHING ELSE, ever.
 * 11 · snapshot_requested      — WRITES snapshotError=null. Dispatched at the top of the fetch
 *                                effect so `refetching` can only claim progress while a request is
 *                                genuinely in flight (invariant k).
 * 12 · snapshot_resolved {snapshot, scopeKey}
 *                              — WRITES snapshot=action.snapshot, loadedKey=action.scopeKey.
 *                                THE SCOPE KEY RIDES IN THE PAYLOAD: the old `setLoadedKey(scopeKey)`
 *                                closed over a value computed in render scope, which a reducer
 *                                cannot see. The effect already captures the right one; it passes it.
 * 13 · snapshot_failed         — WRITES snapshotError='failed'. AND NOTHING ELSE (invariant e).
 * 14 · ai_armed                — WRITES autoAsk=true.
 * 15 · ai_disarmed             — WRITES autoAsk=false.
 * 16 · payer_override_changed {label} — WRITES payerOverride=label.
 * 17 · window_days_changed {days}     — WRITES windowDays=days.
 *
 * EIGHTEEN SWITCH ARMS, SEVENTEEN ACTIONS. The eighteenth is `default: return state` — an arm the
 * `ShellAction` union makes unreachable through the type system, kept because the type system is not
 * the only caller: a hot-reloaded action queued against a newer reducer, or a hand-written dispatch
 * in a future test, would otherwise fall off the end and return `undefined` as the whole state. It
 * returns the SAME object, so a stray dispatch cannot even cost a render. Pinned by a test that
 * dispatches a bogus type through a cast. It matches the `windowReducer` precedent
 * (app/lib/qualify/resolution.ts:417).
 *
 * ── INVARIANTS (each one is pinned by a test in app/test/qualifyV3FlowState.test.tsx) ────────────
 * a · A NEW SEARCH CLEARS EVERYTHING DOWNSTREAM. `search_submitted` from ANY prior state lands on
 *     the same twelve values above — a kept-but-hidden choice is how one client's ranking ends up
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
 * e · A FAILED FETCH KEEPS THE SNAPSHOT (F2). `snapshot_failed` writes `snapshotError` alone. The
 *     last-known-good answer was valid a moment ago and is no less valid because a re-scope failed.
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
import { NO_ANSWER_FILTERS, type AnswerFilters, type FlowStage } from './resolution-flow';

/** The fourteen fields the staged flow moves between screens. No PHI: the term lives in a ref. */
export interface ShellState {
  /** The carrier the user picked on stage 2, in VOB vocabulary. */
  payerPick: string | null;
  /** A plan was chosen on stage 3. */
  picked: boolean;
  /** The user's own escape hatch: answer over the WHOLE footprint. Declining to choose is a
   *  different claim from choosing, and the answer stage says which. */
  skipped: boolean;
  filters: AnswerFilters;
  employerQuery: string;
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
}

export type ShellAction =
  | { type: 'search_submitted' }
  | { type: 'skipped' }
  | { type: 'plan_submitted' }
  | { type: 'went_back'; target: 'identify' | 'payer' | 'plan' }
  | { type: 'payer_picked'; payer: string }
  | { type: 'plan_filter_changed'; value: string }
  | { type: 'employer_query_changed'; value: string }
  | { type: 'filter_toggled'; facet: 'planType' | 'funding' | 'employer'; value: string }
  | { type: 'filters_cleared' }
  | { type: 'retry_requested' }
  | { type: 'snapshot_requested' }
  | { type: 'snapshot_resolved'; snapshot: QualifySnapshot; scopeKey: string }
  | { type: 'snapshot_failed' }
  | { type: 'ai_armed' }
  | { type: 'ai_disarmed' }
  | { type: 'payer_override_changed'; label: string | null }
  | { type: 'window_days_changed'; days: QualifyTrailingDays | null };

export const INITIAL_SHELL_STATE: ShellState = {
  payerPick: null,
  picked: false,
  skipped: false,
  filters: NO_ANSWER_FILTERS,
  employerQuery: '',
  planFilter: '',
  autoAsk: false,
  backTo: null,
  snapshot: null,
  snapshotError: null,
  retryNonce: 0,
  payerOverride: null,
  windowDays: null,
  loadedKey: null,
};

/**
 * Restore `useState`'s bail-out. Keyed off `Object.keys(next)` rather than a hand-listed field set,
 * so adding a fifteenth field cannot silently make two different states compare equal.
 */
function bailIfUnchanged(prev: ShellState, next: ShellState): ShellState {
  for (const k of Object.keys(next) as (keyof ShellState)[]) {
    if (!Object.is(prev[k], next[k])) return next;
  }
  return prev;
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
        employerQuery: '',
        planFilter: '',
        autoAsk: false,
        backTo: null,
        snapshot: null,
        snapshotError: null,
        payerOverride: null,
        windowDays: null,
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
        employerQuery: '',
        payerOverride: null,
        snapshot: null,
        snapshotError: null,
      });

    // A NEW plan is a new population — a genuine first load, so the snapshot blanks to the skeleton
    // (unlike a re-scope, which keeps stale content dimmed).
    case 'plan_submitted':
      return bailIfUnchanged(state, {
        ...state,
        picked: true,
        skipped: false, // choosing a plan supersedes a prior skip
        filters: NO_ANSWER_FILTERS,
        employerQuery: '',
        backTo: null,
        snapshot: null,
        snapshotError: null,
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
        employerQuery: '',
        payerPick: action.target !== 'plan' ? null : state.payerPick,
        planFilter: '',
        backTo: action.target,
      });

    case 'payer_picked':
      return bailIfUnchanged(state, { ...state, payerPick: action.payer, backTo: null });

    case 'plan_filter_changed':
      return bailIfUnchanged(state, { ...state, planFilter: action.value });

    case 'employer_query_changed':
      return bailIfUnchanged(state, { ...state, employerQuery: action.value });

    case 'filter_toggled': {
      const key =
        action.facet === 'planType' ? 'planTypes' : action.facet === 'funding' ? 'funding' : 'employers';
      const cur = state.filters[key];
      const next = cur.includes(action.value)
        ? cur.filter((v) => v !== action.value)
        : [...cur, action.value];
      return bailIfUnchanged(state, { ...state, filters: { ...state.filters, [key]: next } });
    }

    case 'filters_cleared':
      return bailIfUnchanged(state, { ...state, filters: NO_ANSWER_FILTERS, employerQuery: '' });

    // The ONLY write to retryNonce in the whole machine, and it only ever goes up (invariant c).
    case 'retry_requested':
      return { ...state, snapshotError: null, retryNonce: state.retryNonce + 1 };

    case 'snapshot_requested':
      return bailIfUnchanged(state, { ...state, snapshotError: null });

    // The scope key rides in the payload because the reducer cannot see the effect's render scope.
    case 'snapshot_resolved':
      return bailIfUnchanged(state, { ...state, snapshot: action.snapshot, loadedKey: action.scopeKey });

    // KEEP the last-known-good snapshot, and do NOT stamp loadedKey (invariants d, e).
    case 'snapshot_failed':
      return bailIfUnchanged(state, { ...state, snapshotError: 'failed' });

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

    default:
      return state;
  }
}
