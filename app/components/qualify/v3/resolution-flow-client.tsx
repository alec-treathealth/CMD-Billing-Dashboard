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
 * ── MOTION ──────────────────────────────────────────────────────────────────────────────────────
 * GSAP, the requested idiom: the incoming stage slides up 14px/220ms ease-out; tiles stagger
 * min(index,3)×60ms (capped — a 186-plan list must not cascade forever). One easing. Disabled
 * entirely under prefers-reduced-motion. Motion narrates progression; it never gates input.
 */
import { useActionState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { resolveCoverageAction } from '../../../lib/qualify/v3-actions';
// V3_INITIAL_STATE comes from a PLAIN module, never the 'use server' one: a non-function export
// there is registered as a Server Action and 500s every action on the page (see v3FlowState.ts).
import { V3_INITIAL_STATE } from '../../../lib/qualify/v3FlowState';
import { getQualifyFacilityTrends, getQualifySnapshot } from '../../../lib/qualify/actions';
import type { QualifyFacilityTrend, QualifySnapshot, QualifyTrailingDays } from '../../../lib/qualify/contract';
import { QualifyAiPanel } from '../qualify-ai-panel';
import { HeatingUpCards, HeatingUpSkeleton } from '../shared/heating-ticker';
import { staggerDelayMs } from '../tokens';
import {
  answerFiltersActive,
  deriveStage,
  employerNarrowFor,
  filterCandidates,
  NO_ANSWER_FILTERS,
  orderedCandidates,
  payerGroupsOf,
  ResolutionStages,
  type AnswerFilters,
  type FlowStage,
} from './resolution-flow';

// ScrollTrigger ships inside the gsap package — no new dependency. Client components also render on
// the server once, so guard the registration behind a window check.
if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
}

/** The ticker's own window — see the fetch effect for why 90 days rather than 30. */
const TICKER_WINDOW = { kind: 'trailing', days: 90 } as const;

export function ResolutionFlowClient({
  viewerHasAmountsCapability,
}: {
  viewerHasAmountsCapability: boolean;
}): React.ReactElement {
  const [state, formAction, isPending] = useActionState(resolveCoverageAction, V3_INITIAL_STATE);

  // The raw term — JS memory only. See the header block before moving this anywhere.
  const termRef = useRef<string>('');

  const [payerPick, setPayerPick] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  // The user's own escape hatch: jump to the answer over the WHOLE footprint. Distinct from
  // `picked` — declining to choose is a different claim from choosing, and the answer says which.
  const [skipped, setSkipped] = useState(false);
  const [filters, setFilters] = useState<AnswerFilters>(NO_ANSWER_FILTERS);
  const [employerQuery, setEmployerQuery] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [autoAsk, setAutoAsk] = useState(false);
  const [backTo, setBackTo] = useState<FlowStage | null>(null);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [payerOverride, setPayerOverride] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<QualifyTrailingDays | null>(null);
  // True while a RE-SCOPE of the answer (window chip / billed-under chip) is in flight. The design
  // system's refetch rule: content already on screen stays rendered, dimmed, with a progress bar —
  // it never blanks to a skeleton. Skeletons are reserved for the genuine first load (snapshot null).
  const [refetching, setRefetching] = useState(false);
  // The landing ticker. `null` = still loading (renders the skeleton, which reserves the strip's
  // height so a 2.5-5s trend query cannot shove the search box down the page); [] = loaded empty.
  const [trends, setTrends] = useState<QualifyFacilityTrend[] | null>(null);

  // ONE clustering pass per resolution (clusterCarriers is O(n²)); the rail, receipt and both tile
  // stages read this instead of each re-deriving it — scroll-driven work on top of 4-5 re-derives
  // per render was going to surface as employer-filter input lag.
  const payerGroups = useMemo(
    () => (state.resolution !== null ? payerGroupsOf(state.resolution) : []),
    [state.resolution],
  );

  /** A new identify submit invalidates every downstream choice — clear them BEFORE dispatching. */
  const identifyAction = useCallback(
    (fd: FormData) => {
      const term = fd.get('term');
      termRef.current = typeof term === 'string' ? term : '';
      setPayerPick(null);
      setPicked(false);
      setSkipped(false);
      setFilters(NO_ANSWER_FILTERS);
      setEmployerQuery('');
      setPlanFilter('');
      setAutoAsk(false);
      setBackTo(null);
      setSnapshot(null);
      setSnapshotError(null);
      setPayerOverride(null);
      setWindowDays(null);
      setRefetching(false);
      formAction(fd);
    },
    [formAction],
  );

  /** Skip the remaining questions: straight to the answer over the whole footprint. Clears any
   *  half-made narrowing so the general search is genuinely general. */
  const onSkip = useCallback(() => {
    setSkipped(true);
    setPicked(false);
    setPayerPick(null);
    setPlanFilter('');
    setBackTo(null);
    setFilters(NO_ANSWER_FILTERS);
    setEmployerQuery('');
    setPayerOverride(null);
    setSnapshot(null);
    setSnapshotError(null);
    setRefetching(false);
  }, []);

  const onToggleFilter = useCallback((facet: 'planType' | 'funding' | 'employer', value: string) => {
    setRefetching(true); // a filter change re-scopes content already on screen
    setFilters((f) => {
      const key = facet === 'planType' ? 'planTypes' : facet === 'funding' ? 'funding' : 'employers';
      const cur = f[key];
      return { ...f, [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
  }, []);

  const onClearFilters = useCallback(() => {
    setRefetching(true);
    setFilters(NO_ANSWER_FILTERS);
    setEmployerQuery('');
  }, []);

  /** A plan pick: inject the held term (never from the DOM), mark picked, dispatch. A NEW plan is a
   *  new population — a genuine first load, so the snapshot blanks to the skeleton (unlike a
   *  re-scope, which keeps stale content dimmed). */
  const planAction = useCallback(
    (fd: FormData) => {
      fd.set('term', termRef.current);
      setPicked(true);
      setSkipped(false); // choosing a plan supersedes a prior skip
      setFilters(NO_ANSWER_FILTERS);
      setEmployerQuery('');
      setBackTo(null);
      setSnapshot(null);
      setSnapshotError(null);
      setRefetching(false);
      formAction(fd);
    },
    [formAction],
  );

  const onChange = useCallback((target: 'identify' | 'payer' | 'plan') => {
    // Going back CLEARS what was decided at and after that stage — a kept-but-hidden choice is how
    // one client's ranking ends up scoped to another's payer.
    setSnapshot(null);
    setSnapshotError(null);
    setAutoAsk(false);
    setPayerOverride(null);
    setWindowDays(null);
    setRefetching(false);
    setPicked(false);
    setSkipped(false); // stepping back into the funnel un-skips it
    setFilters(NO_ANSWER_FILTERS);
    setEmployerQuery('');
    if (target !== 'plan') setPayerPick(null);
    setPlanFilter('');
    setBackTo(target);
  }, []);

  const derived = deriveStage({ resolution: state.resolution, payerPick, picked, skipped });
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
  const scopeSource: 'user' | 'pick' | 'dominant' | 'skipped' =
    payerOverride !== null ? 'user' : pickLabel !== null ? 'pick' : skipped ? 'skipped' : 'dominant';

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

  // funding goes to the market directly (a closed vocabulary the action intersects); plan type has
  // no market field, so it narrows by way of the employer set the filtered candidates resolve to.
  const narrow = useMemo(() => {
    if (!answerFiltersActive(filters)) return { employers: null as string[] | null, tooMany: null as number | null };
    const filtered = filterCandidates(answerCandidates, filters);
    const res = employerNarrowFor(answerCandidates, filtered);
    if (res === null) return { employers: null, tooMany: null };
    if ('tooMany' in res) return { employers: null, tooMany: res.tooMany };
    return { employers: res.employers, tooMany: null };
  }, [answerCandidates, filters]);

  // A stable dependency key — arrays get a new identity every render and would refetch forever.
  const marketKey = `${filters.funding.slice().sort().join('|')}#${(narrow.employers ?? []).slice().sort().join('|')}`;

  // ── Snapshot for the answer stage — the hardened v2 data path under the new UI ────────────────
  const predicateId = state.resolution?.predicateId ?? null;
  useEffect(() => {
    if (stage !== 'answer' || predicateId === null || isPending) return;
    const term = termRef.current;
    if (term === '') return; // nothing held (e.g. hot-reload mid-flow); the answer stage keeps its loading state
    let alive = true;
    setSnapshotError(null);
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
      ...(market ? { market } : {}),
    })
      .then((s) => {
        if (alive) {
          setSnapshot(s);
          setRefetching(false);
        }
      })
      .catch(() => {
        if (alive) {
          setSnapshot(null);
          setSnapshotError('failed');
          setRefetching(false);
        }
      });
    return () => {
      alive = false;
    };
    // marketKey is the stable serialization of `filters.funding` + `narrow.employers`; the arrays
    // themselves would be new identities every render and refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, predicateId, isPending, sentOverride, windowDays, marketKey]);

  // ── The landing ticker: fetched ONCE on mount, book-wide, independent of the search ───────────
  // Trailing 90 days rather than 30: the strip ranks by rating DELTA against the prior equivalent
  // period, and at 30 days a single claim can swing a facility's delta by double digits. Fail-soft to
  // an empty strip — the trend query is orientation, and it must never block the search box.
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
            // readOnly: v3 resolves a MEMBER, not a facility, so there is no facility-first drill to
            // click into. Inert cards beat buttons that no-op.
            <HeatingUpCards trends={trends} window={TICKER_WINDOW} readOnly />
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
        onPickPayer={(p) => {
          setPayerPick(p);
          setBackTo(null);
        }}
        onPlanFilter={setPlanFilter}
        onAskAi={() => setAutoAsk(true)}
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
                    autoAsk={autoAsk}
                    // ONE-SHOT (review Critical 2): without the disarm, every re-scope (window,
                    // billed-under chip) nulls the snapshot, unmounts the panel, and the remount
                    // re-fires an unrequested, audited, billed LLM call over whatever was on screen.
                    onAutoAsked={() => setAutoAsk(false)}
                  />
                ) : null,
                pending: isPending,
                scopeSource,
                refetching,
                candidates: answerCandidates,
                filters,
                onToggleFilter,
                onClearFilters,
                employerQuery,
                onEmployerQuery: setEmployerQuery,
                employerNarrowTooMany: narrow.tooMany,
                payerOverride,
                // Re-scopes are REFETCHES of content already on screen: the snapshot stays rendered
                // (dimmed, with the progress bar) rather than blanking — the design system's rule.
                onPayerOverride: (label) => {
                  setRefetching(true);
                  setPayerOverride(label);
                },
                windowDays,
                onWindowDays: (d) => {
                  setRefetching(true);
                  setWindowDays(d);
                },
              }
            : null
        }
      />
    </main>
  );
}
