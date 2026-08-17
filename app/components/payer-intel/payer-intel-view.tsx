'use client';

/**
 * The /payer-intel client island — one route, two view states:
 *   IDLE   — ambient: gainers rail · decliners rail · search · census · starred/recent
 *   RESULT — hero · ON FILE chips · percentage band · placement · charge lines · AI cohort read
 *
 * STATE TRANSITIONS ARE CLIENT-SIDE; the URL carries ONLY the non-PHI facet allowlist
 * (contract.ts codec) via history.replaceState so results are shareable without a navigation.
 * Terms (group numbers) never touch the URL; a shared link restores the allowlisted facets and
 * the UI is honest about the rest.
 *
 * MOTION (spec §5, house GSAP pattern — no @gsap/react exists; useLayoutEffect + gsap.context +
 * ctx.revert, matchMedia bail FIRST): IDLE sections stagger in once (300ms, 40ms apart, 8px
 * rise); IDLE→RESULT fades the ambient sections out 200ms then staggers the result in
 * left→right, the three percentage cards in math order (allowed → paid → collected, 80ms);
 * numbers count up via useCountUp; chips scale out 150ms on dismiss. Every leg bails under
 * prefers-reduced-motion — the CSS global reset cannot reach a GSAP tween, so each effect checks
 * matchMedia itself.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import type { QualifyPolicyTapeItem } from '../../lib/qualify/board';
import type {
  PayerIntelBoard,
  PayerIntelDeclinerItem,
  PayerIntelFacetKey,
  PayerIntelResult,
  PayerIntelSavedSearch,
  PayerIntelSearchInput,
  PayerIntelUrlState,
} from '../../lib/payer-intel/contract';
import { encodePayerIntelUrl } from '../../lib/payer-intel/contract';
import {
  clearPayerIntelHistory,
  getPayerIntelBoard,
  runPayerIntelSearch,
  searchPayerIntelEmployers,
  togglePayerIntelStar,
  watchPayerIntelSubject,
} from '../../lib/payer-intel/actions';
import { generatePayerIntelAiRead } from '../../lib/payer-intel/ai-actions';
import { PayerIntelGainersRail, PayerIntelDeclinersRail } from './idle-rails';
import { PayerIntelCensusStrip } from './census-strip';
import { PayerIntelSavedSearches } from './saved-searches';
import { PayerIntelSearchBar, type PayerIntelSearchBarSubmit } from './search-bar';
import { PayerIntelHero, PayerIntelPctBand, PayerIntelPlacementTable, PayerIntelChargeLines } from './result-sections';
import { PayerIntelAiPanel } from './ai-panel';

function reducedMotion(): boolean {
  return typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function PayerIntelView({
  initialBoard,
  initialUrlState,
  facetOptions,
}: {
  initialBoard: PayerIntelBoard;
  /** Decoded server-side from searchParams (non-PHI allowlist only) — a shared link auto-runs. */
  initialUrlState: PayerIntelUrlState;
  facetOptions: {
    facilities: { code: string; name: string; careSetting: 'IP' | 'OP' | 'BOTH' | null }[];
    payers: string[];
  };
}) {
  const [board, setBoard] = useState(initialBoard);
  const [mode, setMode] = useState<'idle' | 'result'>('idle');
  const [result, setResult] = useState<PayerIntelResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [watchState, setWatchState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const lastInput = useRef<PayerIntelSearchInput>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const idleAnimated = useRef(false);
  const searchSeq = useRef(0);

  const facilityNameOf = useCallback(
    (code: string) => facetOptions.facilities.find((f) => f.code === code)?.name ?? code,
    [facetOptions.facilities],
  );

  const syncUrl = useCallback((res: PayerIntelResult | null) => {
    if (typeof window === 'undefined') return;
    const state: PayerIntelUrlState =
      res === null
        ? { payer: null, prefix: null, facilityCodes: [], funding: [] }
        : {
            payer: res.facets.payer,
            prefix: res.facets.prefix,
            facilityCodes: res.facets.facilityCodes,
            funding: res.facets.funding,
          };
    window.history.replaceState(null, '', `${window.location.pathname}${encodePayerIntelUrl(state)}`);
  }, []);

  const refreshBoard = useCallback(() => {
    void getPayerIntelBoard().then((r) => {
      if (r.ok) setBoard(r.board);
    });
  }, []);

  const runSearch = useCallback(
    (input: PayerIntelSearchInput) => {
      const seq = ++searchSeq.current;
      setBusy(true);
      setFailed(false);
      lastInput.current = input;
      void runPayerIntelSearch(input).then((r) => {
        if (searchSeq.current !== seq) return; // superseded
        setBusy(false);
        if (!r.ok) {
          setFailed(true);
          return;
        }
        setWatchState('idle');
        setResult(r.result);
        setMode('result');
        syncUrl(r.result);
        refreshBoard(); // the search we just ran lands in Recent
      });
    },
    [refreshBoard, syncUrl],
  );

  // A shared/bookmarked link with facets auto-runs once on mount.
  useEffect(() => {
    const u = initialUrlState;
    if (u.payer !== null || u.prefix !== null || u.facilityCodes.length > 0 || u.funding.length > 0) {
      runSearch({
        payer: u.payer,
        prefix: u.prefix,
        facilityCodes: u.facilityCodes,
        funding: u.funding,
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
  const transitionToResult = useCallback((input: PayerIntelSearchInput) => {
    const root = rootRef.current;
    if (root === null || reducedMotion()) {
      runSearch(input);
      return;
    }
    const sections = gsap.utils.toArray<HTMLElement>('[data-pi-section]', root);
    gsap.to(sections, { opacity: 0, y: -6, duration: 0.2, ease: 'power2.out' });
    runSearch(input);
  }, [runSearch]);

  // ── Facet dismissal (chip ×) — re-run with the facet removed; numbers count to new values ──────
  const dismissFacet = useCallback(
    (key: PayerIntelFacetKey, value: string | null) => {
      const prev = lastInput.current;
      const cur = result;
      if (cur === null) return;
      const next: PayerIntelSearchInput = {
        payer: key === 'payer' ? null : cur.facets.payer,
        prefix: key === 'prefix' ? null : cur.facets.prefix,
        facilityCodes:
          key === 'facility' ? cur.facets.facilityCodes.filter((c) => c !== value) : cur.facets.facilityCodes,
        employerNames:
          key === 'employer' ? cur.facets.employerNames.filter((e) => e !== value) : cur.facets.employerNames,
        funding: key === 'funding' ? cur.facets.funding.filter((f) => f !== value) : cur.facets.funding,
        groupNumber: key === 'group' ? null : (prev.groupNumber ?? null),
      };
      const anyLeft =
        next.payer !== null ||
        next.prefix !== null ||
        (next.facilityCodes?.length ?? 0) > 0 ||
        (next.employerNames?.length ?? 0) > 0 ||
        (next.funding?.length ?? 0) > 0 ||
        next.groupNumber !== null;
      if (!anyLeft) {
        clearAll();
        return;
      }
      runSearch(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearAll defined below (stable)
    [result, runSearch],
  );

  const clearAll = useCallback(() => {
    searchSeq.current += 1; // cancel any in-flight search
    lastInput.current = {};
    setResult(null);
    setMode('idle');
    setBusy(false);
    idleAnimated.current = false; // the ambient board re-enters with its stagger
    syncUrl(null);
  }, [syncUrl]);

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
      void togglePayerIntelStar(s.id, !s.starred).then((r) => {
        if (!r.ok) refreshBoard(); // roll back the optimistic flip (limit hit / not found / failed)
      });
    },
    [refreshBoard],
  );

  const rerunSaved = useCallback(
    (s: PayerIntelSavedSearch) => {
      transitionToResult({ payer: s.payer, prefix: s.prefixEcho });
    },
    [transitionToResult],
  );

  const clearHistory = useCallback(() => {
    setBoard((b) => ({ ...b, searches: { ...b.searches, recent: [] } }));
    void clearPayerIntelHistory().then(() => refreshBoard());
  }, [refreshBoard]);

  // ── Rail seeds ──────────────────────────────────────────────────────────────────────────────────
  const seedFromGainer = useCallback(
    (item: QualifyPolicyTapeItem) => {
      transitionToResult({ payer: item.payer, prefix: item.echo ?? item.prefix });
    },
    [transitionToResult],
  );
  const seedFromDecliner = useCallback(
    (item: PayerIntelDeclinerItem) => {
      if (item.facilityCode !== null) transitionToResult({ facilityCodes: [item.facilityCode] });
    },
    [transitionToResult],
  );

  const onSubmit = useCallback(
    (s: PayerIntelSearchBarSubmit) => {
      transitionToResult({
        term: s.term,
        payer: s.payer,
        facilityCodes: s.facilityCodes,
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
    void watchPayerIntelSubject(cur.facets.payer, cur.facets.prefix).then((r) => {
      setWatchState(r.ok ? 'saved' : 'failed');
    });
  }, [result]);

  const employerSearch = useCallback(async (term: string) => {
    const r = await searchPayerIntelEmployers(term);
    return r.ok ? r.employers : [];
  }, []);

  return (
    <div ref={rootRef} className="space-y-7">
      {failed ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm" style={{ color: '#B64138' }}>
          The search failed — nothing was shown rather than something wrong. Try again.
        </div>
      ) : null}

      {mode === 'idle' ? (
        <>
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
          <PayerIntelSearchBar
            payers={facetOptions.payers}
            facilities={facetOptions.facilities}
            compressed={false}
            busy={busy}
            onSubmit={onSubmit}
            onEmployerSearch={employerSearch}
          />
          <PayerIntelCensusStrip rows={board.census.rows} syncedAt={board.census.syncedAt} />
          <PayerIntelSavedSearches
            starred={board.searches.starred}
            recent={board.searches.recent}
            persisted
            onToggleStar={toggleStar}
            onRerun={rerunSaved}
            onClearHistory={clearHistory}
          />
        </>
      ) : result !== null ? (
        <>
          <PayerIntelSearchBar
            payers={facetOptions.payers}
            facilities={facetOptions.facilities}
            compressed
            busy={busy}
            onSubmit={onSubmit}
            onEmployerSearch={employerSearch}
          />
          <PayerIntelHero
            result={result}
            facilityNameOf={facilityNameOf}
            watchState={watchState}
            onWatch={onWatch}
            onDismissFacet={dismissFacet}
            onClearAll={clearAll}
          />
          <PayerIntelPctBand result={result} />
          <PayerIntelPlacementTable
            items={result.placement}
            window={result.window}
            censusSyncedAt={board.census.syncedAt}
            cohortLabel={result.facets.prefix ?? result.facets.payer ?? 'this search'}
          />
          <PayerIntelChargeLines combos={result.combos} totalLines={result.totals.lineCount} />
          <PayerIntelAiPanel generate={() => generatePayerIntelAiRead(lastInput.current)} />
        </>
      ) : null}
    </div>
  );
}
