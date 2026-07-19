'use client';

/**
 * Qualify mobile PWA — the interactive shell (Prompt 4b). Owns the search, the "Heating up" module,
 * and the 5-row sliding-window swipe list; it is the only caller of getQualifySnapshot /
 * getQualifyMovers. Facilities render in the contract's rating-desc order (never re-sorted here).
 *
 * Left-swipe → advance (pass). Right-swipe → open the trend sheet, advance on its close. Tap → open
 * the payer-wide detail (no advance). Reset re-seeds the deck from the SAME resolved payer's
 * facilities back to the top of rating order — it does NOT clear the search or re-resolve.
 */
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { getQualifySnapshot, getQualifySnapshotByPayer, getQualifyFacilityCases, getQualifyMovers } from '@/lib/qualify/actions';
import { QUALIFY_WINDOW_OPTIONS } from '@/lib/qualify/contract';
import type { QualifySnapshot, QualifyFacility, QualifyCase, QualifyMover, QualifyWindowDays } from '@/lib/qualify/contract';
import { SwipeRow } from '@/components/qualify/m/swipe-row';
import { TrendSheet } from '@/components/qualify/m/trend-sheet';
import { DetailSheet } from '@/components/qualify/m/detail-sheet';
import { ClaimDetailSheet } from '@/components/qualify/m/claim-detail-sheet';
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

export function QualifyMobileApp({ viewerHasAmountsCapability }: { viewerHasAmountsCapability: boolean }) {
  const [query, setQuery] = useState('');
  const [windowDays, setWindowDays] = useState<QualifyWindowDays>(30);
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [movers, setMovers] = useState<QualifyMover[]>([]);
  const [deck, setDeck] = useState<{ visible: QualifyFacility[]; queue: QualifyFacility[] }>({ visible: [], queue: [] });
  const [trend, setTrend] = useState<QualifyFacility | null>(null);
  const [detail, setDetail] = useState<QualifyFacility | null>(null);
  // Facility-scoped claim lines for the open detail sheet: null === loading, [] === none. `claim` is the
  // single claim line whose ClaimDetailSheet is layered above the list (null === none open).
  const [facilityCases, setFacilityCases] = useState<QualifyCase[] | null>(null);
  const [claim, setClaim] = useState<QualifyCase | null>(null);
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
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: t, windowDays: w });
        setSnapshot(snap);
        setSearched(true);
        setByPayer(null); // resolved via the PHI path, not by payer
        setLastSearch(t); // remember the term so a window change re-ranks this same search
        if (snap.resolved === null) {
          setEcho(t);
          setDeck({ visible: [], queue: [] });
        } else {
          setEcho('');
          setDeck({ visible: snap.facilities.slice(0, VISIBLE), queue: snap.facilities.slice(VISIBLE) });
        }
      } catch {
        setHint('Qualify is unavailable right now. Please try again.');
      }
    });
  }

  // Resolve directly from a "Heating up" payer label (non-PHI) — the on-load auto-resolve AND chip taps.
  // Seeds the deck the same way a search would. No member-id/prefix term is involved on this path.
  function resolveByPayer(label: string, w: QualifyWindowDays) {
    setHint(null);
    initialResolveDone.current = true; // a chip tap supersedes the on-load auto-resolve
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshotByPayer({ payer: label, windowDays: w });
        setSnapshot(snap);
        setSearched(true);
        setByPayer(label); // remember it so a window change re-ranks this same payer
        setLastSearch(null); // resolved by payer, not via a PHI term
        setEcho('');
        setDeck({ visible: snap.facilities.slice(0, VISIBLE), queue: snap.facilities.slice(VISIBLE) });
      } catch {
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
      setDeck({ visible: snapshot.facilities.slice(0, VISIBLE), queue: snapshot.facilities.slice(VISIBLE) });
    }
  }

  // Facility-card tap → open the detail sheet and fetch THAT facility's claim lines (facility-scoped,
  // most-recent-first, capped at 15). payer comes from resolved.payerName so it works for BOTH the
  // PHI-search and resolve-by-payer entry paths. The sheet is a full overlay, so no second card can be
  // tapped until it closes → no in-flight-response race to guard.
  function openFacility(f: QualifyFacility) {
    setClaim(null);
    setFacilityCases(null); // loading
    setDetail(f);
    const payer = snapshot?.resolved?.payerName;
    if (!payer) { setFacilityCases([]); return; }
    getQualifyFacilityCases({ payer, facility: f.facilityKey, windowDays })
      .then((r) => setFacilityCases(r.cases))
      .catch(() => setFacilityCases([]));
  }

  function closeFacility() {
    setDetail(null);
    setFacilityCases(null);
    setClaim(null);
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

      <div style={{ position: 'relative', padding: '12px 16px 24px', display: 'flex', flexDirection: 'column', gap: 10, touchAction: 'pan-y', opacity: isPending ? 0.6 : 1, transition: 'opacity 0.15s' }}>
        {renderBody()}
      </div>

      {showHint ? (
        <div style={{ textAlign: 'center', fontSize: 12, color: INK400, padding: '0 16px 24px' }}>
          Swipe left to pass · right for why · tap to open
        </div>
      ) : null}

      {trend ? <TrendSheet facility={trend} onClose={() => { const f = trend; setTrend(null); advance(f); }} /> : null}
      {detail ? (
        <DetailSheet
          facility={detail}
          cases={facilityCases ?? []}
          loading={facilityCases === null}
          hasAmounts={hasAmounts}
          onOpenClaim={(c) => setClaim(c)}
          onClose={closeFacility}
        />
      ) : null}
      {claim ? <ClaimDetailSheet claim={claim} hasAmounts={hasAmounts} onClose={() => setClaim(null)} /> : null}
    </div>
  );
}
