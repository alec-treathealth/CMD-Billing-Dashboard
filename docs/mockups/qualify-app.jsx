import React, { useState, useRef, useEffect } from 'react';
import { Search, ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Minus, Building2, ShieldCheck, Sparkles, Flame, X, Check } from 'lucide-react';

// ---------------------------------------------------------------------------
// TreatHealthOS base tokens + a sportsbook-adjacent dark deck surface for the
// swipe screen only. Home/detail keep the standard ground/surface tokens —
// the deck is the one place we lean into the borrowed genre.
// ---------------------------------------------------------------------------
const T = {
  teal900: '#0E3A3A',
  teal700: '#135E5A',
  teal500: '#1C8B82',
  teal50: '#EAF4F2',
  coral600: '#E2674F',
  ground: '#FBF8F4',
  surface: '#FFFFFF',
  ink900: '#1B2B2A',
  ink600: '#4A5C5A',
  ink400: '#859794',
  line: '#E4E9E6',
  danger: '#C0453B',
  ok: '#2E8B6F',
  warn: '#C9881E',
  deckBg: '#0B1F1E', // near-black teal — the "book" surface
  deckCard: '#132E2C',
  gold: '#E8B84B',
};

function bucket(pct) {
  if (pct < 25) return { c: T.danger, label: 'Low' };
  if (pct < 50) return { c: T.warn, label: 'Mid' };
  return { c: T.ok, label: 'Strong' };
}

const WINDOWS = [7, 14, 30, 60, 90];

const TRENDING = [
  { prefix: 'W29', payer: 'United Healthcare — GEHA', delta: '+18%', cases: 138 },
  { prefix: 'XJC', payer: 'Anthem Blue Cross CA', delta: '+11%', cases: 94 },
  { prefix: 'AET', payer: 'Aetna', delta: '+7%', cases: 76 },
  { prefix: 'CGN', payer: 'Cigna Health Plans', delta: '+4%', cases: 52 },
];

const ALL_FACILITIES = [
  { name: 'Mental Health Center of San Diego', pct: 61, forecast: 'up', lines: 812, streak: 4 },
  { name: 'Crown View Co-Occurring Institute', pct: 55, forecast: 'flat', lines: 402, streak: 0 },
  { name: 'Opus Health', pct: 47, forecast: 'up', lines: 266, streak: 2 },
  { name: 'My Time Recovery, LLC', pct: 38, forecast: 'down', lines: 540, streak: 0 },
  { name: 'Healthy Life Recovery', pct: 19, forecast: 'down', lines: 301, streak: 0 },
  { name: 'Silicon Valley Recovery, LLC', pct: 44, forecast: 'flat', lines: 233, streak: 0 },
  { name: '405 Recovery', pct: 52, forecast: 'up', lines: 198, streak: 3 },
  { name: 'Hillside Horizon for Teens', pct: 63, forecast: 'up', lines: 176, streak: 5 },
  { name: 'Revival Mental Health', pct: 29, forecast: 'down', lines: 154, streak: 0 },
  { name: 'Restored Hope Recovery', pct: 41, forecast: 'flat', lines: 140, streak: 0 },
  { name: 'Saddleback Recovery', pct: 58, forecast: 'up', lines: 121, streak: 3 },
  { name: 'Texas Mental Health Services', pct: 22, forecast: 'down', lines: 98, streak: 0 },
  { name: 'Postpartum Mental Health', pct: 49, forecast: 'flat', lines: 87, streak: 0 },
  { name: 'The Edge Treatment Center', pct: 66, forecast: 'up', lines: 74, streak: 6 },
  { name: 'Into the Light', pct: 33, forecast: 'down', lines: 61, streak: 0 },
];

const CLAIMS = [
  { memberId: 'W29••••61', cpt: 'H0018', pct: 61, dos: '2026-07-14' },
  { memberId: 'W29••••44', cpt: 'H0018', pct: 22, dos: '2026-07-13' },
  { memberId: 'W29••••02', cpt: 'S9480', pct: 44, dos: '2026-07-12' },
  { memberId: 'W29••••87', cpt: 'H0015', pct: 58, dos: '2026-07-11' },
  { memberId: 'W29••••19', cpt: 'H0035', pct: 12, dos: '2026-07-10' },
  { memberId: 'W29••••73', cpt: 'H0018', pct: 61, dos: '2026-07-09' },
  { memberId: 'W29••••55', cpt: 'S0201', pct: 33, dos: '2026-07-08' },
  { memberId: 'W29••••28', cpt: 'H0017', pct: 55, dos: '2026-07-07' },
  { memberId: 'W29••••91', cpt: 'H0018', pct: 47, dos: '2026-07-06' },
  { memberId: 'W29••••06', cpt: 'H0010', pct: 24, dos: '2026-07-05' },
  { memberId: 'W29••••38', cpt: 'H0018', pct: 61, dos: '2026-07-04' },
  { memberId: 'W29••••14', cpt: 'S9480', pct: 39, dos: '2026-07-03' },
  { memberId: 'W29••••79', cpt: 'H0015', pct: 52, dos: '2026-07-02' },
  { memberId: 'W29••••63', cpt: 'H0035', pct: 18, dos: '2026-07-01' },
  { memberId: 'W29••••50', cpt: 'H0018', pct: 61, dos: '2026-06-30' },
];

function ForecastIcon({ forecast, size = 13, color }) {
  if (forecast === 'up') return <TrendingUp size={size} color={color} />;
  if (forecast === 'down') return <TrendingDown size={size} color={color} />;
  return <Minus size={size} color={color} />;
}

function Header({ title, onBack, dark }) {
  return (
    <div
      className="sticky top-0 z-20 px-4 pb-3 pt-4"
      style={{ background: dark ? T.deckBg : T.teal900 }}
    >
      <div className="flex items-center gap-2.5">
        {onBack && (
          <button
            onClick={onBack}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 active:bg-white/20"
          >
            <ChevronLeft size={18} color="#fff" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!onBack && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
              Treat Health
            </div>
          )}
          <div className="truncate text-lg font-semibold tracking-tight text-white">{title}</div>
        </div>
        {!onBack && (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
            RV
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SwipeDeck — Tinder-mechanics: current card is draggable, tilts, bleeds
// color toward the drag direction; next 2 cards peek stacked behind at a
// diminishing scale/offset so the gesture is obvious before you touch it.
// Swipe RIGHT = open detail (this is the one I want). Swipe LEFT = skip/pass.
// A tap also opens detail — swipe is discoverable, never mandatory.
// ---------------------------------------------------------------------------
function SwipeDeck({ facilities, onOpen, onExhausted }) {
  const [stack, setStack] = useState(facilities);
  const [drag, setDrag] = useState({ x: 0, active: false });
  const startX = useRef(0);

  useEffect(() => {
    setStack(facilities);
  }, [facilities]);

  function onPointerDown(e) {
    startX.current = (e.touches ? e.touches[0].clientX : e.clientX);
    setDrag({ x: 0, active: true });
  }
  function onPointerMove(e) {
    if (!drag.active) return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    setDrag({ x: cx - startX.current, active: true });
  }
  function resolveSwipe(dx) {
    const THRESHOLD = 90;
    if (Math.abs(dx) > THRESHOLD) {
      const top = stack[0];
      const goingRight = dx > 0;
      setStack((s) => s.slice(1));
      setDrag({ x: 0, active: false });
      if (goingRight) onOpen(top);
      if (stack.length === 1) onExhausted && onExhausted();
    } else {
      setDrag({ x: 0, active: false });
    }
  }
  function onPointerUp() {
    resolveSwipe(drag.x);
  }

  if (stack.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-2 text-3xl">🎯</div>
        <div className="text-sm font-semibold text-white">That's the deck</div>
        <div className="mt-1 text-xs text-white/50">Pull down to reshuffle the field</div>
      </div>
    );
  }

  const top = stack[0];
  const b = bucket(top.pct);
  const rotation = drag.x / 14;
  const rightGlow = Math.max(0, Math.min(drag.x / 100, 1));
  const leftGlow = Math.max(0, Math.min(-drag.x / 100, 1));

  return (
    <div className="relative h-[420px] px-4">
      {/* Peeking stacked cards behind — this is the discoverability cue */}
      {stack
        .slice(1, 3)
        .reverse()
        .map((f, revIdx) => {
          const depth = 2 - revIdx; // 2 = furthest back, 1 = directly behind top
          return (
            <div
              key={f.name}
              className="absolute inset-x-4 top-0 rounded-2xl"
              style={{
                background: T.deckCard,
                height: 380,
                transform: `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`,
                opacity: 1 - depth * 0.25,
                zIndex: 10 - depth,
              }}
            />
          );
        })}

      {/* Active draggable card */}
      <div
        onTouchStart={onPointerDown}
        onTouchMove={onPointerMove}
        onTouchEnd={onPointerUp}
        onMouseDown={onPointerDown}
        onMouseMove={(e) => drag.active && onPointerMove(e)}
        onMouseUp={onPointerUp}
        onMouseLeave={() => drag.active && onPointerUp()}
        onClick={() => !drag.active && Math.abs(drag.x) < 5 && onOpen(top)}
        className="absolute inset-x-4 top-0 z-20 cursor-grab select-none rounded-2xl p-4 active:cursor-grabbing"
        style={{
          height: 380,
          background: T.deckCard,
          transform: `translateX(${drag.x}px) rotate(${rotation}deg)`,
          transition: drag.active ? 'none' : 'transform 0.25s ease-out',
          boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          border: `1px solid ${b.c}33`,
        }}
      >
        {/* Directional glow overlays */}
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ background: `linear-gradient(90deg, transparent 60%, ${T.ok}55 100%)`, opacity: rightGlow }}
        />
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ background: `linear-gradient(270deg, transparent 60%, ${T.ink400}55 100%)`, opacity: leftGlow }}
        />
        {/* corner stamps that fade in on drag, sportsbook "confirm" language */}
        <div
          className="pointer-events-none absolute right-4 top-4 flex items-center gap-1 rounded-lg border-2 px-2 py-1 text-xs font-black uppercase tracking-wide"
          style={{ borderColor: T.ok, color: T.ok, opacity: rightGlow, transform: `rotate(-8deg) scale(${0.9 + rightGlow * 0.2})` }}
        >
          <Check size={13} /> Take it
        </div>
        <div
          className="pointer-events-none absolute left-4 top-4 flex items-center gap-1 rounded-lg border-2 px-2 py-1 text-xs font-black uppercase tracking-wide"
          style={{ borderColor: T.ink400, color: '#fff', opacity: leftGlow, transform: `rotate(8deg) scale(${0.9 + leftGlow * 0.2})` }}
        >
          <X size={13} /> Pass
        </div>

        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: `${b.c}22` }}>
                <Building2 size={18} color={b.c} />
              </div>
              <div className="min-w-0">
                <div className="text-[15px] font-bold leading-snug text-white">{top.name}</div>
                <div className="mt-0.5 text-[11px] text-white/45">{top.lines} claim lines this window</div>
              </div>
            </div>
            {top.streak >= 3 && (
              <div className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1" style={{ background: `${T.gold}22` }}>
                <Flame size={12} color={T.gold} />
                <span className="text-[11px] font-bold" style={{ color: T.gold }}>{top.streak}</span>
              </div>
            )}
          </div>

          {/* Odds-board style big number */}
          <div className="mt-6 flex flex-1 flex-col items-center justify-center">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-white/40">Avg allowed</div>
            <div className="text-7xl font-black tabular-nums" style={{ color: b.c, lineHeight: 1 }}>
              {top.pct}
              <span className="text-3xl">%</span>
            </div>
            <div className="mt-3 flex items-center gap-1.5 rounded-full px-3 py-1" style={{ background: `${b.c}22` }}>
              <ForecastIcon forecast={top.forecast} color={b.c} />
              <span className="text-xs font-bold uppercase tracking-wide" style={{ color: b.c }}>
                {b.label} · {top.forecast}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 pt-2 text-[11px] text-white/35">
            <span>← pass</span>
            <span className="text-white/20">·</span>
            <span>tap or swipe right to open →</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function QualifyApp() {
  const [screen, setScreen] = useState('home');
  const [query, setQuery] = useState('');
  const [windowDays, setWindowDays] = useState(30);
  const [activeFacility, setActiveFacility] = useState(null);

  const noData = query.trim().toUpperCase() === 'NONE';

  function runSearch(q) {
    const val = (q !== undefined ? q : query).trim();
    if (!val) return;
    setQuery(val);
    setScreen('results');
  }

  return (
    <div
      className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col overflow-hidden"
      style={{ background: screen === 'results' && !noData ? T.deckBg : T.ground, fontFamily: 'Inter, sans-serif' }}
    >
      {/* ============================ HOME ============================ */}
      {screen === 'home' && (
        <>
          <Header title="Lead Lookup" />
          <div className="px-4 pt-4">
            <div className="flex items-center gap-2 rounded-xl border px-3 py-3" style={{ borderColor: T.line, background: T.surface }}>
              <Search size={16} color={T.ink400} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder="Member ID or alpha prefix"
                className="flex-1 bg-transparent text-sm outline-none"
                style={{ color: T.ink900 }}
              />
              <button onClick={() => runSearch()} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ background: T.teal700 }}>
                Search
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px]" style={{ color: T.ink400 }}>
              <ShieldCheck size={12} />
              Encrypted · exact match · audited
            </div>

            <div className="mt-4 flex items-center gap-1.5">
              {WINDOWS.map((d) => (
                <button
                  key={d}
                  onClick={() => setWindowDays(d)}
                  className="flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors"
                  style={{
                    background: windowDays === d ? T.teal700 : T.surface,
                    color: windowDays === d ? '#fff' : T.ink600,
                    border: `1px solid ${windowDays === d ? T.teal700 : T.line}`,
                  }}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 px-4 pb-8">
            <div className="mb-1 flex items-center gap-1.5">
              <Sparkles size={14} color={T.coral600} />
              <span className="text-sm font-semibold tracking-tight" style={{ color: T.ink900 }}>
                This Month's Movers
              </span>
            </div>
            <p className="mb-3 text-[12px]" style={{ color: T.ink600 }}>
              The alpha prefixes gaining the most claim volume over the last {windowDays} days.
            </p>
            <div className="space-y-2">
              {TRENDING.map((t) => (
                <button
                  key={t.prefix}
                  onClick={() => runSearch(t.prefix)}
                  className="flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left active:scale-[0.98] transition-transform"
                  style={{ borderColor: T.line, background: T.surface }}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold" style={{ background: T.teal50, color: T.teal700 }}>
                    {t.prefix}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium" style={{ color: T.ink900 }}>{t.payer}</div>
                    <div className="text-[11px]" style={{ color: T.ink400 }}>{t.cases} cases</div>
                  </div>
                  <div className="flex items-center gap-1 text-xs font-semibold" style={{ color: T.ok }}>
                    <TrendingUp size={13} />
                    {t.delta}
                  </div>
                  <ChevronRight size={16} color={T.ink400} />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ============================ RESULTS (swipe deck) ============================ */}
      {screen === 'results' && (
        <>
          <Header title={query} onBack={() => setScreen('home')} dark={!noData} />

          {!noData && (
            <>
              <div className="px-4 pt-2">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-white/40">Resolved payer</div>
                    <div className="text-sm font-semibold text-white">UNITED HEALTHCARE — GEHA</div>
                  </div>
                  <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }}>
                    Last {windowDays}d
                  </span>
                </div>
              </div>

              <SwipeDeck
                facilities={ALL_FACILITIES}
                onOpen={(f) => {
                  setActiveFacility(f);
                  setScreen('detail');
                }}
              />

              <div className="mt-4 flex items-center justify-center gap-2 pb-4 text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
                <ShieldCheck size={12} />
                Percentages only · dollar amounts restricted to authorized reviewers
              </div>
            </>
          )}

          {noData && (
            <div className="mt-10 flex flex-col items-center px-8 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: T.teal50 }}>
                <Search size={20} color={T.teal700} />
              </div>
              <div className="mb-1 text-sm font-semibold" style={{ color: T.ink900 }}>
                No history found
              </div>
              <p className="mb-4 text-[13px]" style={{ color: T.ink600 }}>
                No claims on file for <span className="font-medium">{query}</span>. Start a verification of benefits to qualify this lead.
              </p>
              <button className="w-full rounded-xl py-3 text-sm font-semibold text-white" style={{ background: T.teal700 }}>
                Start VOB
              </button>
            </div>
          )}
        </>
      )}

      {/* ============================ DETAIL ============================ */}
      {screen === 'detail' && activeFacility && (
        <>
          <Header title={activeFacility.name} onBack={() => setScreen('results')} />
          <div className="px-4 pt-4 pb-8">
            <div className="mb-4 rounded-2xl border p-4" style={{ borderColor: T.line, background: T.surface }}>
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 shrink-0 rounded-full" style={{ background: bucket(activeFacility.pct).c }} />
                <div className="flex-1">
                  <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: T.ink400 }}>
                    Policy rating
                  </div>
                  <div className="text-xs font-semibold" style={{ color: bucket(activeFacility.pct).c }}>
                    {bucket(activeFacility.pct).label} · trend {activeFacility.forecast}
                  </div>
                </div>
                <div className="text-2xl font-bold tabular-nums" style={{ color: bucket(activeFacility.pct).c }}>
                  {activeFacility.pct}%
                </div>
              </div>
            </div>

            <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[11px]" style={{ background: T.teal50, color: T.ink600 }}>
              <ShieldCheck size={13} color={T.teal700} />
              Percentages only. Dollar amounts are restricted to authorized reviewers.
            </div>

            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: T.ink400 }}>
              Last 15 claims
            </div>
            <div className="space-y-2">
              {CLAIMS.map((c, i) => {
                const b = bucket(c.pct);
                return (
                  <div key={i} className="flex items-center gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: T.line, background: T.surface }}>
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold tabular-nums"
                      style={{ background: `${b.c}1A`, color: b.c }}
                    >
                      {c.pct}%
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium tabular-nums" style={{ color: T.ink900 }}>
                        {c.memberId}
                      </div>
                      <div className="truncate text-[11px]" style={{ color: T.ink400 }}>
                        {c.cpt} · {c.dos}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
