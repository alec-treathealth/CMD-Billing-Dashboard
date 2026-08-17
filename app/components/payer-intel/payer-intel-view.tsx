'use client';

/**
 * The /payer-intel client island — one route, two view states:
 *   IDLE   — ambient: gainers rail · decliners rail · search · starred/recent · census (compact)
 *   RESULT — hero · ON FILE chips · top-payer/facility drills · percentage band · placement ·
 *            CPT×rev rollup · charge-line grid · census (compact) · AI cohort read
 *
 * 2026-08-17 review rulings folded in: the rails MOVE (useMarquee inside idle-rails) and ADAPT to
 * the recency toggle (the toggle refetches the board with the new window); saved searches sit
 * DIRECTLY below the search bar; the census strip is compact and renders on BOTH states; every
 * summary row is a DRILL (click = add the facet, re-run); the charge-line grid gives Collections'
 * row-level view.
 *
 * STATE TRANSITIONS ARE CLIENT-SIDE; the URL carries ONLY the non-PHI facet allowlist
 * (contract.ts codec) via history.replaceState. Terms (group numbers) never touch the URL.
 *
 * A11Y: a polite live region narrates search progress; focus moves to the result heading when a
 * search completes (SC 2.4.3 — the content changed under the user); every GSAP leg bails under
 * prefers-reduced-motion (matchMedia — the CSS reset cannot reach a GSAP tween); controls animate
 * `opacity`, never autoAlpha.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import type { QualifyPolicyTapeItem } from '../../lib/qualify/board';
import type {
  PayerIntelBoard,
  PayerIntelDeclinerItem,
  PayerIntelFacetKey,
  PayerIntelGridPage,
  PayerIntelResult,
  PayerIntelSavedSearch,
  PayerIntelSearchInput,
  PayerIntelUrlState,
} from '../../lib/payer-intel/contract';
import { PAYER_INTEL_DEFAULT_WINDOW_DAYS, encodePayerIntelUrl } from '../../lib/payer-intel/contract';
import {
  clearPayerIntelHistory,
  getPayerIntelBoard,
  loadPayerIntelChargeRows,
  runPayerIntelSearch,
  searchPayerIntelEmployers,
  togglePayerIntelStar,
  watchPayerIntelSubject,
} from '../../lib/payer-intel/actions';
import { generatePayerIntelAiRead } from '../../lib/payer-intel/ai-actions';
import { PayerIntelGainersRail, PayerIntelDeclinersRail } from './idle-rails';
import { PayerIntelCensusPanel } from './census-panel';
import { PayerIntelSavedSearches } from './saved-searches';
import { PayerIntelSearchBar, type PayerIntelSearchBarSubmit } from './search-bar';
import {
  PayerIntelChargeLines,
  PayerIntelGridTable,
  PayerIntelHero,
  PayerIntelPctBand,
  PayerIntelPlacementTable,
  PayerIntelSectionBox,
  PayerIntelTopGroups,
} from './result-sections';
import { PayerIntelAiPanel } from './ai-panel';

function reducedMotion(): boolean {
  return typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * The main-column / census-rail split, shared by both view states (Alec, 2026-08-17: the census
 * "takes up too much of the screen … put it on the side"). ONE column below 1280px — the rail
 * stacks under the content rather than squeezing a 12-column grid into a phone. `items-start` is
 * load-bearing: without it the grid stretches the aside to the row height and `sticky` has no
 * scroll range to work in.
 */
const SPLIT = 'grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_318px] xl:items-start';
const RAIL = 'xl:sticky xl:top-6';

export function PayerIntelView({
  initialBoard,
  initialUrlState,
  facetOptions,
}: {
  initialBoard: PayerIntelBoard;
  /** Decoded server-side from searchParams (non-PHI allowlist only) — a shared link auto-runs. */
  initialUrlState: PayerIntelUrlState;
  facetOptions: {
    facilities: { value: string; name: string; careSetting: 'IP' | 'OP' | 'BOTH' | null }[];
    payers: string[];
  };
}) {
  const [board, setBoard] = useState(initialBoard);
  const [mode, setMode] = useState<'idle' | 'result'>('idle');
  const [result, setResult] = useState<PayerIntelResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [watchState, setWatchState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [windowDays, setWindowDays] = useState(initialUrlState.windowDays ?? PAYER_INTEL_DEFAULT_WINDOW_DAYS);
  const [grid, setGrid] = useState<PayerIntelGridPage | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridFailed, setGridFailed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const lastInput = useRef<PayerIntelSearchInput>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resultHeadingRef = useRef<HTMLDivElement | null>(null);
  const idleAnimated = useRef(false);
  const searchSeq = useRef(0);
  const gridSeq = useRef(0);
  const boardSeq = useRef(0);

  const syncUrl = useCallback((res: PayerIntelResult | null, days: number) => {
    if (typeof window === 'undefined') return;
    const state: PayerIntelUrlState =
      res === null
        ? { payer: null, prefix: null, facilities: [], funding: [], cpt: null, revenue: null, windowDays: days }
        : {
            payer: res.facets.payer,
            prefix: res.facets.prefix,
            facilities: res.facets.facilities,
            funding: res.facets.funding,
            cpt: res.facets.cpt,
            revenue: res.facets.revenue,
            windowDays: res.facets.windowDays,
          };
    window.history.replaceState(null, '', `${window.location.pathname}${encodePayerIntelUrl(state)}`);
  }, []);

  /** Refetch the ambient board — after a search (history changed) or a window toggle (rails adapt). */
  const refreshBoard = useCallback((days: number) => {
    const seq = ++boardSeq.current;
    void getPayerIntelBoard(days)
      .then((r) => {
        if (r.ok && boardSeq.current === seq) setBoard(r.board);
      })
      // The board is AMBIENT: a failed refresh keeps whatever is already on screen and says
      // nothing. It is the one action here whose failure genuinely does not need surfacing.
      .catch(() => {});
  }, []);

  /**
   * One keyset page of the charge-line grid.
   *
   * ⚠ EVERY Server Action call on this surface MUST terminate in `.catch`. A bare `.then()` chain
   * strands the UI in whatever pending state it set: this section showed "Loading charge lines…"
   * FOREVER on any rejection — a stale action id after a redeploy, a dropped POST, a function
   * timeout — with no error, no retry, and nothing in the server logs to find (the rejection never
   * reached the server). That was the 2026-08-17 "charge lines will not load" report.
   */
  const loadGrid = useCallback((input: PayerIntelSearchInput, cursor: PayerIntelGridPage['nextCursor']): Promise<void> => {
    const seq = ++gridSeq.current;
    setGridLoading(true);
    setGridFailed(false);
    return loadPayerIntelChargeRows(input, cursor)
      .then((r) => {
        if (gridSeq.current !== seq) return;
        setGridLoading(false);
        if (!r.ok) {
          // An honest failed state, never "will load with the search" — that message is a lie once
          // the request has already come back refusing.
          setGridFailed(true);
          return;
        }
        setGrid((prev) =>
          cursor !== null && prev !== null
            ? { rows: [...prev.rows, ...r.page.rows], nextCursor: r.page.nextCursor }
            : r.page,
        );
      })
      .catch(() => {
        if (gridSeq.current !== seq) return;
        setGridLoading(false);
        setGridFailed(true);
      });
  }, []);

  const runSearch = useCallback(
    (input: PayerIntelSearchInput) => {
      const seq = ++searchSeq.current;
      setBusy(true);
      setFailed(false);
      setAnnounce('Searching…');
      const withWindow = { ...input, windowDays: input.windowDays ?? windowDays };
      lastInput.current = withWindow;
      setGrid(null);
      setGridFailed(false);
      setGridLoading(true); // page 1 rides the search, so the grid is pending for exactly as long
      void runPayerIntelSearch(withWindow)
        .then((r) => {
          if (searchSeq.current !== seq) return; // superseded
          setBusy(false);
          if (!r.ok) {
            setFailed(true);
            setGridLoading(false);
            setGridFailed(true);
            setAnnounce('The search failed.');
            return;
          }
          setWatchState('idle');
          setResult(r.result);
          setMode('result');
          setWindowDays(r.result.facets.windowDays);
          setAnnounce(
            `${r.result.totals.lineCount.toLocaleString('en-US')} charge lines over the past ${r.result.facets.windowDays} days.`,
          );
          syncUrl(r.result, r.result.facets.windowDays);
          // PAGE 1 ARRIVES WITH THE SEARCH — no second Server Action, so there is no second hop
          // to fail. The previous two builds fetched it separately and it never landed; the SQL
          // was 50ms as both postgres and claims_reader and the server logged no 5xx, so the
          // failure was the hop itself. `loadGrid` now serves "Load more" only.
          gridSeq.current += 1; // any in-flight Load-more from the previous result is superseded
          setGrid(r.result.grid);
          setGridLoading(false);
          setGridFailed(false);
          refreshBoard(r.result.facets.windowDays); // the search we just ran lands in Recent
          // Focus the result heading so keyboard/AT users land on the new content (SC 2.4.3).
          window.requestAnimationFrame(() => resultHeadingRef.current?.focus());
        })
        .catch(() => {
          if (searchSeq.current !== seq) return;
          setBusy(false);
          setFailed(true);
          setGridLoading(false);
          setGridFailed(true);
          setAnnounce('The search failed.');
        });
    },
    [loadGrid, refreshBoard, syncUrl, windowDays],
  );

  const clearAll = useCallback(() => {
    searchSeq.current += 1; // cancel any in-flight search
    gridSeq.current += 1;
    lastInput.current = {};
    setResult(null);
    setGrid(null);
    setGridLoading(false);
    setGridFailed(false);
    setMode('idle');
    setBusy(false);
    setAnnounce('Cleared — back to the overview.');
    idleAnimated.current = false; // the ambient board re-enters with its stagger
    syncUrl(null, windowDays);
  }, [syncUrl, windowDays]);

  /** The recency toggle: on IDLE it re-scopes the RAILS; on RESULT it re-runs the search. */
  const changeWindowDays = useCallback(
    (days: number) => {
      if (days === windowDays) return;
      setWindowDays(days);
      if (mode === 'result') {
        runSearch({ ...lastInput.current, windowDays: days });
      } else {
        refreshBoard(days);
        syncUrl(null, days);
      }
    },
    [mode, refreshBoard, runSearch, syncUrl, windowDays],
  );

  // A shared/bookmarked link with facets auto-runs once on mount.
  useEffect(() => {
    const u = initialUrlState;
    if (u.payer !== null || u.prefix !== null || u.facilities.length > 0 || u.funding.length > 0 || u.cpt !== null) {
      runSearch({
        payer: u.payer,
        prefix: u.prefix,
        facilities: u.facilities,
        funding: u.funding,
        cpt: u.cpt,
        revenue: u.revenue,
        windowDays: u.windowDays,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate mount-once auto-run
  }, []);

  // ── Motion: IDLE entrance (one-time) ────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (mode !== 'idle' || idleAnimated.current || root === null || reducedMotion()) {
      idleAnimated.current = idleAnimated.current || mode === 'idle';
      return;
    }
    idleAnimated.current = true;
    const ctx = gsap.context(() => {
      const sections = gsap.utils.toArray<HTMLElement>('[data-pi-section]', root);
      // `opacity`, never autoAlpha — these sections contain CONTROLS, and visibility:hidden drops
      // them from the a11y tree mid-tween (the resolution-flow ruling: motion never gates input).
      gsap.fromTo(
        sections,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.04, onInterrupt: () => gsap.set(sections, { opacity: 1, y: 0 }) },
      );
    }, root);
    return () => ctx.revert();
  }, [mode]);

  // ── Motion: RESULT entrance (per result identity) ───────────────────────────────────────────────
  const resultKey = result !== null ? JSON.stringify(result.facets) : '';
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (mode !== 'result' || root === null || result === null || reducedMotion()) return;
    const ctx = gsap.context(() => {
      const sections = gsap.utils.toArray<HTMLElement>('[data-pi-section]', root);
      gsap.fromTo(
        sections,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.06, onInterrupt: () => gsap.set(sections, { opacity: 1, y: 0 }) },
      );
      // The three percentage cards enter IN MATH ORDER (allowed → paid → collected) — the DOM
      // order already mirrors the formula, so a left→right stagger IS the sequence.
      const cards = gsap.utils.toArray<HTMLElement>('[data-pi-pct-card]', root);
      gsap.fromTo(
        cards,
        { opacity: 0, x: -12 },
        { opacity: 1, x: 0, duration: 0.3, ease: 'power2.out', stagger: 0.08, delay: 0.12, onInterrupt: () => gsap.set(cards, { opacity: 1, x: 0 }) },
      );
    }, root);
    return () => ctx.revert();
  }, [mode, resultKey, result]);

  /** IDLE→RESULT exit: fade the ambient sections 200ms, then flip. Instant under reduced motion. */
  const transitionToResult = useCallback(
    (input: PayerIntelSearchInput) => {
      const root = rootRef.current;
      if (root !== null && !reducedMotion()) {
        const sections = gsap.utils.toArray<HTMLElement>('[data-pi-section]', root);
        gsap.to(sections, { opacity: 0, y: -6, duration: 0.2, ease: 'power2.out' });
      }
      runSearch(input);
    },
    [runSearch],
  );

  // ── Facet dismissal (chip ×) — re-run with the facet removed; numbers count to new values ──────
  const dismissFacet = useCallback(
    (key: PayerIntelFacetKey, value: string | null) => {
      const prev = lastInput.current;
      const cur = result;
      if (cur === null) return;
      const next: PayerIntelSearchInput = {
        payer: key === 'payer' ? null : cur.facets.payer,
        prefix: key === 'prefix' ? null : cur.facets.prefix,
        facilities: key === 'facility' ? cur.facets.facilities.filter((f) => f !== value) : cur.facets.facilities,
        employerNames:
          key === 'employer' ? cur.facets.employerNames.filter((e) => e !== value) : cur.facets.employerNames,
        funding: key === 'funding' ? cur.facets.funding.filter((f) => f !== value) : cur.facets.funding,
        groupNumber: key === 'group' ? null : (prev.groupNumber ?? null),
        cpt: key === 'cpt_rev' ? null : cur.facets.cpt,
        revenue: key === 'cpt_rev' ? null : cur.facets.revenue,
        windowDays: cur.facets.windowDays,
      };
      const anyLeft =
        next.payer !== null ||
        next.prefix !== null ||
        (next.facilities?.length ?? 0) > 0 ||
        (next.employerNames?.length ?? 0) > 0 ||
        (next.funding?.length ?? 0) > 0 ||
        next.groupNumber !== null ||
        next.cpt !== null;
      if (!anyLeft) {
        clearAll();
        return;
      }
      runSearch(next);
    },
    [clearAll, result, runSearch],
  );

  // ── Drill-downs (a summary row IS a filter) ─────────────────────────────────────────────────────
  const drillPayer = useCallback(
    (label: string) => runSearch({ ...lastInput.current, payer: label }),
    [runSearch],
  );
  const drillFacility = useCallback(
    (label: string) => {
      const cur = lastInput.current.facilities ?? [];
      runSearch({ ...lastInput.current, facilities: cur.includes(label) ? cur : [...cur, label] });
    },
    [runSearch],
  );
  const drillCombo = useCallback(
    (cpt: string | null, revenue: string | null) =>
      runSearch({ ...lastInput.current, cpt, revenue }),
    [runSearch],
  );

  // ── Saved-search handlers ───────────────────────────────────────────────────────────────────────
  const toggleStar = useCallback(
    (s: PayerIntelSavedSearch) => {
      // Optimistic flip; reconcile from the server after.
      setBoard((b) => {
        const flip = (arr: readonly PayerIntelSavedSearch[]) =>
          arr.map((x) => (x.id === s.id ? { ...x, starred: !s.starred } : x));
        const all = [...flip(b.searches.starred), ...flip(b.searches.recent)];
        return {
          ...b,
          searches: { starred: all.filter((x) => x.starred), recent: all.filter((x) => !x.starred) },
        };
      });
      void togglePayerIntelStar(s.id, !s.starred)
        .then((r) => {
          if (!r.ok) refreshBoard(windowDays); // roll back the optimistic flip (limit / not found / failed)
        })
        // A rejected star must roll the optimistic flip back too, or the UI shows a star that
        // never persisted.
        .catch(() => refreshBoard(windowDays));
    },
    [refreshBoard, windowDays],
  );

  const rerunSaved = useCallback(
    (s: PayerIntelSavedSearch) => {
      transitionToResult({ payer: s.payer, prefix: s.prefixEcho });
    },
    [transitionToResult],
  );

  const clearHistory = useCallback(() => {
    setBoard((b) => ({ ...b, searches: { ...b.searches, recent: [] } }));
    void clearPayerIntelHistory()
      .then(() => refreshBoard(windowDays))
      .catch(() => refreshBoard(windowDays)); // reconcile either way — the optimistic clear may not have stuck
  }, [refreshBoard, windowDays]);

  // ── Rail seeds ──────────────────────────────────────────────────────────────────────────────────
  const seedFromGainer = useCallback(
    (item: QualifyPolicyTapeItem) => {
      transitionToResult({ payer: item.payer, prefix: item.echo ?? item.prefix });
    },
    [transitionToResult],
  );
  const seedFromDecliner = useCallback(
    (item: PayerIntelDeclinerItem) => {
      // The rail's facility label IS the rollup text — exactly what the filter matches.
      transitionToResult({ facilities: [item.facility] });
    },
    [transitionToResult],
  );

  const onSubmit = useCallback(
    (s: PayerIntelSearchBarSubmit) => {
      transitionToResult({
        term: s.term,
        payer: s.payer,
        facilities: s.facilities,
        employerNames: s.employerNames,
        funding: s.funding,
        groupNumber: s.groupNumber,
      });
    },
    [transitionToResult],
  );

  const onWatch = useCallback(() => {
    const cur = result;
    if (cur === null || cur.facets.payer === null) return;
    setWatchState('saving');
    void watchPayerIntelSubject(cur.facets.payer, cur.facets.prefix)
      .then((r) => {
        setWatchState(r.ok ? 'saved' : 'failed');
      })
      .catch(() => setWatchState('failed')); // the button says "Retry watch" rather than sticking on "Saving…"
  }, [result]);

  const employerSearch = useCallback(async (term: string) => {
    try {
      const r = await searchPayerIntelEmployers(term);
      return r.ok ? r.employers : [];
    } catch {
      return []; // a type-ahead that throws must not take the search bar down with it
    }
  }, []);

  const searchBar = (compressed: boolean) => (
    <PayerIntelSearchBar
      payers={facetOptions.payers}
      facilities={facetOptions.facilities}
      compressed={compressed}
      busy={busy}
      windowDays={windowDays}
      onWindowDaysChange={changeWindowDays}
      onSubmit={onSubmit}
      onEmployerSearch={employerSearch}
    />
  );

  return (
    <div ref={rootRef} className="space-y-7">
      {/* Polite narration for AT: search progress + result count, never a focus steal. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      {failed ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm" style={{ color: '#B64138' }}>
          The search failed — nothing was shown rather than something wrong. Try again.
        </div>
      ) : null}

      {mode === 'idle' ? (
        <>
          {/* The rails stay FULL-BLEED above the split — a marquee wants every pixel of track. */}
          <PayerIntelGainersRail
            items={board.gainers.items}
            asOf={board.gainers.asOf}
            deltaDays={board.gainers.deltaDays}
            onSeed={seedFromGainer}
          />
          <PayerIntelDeclinersRail
            items={board.decliners.items}
            windowDays={board.decliners.windowDays}
            thresholdPts={board.decliners.thresholdPts}
            onSeed={seedFromDecliner}
          />
          <div className={SPLIT}>
            <div className="min-w-0 space-y-7">
              {searchBar(false)}
              {/* Saved searches sit DIRECTLY under the bar (2026-08-17 review) — they ARE searches. */}
              <PayerIntelSavedSearches
                starred={board.searches.starred}
                recent={board.searches.recent}
                persisted
                onToggleStar={toggleStar}
                onRerun={rerunSaved}
                onClearHistory={clearHistory}
              />
            </div>
            <aside className={RAIL}>
              <PayerIntelCensusPanel rows={board.census.rows} syncedAt={board.census.syncedAt} />
            </aside>
          </div>
        </>
      ) : result !== null ? (
        <>
          {searchBar(true)}
          {/* Focus target for the completed search — tabIndex -1 so it is programmatic-only. */}
          <div ref={resultHeadingRef} tabIndex={-1} className="outline-none">
            <PayerIntelHero
              result={result}
              watchState={watchState}
              onWatch={onWatch}
              onDismissFacet={dismissFacet}
              onClearAll={clearAll}
            />
          </div>
          {/* The three percentages sit DIRECTLY under the hero (2026-08-17 ruling) — they are the
              answer to "how does this policy pay", and everything below is the breakdown of it. */}
          <PayerIntelPctBand result={result} />
          <div className={SPLIT}>
            <div className="min-w-0 space-y-7">
              {/* ONE box, divided into sections — the Collections summary-card shape. */}
              <PayerIntelSectionBox>
                <div className="p-4">
                  <PayerIntelTopGroups
                    byPayer={result.byPayer}
                    byFacility={result.byFacility}
                    onDrillPayer={drillPayer}
                    onDrillFacility={drillFacility}
                  />
                </div>
                <div className="p-4">
                  <PayerIntelPlacementTable
                    items={result.placement}
                    window={result.window}
                    censusSyncedAt={board.census.syncedAt}
                    cohortLabel={result.facets.prefix ?? result.facets.payer ?? 'this search'}
                  />
                </div>
                <div className="p-4">
                  <PayerIntelChargeLines
                    combos={result.combos}
                    totalLines={result.totals.lineCount}
                    onDrillCombo={drillCombo}
                  />
                </div>
              </PayerIntelSectionBox>
              {/* Charge lines stay their OWN section: row-level detail with its own paging and
                  its own failure state, not a panel of the summary. */}
              <PayerIntelGridTable
                page={grid}
                loading={gridLoading}
                failed={gridFailed}
                onRetry={() => loadGrid(lastInput.current, null)}
                onLoadMore={() => loadGrid(lastInput.current, grid?.nextCursor ?? null)}
              />
              <PayerIntelAiPanel generate={() => generatePayerIntelAiRead(lastInput.current)} />
            </div>
            {/* The census rides on RESULT too (2026-08-17 ruling) — same rail, same panel. */}
            <aside className={RAIL}>
              <PayerIntelCensusPanel rows={board.census.rows} syncedAt={board.census.syncedAt} />
            </aside>
          </div>
        </>
      ) : null}
    </div>
  );
}
