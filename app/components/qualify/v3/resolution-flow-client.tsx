'use client';

/**
 * Client shell for the staged v3 flow — owns the state, the motion, and the PHI discipline.
 *
 * ── WHERE THE TYPED IDENTIFIER LIVES ────────────────────────────────────────────────────────────
 * In `termRef` — JS memory only (the IdentityForm discipline). It is captured from the identify
 * form's FormData at dispatch and INJECTED into every later submission the same way, so it is never
 * rendered into the DOM as a hidden field, never in a URL, never persisted. What renders is
 * `handle.echo`, prefix-safe by construction ('' for a full member id). This is also what lets a
 * full-member-id search survive the plan-pick round trip: the earlier S1/S2 forms round-tripped the
 * EMPTY echo as the term, which re-resolved a full-id search as 'empty' — carrying the term in the
 * ref instead of the DOM fixes that without ever writing the id anywhere readable.
 *
 * ── STAGE MACHINE ───────────────────────────────────────────────────────────────────────────────
 * `deriveStage` is pure (resolution × payerPick × picked). The shell adds one escape hatch —
 * `backTo`, set by the receipt's Change buttons — and clears client choices when the user goes
 * back, so a stale carrier pick can never scope a new plan pick (the payer-override stale-read
 * class of bug, PR #124's lesson, applied here by construction).
 *
 * ── WHERE THE STATE RULES LIVE ──────────────────────────────────────────────────────────────────
 * In `./flow-state.ts` — `shellReducer`, sixteen fields, nineteen actions, with the full
 * per-action field-write table and the lettered invariants (a–m) in its header. READ THAT FIRST
 * before changing any handler here. What is left in this file is deliberately only the three things
 * a reducer cannot hold: the PHI ref, the effects, and the values derived per render (`stage`,
 * `scopeKey`, `stale`/`refetching`/`staleAfterError` — never stored, see the stuck-flag note below).
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────────────────────────
 * GSAP, the requested idiom: the incoming stage slides up 14px/220ms ease-out; tiles stagger
 * min(index,3)×60ms (capped — a 186-plan list must not cascade forever). One easing. Disabled
 * entirely under prefers-reduced-motion. Motion narrates progression; it never gates input.
 *
 * THREE SURFACES SPEAK IT, and only three: the stage subtree (14px), the scorecard/plan tiles
 * (6-10px, scroll-batched), and — added 2026-08-07 for the Skip — the answer stage's FACET INVENTORY
 * (6px, staggered on arrival). Same duration, same ease, same stagger function. The inventory is the
 * one that animates plain OPACITY instead of `autoAlpha`, because its rows are live controls and
 * `visibility: hidden` would make them unclickable for the length of the stagger — see the effect.
 */
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { resolveCoverageAction } from '../../../lib/qualify/v3-actions';
// V3_INITIAL_STATE comes from a PLAIN module, never the 'use server' one: a non-function export
// there is registered as a Server Action and 500s every action on the page (see v3FlowState.ts).
import { V3_INITIAL_STATE } from '../../../lib/qualify/v3FlowState';
import {
  getQualifyFacilityTrends,
  getQualifySnapshot,
  loadQualifyDataFreshness,
  loadQualifyFacilityOptions,
} from '../../../lib/qualify/actions';
import type { QualifyFacilityTrend, QualifyTrailingDays } from '../../../lib/qualify/contract';
import type { QualifyFacilityNarrowOption } from '../../../lib/qualify/facilityVariants';
import { QualifyAiPanel } from '../qualify-ai-panel';
import { bookPlacementFor } from '../../../lib/qualify/bookPlacement';
import { HeatingUpCards, HeatingUpSkeleton } from '../shared/heating-ticker';
import { TickerExplainer } from '../ticker-explainer';
import { buildTrendAiInput } from '../../../lib/qualify/tickerAiPayload';
import { staggerDelayMs } from '../tokens';
import { AREA_ALL, areaKeyFor } from '../m/area-chips';
import {
  answerFiltersActive,
  deriveStage,
  employerNarrowFor,
  filterCandidates,
  isRefetching,
  orderedCandidates,
  payerGroupsOf,
  soleAnswerableCarrier,
  ResolutionStages,
  scopeKeyOf,
  scopeSourceOf,
  tickerIsLive,
  type FlowStage,
} from './resolution-flow';
// The flow's sixteen fields and the rules that move them. Its header is the spec; this file is the
// transport (PHI ref, effects, derivations) wired to it.
import { INITIAL_SHELL_STATE, makeRetryHandler, shellReducer } from './flow-state';
// ── The Smoke two-pane shell (2026-08-10) ────────────────────────────────────────────────────────
// The rail + board composition around the SAME machinery above. Everything is reused: the rail
// hosts ResolutionStages (answerInline=false), the board hosts StageAnswer with the SAME answer
// bag, so the two panes cannot disagree — one derivation, two render sites.
import { StageAnswer } from './resolution-flow';
import { LaneRail } from '../shell/lane-rail';
import { QualifyComposer } from '../shell/composer';
import { ThisSearchZone } from '../shell/board-zone';
import { WatchersPanel } from '../shell/watchers-panel';
import { RecentSearches } from '../shell/recent-searches';
// The shell's own pure derivations — each one a defect the review confirmed in THIS file's wiring,
// moved somewhere a hermetic test can call it. Read that module's headers before changing any of the
// four call sites below; the reasoning is the fix, not the one-liner.
import {
  deriveBoardStatus,
  deriveWatcherDeleteAction,
  laneIsOpen,
  recentSearchKeyOf,
  revealScopeFor,
  type QualifyWatcherSaveFailure,
} from '../shell/shell-session';
// ⚠ THE ONE MASK. This shell derived its own `${slice(0,3)} •••• ${slice(-4)}` echo with a `<5`
// length guard — byte-for-byte the defect adversarial review had already found and fixed inside
// `maskedPatientEcho`: below eight characters the prefix and the tail OVERLAP, so an 8-char id like
// `ABC12345` rendered `ABC •••• 2345` — seven of eight characters, in order, into the DOM. The
// server refuses that shape (it returns tail-only), so the two paths disagreed about what a mask is.
// `qualifyWatchers.ts` claims to be "the ONLY implementation of the format, so … exactly one place to
// audit"; importing it is what makes that claim true. It is pure, dependency-free and already in this
// bundle via watcher-actions.ts. NEVER re-derive a mask here — the refusal is its `null`, not a
// length literal.
import { maskedPatientEcho } from '../../../../src/collections/qualifyWatchers';
import { PolicyTapeMount } from '../policy-tape-mount';
import type { QualifyAiChipId } from '../../../lib/qualify/aiChips';
import type { QualifyChipSlots } from '../../../lib/qualify/chipTemplates';
// The one shape of a composer ask, shared with the panel that consumes it — see externalAsk.ts.
import type { QualifyExternalAsk } from '../../../lib/qualify/externalAsk';
import {
  clearQualifyRecentSearches,
  deleteQualifyWatcher,
  getQualifyWatchboard,
  recordQualifyRecentSearch,
  saveQualifyPatientWatcher,
  saveQualifyTrendWatcher,
} from '../../../lib/qualify/watcher-actions';
import {
  QUALIFY_WATCHER_DEFAULT_THRESHOLD,
  type QualifyPatientWatcher,
  type QualifyRecentSearch,
  type QualifyTrendWatcher,
  type QualifyWatchboardResult,
} from '../../../lib/qualify/watchers';

// ScrollTrigger ships inside the gsap package — no new dependency. Client components also render on
// the server once, so guard the registration behind a window check.
if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
}

/**
 * The momentum strip's own window. **90 DAYS since 2026-08-09** (was 60), for two reasons that point
 * the same way:
 *
 *  · CONSISTENCY — the policy tape directly above it reports a 90-day rating change (Alec's 2026-08-08
 *    ruling, `QUALIFY_RATING_HISTORY_WINDOW_DAYS`). Two strips stacked on one screen reporting
 *    "movement" over different horizons invites exactly the comparison neither one supports.
 *  · SAMPLE — `payment_received` lags service, so the median claim in this book is ~150 days old
 *    (measured). A 30-day window sees ~10-12% of the evidence and a 90-day one ~30%, which is the
 *    difference between a delta that moves on one reversal and one that moves on a trend.
 *
 * Coverage was NOT the tiebreaker and should not be cited as one: 30/60/90 clear the sample gates for
 * 40/42/39 facilities respectively (measured 2026-08-09) — near-identical. The argument is horizon
 * agreement and evidence depth, not how many cards appear.
 */
const TICKER_WINDOW = { kind: 'trailing', days: 90 } as const;

/** Stable empty reference for "no ticker card is pressed" — a fresh Set would defeat the strip's memo. */
const NO_TICKER_KEYS: ReadonlySet<string> = new Set();

export function ResolutionFlowClient({
  viewerHasAmountsCapability,
  shellMode = false,
}: {
  viewerHasAmountsCapability: boolean;
  /** The Smoke two-pane shell (rail + board). Server-decided (qualifySmokeShellEnabled) and stable
   *  for the life of the mount — page.tsx passes it once; it never changes at runtime. */
  shellMode?: boolean;
}): React.ReactElement {
  const [state, formAction, isPending] = useActionState(resolveCoverageAction, V3_INITIAL_STATE);

  // The raw term — JS memory only. See the header block before moving this anywhere.
  const termRef = useRef<string>('');

  /** ── THE SESSION'S OWN COUNT OF SEARCHES ───────────────────────────────────────────────────────
   *  Bumped once per identify dispatch, and the ONLY thing on this surface that distinguishes two
   *  members: `predicateId`, `scopeKey` and `handle.echo` all provably collide across them, and the
   *  raw term may not be used as a key at all. `recentSearchKeyOf` owns the full argument. An integer
   *  — never PHI, never on the wire, never rendered. Declared here beside `termRef` because
   *  `identifyAction` (below) is the one writer and lives above the shell's own state block. */
  const searchSeqRef = useRef(0);

  /** ── "START OVER" HAPPENED AND `useActionState` CANNOT BE TOLD ─────────────────────────────────
   *  `state.resolution` is owned by the server action; only a new dispatch replaces it, so the reset
   *  leaves it non-null and the rail went on saying "Locked to GGS" over an emptied board. This is
   *  the session's own bit, armed by the reset and disarmed by the next identify submit; what the
   *  rail renders is DERIVED from it and `state.resolution` together (`laneIsOpen`), never stored as
   *  a third "hasResolution" flag — the stuck-flag rule this file's header sets.
   *
   *  DISARMED AT SUBMIT, NOT AT THE NEXT RESOLUTION, and that is a choice rather than an oversight.
   *  Between a submit and the action returning, `useActionState` still holds the PREVIOUS resolution,
   *  so the whole rail shows the previous lane for that second — `deriveStage` puts the stage back on
   *  'payer' over the old carriers, which is pre-existing v3 behaviour on EVERY search, reset or not.
   *  Holding this armed until a new resolution landed would make the strip alone say "No lane yet"
   *  while the stage beside it listed the old lane's carriers, which is exactly the two-panes-
   *  disagreeing failure the shell's one-derivation discipline exists to prevent. The residual is
   *  named here so it is weighed rather than rediscovered; fixing it means fixing the stage too.
   *
   *  INERT IN SINGLE-COLUMN MODE: nothing outside the shell branch reads it, and its only non-shell
   *  writer (`identifyAction`) writes `false` over `false`, which React's `useState` bail-out drops
   *  without scheduling a render. */
  const [sessionCleared, setSessionCleared] = useState(false);

  // ONE state machine, not sixteen useState hooks. Destructured so every read site below is the
  // same identifier it always was. Notable fields, restated here because they are easy to misuse:
  //   · retryNonce — monotonic, NEVER reset. It is the only way to re-fire a request whose inputs
  //     did not change: the snapshot effect keys on `scopeKey`, which is by construction identical
  //     on a retry, so without it "try again" is a no-op and a failed answer stage stays dead.
  //   · loadedKey — what scope the RENDERED snapshot describes; stamped only on success. A re-scope
  //     keeps content on screen, dimmed, with a progress bar — never blanked; skeletons are for the
  //     genuine first load (snapshot null). `refetching` is DERIVED from this against the requested
  //     scope key — never an independently-set flag (see scopeKeyOf for the stuck-flag bug).
  //   · skipped — the user's own escape hatch: jump to the answer over the WHOLE footprint.
  //     Distinct from `picked`; declining to choose is a different claim from choosing.
  const [flow, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE);
  const {
    payerPick,
    picked,
    skipped,
    filters,
    planFilter,
    autoAsk,
    backTo,
    snapshot,
    snapshotError,
    retryNonce,
    payerOverride,
    windowDays,
    loadedKey,
    area,
    facilityNarrow,
    narrowExpanded,
    refreshingNonce,
    windowMove,
  } = flow;

  /* ── THE REFRESH'S OWN IN-FLIGHT SIGNAL (S5) ───────────────────────────────────────────────────
   * DERIVED, like the three below it, and for the same reason — but from a field the reducer arms
   * on the press itself (`retry_requested`) and clears at BOTH terminal dispatches, because the three
   * below structurally cannot see this case. `stale`/`refetching`/`staleAfterError` all hang off
   * `loadedKey !== scopeKey`, which a SAME-SCOPE refresh cannot move; `showSkeleton` needs a null
   * snapshot; `isPending` belongs to the server action, which a refresh does not re-run. So without
   * this the screen does not move for the 1-2s the request takes and the operator presses again.
   * See flow-state.ts invariant (o) for the one-arm / six-clear discipline that keeps it unstuck. */
  const refreshing = refreshingNonce !== null;

  // NOT in the reducer, deliberately: the ticker is a mount-once fetch that no flow field and no
  // handler touches. `null` = still loading (renders the skeleton, which reserves the strip's
  // height so a 2.5-5s trend query cannot shove the search box down the page); [] = loaded empty.
  const [trends, setTrends] = useState<QualifyFacilityTrend[] | null>(null);

  // ── The FACILITY narrow's VOCABULARY (S4) ─────────────────────────────────────────────────────
  // NOT in the reducer either, and for the same `trends` reason: it is a mount-once fetch that no
  // flow field and no handler touches. `[]` is both the pre-load and the failed-load state, and it
  // renders NO control rather than an empty picker — the answer stage's other honest silence.
  //
  // ⚠ IT IS ITS OWN REQUEST, NEVER PART OF THE SNAPSHOT ONE. Folding a near-static, `unstable_cache`d,
  // tenant-scoped, non-PHI vocabulary into the ranking request would re-fetch it on every window chip
  // and every billed-under press, and — worse — would put a facility list inside the payload the
  // narrow must never reach (invariant m).
  const [facilityOptions, setFacilityOptions] = useState<QualifyFacilityNarrowOption[]>([]);

  // ── WHEN THE RANKING INDEX WAS LAST REBUILT (S5) ──────────────────────────────────────────────
  // NOT in the reducer, for the `trends` reason exactly: no flow field and no handler touches it,
  // and folding an orthogonal operational fact into a state machine only makes the machine harder
  // to read. `null` is both the pre-load and the failed-load state, and it renders as "freshness
  // unknown" rather than as a number nothing can stand behind.
  const [dataRebuiltAt, setDataRebuiltAt] = useState<string | null>(null);

  // ONE clustering pass per resolution (clusterCarriers is O(n²)); the rail, receipt and both tile
  // stages read this instead of each re-deriving it — scroll-driven work on top of 4-5 re-derives
  // per render was going to surface as employer-filter input lag.
  const payerGroups = useMemo(
    () => (state.resolution !== null ? payerGroupsOf(state.resolution) : []),
    [state.resolution],
  );

  /* ── THE AUTO-RESOLVED CARRIER (Design A, ratified 2026-08-11) ──────────────────────────────────
   * When exactly ONE cluster behind the token could answer the carrier question, `deriveStage` does
   * not ask it — and this is the value that makes that resolution real everywhere downstream instead
   * of merely skipping a screen.
   *
   * ⚠ IT IS A DERIVATION, NOT A DISPATCH, AND THAT IS THE WHOLE DESIGN. The obvious shortcut is an
   * effect that fires `payer_picked` when one answerable cluster exists. It is wrong for a reason this
   * flow has already paid for twice: the reducer's `payerPick` means "the OPERATOR chose this carrier",
   * and every surface that reads it — the lane checklist's `done`, the receipt's decision entry,
   * `scopeSourceOf`'s 'user' vs 'pick' vs 'dominant' — is entitled to believe that. Writing a machine
   * ruling into that field makes the two indistinguishable, which is precisely the collapse
   * `ScopeSource` documents at length. It would also put a navigation rule outside the machine that
   * owns every other one (see the `onToggleNarrow` note above).
   *
   * So `payerPick` STAYS NULL through an auto-resolve, and the composition happens at the read sites:
   * `effectivePick` is what the SCREEN is scoped to, `payerPick` is what the OPERATOR decided, and
   * `carrierAutoResolved` is the one bit that says which of the two `effectivePick` came from. That
   * bit cannot be recovered downstream from the label alone — an operator may legitimately pick the
   * only answerable carrier by hand, and that is a different claim from the machine resolving to it —
   * which is why it travels as its own prop rather than being re-derived per surface. */
  const soleAnswerable = useMemo(() => soleAnswerableCarrier(payerGroups), [payerGroups]);
  const reopeningPayer = backTo === 'payer';
  const carrierAutoResolved =
    !reopeningPayer && payerPick === null && !skipped && payerGroups.length > 1 && soleAnswerable !== null;
  const effectivePick = reopeningPayer
    ? null
    : payerPick ?? (carrierAutoResolved ? (soleAnswerable?.payer ?? null) : null);

  /** A new identify submit invalidates every downstream choice — clear them BEFORE dispatching to
   *  the server action. Capturing the term into the ref is the ONLY thing that happens outside the
   *  reducer here, and it happens outside because the term is PHI (see the header). */
  const identifyAction = useCallback(
    (fd: FormData) => {
      const term = fd.get('term');
      termRef.current = typeof term === 'string' ? term : '';
      // A NEW SEARCH IS A NEW SESSION IDENTITY, and both of these say so — one for the history
      // dedupe (two members are two sequence numbers however identically they hash), one for the
      // rail's lock strip (a submit re-opens a lane a reset closed). Both are inert in single-column
      // mode: nothing there reads either, and the setState is a no-op write of `false` over `false`.
      searchSeqRef.current += 1;
      setSessionCleared(false);
      // The third of the same kind: a "watcher not saved" notice belongs to the search that failed
      // to save, not to the one being typed now. Same inertness argument — null over null.
      setWatcherSaveFailed(null);
      dispatch({ type: 'search_submitted' });
      formAction(fd);
    },
    [formAction],
  );

  /** Skip the remaining questions: straight to the answer over the whole footprint. Clears any
   *  half-made narrowing so the general search is genuinely general. */
  const onSkip = useCallback(() => {
    dispatch({ type: 'skipped' });
  }, []);

  const onToggleFilter = useCallback((facet: 'funding' | 'employer', value: string) => {
    dispatch({ type: 'filter_toggled', facet, value });
  }, []);

  const onClearFilters = useCallback(() => {
    dispatch({ type: 'filters_cleared' });
  }, []);

  /** The AREA facet — the restored location narrow. Grid-only by construction: it writes one reducer
   *  field that `scopeKeyOf` does not read, so the fetch effect below cannot observe it and no
   *  snapshot request is issued (flow-state.ts invariant m). */
  const onSelectArea = useCallback((key: string) => {
    dispatch({ type: 'area_selected', key });
  }, []);

  /** The FACILITY facet (S4) — the restored v2 type-ahead. Grid-only by exactly the same construction
   *  as the area above: it writes one reducer field that `scopeKeyOf` does not read, so the fetch
   *  effect below cannot observe it and no snapshot request is issued (flow-state.ts invariant m).
   *  One handler in both directions, because the picker's own `Clear N` walks the selection back
   *  through it — see the reducer's `facility_narrow_toggled` arm. */
  const onToggleFacility = useCallback((value: string) => {
    dispatch({ type: 'facility_narrow_toggled', value });
  }, []);

  /** The NARROW SEARCH card's disclosure. A pure presentation flip that reaches no request — it
   *  writes the one reducer field `scopeKeyOf` does not read, so the fetch effect below cannot
   *  observe it (flow-state.ts invariant n). It is in the reducer for the reason the reducer's own
   *  header gives: two navigations have to WRITE it — a Skip must land the card OPEN and a plan pick
   *  must land it CLOSED — so it fails the `trends` orthogonality test that keeps state out. (An
   *  earlier version of this comment claimed no local `useState` could express that. Not true: a
   *  `useState` plus an effect keyed on `skipped` could. It would just put a navigation rule outside
   *  the machine that owns every other one, and out of reach of the field-write table.) */
  const onToggleNarrow = useCallback(() => {
    dispatch({ type: 'narrow_toggled' });
  }, []);

  /** Re-issue the SAME snapshot request — the failure banner's "Try again" and the NARROW SEARCH
   *  card's standing "Refresh the ranking" are this one call. Bumping the nonce is what moves the
   *  effect's dependency array; nothing about the request itself changes (the term is still in
   *  `termRef`, the scope still in state), so nothing is stashed anywhere to support this.
   *
   *  ⚠ THE TWO GUARDS LIVE IN `makeRetryHandler`, WHICH IS WHY THEY ARE TESTED (S5 fix round). They
   *  used to be an inline `if` in this closure, covered only by a source scan — and that scan
   *  compared two `indexOf` results, so deleting the guard made it `-1 < positive` and the mutation
   *  ran a full green suite. The factory is pure and hermetic; this call site is the wiring. The PHI
   *  never leaves the ref: `getTerm` is a GETTER, read inside the handler and never stored.
   *
   *  `isBusy` folds in what the DOM's `disabled` attribute used to enforce — see the control itself
   *  for why that attribute had to go (it steals keyboard focus the instant it lands). */
  const onRetrySnapshot = useMemo(
    () =>
      makeRetryHandler({
        getTerm: () => termRef.current,
        isBusy: () => refreshing || isPending,
        dispatch,
      }),
    [refreshing, isPending],
  );

  /** A plan pick: inject the held term (never from the DOM), mark picked, dispatch. A NEW plan is a
   *  new population — a genuine first load, so the snapshot blanks to the skeleton (unlike a
   *  re-scope, which keeps stale content dimmed). */
  const planAction = useCallback(
    (fd: FormData) => {
      fd.set('term', termRef.current);
      dispatch({ type: 'plan_submitted' });
      formAction(fd);
    },
    [formAction],
  );

  /** Going back CLEARS what was decided at and after that stage — a kept-but-hidden choice is how
   *  one client's ranking ends up scoped to another's payer. */
  const onChange = useCallback((target: 'identify' | 'payer' | 'plan') => {
    dispatch({ type: 'went_back', target });
  }, []);

  // `payerGroups` is the SAME memoized set the rail, receipt and tiles read (see the useMemo above).
  // Passing it here is what makes "which stage are we on" and "how many carriers does the rail show"
  // one derivation instead of two that happen to agree.
  //
  // ⚠ RAW `payerPick` HERE, NOT `effectivePick`, AND THE ASYMMETRY IS DELIBERATE. `deriveStage` is the
  // STAGE authority and computes answerability itself, so handing it the already-composed pick would
  // short-circuit its own answerable branch — the machine's resolution would then be decided here and
  // merely ratified there, which is two derivations of one decision and exactly what threading
  // `payerGroups` was meant to stop. The split that holds: `deriveStage` owns "which question is open",
  // `effectivePick` owns "which carrier the screen is scoped to". They cannot disagree, because
  // `effectivePick` is non-null in precisely the cases `deriveStage` declines to ask.
  const derived = deriveStage({ resolution: state.resolution, payerPick, picked, skipped, payerGroups });
  // The receipt's Change can only step BACKWARD from what is derivable; any submit clears it.
  const stage: FlowStage = backTo ?? derived;

  // ── The pick→ranking bridge (review Critical 1) ────────────────────────────────────────────────
  // The pick is in VOB vocabulary; the snapshot's payerOverride is in claims vocabulary. The chosen
  // group carries its own confirmed claims labels (claimsPayerLabels, resolutionService §5b), so the
  // ranking is scoped to the payer the user actually picked. A user chip click outranks the bridge;
  // the core validates whatever is sent against the token's own spread, so this can only align
  // scope, never widen it. When the bridge is empty (unmapped / no claims), nothing is sent and the
  // answer stage SAYS the ranking is dominant-payer scoped instead of implying it is the pick's.
  // A SKIP suppresses the bridge deliberately: the resolution still carries a pre-selected group
  // (the largest candidate), and riding its claims label would scope the "general search" to a plan
  // the user explicitly declined to choose.
  const pickLabel = skipped ? null : (state.resolution?.group.claimsPayerLabels[0] ?? null);
  const sentOverride = payerOverride ?? pickLabel;
  // TWO CLAIMS, TWO VALUES. `scopeSource` answers "who chose the payer label" and nothing else; the
  // reducer's `skipped` answers "was a plan chosen" and is threaded to the presentation as its own
  // prop below. They used to be one enum, and because a billed-under chip legitimately outranks a
  // skip for the FIRST question, one chip press after a Skip turned every skip guard off at once and
  // re-presented the declined plan as a picked one. See `ScopeSource` in ./resolution-flow.
  const scopeSource = scopeSourceOf({ payerOverride, pickLabel });
  // ── IDENTIFIER-WIDE: what "Skip — search all plans" now actually asks for ──────────────────────
  // Until 2026-08-07 a Skip sent NOTHING and the core resolved the dominant billed-under label, so
  // the "general search" covered one label out of up to seventeen — measured on a live prefix, AETNA
  // 5,308 lines ranked while AETNA US HEALTHCARE (1,038) and AETNA - FIRST HEALTH NETWORK (7) were
  // silently excluded, along with the two facilities the member billed ONLY under those. Alec's
  // ruling: rank the whole footprint. `payerScope: 'all'` is that request.
  //
  // A BILLED UNDER chip still wins. `payerOverride !== null` means the operator explicitly re-scoped
  // to one label AFTER skipping, the chip renders as "showing", and the core would refuse to honour
  // both anyway — so this client asks for exactly one of them, and the two never race.
  const allPayers = skipped && payerOverride === null;

  // ── The answer-stage filter universe and the market narrow ────────────────────────────────────
  // Universe: after a Skip, every candidate behind the identifier; otherwise the picked carrier's
  // cluster, so the filter lines describe the set the user is actually looking at.
  // ⚠ `effectivePick`, NOT `payerPick` — otherwise the facet universe outruns the answer's own scope.
  // On an auto-resolve the reducer's pick is null, so this fell through to `all`: the funding and
  // employer facets would have enumerated the DEAD-END carriers' plans beside a ranking scoped to the
  // one answerable carrier, and (per the memo below) the surviving employers are sent as
  // `market.employers`. So a filter press could have re-ranked over employers belonging to a carrier
  // the operator was never even shown a tile for.
  const answerCandidates = useMemo(() => {
    if (state.resolution === null) return [];
    const all = orderedCandidates(state.resolution);
    if (skipped || effectivePick === null) return all;
    const cluster = payerGroups.find((p) => p.payer === effectivePick);
    return cluster ? all.filter((c) => cluster.names.has(c.payerDisplayName)) : all;
  }, [state.resolution, skipped, effectivePick, payerGroups]);

  // Funding goes to the market directly (a closed vocabulary the action intersects); the employer
  // selection goes by way of `employerNarrowFor`, which sends it only when it is a PROPER SUBSET
  // within the 200 bound.
  //
  // ⚠ THIS MEMO IS THE WHOLE REASON PLAN TYPE STOPPED BEING A FILTER (2026-08-07). It is the seam
  // where a facet with no market field of its own still becomes a request: `filterCandidates`
  // narrows the candidate set, and the EMPLOYERS of whatever survives are sent as `market.employers`.
  // That made plan type LOOK inert — it was not. Anything added to `AnswerFilters` from here on
  // inherits the same reach; assume a new facet re-ranks the screen until you have shown it cannot
  // move `narrow.employers`.
  const narrow = useMemo(() => {
    if (!answerFiltersActive(filters)) return { employers: null as string[] | null, tooMany: null as number | null };
    const filtered = filterCandidates(answerCandidates, filters);
    const res = employerNarrowFor(answerCandidates, filtered);
    if (res === null) return { employers: null, tooMany: null };
    if ('tooMany' in res) return { employers: null, tooMany: res.tooMany };
    return { employers: res.employers, tooMany: null };
  }, [answerCandidates, filters]);

  // A stable dependency key — arrays get a new identity every render and would refetch forever.
  // ONE key for the whole request identity, used both as the effect's dependency and as the
  // yardstick for `refetching`, so the two can never disagree about what is in flight.
  const scopeKey = scopeKeyOf({
    payerLabel: sentOverride,
    windowDays,
    funding: filters.funding,
    employers: narrow.employers,
    allPayers,
  });
  // THREE states, not one boolean — because a failed refetch now KEEPS its snapshot, and
  // `isRefetching` cannot tell "a request is running" from "a request stopped, badly".
  //
  //   stale           — what is on screen no longer describes what the user asked for. Dim it.
  //   refetching      — stale AND a request is genuinely in flight. Drives the progress beam ONLY.
  //   staleAfterError — stale AND the request failed. Dim, but claim no progress.
  //
  // Collapsing these would animate a progress beam over a dead fetch and suppress the hero numeral
  // forever — the exact stuck-flag class of bug 7a40728/bef4c57 fixed. Note the deliberate
  // asymmetry: a failure at the SAME scope (loadedKey === scopeKey) leaves `stale` false, so the
  // content stays full-opacity with its headline intact and only the banner is appended — nothing
  // on screen is wrong in that case, so nothing should look provisional.
  const stale = isRefetching(snapshot !== null, loadedKey, scopeKey);
  const refetching = stale && snapshotError === null;
  const staleAfterError = stale && snapshotError !== null;

  // ── Snapshot for the answer stage — the hardened v2 data path under the new UI ────────────────
  const predicateId = state.resolution?.predicateId ?? null;
  useEffect(() => {
    if (stage !== 'answer' || predicateId === null || isPending) return;
    const term = termRef.current;
    if (term === '') return; // nothing held (e.g. hot-reload mid-flow); the answer stage keeps its loading state
    let alive = true;
    dispatch({ type: 'snapshot_requested' });
    const market =
      filters.funding.length > 0 || narrow.employers !== null
        ? {
            ...(filters.funding.length > 0 ? { funding: filters.funding } : {}),
            ...(narrow.employers !== null ? { employers: narrow.employers } : {}),
          }
        : undefined;
    getQualifySnapshot({
      query: term,
      window: { kind: 'trailing', days: windowDays ?? 90 },
      auto: windowDays === null,
      ...(sentOverride !== null ? { payerOverride: sentOverride } : {}),
      // Mutually exclusive with payerOverride by construction (see `allPayers` above).
      ...(allPayers ? { payerScope: 'all' as const } : {}),
      ...(market ? { market } : {}),
    })
      .then((s) => {
        // `scopeKey` rides in the PAYLOAD: it is computed in render scope, and the reducer cannot
        // see render scope. This closure already holds the right one — the key for the request that
        // just came back — so it stamps WHAT this snapshot describes.
        if (alive) dispatch({ type: 'snapshot_resolved', snapshot: s, scopeKey });
      })
      .catch(() => {
        if (alive) {
          // KEEP the last-known-good snapshot. It was valid a moment ago and is no less valid
          // because a re-scope failed; blanking it threw away a correct answer to report a failed
          // request. `loadedKey` is deliberately NOT stamped here — it must keep pointing at the
          // scope the RENDERED snapshot actually describes, which is what lets the stage below tell
          // "stale content" apart from "content that matches what was asked".
          dispatch({ type: 'snapshot_failed' });
        }
      });
    return () => {
      alive = false;
    };
    // scopeKey is the stable serialization of every request input (payer label, window, funding,
    // employers); the arrays themselves would be new identities every render and refetch forever.
    // Depending on it alone is sound BECAUSE it is derived from exactly those values.
    // `retryNonce` is the manual re-trigger: a retry re-issues an IDENTICAL request, so scopeKey
    // cannot move and the effect would otherwise never re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, predicateId, isPending, scopeKey, retryNonce]);

  // ── The landing ticker: fetched ONCE on mount, book-wide, independent of the search ───────────
  // Trailing 60 days (Alec, 2026-08-06 — narrowed from 90 so the strip reads as current). The strip
  // ranks by rating DELTA against the prior equivalent period, so the window has a floor: at 30 days a
  // single claim can swing a facility's delta by double digits. 60 keeps that noise bounded while
  // halving the lag; do not take it lower without re-checking the delta distribution. Fail-soft to an
  // empty strip — the trend query is orientation, and it must never block the search box.
  useEffect(() => {
    let alive = true;
    getQualifyFacilityTrends(TICKER_WINDOW)
      .then((t) => {
        if (alive) setTrends(t);
      })
      .catch(() => {
        if (alive) setTrends([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── The FACILITY vocabulary: fetched ONCE on mount, tenant-scoped, independent of the search ───
  // The ticker's shape exactly (mount-once, fail-soft, no dependency on the flow), because it is the
  // same kind of thing: near-static reference data that must never block or shape the answer. The
  // action is `unstable_cache`d for an hour behind the 'cmd-facilities' tag, so this costs a warm
  // cache read rather than a query, and a failure leaves the narrow simply absent.
  useEffect(() => {
    let alive = true;
    loadQualifyFacilityOptions()
      .then((r) => {
        if (!alive) return;
        setFacilityOptions(
          r.ok
            ? r.facilities.map((f) => ({
                value: f.value,
                variants: f.variants,
                display: f.display,
                careSetting: f.care_setting,
              }))
            : [],
        );
      })
      .catch(() => {
        if (alive) setFacilityOptions([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── WHEN THE RANKING INDEX WAS LAST REBUILT: its own request, re-issued on every refresh ──────
  //
  // ⚠ NOT A SEGMENT OF THE SNAPSHOT CALL, and that is the S5 decision rather than an accident. The
  // snapshot is member-scoped, PHI-audited and the one call this whole surface waits on; the rebuild
  // time is a global operational fact with no tenant and no identifier. Riding along would make
  // every v2-tab and mobile snapshot pay for a read neither renders, and — worse — would give the
  // freshness read the RANKING's failure mode, when the whole point is that it degrades to "unknown"
  // and leaves the answer untouched.
  //
  // KEYED ON `retryNonce`, WHICH IS WHAT MAKES THE REFRESH CONTROL HONEST: press it and the time
  // moves with the data, rather than standing at whatever the answer stage first loaded. Gated on
  // the answer stage because that is the only place it renders; a re-scope deliberately does NOT
  // re-read it — the rebuild happens hourly, and a window chip does not change when it last ran.
  useEffect(() => {
    if (stage !== 'answer') return;
    let alive = true;
    loadQualifyDataFreshness()
      .then((r) => {
        if (alive) setDataRebuiltAt(r.ok ? r.rebuiltAt : null);
      })
      .catch(() => {
        if (alive) setDataRebuiltAt(null);
      });
    return () => {
      alive = false;
    };
  }, [stage, retryNonce]);

  // ── Motion + focus ─────────────────────────────────────────────────────────────────────────────
  // ⚠ THE TWEEN TARGETS `[data-v3-stage]` — THE STAGE SUBTREE — NEVER THE <main>. An earlier version
  // animated `autoAlpha` on the <main> wrapper, which sets `visibility: hidden` on the h1, the rail,
  // the receipt, the live region and the ticker on every stage change: the whole page blinked, and
  // the focus call (then a separate passive effect) ran while its target was inside a hidden subtree,
  // which is a no-op in every browser — so keyboard focus fell to <body>, the exact regression the
  // effect existed to prevent. Focus now moves inside the timeline's onStart, when the target is
  // visible; under prefers-reduced-motion — where every tween and trigger is skipped and content
  // renders fully revealed, immediately — the focus call still runs on its own.
  //
  // Keyed on the stage AND on the snapshot's arrival, so the answer's scorecards get their entrance
  // (they land after the stage does). A RE-SCOPE no longer nulls the snapshot, so `hasSnapshot` is
  // stable across it — the dim-and-progress-bar treatment plays instead of a re-entrance.
  const hasSnapshot = snapshot !== null;
  const stageRef = useRef<HTMLElement | null>(null);
  const prevStageRef = useRef<FlowStage | null>(null);
  useLayoutEffect(() => {
    const root = stageRef.current;
    const prev = prevStageRef.current;
    prevStageRef.current = stage;
    const stageChanged = prev !== null && prev !== stage;
    // Focus follows the question: the stage's own <h2> (tabIndex={-1} in the Stage chrome), so a
    // keyboard user is never dropped to <body> when a tile click unmounts the focused element.
    // Skipped on first render — stealing focus from the search input on page load is worse.
    const focusHeading = () => document.getElementById(`qualify-s-${stage}-heading`)?.focus();
    const stageEl = root?.querySelector<HTMLElement>('[data-v3-stage]') ?? null;
    if (!root || !stageEl || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (stageChanged) focusHeading();
      return;
    }
    const ctx = gsap.context(() => {
      gsap.fromTo(
        stageEl,
        { autoAlpha: 0, y: 14 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.22,
          ease: 'power2.out',
          onStart: () => {
            if (stageChanged) focusHeading();
          },
        },
      );

      // Batched scroll reveal (one batcher, never one trigger per tile — a 186-plan list with 186
      // triggers janks). Tiles start hidden ONLY inside this guarded block, so a reduced-motion user
      // — for whom none of this runs — gets the fully-revealed list immediately. `once: true`: a
      // list the user is scanning must not re-animate on scroll-back. Stage 3 gets full amplitude,
      // stage 2 the same vocabulary at lower amplitude, so the two screens read as one system.
      // ── WHERE THE TWO REVEALS LOOK (shell fix, 2026-08-10) ──────────────────────────────────────
      // Single-column: the stage subtree, exactly as before. SHELL: the whole root, because the
      // answer renders in the BOARD pane (`answerInline={false}`) and is therefore not under
      // `[data-v3-stage]` at all — so both reveals below were selecting over a subtree that in shell
      // mode contains no answer content, and neither the tile stagger nor the facet reveal ever ran.
      // The ENTRANCE above deliberately does NOT take this scope: it animates `autoAlpha`, and
      // widening `visibility: hidden` to the root is the <main>-level regression this effect's own
      // header is a post-mortem of. See `revealScopeFor` for the full statement.
      const revealRoot = revealScopeFor(shellMode, root, stageEl);
      const tiles = gsap.utils.toArray<HTMLElement>('[data-v3-tile]', revealRoot);
      if (tiles.length > 0) {
        const rise = stage === 'plan' ? 10 : 6;
        gsap.set(tiles, { autoAlpha: 0, y: rise });
        ScrollTrigger.batch(tiles, {
          start: 'top 88%',
          once: true,
          interval: 0.1,
          onEnter: (batch) =>
            gsap.to(batch, {
              autoAlpha: 1,
              y: 0,
              duration: 0.22,
              ease: 'power2.out',
              stagger: (i: number) => staggerDelayMs(i) / 1000,
            }),
        });
      }

      // ── THE SKIP REVEAL (Alec, 2026-08-07) ──────────────────────────────────────────────────────
      // The Skip lands on an inventory of every facet and its ON/OFF state, and the motion carries
      // the eye down through that inventory — the same 220ms / power2.out / min(i,3)×60ms vocabulary
      // the stage and the tiles already speak, at the tiles' lower amplitude. No second easing, no
      // second timing curve, no new idiom.
      //
      // CONCURRENT WITH THE STAGE ENTRANCE, not sequenced after it. Both tweens are created in the
      // same `gsap.context` on the same tick and start together; what separates them visually is the
      // STAGGER (0 / 60 / 120 / 180ms, capped) against the stage's single 14px rise, so the rows
      // resolve just behind it. Stating that plainly, because "the stage lands first and the rows
      // follow" would describe a timeline this code does not build and send a reader hunting a delay.
      //
      // ⚠ OPACITY, NOT `autoAlpha`, AND THAT IS THE WHOLE CONSTRAINT. `autoAlpha` sets
      // `visibility: hidden`, which makes an element genuinely unclickable and drops it out of the
      // accessibility tree — so the tile treatment above, correct for a scroll-revealed LIST, would
      // here make the last row's toggles dead for ~400ms after a Skip. These rows are CONTROLS, and
      // the ruling is that motion narrates progression and never gates input. With plain opacity the
      // switches are clickable, focusable and announced from the first frame; the animation is
      // decoration over a live surface, which is the only honest way to animate a control.
      //
      // Runs off the same layout effect (and therefore the same reduced-motion guard) as everything
      // else here: under `prefers-reduced-motion` the inventory renders complete and immediately.
      // Selected across the STAGE, not inside `[data-v3-inventory]`, because one facet's control does
      // not live on the control card: the AREA row sits beside the grid it narrows (see AreaLine —
      // everything on the control card re-issues the ranking request and area does not). It is still
      // a facet of the inventory, so it is still a beat of the reveal, and DOM order puts it last,
      // which is where it belongs — the last thing between the operator and the list.
      // Same widened scope in shell mode as the tiles above, and the `opacity`-not-`autoAlpha` rule
      // matters MORE there, not less: in the board these rows are the answer's live controls and the
      // reveal now actually reaches them.
      const facetRows = gsap.utils.toArray<HTMLElement>('[data-v3-facet]', revealRoot);
      if (facetRows.length > 0) {
        gsap.fromTo(
          facetRows,
          { opacity: 0, y: 6 },
          {
            opacity: 1,
            y: 0,
            duration: 0.22,
            ease: 'power2.out',
            stagger: (i: number) => staggerDelayMs(i) / 1000,
            // Belt and braces: if a tween is ever interrupted mid-flight (a re-scope unmounting the
            // block), the row must not be left at a fractional opacity.
            onInterrupt: () => gsap.set(facetRows, { opacity: 1, y: 0 }),
          },
        );
      }

      // The plan stage's sticky header: CSS `position: sticky` does the pinning; ScrollTrigger only
      // ADDS the elevation (`q-stuck` in globals.css) once the grid has scrolled beneath it — no
      // `pin: true`, whose spacer elements fight the grid layout.
      const sticky = root.querySelector<HTMLElement>('[data-v3-sticky]');
      const grid = root.querySelector<HTMLElement>('[data-v3-grid]');
      if (sticky && grid) {
        ScrollTrigger.create({
          trigger: grid,
          start: 'top 128px',
          end: 'max',
          onToggle: (self) => sticky.classList.toggle('q-stuck', self.isActive),
        });
      }
    }, root);
    return () => ctx.revert();
    // `shellMode` is server-decided and stable for the life of the mount, so it can never actually
    // re-fire this — it is in the array because the effect now READS it, and a dependency a reader
    // has to prove constant is worse than one that is simply listed.
  }, [stage, hasSnapshot, shellMode]);

  // The employer filter changes the tile list's length on every keystroke, which invalidates every
  // ScrollTrigger's measured position — refresh, debounced, or 186 keystroke-refreshes thrash.
  useEffect(() => {
    if (stage !== 'plan') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setTimeout(() => ScrollTrigger.refresh(), 150);
    return () => window.clearTimeout(t);
  }, [planFilter, stage]);

  // ── The Heating Up ticker as a CONTROL (the restored half of v2's clickable strip) ─────────────
  // v2's cards pivoted the whole surface to {facility + dominant payer}. v3 cannot do that and stay
  // itself — it resolves a MEMBER, and re-pivoting to a facility throws the member away — so a card
  // click here seeds the answer stage's AREA facet from the card's own state instead. That is only
  // meaningful once there is a ranked list to narrow, which is exactly what `tickerIsLive` says.
  //
  // ONE predicate drives BOTH the `readOnly` treatment and the handler's guard. Two would eventually
  // disagree, and the disagreement that matters is the one that ships a card looking clickable with
  // a handler that returns early — the dead-target failure `openable` already refuses.
  const tickerLive = tickerIsLive(stage, hasSnapshot);
  const onTickerOpen = useCallback(
    (t: QualifyFacilityTrend) => {
      if (!tickerLive) return;
      dispatch({ type: 'area_selected', key: areaKeyFor(t.state) });
    },
    [tickerLive],
  );
  // Cards whose area IS the active narrow read pressed, so a click has visible consequence inside
  // the strip and not only in the grid below it. Book-wide trends, member-scoped ranking: a pressed
  // card is a claim about the FACET, not about the member's history at that facility.
  const tickerActiveKeys = useMemo(
    () =>
      area === AREA_ALL || trends === null
        ? NO_TICKER_KEYS
        : new Set(trends.filter((t) => areaKeyFor(t.state) === area).map((t) => t.facilityKey)),
    [trends, area],
  );
  /** The momentum card whose explanation is open (2026-08-09). Plain local state, NOT a reducer
   *  field: it shapes no request, survives no navigation, and `flow-state.ts`'s own admission test
   *  ("does any handler or flow field touch it") says a bit like this stays out of there. */
  const [explainTrend, setExplainTrend] = useState<QualifyFacilityTrend | null>(null);

  // ── SMOKE SHELL STATE (2026-08-10) — all hooks run unconditionally (rules of hooks); every
  // effect and handler below guards on `shellMode` instead. None of these are reducer fields, each
  // for a reason the machine's header already states: the watchboard is a mount fetch no flow field
  // touches (the `trends` rule); externalAsk is one-shot presentation the panel consumes; the
  // session lists are the browser-only fallback for a save the server could not persist.
  /** The composer's pending ask — nonce'd so two identical asks are two requests. */
  const [externalAsk, setExternalAsk] = useState<QualifyExternalAsk | null>(null);
  const askNonceRef = useRef(0);
  /** Server-persisted watchers + recent searches. null = NOT YET LOADED (a state of its own — see
   *  `deriveBoardStatus`, and never collapse it onto a boolean); 'failed' = the READ failed, which is
   *  a different claim from `available:false` (the relations answered as absent — see
   *  reloadWatchboard, and note that mig 0097 is APPLIED, so absent means they went missing). */
  const [watchboard, setWatchboard] = useState<QualifyWatchboardResult | 'failed' | null>(null);
  /** Session-only fallbacks — a save that came back `persisted:false` lands here rather than being
   *  lost. Post-0097 that path is a should-never-see fault, not the expected pre-apply mode. */
  const [sessionTrend, setSessionTrend] = useState<(QualifyTrendWatcher & { sessionOnly: true })[]>([]);
  const [sessionPatient, setSessionPatient] = useState<(QualifyPatientWatcher & { sessionOnly: true })[]>([]);
  const [sessionRecent, setSessionRecent] = useState<(QualifyRecentSearch & { sessionOnly: true })[]>([]);
  /** Searches already recorded to history, keyed by `recentSearchKeyOf` — a re-scope of the same
   *  resolution must not re-log, and two DIFFERENT members must never share a key. Read that
   *  function's header before touching the key: the three obvious candidates all collide, and the
   *  collision is silent (the second member's search simply never appears in the list). */
  const recordedRef = useRef<Set<string>>(new Set());
  /** The last watcher SAVE was refused or failed — the write-direction twin of the panel's
   *  `readFailed`. Cleared by the next save or delete that succeeds, so the notice describes the
   *  last outcome rather than accumulating. Null = nothing to say. */
  const [watcherSaveFailed, setWatcherSaveFailed] = useState<QualifyWatcherSaveFailure | null>(null);

  /**
   * THREE STATES HERE, FOUR AT THE PANELS — `null` (not loaded yet), a board (whose own `available`
   * splits durable from absent), or `'failed'`. `deriveBoardStatus` is the mapping.
   *
   * The first version collapsed a FAILED read to null, and null rendered as "storage is not set up".
   * Those are different claims and the difference is operationally nasty: with the relations present
   * but the reader's SELECT grant or RLS policy missing, the read 42501s while WRITES still succeed
   * (they go through the SECURITY DEFINER, which needs only EXECUTE) — so a rep saves a watcher, the
   * save reports persisted, and the watcher appears nowhere while the panel calmly explains that
   * storage is not set up. That is the 0089 failure shape the loaders' own header cites: a permission
   * error wearing "not provisioned yet" as a costume. The second version fixed that and then made the
   * mirror-image mistake one layer out, at the panel props — see `deriveBoardStatus`.
   *
   * The in-flight generation counter is the second half: five call sites can fire reloads that
   * resolve out of order, and a stale response landing last would resurrect a just-deleted watcher.
   */
  const boardGenRef = useRef(0);
  const reloadWatchboard = useCallback(() => {
    const gen = ++boardGenRef.current;
    getQualifyWatchboard()
      .then((r) => {
        if (boardGenRef.current !== gen) return; // superseded by a newer reload
        setWatchboard(r.ok ? r.board : 'failed');
      })
      .catch(() => {
        if (boardGenRef.current === gen) setWatchboard('failed');
      });
  }, []);

  // Watchboard: mount-once, shell only, fail-soft — the panels render their empty states on null.
  useEffect(() => {
    if (!shellMode) return;
    reloadWatchboard();
  }, [shellMode, reloadWatchboard]);

  // ── RECENT-SEARCH RECORDING: once per RESOLVED SEARCH, not per snapshot ───────────────────────
  // A window chip, a billed-under press or a refresh re-fetches the same resolved search and must
  // not re-log it; a new identify submit — and a plan pick inside one, which re-resolves to a
  // concrete plan class — does. Facets only: the term goes to the action solely so the ≤3-char echo
  // derives SERVER-side (a member-ID search degrades to its prefix; see watcher-actions.ts), and the
  // in-memory copy uses the already-safe `state.echo`.
  //
  // ⚠ THE KEY IS `(searchSeq, predicateId)`, NOT `predicateId`. `predicateIdFor` hashes only
  // {kind, canonicalPayerId, employerLabel, funding, planType, from, to} — no identifier — so two
  // different members on the same plan shape hashed identically and the SECOND one's search was
  // silently never recorded. `scopeKey` fails the same way (its header: "carries NO identifier at
  // all") and `handle.echo` is '' for every full-member-ID search, so neither rescues it. The
  // session's own search counter does, and it is an integer rather than the one thing that would
  // trivially work and must never be used — the raw term. See `recentSearchKeyOf`.
  const snapshotForRecent = snapshot;
  useEffect(() => {
    if (!shellMode || snapshotForRecent === null) return;
    const pid = state.resolution?.predicateId ?? null;
    if (pid === null) return;
    const key = recentSearchKeyOf(searchSeqRef.current, pid);
    if (recordedRef.current.has(key)) return;
    recordedRef.current.add(key);
    const term = termRef.current;
    if (term === '') return;
    const payer = snapshotForRecent.resolved?.payerName ?? null;
    const planClass = snapshotForRecent.policy?.found ? snapshotForRecent.policy.policyType : null;
    setSessionRecent((prev) =>
      [
        {
          id: '',
          payer,
          prefixEcho: state.echo !== '' ? state.echo : null,
          planClass,
          searchedAt: new Date().toISOString(),
          sessionOnly: true as const,
        },
        ...prev,
      ].slice(0, 20),
    );
    // Fire-and-forget: a failed record must never disturb the search that just succeeded.
    void recordQualifyRecentSearch({ term, payer, planClass }).catch(() => {});
  }, [shellMode, snapshotForRecent, state.resolution, state.echo]);

  /** ── THE RAIL'S LOCK STATE, DERIVED ────────────────────────────────────────────────────────────
   *  What the strip says must describe the SESSION, not the server action's leftover state. See
   *  `laneIsOpen` for why the shell cannot simply null `state.resolution`.
   *
   *  ⚠ `stageIsIdentify` IS THE SECOND DOOR, and it was open until now. `onChange('identify')` — the
   *  receipt's Change on the Search row — dispatches the SAME `went_back{target:'identify'}` as the
   *  reset but through a handler that arms nothing, so the board zone rendered "Nothing resolved yet"
   *  while the strip beside it still said "🔒 Locked to GGS". Reading the STAGE closes every route
   *  back to that screen at once, including a future one, instead of arming a bit per handler. It
   *  does not disturb the pending-window behaviour documented on `sessionCleared`: there the stage is
   *  'payer', not 'identify' (a new submit clears `backTo`, and `deriveStage` sees the previous
   *  resolution). */
  const laneOpen = laneIsOpen({
    resolutionPresent: state.resolution !== null,
    sessionCleared,
    stageIsIdentify: stage === 'identify',
  });

  /** Rail head "Start over": drop the held term, step the machine back to identify, clear the
   *  pending ask, and CLOSE THE LANE. Watchers and history deliberately survive — they are the
   *  session's memory. */
  const onSessionReset = useCallback(() => {
    if (!laneOpen) return; // aria-disabled control — the refusal lives here, and it reads the
    // DERIVED lane state so a second press on an already-reset rail is the no-op the treatment
    // promises (`state.resolution !== null` would have let it through).
    termRef.current = '';
    setExternalAsk(null);
    setExplainTrend(null);
    // ⚠ THIS is what makes the strip say "No lane yet" — dispatching `went_back` cannot, because
    // `state.resolution` lives in `useActionState` and no client dispatch replaces it.
    setSessionCleared(true);
    // A watcher notice is about a search that no longer exists — it must not stand over a new lane.
    setWatcherSaveFailed(null);
    // Belt and braces, no longer load-bearing: with the search counter in the key (see the
    // recording effect) a post-reset search mints new keys anyway. Kept because it bounds the set
    // to one session's worth of entries rather than the mount's.
    recordedRef.current = new Set();
    dispatch({ type: 'went_back', target: 'identify' });
  }, [laneOpen]);

  /** A recent-search Re-run: the stored ≤3-char prefix IS a valid search term — re-resolve fresh
   *  through the same identify path a typed search takes (term into the ref, never the DOM). */
  const onRerunRecent = useCallback(
    (prefixEcho: string) => {
      const fd = new FormData();
      fd.set('term', prefixEcho);
      startTransition(() => {
        identifyAction(fd);
      });
    },
    [identifyAction],
  );

  const onComposerAsk = useCallback((question: QualifyAiChipId, slots: QualifyChipSlots | null) => {
    setExternalAsk({ question, slots, nonce: ++askNonceRef.current });
  }, []);

  /** Watch the resolved payer (trend). Persisted — 0097 is applied live; the session-only branch
   *  below is the fault path for a save the server could not persist, not the normal one. */
  // `effectivePick` as the fallback: on an auto-resolve, before the snapshot lands, the reducer's pick
  // is null and the "＋ watch …" control would simply not render — the one carrier the lane is actually
  // locked to being the one the operator could not watch.
  const watchPayerLabel = snapshot?.resolved?.payerName ?? effectivePick;
  const onWatchPayer = useCallback(() => {
    if (watchPayerLabel === null) return;
    const payer = watchPayerLabel;
    void saveQualifyTrendWatcher({ payer, term: termRef.current, thresholdPts: QUALIFY_WATCHER_DEFAULT_THRESHOLD })
      .then((res) => {
        // A REFUSED SAVE USED TO BE COMPLETELY SILENT — `return` and nothing on screen moved, so the
        // only available reading was "the click missed". The reason rides through to the panel's
        // aria-live status; the success path clears it, so the notice describes the last outcome.
        if (!res.ok) {
          setWatcherSaveFailed(res.reason);
          return;
        }
        setWatcherSaveFailed(null);
        if (res.persisted) reloadWatchboard();
        else
          setSessionTrend((prev) =>
            prev.some((w) => w.payer === payer)
              ? prev
              : [
                  ...prev,
                  {
                    id: '',
                    kind: 'trend' as const,
                    payer,
                    prefix: state.echo !== '' ? state.echo : null,
                    thresholdPts: QUALIFY_WATCHER_DEFAULT_THRESHOLD,
                    since: 'today',
                    points: [],
                    ratingNow: null,
                    deltaPts: null,
                    alerting: false,
                    sessionOnly: true as const,
                  },
                ],
          );
      })
      .catch(() => setWatcherSaveFailed('failed'));
  }, [watchPayerLabel, state.echo, reloadWatchboard]);

  /** Watch this patient — full-member-ID searches only (echo === '' is that signal: handle.echo is
   *  prefix-only by construction). The raw term goes to the action, which stores token + masked
   *  echo and discards it; the SESSION copy masks locally and also never keeps the term. */
  const canWatchPatient = state.echo === '' && stage === 'answer' && state.resolution !== null;
  const onWatchPatient = useCallback(() => {
    const term = termRef.current;
    // THE REFUSAL IS `maskedPatientEcho` RETURNING NULL — not a length literal here. The old `< 5`
    // was wrong twice over: it is the exact off-by-three the shared function's header is a
    // post-mortem of (the real floor is 8, because prefix and tail overlap below that), and having a
    // second copy of the rule at all is how the two paths came to disagree. Asking the one
    // implementation whether this term is maskable answers both questions at once, and it still
    // covers the case this guard was originally added for: the ref empties on a reset and on a hot
    // reload mid-flow while `canWatchPatient` reads true off `state`, and '' masks to null.
    const localEcho = maskedPatientEcho(term);
    if (localEcho === null) {
      setWatcherSaveFailed('invalid');
      return;
    }
    const planContext = [snapshot?.resolved?.payerName, snapshot?.policy?.found ? snapshot.policy.policyType : null]
      .filter(Boolean)
      .join(' · ');
    void saveQualifyPatientWatcher({ term, planContext: planContext || null })
      .then((res) => {
        if (!res.ok) {
          setWatcherSaveFailed(res.reason);
          return;
        }
        setWatcherSaveFailed(null);
        if (res.persisted) reloadWatchboard();
        else
          setSessionPatient((prev) =>
            prev.some((w) => w.echo === localEcho)
              ? prev
              : [
                  ...prev,
                  {
                    id: '',
                    kind: 'patient' as const,
                    echo: localEcho,
                    planContext: planContext || null,
                    since: 'today',
                    sessionOnly: true as const,
                  },
                ],
          );
      })
      .catch(() => setWatcherSaveFailed('failed'));
  }, [snapshot, reloadWatchboard]);

  const onDeleteWatcher = useCallback(
    (kind: 'trend' | 'patient', id: string | null, index: number) => {
      // Session-only rows are indexed within the SESSION slice, which renders after the server
      // rows — deriveWatcherDeleteAction is the one place that arithmetic lives; see its header.
      const b = watchboard === 'failed' || watchboard === null ? null : watchboard;
      const serverCount = kind === 'trend' ? (b?.trend.length ?? 0) : (b?.patient.length ?? 0);
      const action = deriveWatcherDeleteAction(id, index, serverCount);
      if (action.kind === 'server') {
        void deleteQualifyWatcher(action.id)
          .then((res) => {
            // "clear it on the next successful action" — a delete that lands proves the panel is
            // reachable, so a stale save notice above it is no longer describing anything current.
            if (res.ok) {
              setWatcherSaveFailed(null);
              reloadWatchboard();
            }
          })
          .catch(() => {});
        return;
      }
      setWatcherSaveFailed(null);
      const { sessionIndex } = action;
      if (kind === 'trend') setSessionTrend((prev) => prev.filter((_, i) => i !== sessionIndex));
      else setSessionPatient((prev) => prev.filter((_, i) => i !== sessionIndex));
    },
    [watchboard, reloadWatchboard],
  );

  const onClearRecent = useCallback(() => {
    setSessionRecent([]);
    void clearQualifyRecentSearches()
      .then((res) => {
        if (res.ok) reloadWatchboard();
      })
      .catch(() => {});
  }, [reloadWatchboard]);

  // ── THE TICKER NODE, built once and mounted once — in the stages root (single-column) or in the
  // board's tape stack (shell). Two mount SITES, one element; the single-mount rule (marquee scroll
  // position) is per-render-path, and the flag never changes at runtime.
  const tickerNode =
    trends === null ? (
      <HeatingUpSkeleton />
    ) : (
            // readOnly OFF only on the answer stage: there a click seeds the AREA facet. On the
            // landing there is no ranking to narrow, so the cards stay inert — v3 resolves a MEMBER,
            // and inert cards beat buttons that no-op. `scopePayer` stays null on BOTH stages: these
            // trends were fetched book-wide, and labelling the strip with the resolved payer would
            // claim a scope the query never had.
            /* ── A CLICK NOW EXPLAINS (Alec, 2026-08-09) ────────────────────────────────────────
               `onExplain` overrides `readOnly`/`onOpen` inside the strip, so every card is live on
               every stage — which is what "click on any one of the tickers" asks for, and it also
               retires the readOnly/inert branch that existed only because there was nowhere for a
               click to go on the first three stages.
               THE COST, STATED: the answer stage's area-seeding shortcut is gone. AREA remains a
               first-class control beside the grid it narrows (`AreaLine`) — the ticker was a
               shortcut to it, never its home. `tickerLive`/`tickerActiveKeys` are kept and still
               passed: they describe the AREA facet's state, and reviving the shortcut later must not
               require rebuilding the derivations that made it honest. */
            <>
              <HeatingUpCards
                trends={trends}
                window={TICKER_WINDOW}
                readOnly={!tickerLive}
                openAs="area"
                activeFacilityKeys={tickerActiveKeys}
                onOpen={onTickerOpen}
                onExplain={setExplainTrend}
                explainingKey={explainTrend?.facilityKey ?? null}
              />
              {explainTrend ? (
                <TrendExplainer trend={explainTrend} onClose={() => setExplainTrend(null)} />
              ) : null}
            </>
          );

  // ── THE ANSWER BAG — one derivation, two render sites. ResolutionStages reads it for the live
  // region + receipt EVEN when answerInline is false; the board's StageAnswer renders from the same
  // object, so the spoken claim and the drawn answer cannot disagree across panes.
  const answerBag = state.resolution
    ? {
        snapshot,
        snapshotError,
        aiPanel: snapshot ? (
          <QualifyAiPanel
            snapshot={snapshot}
            blind={!viewerHasAmountsCapability}
            // WHERE the answer stage drew the payer's book, so the panel's grounding caption
            // names the list the model actually read. TOLD, not derived from the field — it is
            // on the wire for the v2 tab too, and v2 draws no book (see the prop's own doc).
            //
            // ⚠ ONE CALL, NOT A TERNARY HERE. The composition (leads-first, then on-screen)
            // used to be written inline in this file — which nothing hermetic imports, so
            // INVERTING IT shipped app 557/0 and a clean build with 'leading' unreachable.
            // The decision now lives in bookPlacement.ts with its own tests; this is JSX.
            bookPlacement={bookPlacementFor(snapshot)}
            autoAsk={autoAsk}
            // ONE-SHOT (review Critical 2): without the disarm, every re-scope (window,
            // billed-under chip) nulls the snapshot, unmounts the panel, and the remount
            // re-fires an unrequested, audited, billed LLM call over whatever was on screen.
            onAutoAsked={() => dispatch({ type: 'ai_disarmed' })}
            // The rail composer's ask (Smoke shell) — nonce'd, one-shot, disarmed by the owner
            // here so a panel remount cannot re-fire it. Same discipline as autoAsk above.
            externalAsk={externalAsk}
            onExternalAsked={() => setExternalAsk(null)}
          />
        ) : null,
        pending: isPending,
        scopeSource,
        // The reducer field itself. Everything that must not claim a plan was chosen —
        // the receipt, the identity line, the skip banner, the suppressed notices and
        // provenance — reads THIS, so a re-scope cannot un-skip the presentation.
        skipped,
        refetching,
        staleAfterError,
        // ONE HANDLER, TWO RENDER SITES (S5): the failure banner's "Try again" and the
        // NARROW SEARCH card's standing "Refresh the ranking". A second refetch path would
        // be a second writer of the value the fetch effect keys on.
        onRetry: onRetrySnapshot,
        // The refresh's own progress signal — see the derivation above for why the three
        // fields beside it cannot cover a same-scope re-run.
        refreshing,
        dataRebuiltAt,
        // The auto window landing on a different rung under an UNCHANGED request key: the
        // one scope change on this surface that no staleness flag can observe.
        windowMove,
        candidates: answerCandidates,
        filters,
        onToggleFilter,
        onClearFilters,
        employerNarrowTooMany: narrow.tooMany,
        area,
        onSelectArea,
        // The SECOND grid narrow (S4). Both of these ride here rather than through
        // `scopeKey`, and that absence from the fetch effect's inputs is the whole guarantee.
        facilityOptions,
        facilityNarrow,
        onToggleFacility,
        payerOverride,
        // Re-scopes are REFETCHES of content already on screen: the snapshot stays rendered
        // (dimmed, with the progress bar) rather than blanking — the design system's rule.
        // Which is why these two actions write ONE field each and never touch `snapshot`.
        onPayerOverride: (label: string | null) => dispatch({ type: 'payer_override_changed', label }),
        windowDays,
        onWindowDays: (d: QualifyTrailingDays | null) => dispatch({ type: 'window_days_changed', days: d }),
        narrowExpanded,
        onToggleNarrow,
      }
    : null;

  const stagesNode = (
    <ResolutionStages
      // In shell mode the strip mounts in the BOARD's tape stack instead — one mount per render
      // path, decided by a server prop that never changes at runtime, so the marquee's single-mount
      // rule (no per-stage remount) still holds within each path.
      ticker={shellMode ? null : tickerNode}
      payerGroups={payerGroups}
      stage={stage}
      resolution={state.resolution}
      reason={state.reason}
      echo={state.echo}
      // ── THE SEARCH BOX MUST NOT CONTRADICT THE STRIP 12px ABOVE IT ────────────────────────────
      // `echo` becomes StageIdentify's `defaultValue` and the resolution's `readAs` becomes
      // "We read as a 3-character member-ID prefix." — both claims about a search that a reset has
      // dropped. Before the lock-strip fix these were stale AND AGREED with the strip; fixing one
      // and not the other would leave the rail arguing with itself.
      //
      // ⚠ `sessionCleared`, NOT `!laneOpen`. The receipt's Change lands on this same screen with the
      // term still held, and there the pre-fill is the point — the operator is editing a search, not
      // starting one. Only a reset drops the term. Passing `!laneOpen` here would also change the
      // SINGLE-COLUMN path, where a Change legitimately pre-fills today.
      laneCleared={sessionCleared}
      denied={state.denied}
      pending={isPending}
      // The carrier the SCREEN is scoped to (operator's pick, or the machine's auto-resolve), paired
      // with the bit that says which — so no surface downstream has to guess, and none can claim the
      // operator decided something they did not. See the `effectivePick` derivation above.
      payerPick={effectivePick}
      carrierAutoResolved={carrierAutoResolved}
      planFilter={planFilter}
      identifyAction={identifyAction}
      planAction={planAction}
      onPickPayer={(p) => dispatch({ type: 'payer_picked', payer: p })}
      onPlanFilter={(v) => dispatch({ type: 'plan_filter_changed', value: v })}
      onAskAi={() => dispatch({ type: 'ai_armed' })}
      onChange={onChange}
      onSkip={onSkip}
      answer={answerBag}
      answerInline={!shellMode}
      // The mock's rail progression — stepper-with-values, receipt checklist, event feed. Shell only:
      // the single-column fallback keeps the bare StepRail it has always had.
      showLaneReceipt={shellMode}
    />
  );

  if (!shellMode) {
    return (
      // THE PAGE CHROME. Matching the v2 tab's <main> exactly, because the route layout supplies
      // none: the first staged build returned a bare <div> and rendered the h1 flush against the
      // viewport's top-left corner. max-w-[1680px] is the design system's wide-desktop bound.
      <main ref={stageRef} className="mx-auto max-w-[1680px] p-6 sm:p-8">
        {stagesNode}
      </main>
    );
  }

  // ── THE SMOKE SHELL — rail + board ("drill left → resolve right") ──────────────────────────────
  // Server rows first, session-only rows after (onDeleteWatcher's index math depends on exactly
  // this order); recent shows session first because newest-first is that list's whole ordering.
  const board = watchboard === 'failed' || watchboard === null ? null : watchboard;
  const trendView = [...(board?.trend ?? []), ...sessionTrend];
  const patientView = [...(board?.patient ?? []), ...sessionPatient];
  const recentView = [...sessionRecent, ...(board?.recent ?? [])];
  // ⚠ NOT `board?.available ?? false`. That collapsed `null` (the mount fetch has not resolved) onto
  // `false` (the relations are absent), so for the whole fetch window both panels rendered the
  // absent-state sentence to every operator on every load — and 0097 is applied, so it was false.
  // `deriveBoardStatus` keeps the four states four; the panels switch on it and cannot default.
  const boardStatus = deriveBoardStatus(watchboard);

  const watchActions = (
    <span className="flex items-center gap-1.5">
      {stage !== 'identify' && watchPayerLabel !== null ? (
        <button
          type="button"
          onClick={onWatchPayer}
          className="rounded-lg border border-teal200 px-2 py-0.5 font-mono text-[10px] font-semibold text-teal700 transition-colors hover:bg-teal50"
        >
          ＋ watch {watchPayerLabel}
        </button>
      ) : null}
      {canWatchPatient ? (
        <button
          type="button"
          onClick={onWatchPatient}
          className="rounded-lg border border-teal200 px-2 py-0.5 font-mono text-[10px] font-semibold text-teal700 transition-colors hover:bg-teal50"
        >
          ＋ watch this patient
        </button>
      ) : null}
    </span>
  );

  return (
    // NO <h1> HERE: ResolutionStages renders the page's one "Qualify a client" heading inside the
    // rail. A second identical h1 would give the page two top-level headings with the same text —
    // heading navigation would announce the surface twice and neither would be the landmark.
    <main ref={stageRef} className="mx-auto max-w-[1680px] p-4 sm:p-6">
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[416px_minmax(0,1fr)]">
        <LaneRail
          // ALL THREE GATE ON `laneOpen`, NOT ON `state.resolution`. The rail describes the session,
          // and after "Start over" the server action's resolution is stale but unclearable — passing
          // it straight through is what left the strip naming the abandoned lane. Gating the echo and
          // the sentence too (not only the boolean) keeps that structural rather than dependent on
          // LaneRail continuing to branch on `hasResolution` internally.
          echo={laneOpen ? state.echo : ''}
          readAs={laneOpen ? (state.resolution?.handle.readAs ?? null) : null}
          hasResolution={laneOpen}
          onReset={onSessionReset}
          composer={<QualifyComposer snapshot={snapshot} onAsk={onComposerAsk} />}
        >
          {stagesNode}
        </LaneRail>

        <div className="min-w-0">
          {/* the two-lane tape: policies on the move (dark idiom), then facility momentum. */}
          <PolicyTapeMount />
          <div className="mt-3">{tickerNode}</div>

          <ThisSearchZone
            stage={stage}
            resolution={state.resolution}
            payerGroups={payerGroups}
            // `PayerHero` mounts only on the plan stage and keys on this being non-null. With the raw
            // pick it rendered its "Carrier picked — choosing a plan in the lane narrows this board to
            // it" placeholder on every auto-resolve — a board panel saying nothing had been resolved
            // while the lane beside it said the carrier was locked.
            payerPick={effectivePick}
            echo={state.echo}
          >
            {state.resolution && answerBag ? <StageAnswer resolution={state.resolution} {...answerBag} /> : null}
          </ThisSearchZone>

          <WatchersPanel
            status={boardStatus}
            saveFailed={watcherSaveFailed}
            trend={trendView}
            patient={patientView}
            onDelete={onDeleteWatcher}
            watchAction={watchActions}
          />

          <RecentSearches
            items={recentView}
            status={boardStatus}
            onRerun={onRerunRecent}
            onClear={onClearRecent}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * The momentum card's explainer, with its payload memoized HERE and not in the shell.
 *
 * `TickerExplainer` re-asks whenever its `input` identity changes, and this shell re-renders on
 * every keystroke, every stage move and every fetch tick. Building the payload inline would mint a
 * fresh object each time and fire another audited, billed model call per render. Scoping the memo to
 * its own component makes the dependency exactly the clicked card.
 *
 * `blind: false`: the trend query projects no dollar column, so there are no amounts to withhold —
 * and the server re-derives the real capability from the principal regardless. This field only tunes
 * the model's phrasing about dollars it was never given; it is a hint, never the control.
 */
function TrendExplainer({ trend, onClose }: { trend: QualifyFacilityTrend; onClose: () => void }) {
  const input = useMemo(() => buildTrendAiInput(trend, TICKER_WINDOW.days, false), [trend]);
  const delta =
    trend.deltaPts === null
      ? 'no prior window'
      : `${trend.deltaPts > 0 ? '▲ +' : trend.deltaPts < 0 ? '▼ ' : '◆ '}${trend.deltaPts.toFixed(1)} pts`;
  return (
    <TickerExplainer
      title={trend.name}
      subtitle={`${trend.currentRating === null ? '—' : Math.round(trend.currentRating)}% · ${delta} · trailing ${TICKER_WINDOW.days} days`}
      input={input}
      onClose={onClose}
    />
  );
}
