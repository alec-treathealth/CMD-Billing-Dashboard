'use client';

/**
 * Qualify WINDOW CONTROL (redesign + Range menu). Quick PILLS 30d/60d/90d map to the trailing shape;
 * a "Range ▾" dropdown holds the longer ROLLING spans (6/9/12 months — capped at 1 year) AND the
 * CALENDAR month/year picker (a specific-period window). The trigger shows the active non-pill
 * selection's label. Controlled — the only external state is the parent's QualifyWindow; the dropdown's
 * open/close is local. Years span the data floor (QUALIFY_CAL_YEAR_MIN) → the current ops year.
 */
import { useEffect, useRef, useState } from 'react';
import {
  QUALIFY_WINDOW_OPTIONS,
  QUALIFY_ROLLING_OPTIONS,
  QUALIFY_CAL_YEAR_MIN,
  qualifyRollingLabel,
  qualifyWindowLabel,
  trailingWindow,
  type QualifyWindow,
} from '../../lib/qualify/contract';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function WindowControl({
  window: win,
  currentYear,
  onChange,
}: {
  window: QualifyWindow;
  /** The ops "today" year (server-derived upstream; injectable so tests are deterministic). */
  currentYear: number;
  onChange: (w: QualifyWindow) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the Range menu on click-outside / Escape (it's a menu, not a modal — no focus trap).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isPill = win.kind === 'trailing' && (QUALIFY_WINDOW_OPTIONS as readonly number[]).includes(win.days);
  const rangeActive = !isPill; // a rolling span (180/270/365) OR a calendar window
  const rangeLabel = rangeActive ? qualifyWindowLabel(win) : 'Range';

  const calendar = win.kind !== 'trailing';
  const years: number[] = [];
  for (let y = currentYear; y >= QUALIFY_CAL_YEAR_MIN; y--) years.push(y);
  const selYear = win.kind === 'trailing' ? currentYear : win.year;
  const selMonth = win.kind === 'month' ? win.month : 0; // 0 = All months (the year window)

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-full border bg-background p-0.5" role="group" aria-label="Time window">
        {QUALIFY_WINDOW_OPTIONS.map((d) => {
          const active = win.kind === 'trailing' && win.days === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => {
                onChange(trailingWindow(d));
                setOpen(false);
              }}
              aria-pressed={active}
              className={[
                'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
                active ? 'bg-teal700 text-white shadow-ths-sm' : 'text-muted-foreground hover:text-ink900',
              ].join(' ')}
            >
              {d}d
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-pressed={rangeActive}
          className={[
            'flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
            rangeActive ? 'bg-teal700 text-white shadow-ths-sm' : 'text-muted-foreground hover:text-ink900',
          ].join(' ')}
        >
          {rangeLabel}
          <svg aria-hidden width="9" height="9" viewBox="0 0 10 10" className="opacity-70">
            <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open ? (
        <div
          role="menu"
          aria-label="Longer date range"
          className="animate-ths-reveal absolute left-0 top-full z-30 mt-2 w-64 rounded-xl border bg-card p-2 shadow-ths-lg"
        >
          <div className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-widest text-ink400">Rolling (from today)</div>
          {QUALIFY_ROLLING_OPTIONS.map((d) => {
            const active = win.kind === 'trailing' && win.days === d;
            return (
              <button
                key={d}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(trailingWindow(d));
                  setOpen(false);
                }}
                className={[
                  'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                  active ? 'bg-teal50 text-teal700' : 'text-ink900 hover:bg-background',
                ].join(' ')}
              >
                {qualifyRollingLabel(d)}
                {active ? <span aria-hidden>✓</span> : null}
              </button>
            );
          })}

          <div className="mt-1 border-t px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-ink400">
            Specific period
          </div>
          <div className="flex items-center gap-2 px-2 py-1">
            <select
              aria-label="Month"
              value={selMonth}
              onChange={(e) => {
                const m = Number(e.target.value);
                onChange(m === 0 ? { kind: 'year', year: selYear } : { kind: 'month', year: selYear, month: m });
              }}
              className="h-9 flex-1 rounded-lg border bg-card px-2 text-[13px] text-ink900"
            >
              <option value={0}>All months</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <select
              aria-label="Year"
              value={selYear}
              onChange={(e) => {
                const y = Number(e.target.value);
                onChange(selMonth === 0 ? { kind: 'year', year: y } : { kind: 'month', year: y, month: selMonth });
              }}
              className="h-9 w-24 rounded-lg border bg-card px-2 text-[13px] text-ink900"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          {calendar ? <div className="px-2 pb-1 pt-0.5 text-[11px] text-ink400">Showing {qualifyWindowLabel(win)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
