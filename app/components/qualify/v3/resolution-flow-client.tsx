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
import { getQualifyFacilityTrends, getQualifySnapshot } from '../../../lib/qualify/actions';
import type { QualifyFacilityTrend } from '../../../lib/qualify/contract';
import { QualifyAiPanel } from '../qualify-ai-panel';
import { HeatingUpCards, HeatingUpSkeleton } from '../shared/heating-ticker';
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
  ResolutionStages,
  scopeKeyOf,
  scopeSourceOf,
  tickerIsLive,
  type FlowStage,
} from './resolution-flow';
// The flow's sixteen fields and the rules that move them. Its header is the spec; this file is the
// transport (PHI ref, effects, derivations) wired to it.
import { INITIAL_SHELL_STATE, shellReducer } from './flow-state';

// ScrollTrigger ships inside the gsap package — no new dependency. Client components also render on
// the server once, so guard the registration behind a window check.
if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
}

/** The ticker's own window — see the fetch effect for why a trailing window rather than 30 days. */
const TICKER_WINDOW = { kind: 'trailing', days: 60 } as const;

/** Stable empty reference for "no ticker card is pressed" — a fresh Set would defeat the strip's memo. */
const NO_TICKER_KEYS: ReadonlySet<string> = new Set();

export function ResolutionFlowClient({
  viewerHasAmountsCapability,
}: {
  viewerHasAmountsCapability: boolean;
}): React.ReactElement {
  const [state, formAction, isPending] = useActionState(resolveCoverageAction, V3_INITIAL_STATE);

  // The raw term — JS memory only. See the header block before moving this anywhere.
  const termRef = useRef<string>('');

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
    narrowExpanded,
  } = flow;

  // NOT in the reducer, deliberately: the ticker is a mount-once fetch that no flow field and no
  // handler touches. `null` = still loading (renders the skeleton, which reserves the strip's
  // height so a 2.5-5s trend query cannot shove the search box down the page); [] = loaded empty.
  const [trends, setTrends] = useState<QualifyFacilityTrend[] | null>(null);

  // ONE clustering pass per resolution (clusterCarriers is O(n²)); the rail, receipt and both tile
  // stages read this instead of each re-deriving it — scroll-driven work on top of 4-5 re-derives
  // per render was going to surface as employer-filter input lag.
  const payerGroups = useMemo(
    () => (state.resolution !== null ? payerGroupsOf(state.resolution) : []),
    [state.resolution],
  );

  /** A new identify submit invalidates every downstream choice — clear them BEFORE dispatching to
   *  the server action. Capturing the term into the ref is the ONLY thing that happens outside the
   *  reducer here, and it happens outside because the term is PHI (see the header). */
  const identifyAction = useCallback(
    (fd: FormData) => {
      const term = fd.get('term');
      termRef.current = typeof term === 'string' ? term : '';
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

  /** Re-issue the SAME snapshot request after a failure. Bumping the nonce is what moves the
   *  effect's dependency array; nothing about the request itself changes (the term is still in
   *  `termRef`, the scope still in state), so nothing is stashed anywhere to support this. The
   *  empty-term guard mirrors the effect's own early return at the top — without it, clearing the
   *  error here would leave a banner-free stage with no fetch behind it. It stays in this wrapper
   *  rather than in the reducer because the reducer must never read the PHI ref. */
  const onRetrySnapshot = useCallback(() => {
    if (termRef.current === '') return;
    dispatch({ type: 'retry_requested' });
  }, []);

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
  const answerCandidates = useMemo(() => {
    if (state.resolution === null) return [];
    const all = orderedCandidates(state.resolution);
    if (skipped || payerPick === null) return all;
    const cluster = payerGroups.find((p) => p.payer === payerPick);
    return cluster ? all.filter((c) => cluster.names.has(c.payerDisplayName)) : all;
  }, [state.resolution, skipped, payerPick, payerGroups]);

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
      const tiles = gsap.utils.toArray<HTMLElement>('[data-v3-tile]', stageEl);
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
      const facetRows = gsap.utils.toArray<HTMLElement>('[data-v3-facet]', stageEl);
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
  }, [stage, hasSnapshot]);

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

  return (
    // THE PAGE CHROME. Matching the v2 tab's <main> exactly, because the route layout supplies none:
    // the first staged build returned a bare <div> and rendered the h1 flush against the viewport's
    // top-left corner with zero padding. max-w-[1680px] is the design system's wide-desktop bound.
    <main ref={stageRef} className="mx-auto max-w-[1680px] p-6 sm:p-8">
      <ResolutionStages
        ticker={
          trends === null ? (
            <HeatingUpSkeleton />
          ) : (
            // readOnly OFF only on the answer stage: there a click seeds the AREA facet. On the
            // landing there is no ranking to narrow, so the cards stay inert — v3 resolves a MEMBER,
            // and inert cards beat buttons that no-op. `scopePayer` stays null on BOTH stages: these
            // trends were fetched book-wide, and labelling the strip with the resolved payer would
            // claim a scope the query never had.
            <HeatingUpCards
              trends={trends}
              window={TICKER_WINDOW}
              readOnly={!tickerLive}
              openAs="area"
              activeFacilityKeys={tickerActiveKeys}
              onOpen={onTickerOpen}
            />
          )
        }
        payerGroups={payerGroups}
        stage={stage}
        resolution={state.resolution}
        reason={state.reason}
        echo={state.echo}
        denied={state.denied}
        pending={isPending}
        payerPick={payerPick}
        planFilter={planFilter}
        identifyAction={identifyAction}
        planAction={planAction}
        onPickPayer={(p) => dispatch({ type: 'payer_picked', payer: p })}
        onPlanFilter={(v) => dispatch({ type: 'plan_filter_changed', value: v })}
        onAskAi={() => dispatch({ type: 'ai_armed' })}
        onChange={onChange}
        onSkip={onSkip}
        answer={
          state.resolution
            ? {
                snapshot,
                snapshotError,
                aiPanel: snapshot ? (
                  <QualifyAiPanel
                    snapshot={snapshot}
                    blind={!viewerHasAmountsCapability}
                    // S2: the answer stage renders the payer's whole book BELOW the member ranking
                    // whenever the core loaded one, so the panel's grounding caption has to name
                    // which of the two it read. TOLD, not derived from the field — it is on the wire
                    // for the v2 tab too, and v2 draws no book (see the prop's own doc).
                    bookOnScreen={snapshot.bookFacilities !== null}
                    autoAsk={autoAsk}
                    // ONE-SHOT (review Critical 2): without the disarm, every re-scope (window,
                    // billed-under chip) nulls the snapshot, unmounts the panel, and the remount
                    // re-fires an unrequested, audited, billed LLM call over whatever was on screen.
                    onAutoAsked={() => dispatch({ type: 'ai_disarmed' })}
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
                onRetry: onRetrySnapshot,
                candidates: answerCandidates,
                filters,
                onToggleFilter,
                onClearFilters,
                employerNarrowTooMany: narrow.tooMany,
                area,
                onSelectArea,
                payerOverride,
                // Re-scopes are REFETCHES of content already on screen: the snapshot stays rendered
                // (dimmed, with the progress bar) rather than blanking — the design system's rule.
                // Which is why these two actions write ONE field each and never touch `snapshot`.
                onPayerOverride: (label) => dispatch({ type: 'payer_override_changed', label }),
                windowDays,
                onWindowDays: (d) => dispatch({ type: 'window_days_changed', days: d }),
                narrowExpanded,
                onToggleNarrow,
              }
            : null
        }
      />
    </main>
  );
}
