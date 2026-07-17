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
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { getQualifySnapshot, getQualifyMovers } from '@/lib/qualify/actions';
import type { QualifySnapshot, QualifyFacility, QualifyMover } from '@/lib/qualify/contract';
import { SwipeRow } from '@/components/qualify/m/swipe-row';
import { TrendSheet } from '@/components/qualify/m/trend-sheet';
import { DetailSheet } from '@/components/qualify/m/detail-sheet';
import { HeatingUp } from '@/components/qualify/m/heating-up';
import { SwRegister } from '@/components/qualify/m/sw-register';
import { SearchIcon, RefreshIcon } from '@/components/qualify/m/icons';

const TEAL900 = '#0E3A3A';
const GROUND = '#FBF8F4';
const INK900 = '#1B2B2A';
const INK400 = '#859794';
const WINDOW = 30 as const;
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
  const [snapshot, setSnapshot] = useState<QualifySnapshot | null>(null);
  const [movers, setMovers] = useState<QualifyMover[]>([]);
  const [deck, setDeck] = useState<{ visible: QualifyFacility[]; queue: QualifyFacility[] }>({ visible: [], queue: [] });
  const [trend, setTrend] = useState<QualifyFacility | null>(null);
  const [detail, setDetail] = useState<QualifyFacility | null>(null);
  const [searched, setSearched] = useState(false);
  const [echo, setEcho] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const hasAmounts = snapshot ? snapshot.viewerHasAmountsCapability : viewerHasAmountsCapability;

  useEffect(() => {
    let alive = true;
    getQualifyMovers(WINDOW)
      .then((r) => { if (alive) setMovers(r.movers); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  function runSearch(raw: string) {
    const t = raw.trim();
    if (t.length < 3) {
      setHint('Enter at least a 3-letter prefix or a member ID.');
      return;
    }
    setHint(null);
    startTransition(async () => {
      try {
        const snap = await getQualifySnapshot({ query: t, windowDays: WINDOW });
        setSnapshot(snap);
        setSearched(true);
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

  function resetDeck() {
    if (snapshot?.resolved) {
      setDeck({ visible: snapshot.facilities.slice(0, VISIBLE), queue: snapshot.facilities.slice(VISIBLE) });
    }
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
      <SwipeRow key={f.rank} facility={f} onPass={advance} onWhy={(x) => setTrend(x)} onOpen={(x) => setDetail(x)} />
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
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(query); }}
            enterKeyHint="search"
            spellCheck={false}
            placeholder="Member ID or 3-letter prefix"
            aria-label="Member ID or alpha prefix"
            style={{ width: '100%', height: 40, padding: '0 14px 0 36px', borderRadius: 12, border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 14, outline: 'none' }}
          />
        </div>
      </div>

      <HeatingUp movers={movers} />
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
      {detail ? <DetailSheet facility={detail} cases={snapshot?.cases ?? []} hasAmounts={hasAmounts} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}
