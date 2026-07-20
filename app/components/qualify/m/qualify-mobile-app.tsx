'use client';

/**
 * Qualify mobile PWA — the interactive shell (Prompt 4b). Owns the search, the "Heating up" module,
 * and the 5-row sliding-window swipe list; it is the only caller of getQualifySnapshot /
 * getQualifyMovers. Facilities render in the contract's rating-desc order (never re-sorted here).
 *
 * Left-swipe → advance (pass, removes the facility). Right-swipe → peek the rating "why" sheet,
 * NON-destructive (the facility stays in the deck; closing the sheet does NOT advance). Tap → open
 * the facility detail (no advance). Reset re-seeds the deck from the SAME resolved payer's
 * facilities back to the top of rating order — it does NOT clear the search or re-resolve.
 */
import { useCallback, useEffect, useReducer, useRef, useState, useTransition, type ReactNode } from 'react';
import { getQualifySnapshot, getQualifySnapshotByPayer, getQualifyFacilityCases, getQualifyMovers, revealQualifyRows } from '@/lib/qualify/actions';
import { QUALIFY_WINDOW_OPTIONS } from '@/lib/qualify/contract';
import type { QualifySnapshot, QualifyFacility, QualifyCase, QualifyMover, QualifyWindowDays, QualifyPhi } from '@/lib/qualify/contract';
import { cohortReducer, cohortKey, INITIAL_COHORT, type QualifyCohort } from '@/lib/qualify/qualifyCohort';
import { resolveLandingWins, drillLandingWins, isPayerChange } from '@/lib/qualify/qualifyGuards';
import { SwipeRow } from '@/components/qualify/m/swipe-row';
import { TrendSheet } from '@/components/qualify/m/trend-sheet';
import { DetailSheet } from '@/components/qualify/m/detail-sheet';
import { ClaimDetailSheet } from '@/components/qualify/m/claim-detail-sheet';
import { AreaChips, deriveAreaChips, facilitiesInArea, AREA_ALL } from '@/components/qualify/m/area-chips';
import { HeatingUp } from '@/components/qualify/m/heating-up';
import { SwRegister } from '@/components/qualify/m/sw-register';
import { SearchIcon, RefreshIcon } from '@/components/qualify/m/icons';

const TEAL900 = '#0E3A3A';
const GROUND = '#FBF8F4';
const INK900 = '#1B2B2A';
const INK400 = '#859794';
const VISIBLE = 5;

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '40px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: INK400, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

export function QualifyMobileApp({
  viewerHasAmountsCapability,
  canRevealPhi,
}: {
  viewerHasAmountsCapability: boolean;
  canRevealPhi: boolean;
}) {
  const [query, setQuery] = useState('');
  const [windowDays, setWindowDays] = useState<QualifyWindowDays>(30);
  // Area (state) filter over the resolved deck, alongside windowDays. Resets to AREA_ALL on any new
  // resolution (search / payer tap) and on a window change (which re-resolves) — see runSearch/resolveByPayer.
  const [areaFilter, setAreaFilter] = useState<string>(AREA_ALL);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [movers, setMovers] = useState<QualifyMover[]>([]);
  const [deck, setDeck] = useState<{ visible: QualifyFacility[]; queue: QualifyFacility[] }>({ visible: [], queue: [] });
  const [trend, setTrend] = useState<QualifyFacility | null>(null);
  const [detail, setDetail] = useState<QualifyFacility | null>(null);
  // Facility-scoped claim lines for the open detail sheet: null === loading, [] === none. `claim` is the
  // single claim line whose ClaimDetailSheet is layered above the list (null === none open).
  const [facilityCases, setFacilityCases] = useState<QualifyCase[] | null>(null);
  const [claim, setClaim] = useState<QualifyCase | null>(null);
  // PHI reveal (facility-scoped, audited): `revealedPhi` caches the fetched identifiers for the OPEN
  // facility's claims (keyed by case id); `phiShown` toggles their visibility WITHOUT re-auditing (one
  // revealQualifyRows call per facility view). All reset when a facility opens/closes. Gated by canRevealPhi.
  const [revealedPhi, setRevealedPhi] = useState<Map<number, QualifyPhi>>(() => new Map());
  const [phiShown, setPhiShown] = useState(false);
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  // How the CURRENT snapshot was resolved, so a window change re-ranks via the SAME path (window is
  // orthogonal to resolution). byPayer = the Heating-up label (chip tap or on-load auto-resolve);
  // lastSearch = the PHI term (member id / prefix). At most one is non-null once resolved.
  const [byPayer, setByPayer] = useState<string | null>(null);
  const [lastSearch, setLastSearch] = useState<string | null>(null);
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Auto-resolve the top mover ONCE, on first load only. A manual search/tap trips this so the on-load
  // resolve can never clobber user intent; a window change never re-trips it (guarded in Effect B).
  const initialResolveDone = useRef(false);
  // Monotonic request tokens: server-action responses can land out of order (search→search, rapid window
  // pills, close→reopen a facility), so each async path stamps its issue order and only the LATEST commits
  // state. Two independent streams: deck resolution (search / payer / window) and the facility-drill fetch.
  const resolveSeq = useRef(0);
  const facilitySeq = useRef(0);
  // Drill cases COHORT (payer/facility/window/prefix + page/cursors), reducer-owned (the SAME shared,
  // root-tested cohortReducer desktop uses). Every drill transition DISPATCHES; `apply` returns the
  // resulting cohort so the fetch can read it + stamp its cohortKey. `cohortRef` lets an async cases
  // landing check the cohort changed underneath (the identity guard). This stage leaves prefix='' /
  // page=0 (no input/pager UI until 3b/3c) — the reducer carries the fields, unused for now.
  const [cohort, dispatch] = useReducer(cohortReducer, INITIAL_COHORT);
  const cohortRef = useRef(cohort);
  cohortRef.current = cohort;
  const apply = useCallback((action: Parameters<typeof cohortReducer>[1]): QualifyCohort => {
    const next = cohortReducer(cohortRef.current, action);
    dispatch(action);
    return next;
  }, []);
  // Mirror of `detail` for async closures: a resolution landing must read the CURRENTLY-open sheet (not the
  // stale closure value) to decide the payer-change sheet-close.
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;

  // Effect A — keep the Heating-up movers in sync with the selected window (mount + every change).
  useEffect(() => {
    let alive = true;
    getQualifyMovers(windowDays)
      .then((r) => { if (alive) setMovers(r.movers); })
      .catch(() => {});
    return () => { alive = false; };
  }, [windowDays]);

  // Effect B — land POPULATED: auto-resolve the top mover the first time movers arrive. The ref makes it
  // fire at most once, so a movers refresh (window change) never re-resolves; runSearch/resolveByPayer
  // trip the ref first, so a manual search or chip tap issued before movers land is never clobbered. If
  // movers is empty (no data), this no-ops and the search-prompt empty state stands.
  useEffect(() => {
    if (initialResolveDone.current) return;
    const top = movers[0];
    if (!top) return;
    initialResolveDone.current = true;
    resolveByPayer(top.label, windowDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movers]);

  function runSearch(raw: string, w: QualifyWindowDays) {
    const t = raw.trim();
    if (t.length < 3) {
      setHint('Enter at least a 3-letter prefix or a member ID.');
      return;
    }
    setHint(null);
    initialResolveDone.current = true; // a manual search supersedes the on-load auto-resolve
    const seq = ++resolveSeq.current;
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: t, windowDays: w });
        if (!resolveLandingWins(seq, resolveSeq.current)) return; // a newer resolve superseded this one — drop it
        setSnapshot(snap);
        setSearched(true);
        setByPayer(null); // resolved via the PHI path, not by payer
        setLastSearch(t); // remember the term so a window change re-ranks this same search
        setAreaFilter(AREA_ALL); // a fresh resolution starts unfiltered
        if (snap.resolved === null) {
          setEcho(t);
          setDeck({ visible: [], queue: [] });
        } else {
          setEcho('');
          setDeck({ visible: snap.facilities.slice(0, VISIBLE), queue: snap.facilities.slice(VISIBLE) });
        }
        syncCohortForResolution(snap.resolved?.payerName ?? null, w);
      } catch {
        if (!resolveLandingWins(seq, resolveSeq.current)) return;
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }

  // Resolve directly from a "Heating up" payer label (non-PHI) — the on-load auto-resolve AND chip taps.
  // Seeds the deck the same way a search would. No member-id/prefix term is involved on this path.
  function resolveByPayer(label: string, w: QualifyWindowDays) {
    setHint(null);
    initialResolveDone.current = true; // a chip tap supersedes the on-load auto-resolve
    const seq = ++resolveSeq.current;
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshotByPayer({ payer: label, windowDays: w });
        if (!resolveLandingWins(seq, resolveSeq.current)) return; // a newer resolve superseded this one — drop it
        setSnapshot(snap);
        setSearched(true);
        setByPayer(label); // remember it so a window change re-ranks this same payer
        setLastSearch(null); // resolved by payer, not via a PHI term
        setAreaFilter(AREA_ALL); // a fresh resolution starts unfiltered
        setEcho('');
        setDeck({ visible: snap.facilities.slice(0, VISIBLE), queue: snap.facilities.slice(VISIBLE) });
        // Authoritative identity is the RESOLVED payer name (not the tapped label), matching desktop.
        syncCohortForResolution(snap.resolved?.payerName ?? null, w);
      } catch {
        if (!resolveLandingWins(seq, resolveSeq.current)) return;
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }

  // Window is orthogonal to resolution: re-fetch movers (Effect A, via setWindowDays) and re-rank
  // whatever is CURRENTLY resolved via its own path. Never auto-resolves and never clears — it only
  // re-resolves when something is already resolved.
  function onWindow(w: QualifyWindowDays) {
    if (w === windowDays) return;
    setWindowDays(w);
    if (byPayer) resolveByPayer(byPayer, w);
    else if (lastSearch) runSearch(lastSearch, w);
  }

  function resetDeck() {
    if (snapshot?.resolved) {
      // Re-seed from the top of the CURRENTLY-filtered set (keeps the active area chip). With
      // areaFilter === AREA_ALL the filtered set is the full list — identical to the pre-area behavior.
      const list = facilitiesInArea(snapshot.facilities, areaFilter);
      setDeck({ visible: list.slice(0, VISIBLE), queue: list.slice(VISIBLE) });
    }
  }

  // Area chip tap → narrow the deck to that state WITHOUT re-resolving. Re-seeds from the filtered set
  // (rating order preserved); the SwipeRow gesture model is untouched.
  function onSelectArea(key: string) {
    if (!snapshot?.resolved) return;
    setAreaFilter(key);
    const list = facilitiesInArea(snapshot.facilities, key);
    setDeck({ visible: list.slice(0, VISIBLE), queue: list.slice(VISIBLE) });
  }

  // Facility-card tap → open the detail sheet and fetch THAT facility's claim lines (facility-scoped,
  // most-recent-first, capped at 15). payer comes from resolved.payerName so it works for BOTH the
  // PHI-search and resolve-by-payer entry paths. A close→reopen-a-different-card can leave two fetches in
  // flight; the facilitySeq token ensures only the latest open's response paints (and a close invalidates
  // any pending one), so a slow prior fetch can never land under the wrong facility's header.
  // Each facility view starts fully masked — clear any PHI revealed for the previous facility. Resets
  // revealPending too: a close/reopen while a reveal is in flight makes the response drop on the seq guard
  // (before it clears the flag), so without this reset the button would stay stuck "Revealing…" all session.
  function clearReveal() {
    setRevealedPhi(new Map());
    setPhiShown(false);
    setRevealPending(false);
    setRevealError(null);
  }

  // The DRILL stream: fetch cohort `c`'s facility cases and paint ONLY if the landing still wins BOTH drill
  // guards — facilitySeq (recency: close/reopen + future pager races) AND cohortKey (identity: the cohort
  // didn't change underneath). Writes ONLY facilityCases (+ bumps facilitySeq) — never resolution state.
  // Shared by the tap-open and the same-payer window refresh; payer/facility/window all come from `c`.
  function fetchDrill(c: QualifyCohort) {
    const seq = ++facilitySeq.current;
    const key = cohortKey(c);
    if (!c.payer || !c.facility) { setFacilityCases([]); return; }
    getQualifyFacilityCases({ payer: c.payer, facility: c.facility, windowDays: c.window })
      .then((r) => { if (drillLandingWins(seq, facilitySeq.current, key, cohortKey(cohortRef.current))) setFacilityCases(r.cases); })
      .catch(() => { if (drillLandingWins(seq, facilitySeq.current, key, cohortKey(cohortRef.current))) setFacilityCases([]); });
  }

  // Fold a LANDED resolution into the drill cohort + open sheet — the ONLY coupling between the two streams,
  // and exactly what removes the stuck-loading regression. Payer CHANGE → close any open sheet + reset the
  // cohort (RESOLVE_PAYER); SAME payer (a window change re-resolving the same payer) → keep the sheet,
  // CHANGE_WINDOW (keeps facility+prefix, resets cursor) and refresh the open drill for the new window.
  function syncCohortForResolution(nextPayer: string | null, w: QualifyWindowDays) {
    if (isPayerChange(cohortRef.current.payer, nextPayer)) {
      if (detailRef.current) closeFacility(); // strands nothing: closeFacility bumps facilitySeq
      apply({ type: 'RESOLVE_PAYER', payer: nextPayer, facility: null, window: w });
    } else {
      const next = apply({ type: 'CHANGE_WINDOW', window: w });
      if (detailRef.current) fetchDrill(next);
    }
  }

  function openFacility(f: QualifyFacility) {
    setClaim(null);
    setFacilityCases(null); // loading
    setDetail(f);
    clearReveal();
    // SWITCH_FACILITY (keeps payer/window/prefix); the drill fetch reads payer/facility/window from the cohort.
    fetchDrill(apply({ type: 'SWITCH_FACILITY', facility: f.facilityKey }));
  }

  function closeFacility() {
    facilitySeq.current++; // invalidate any in-flight drill (and reveal) so nothing paints after the sheet is gone
    setDetail(null);
    setFacilityCases(null);
    setClaim(null);
    clearReveal();
  }

  // "Reveal all" on the open facility sheet → ONE audited revealQualifyRows over the visible claim ids
  // (≤15, well under the 50 batch cap). Hide is visibility-only (keeps the cache) so re-showing never
  // re-audits, matching the desktop discipline of one audited reveal per view. Gated by canRevealPhi.
  function toggleRevealAll() {
    if (!canRevealPhi) return;
    const rows = facilityCases;
    if (!rows || rows.length === 0) return;
    if (phiShown) { setPhiShown(false); return; } // hide (cache retained)
    const ids = rows.map((c) => c.id);
    if (ids.every((id) => revealedPhi.has(id))) { setPhiShown(true); return; } // already fetched → just show
    if (revealPending) return;
    const seq = facilitySeq.current; // drop the response if the facility changes/closes before it lands
    setRevealPending(true);
    setRevealError(null);
    revealQualifyRows(ids)
      .then((res) => {
        if (seq !== facilitySeq.current) return;
        setRevealPending(false);
        if (res.ok) {
          setRevealedPhi(() => {
            const m = new Map<number, QualifyPhi>();
            for (const r of res.rows) {
              m.set(r.id, { patient_name: r.patient_name, member_id_raw: r.member_id_raw, group_number: r.group_number });
            }
            return m;
          });
          setPhiShown(true);
        } else {
          setRevealError(res.error);
        }
      })
      .catch(() => {
        if (seq !== facilitySeq.current) return;
        setRevealPending(false);
        setRevealError('Reveal is unavailable right now.');
      });
  }

  function advance(f: QualifyFacility) {
    setDeck(({ visible, queue }) => {
      const nv = visible.filter((x) => x.rank !== f.rank);
      const [next, ...rest] = queue;
      if (next) return { visible: [...nv, next], queue: rest };
      return { visible: nv, queue };
    });
  }

  function renderBody(): ReactNode {
    if (!searched) {
      return <EmptyState>Search a member ID or 3-letter prefix to pull a payer&rsquo;s facilities.</EmptyState>;
    }
    if (snapshot && snapshot.resolved === null) {
      return (
        <EmptyState>
          No match for <span className="ths-num" style={{ color: INK900, fontWeight: 600 }}>{echo}</span>
        </EmptyState>
      );
    }
    if (snapshot && snapshot.facilities.length === 0) {
      return <EmptyState>No facilities for this payer in this window.</EmptyState>;
    }
    if (deck.visible.length === 0) {
      return (
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <div className="ths-h" style={{ fontSize: 14, fontWeight: 600, color: INK900 }}>That&rsquo;s the list</div>
          <div style={{ marginTop: 4, fontSize: 12, color: INK400 }}>Tap Reset to reshuffle</div>
        </div>
      );
    }
    return deck.visible.map((f) => (
      <SwipeRow key={f.rank} facility={f} onPass={advance} onWhy={(x) => setTrend(x)} onOpen={openFacility} />
    ));
  }

  const showHint = deck.visible.length > 0;
  // Area chips only when a payer is resolved AND there are >=2 real buckets (>2 chips incl. "All") — a
  // single-state payer with no unmapped facilities gets no pointless "All / CA" row.
  const areaChips = snapshot?.resolved ? deriveAreaChips(snapshot.facilities) : [];
  const showAreaChips = areaChips.length > 2;

  return (
    <div style={{ minHeight: '100vh', background: GROUND }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 20, padding: '16px 16px 12px', background: TEAL900 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.6)' }}>Qualify</div>
            <div className="ths-h" style={{ fontSize: 18, fontWeight: 600, color: '#fff' }}>Lead lookup</div>
          </div>
          <button
            type="button"
            onClick={resetDeck}
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 999, background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
          >
            <RefreshIcon size={14} color="#fff" />
            <span>Reset</span>
          </button>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)' }}>
            <SearchIcon size={16} color="rgba(255,255,255,0.4)" />
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(query, windowDays); }}
            enterKeyHint="search"
            spellCheck={false}
            placeholder="Member ID or 3-letter prefix"
            aria-label="Member ID or alpha prefix"
            style={{ width: '100%', height: 40, padding: '0 14px 0 36px', borderRadius: 12, border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 14, outline: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }} role="group" aria-label="Time window">
          {QUALIFY_WINDOW_OPTIONS.map((w) => {
            const active = w === windowDays;
            return (
              <button
                key={w}
                type="button"
                onClick={() => onWindow(w)}
                aria-pressed={active}
                style={{
                  flex: 1,
                  height: 30,
                  borderRadius: 999,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  background: active ? '#fff' : 'rgba(255,255,255,0.1)',
                  color: active ? TEAL900 : 'rgba(255,255,255,0.7)',
                }}
              >
                {w}d
              </button>
            );
          })}
        </div>
      </div>

      <HeatingUp movers={movers} windowDays={windowDays} onOpen={(label) => resolveByPayer(label, windowDays)} />
      <SwRegister />

      {hint ? <div style={{ padding: '0 16px', fontSize: 12, color: '#C9881E' }}>{hint}</div> : null}

      {showAreaChips ? <AreaChips chips={areaChips} active={areaFilter} onSelect={onSelectArea} /> : null}

      <div style={{ position: 'relative', padding: '12px 16px 24px', display: 'flex', flexDirection: 'column', gap: 10, touchAction: 'pan-y', opacity: isPending ? 0.6 : 1, transition: 'opacity 0.15s' }}>
        {renderBody()}
      </div>

      {showHint ? (
        <div style={{ textAlign: 'center', fontSize: 12, color: INK400, padding: '0 16px 24px' }}>
          Swipe left to pass · right for why · tap to open
        </div>
      ) : null}

      {trend ? <TrendSheet facility={trend} onClose={() => setTrend(null)} /> : null}
      {detail ? (
        <DetailSheet
          facility={detail}
          cases={facilityCases ?? []}
          loading={facilityCases === null}
          hasAmounts={hasAmounts}
          canReveal={canRevealPhi}
          revealed={revealedPhi}
          phiShown={phiShown}
          revealPending={revealPending}
          revealError={revealError}
          onRevealAll={toggleRevealAll}
          onOpenClaim={(c) => setClaim(c)}
          onClose={closeFacility}
        />
      ) : null}
      {claim ? (
        <ClaimDetailSheet
          claim={claim}
          hasAmounts={hasAmounts}
          phi={phiShown ? revealedPhi.get(claim.id) ?? null : null}
          onClose={() => setClaim(null)}
        />
      ) : null}
    </div>
  );
}
