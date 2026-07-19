'use client';

/**
 * Qualify tab — the interactive container. Owns search/window/toggle/modal state and is the caller of
 * the Qualify Server Actions (the browser's sole data path): getQualifySnapshot (member/prefix search),
 * getQualifySnapshotByPayer (resolve-by-payer), and getQualifyMovers (for the on-load default). It
 * hands plain, already-shaped data to the pure presentational children (facility panel, cases table,
 * VOB modal).
 *
 * PER-FACILITY CASES (ruling Q-4 / Prompt-4 finding #4): the "Recent cases" panel shows the 15
 * most-recent distinct patients for the resolved payer FILTERED TO THE SELECTED FACILITY — never the
 * payer-wide set (the mockup's "same 15 regardless of facility" bug). Selecting a facility row calls
 * the existing getQualifyFacilityCases action (same server path the mobile card-tap uses; cross-tenant,
 * masked, amounts stripped server-side). On every resolve we auto-select the rank-1 facility so the
 * tab lands populated. A facility switch discards any revealed PHI — the same scope-change rule a new
 * search follows (each drill is its own audited access). snapshot.cases (payer-wide) is intentionally
 * left fetched-but-unrendered here — dropping it would change the shared getQualifySnapshot contract.
 *
 * ON LOAD it auto-resolves the top "Heating up" payer so the tab lands POPULATED (matching the
 * mockup's populated-on-load feel) instead of an empty search prompt. The user can then search or
 * change the window to switch payers; a manual search clears the by-payer default.
 *
 * Amounts capability is server-authoritative: it comes from the snapshot once one exists, and is
 * seeded before the first search by the server-derived prop so an admissions_seat never renders the
 * $ column headers even on the empty state.
 *
 * Window control is 7/14/30/60/90 (contract QUALIFY_WINDOW_OPTIONS) — the mock's "Month" was
 * dropped (Alec) because it is a different window shape than the contract's trailing-N-days math.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Search } from 'lucide-react';
import {
  getQualifySnapshot,
  getQualifySnapshotByPayer,
  getQualifyFacilityCases,
  getQualifyMovers,
  revealQualifyRow,
} from '@/lib/qualify/actions';
import {
  QUALIFY_WINDOW_OPTIONS,
  type QualifySnapshot,
  type QualifyWindowDays,
  type QualifyCase,
  type QualifyMover,
  type QualifyPhi,
} from '@/lib/qualify/contract';
import { buildFacilityBucketMap } from '@/components/qualify/colors';
import { FacilityPanel } from '@/components/qualify/facility-panel';
import { CasesTable } from '@/components/qualify/cases-table';
import { HeatingUpBar } from '@/components/qualify/heating-up-bar';
import { VobModal } from '@/components/qualify/vob-modal';

const MIN_QUERY_LEN = 3;

/** windowStart (inclusive) .. windowEnd (EXCLUSIVE) → "Jun 18 – Jul 17, 2026" (inclusive last day). */
function formatWindowRange(startIso: string, endExclusiveIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`);
  const endIncl = new Date(new Date(`${endExclusiveIso}T00:00:00Z`).getTime() - 86_400_000);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mo(start)} ${start.getUTCDate()} – ${mo(endIncl)} ${endIncl.getUTCDate()}, ${endIncl.getUTCFullYear()}`;
}

export function QualifyTab({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const [query, setQuery] = useState('');
  const [windowDays, setWindowDays] = useState<QualifyWindowDays>(30);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [isPending, startTransition] = useTransition();
  // Per-facility cases drill (ruling Q-4): the raw facilityKey currently scoping the cases panel, and
  // that facility's 15 most-recent distinct patients (from getQualifyFacilityCases). A dedicated
  // transition so a facility-to-facility switch doesn't co-mingle with the payer-resolve pending state.
  const [selectedFacilityKey, setSelectedFacilityKey] = useState<string | null>(null);
  const [facilityCases, setFacilityCases] = useState<QualifyCase[]>([]);
  const [isFacilityPending, startFacilityTransition] = useTransition();
  // "Heating up" payer quick-pick (desktop parity with mobile): trending payers for the current window,
  // rendered as a click-to-resolve chip row. Fetched on load + re-fetched on window change.
  const [movers, setMovers] = useState<QualifyMover[]>([]);
  const [heatOn, setHeatOn] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // Non-null when the CURRENT resolution came from the by-payer path (the on-load default or a future
  // payer tap), so a window change re-resolves by payer instead of re-running an (empty) search.
  const [byPayer, setByPayer] = useState<string | null>(null);
  // True until the on-load auto-resolve of the top payer settles (so we show "Resolving…", not the
  // empty search prompt, on first paint).
  const [initializing, setInitializing] = useState(true);
  // PHI reveal (Prompt 3c): `revealed` caches the FETCHED PHI for the session (never dropped on hide);
  // `shown` controls visibility. Toggling a revealed row off/on never re-audits — one audited
  // revealQualifyRow per row per session. All four reset on a new search.
  const [revealed, setRevealed] = useState<Map<number, QualifyPhi>>(() => new Map());
  const [shown, setShown] = useState<Set<number>>(() => new Set());
  const [pendingIds, setPendingIds] = useState<Set<number>>(() => new Set());
  const [revealErrors, setRevealErrors] = useState<Map<number, string>>(() => new Map());
  // Resolution identity (search-is-authority). Every resolution entry point (runSearch / resolveByPayer /
  // selectFacility) bumps-and-captures this at entry; every post-await write guards `genRef.current === gen`
  // and bails otherwise. So a newer resolution DISCARDS any in-flight older chip/facility/reveal write —
  // the header (snapshot) and the rows (facilityCases) can never be sourced from two different resolutions.
  // A reveal CAPTURES the current gen (without bumping) so a stale reveal can't re-populate PHI after a
  // newer resolution's resetReveal(). Window changes don't touch this ref (independent control).
  const genRef = useRef(0);

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;
  const facilityBuckets = useMemo(
    () => buildFacilityBucketMap(snapshot?.facilities ?? []),
    [snapshot],
  );

  // Discard any revealed PHI — used on every scope change (new search, new payer, facility switch).
  const resetReveal = useCallback(() => {
    setRevealed(new Map());
    setShown(new Set());
    setPendingIds(new Set());
    setRevealErrors(new Map());
  }, []);

  // Auto-select the rank-1 facility of a fresh snapshot and fetch ITS cases, so the tab lands with the
  // cases panel already scoped to a facility (never the payer-wide set). Returns key+cases so the caller
  // sets snapshot/selection/cases together (one paint, no empty-cases flash). Throws propagate to the
  // resolve transition's catch — a facility-cases failure is surfaced as a resolve failure, not silently
  // swallowed into a good-snapshot-with-no-cases state.
  const seedFacility = useCallback(
    async (snap: QualifySnapshot, w: QualifyWindowDays): Promise<{ key: string | null; cases: QualifyCase[] }> => {
      const top = snap.resolved ? snap.facilities[0] : undefined;
      if (!snap.resolved || !top) return { key: null, cases: [] };
      const res = await getQualifyFacilityCases({ payer: snap.resolved.payerName, facility: top.facilityKey, windowDays: w });
      return { key: top.facilityKey, cases: res.cases };
    },
    [],
  );

  const runSearch = useCallback((rawQuery: string, w: QualifyWindowDays) => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setHint(`Enter at least a ${MIN_QUERY_LEN}-letter alpha prefix or a full member ID.`);
      return;
    }
    setHint(null);
    // New search → discard any revealed PHI from the previous payer.
    resetReveal();
    const gen = ++genRef.current; // this search is now the authoritative resolution
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: trimmed, windowDays: w });
        // Seed the rank-1 facility's cases BEFORE committing state, so snapshot + selection + cases
        // land in one paint (ruling Q-4: the cases panel is always facility-scoped, never payer-wide).
        const seed = await seedFacility(snap, w);
        if (genRef.current !== gen) return; // a newer resolution superseded this search — discard
        setSnapshot(snap);
        setSelectedFacilityKey(seed.key);
        setFacilityCases(seed.cases);
        setHasSearched(true);
        setByPayer(null); // an explicit search supersedes the by-payer default
        if (snap.resolved === null) {
          setEcho(trimmed);
          setModalOpen(true);
        } else {
          setModalOpen(false);
        }
      } catch {
        // The action fails closed (throws) when there is no per-user principal to audit against
        // (e.g. the no-auth staged-rollout fallback) or on a transient error — surface a friendly
        // hint rather than an uncaught rejection. Never echoes the underlying error (could name a
        // field/config).
        if (genRef.current !== gen) return; // don't surface a stale error over a newer resolution
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }, [resetReveal, seedFacility]);

  // Resolve directly by payer label (the on-load default; reuses the resolve-by-payer action). Mirrors
  // runSearch's reveal-state reset. Sets `byPayer` so a window change re-resolves this payer.
  const resolveByPayer = useCallback((payer: string, w: QualifyWindowDays) => {
    setHint(null);
    resetReveal();
    const gen = ++genRef.current; // this chip resolve is now the authoritative resolution
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshotByPayer({ payer, windowDays: w });
        const seed = await seedFacility(snap, w); // auto-select rank-1 facility (see runSearch)
        if (genRef.current !== gen) return; // a newer resolution (e.g. a search) superseded this — discard
        setSnapshot(snap);
        setSelectedFacilityKey(seed.key);
        setFacilityCases(seed.cases);
        setHasSearched(true);
        setByPayer(payer);
        setModalOpen(false);
      } catch {
        if (genRef.current !== gen) return; // don't surface a stale error over a newer resolution
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }, [resetReveal, seedFacility]);

  // Facility row click → re-scope the cases panel to that facility. Highlights instantly; discards any
  // revealed PHI (scope change, re-audited); no-ops on the already-selected row so it can't re-audit.
  const selectFacility = useCallback(
    (facilityKey: string) => {
      const payer = snapshot?.resolved?.payerName;
      if (!payer || facilityKey === selectedFacilityKey) return;
      const gen = ++genRef.current; // a facility drill is a new resolution identity for the cases panel
      setSelectedFacilityKey(facilityKey);
      resetReveal();
      startFacilityTransition(async () => {
        try {
          const res = await getQualifyFacilityCases({ payer, facility: facilityKey, windowDays });
          if (genRef.current !== gen) return; // a newer resolution/drill superseded this fetch — discard
          setFacilityCases(res.cases);
        } catch {
          if (genRef.current !== gen) return; // don't surface a stale error over a newer resolution
          setHint('Qualify is unavailable right now. Please try again.');
        }
      });
    },
    [snapshot, selectedFacilityKey, windowDays, resetReveal],
  );

  // On load, land POPULATED: fetch the "Heating up" movers (for the quick-pick chip row) and resolve
  // the top one (highest distinct-patient mover). If there are no movers or the fetch fails, fall
  // through to the empty search prompt. Runs once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await getQualifyMovers(windowDays);
        if (!alive) return;
        setMovers(m.movers);
        const top = m.movers[0]?.label;
        if (top) resolveByPayer(top, windowDays);
      } catch {
        // leave the empty prompt — the user can still search
      } finally {
        if (alive) setInitializing(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the "Heating up" chip row tracking the window: re-fetch movers whenever windowDays changes
  // (the initial window is covered by the on-load effect above; skip the mount run to avoid a double
  // fetch). Chip-row only — does NOT re-resolve; onWindow already re-resolves the active payer/search.
  const moversInitDone = useRef(false);
  useEffect(() => {
    if (!moversInitDone.current) {
      moversInitDone.current = true;
      return;
    }
    let alive = true;
    getQualifyMovers(windowDays)
      .then((m) => {
        if (alive) setMovers(m.movers);
      })
      .catch(() => {
        /* stale/failed movers just leave the prior chips — never blocks search */
      });
    return () => {
      alive = false;
    };
  }, [windowDays]);

  const toggleReveal = useCallback(
    (id: number) => {
      // Hide (visibility only — keep the fetched PHI cached).
      if (shown.has(id)) {
        setShown((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return;
      }
      // Already fetched this session → just show it again. No re-fetch, no re-audit.
      if (revealed.has(id)) {
        setShown((s) => new Set(s).add(id));
        return;
      }
      if (pendingIds.has(id)) return; // in flight
      // First reveal for this row → the ONE audited fetch.
      setPendingIds((p) => new Set(p).add(id));
      setRevealErrors((e) => {
        const n = new Map(e);
        n.delete(id);
        return n;
      });
      // CAPTURE (don't bump) the current resolution identity: if a newer resolution lands while this
      // reveal is in flight, its resetReveal() has already cleared PHI state — bail so this stale reveal
      // can't re-populate revealed/shown for a row that no longer belongs to the visible resolution.
      const gen = genRef.current;
      void (async () => {
        try {
          const res = await revealQualifyRow(id);
          if (genRef.current !== gen) return; // stale reveal — a newer resolution superseded it
          setPendingIds((p) => {
            const n = new Set(p);
            n.delete(id);
            return n;
          });
          if (res.ok) {
            setRevealed((m) => new Map(m).set(id, res.phi));
            setShown((s) => new Set(s).add(id));
          } else {
            setRevealErrors((e) => new Map(e).set(id, res.error));
          }
        } catch {
          if (genRef.current !== gen) return; // stale reveal — a newer resolution superseded it
          setPendingIds((p) => {
            const n = new Set(p);
            n.delete(id);
            return n;
          });
          setRevealErrors((e) => new Map(e).set(id, 'Reveal is unavailable right now.'));
        }
      })();
    },
    [shown, revealed, pendingIds],
  );

  const onWindow = (w: QualifyWindowDays) => {
    setWindowDays(w);
    // Re-resolve so the panels track the new window — by payer if that's how we resolved, else by the
    // search query. (Only when something is already resolved.)
    if (byPayer) resolveByPayer(byPayer, w);
    else if (snapshot?.resolved) runSearch(query, w);
  };

  const resolved = snapshot?.resolved ?? null;
  // Human name of the selected facility, for the cases-panel scope label (display only, never PHI).
  const selectedFacilityLabel =
    snapshot?.facilities.find((f) => f.facilityKey === selectedFacilityKey)?.name ?? null;

  return (
    <main className="mx-auto max-w-[1280px] space-y-4 p-6 sm:p-8">
      {/* page head + color-layer toggle */}
      <div className="flex items-end justify-between gap-5">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Qualify</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Admissions lead qualification · resolve a payer, read facility performance and recent cases
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={heatOn}
          onClick={() => setHeatOn((v) => !v)}
          className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"
        >
          <span>Color layer</span>
          <span className={['relative h-[22px] w-[38px] rounded-full transition-colors', heatOn ? 'bg-teal700' : 'bg-line'].join(' ')}>
            <span
              className={['absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-ths transition-all', heatOn ? 'left-[18px]' : 'left-0.5'].join(' ')}
            />
          </span>
        </button>
      </div>

      {/* filter / search bar */}
      <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-t-2 border-t-teal700 bg-card p-3.5 shadow-sm">
        <div className="relative min-w-[280px] max-w-[460px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(query, windowDays);
            }}
            spellCheck={false}
            placeholder="3-letter alpha prefix or member ID"
            aria-label="Member ID or alpha prefix"
            className="h-10 w-full rounded-xl border bg-background pl-9 pr-3 text-sm text-ink900 outline-none focus:border-teal500 focus:bg-white focus:ring-4 focus:ring-teal50"
          />
        </div>
        <button
          type="button"
          onClick={() => runSearch(query, windowDays)}
          disabled={isPending}
          className="rounded-xl border border-teal200 bg-teal50 px-4 py-2 text-[13px] font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-60"
        >
          {isPending ? 'Resolving…' : 'Resolve payer'}
        </button>
        <div className="h-6 w-px bg-line" />
        <div className="inline-flex rounded-full border bg-background p-0.5" role="group" aria-label="Time window">
          {QUALIFY_WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWindow(w)}
              aria-pressed={windowDays === w}
              className={['rounded-full px-3 py-1.5 text-xs font-semibold transition-colors', windowDays === w ? 'bg-teal700 text-white' : 'text-muted-foreground hover:text-ink900'].join(' ')}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      {hint ? <p className="px-1 text-xs text-status-warn">{hint}</p> : null}

      {/* "Heating up" payer quick-pick — click a chip to resolve that payer (parity with mobile) */}
      <HeatingUpBar
        movers={movers}
        windowDays={windowDays}
        activeLabel={byPayer}
        onOpen={(label) => resolveByPayer(label, windowDays)}
      />

      {/* resolved context */}
      {resolved ? (
        <div className="flex flex-wrap items-center gap-3 px-0.5">
          <span className="inline-flex items-center gap-2 rounded-full bg-teal900 py-1.5 pl-3 pr-3.5 text-[13.5px] font-semibold text-white">
            <span className="text-[10px] font-bold uppercase tracking-wider text-teal200">Resolved payer</span>
            {resolved.payerName}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {resolved.matchedOn === 'prefix' ? (
              <>
                matched on prefix <span className="font-mono text-ink900">{resolved.matchedValue}</span>
              </>
            ) : resolved.matchedOn === 'payer' ? (
              <>top payer this window</>
            ) : (
              <>matched on member ID</>
            )}{' '}
            · <span className="font-mono text-ink900">{resolved.totalCharges.toLocaleString('en-US')}</span> charges across{' '}
            <span className="font-mono text-ink900">{resolved.facilityCount}</span> facilities · window{' '}
            <span className="font-mono text-ink900">{formatWindowRange(resolved.windowStart, resolved.windowEnd)}</span>
          </span>
        </div>
      ) : null}

      {/* grid or empty prompt */}
      {snapshot && snapshot.resolved ? (
        <div className="grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[340px_1fr]">
          <FacilityPanel
            facilities={snapshot.facilities}
            hasAmounts={hasAmounts}
            heatOn={heatOn}
            selectedKey={selectedFacilityKey}
            onSelect={selectFacility}
          />
          <div
            aria-busy={isFacilityPending}
            className={['transition-opacity', isFacilityPending ? 'opacity-60' : ''].join(' ')}
          >
            <CasesTable
              cases={facilityCases}
              hasAmounts={hasAmounts}
              heatOn={heatOn}
              facilityBuckets={facilityBuckets}
              facilityLabel={selectedFacilityLabel}
              canReveal={canRevealPhi}
              revealed={revealed}
              shown={shown}
              pendingIds={pendingIds}
              revealErrors={revealErrors}
              onToggle={toggleReveal}
            />
          </div>
        </div>
      ) : initializing || isPending ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Resolving…
        </div>
      ) : (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          {hasSearched
            ? 'No payer resolved for that identifier in the selected window.'
            : 'Search a member ID or 3-letter alpha prefix to resolve a payer and see facility performance and recent cases.'}
        </div>
      )}

      <VobModal open={modalOpen} query={echo} onClose={() => setModalOpen(false)} />
    </main>
  );
}
