'use client';

/**
 * Qualify WINDOW CONTROL (redesign) — 30d / 60d / 90d / Month-Year. The trailing pills map to the
 * contract's trailing shape; "Month/Year" switches to the CALENDAR shape (a real calendar window,
 * not trailing-N — ruled) and reveals Month + Year selects. Month "All months" = the whole-year
 * window. Controlled + presentational (the only state is the parent's QualifyWindow); renders
 * hermetically. Years span the data floor (QUALIFY_CAL_YEAR_MIN) → the current ops year.
 */
import {
  QUALIFY_WINDOW_OPTIONS,
  QUALIFY_CAL_YEAR_MIN,
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
  const calendar = win.kind !== 'trailing';
  const years: number[] = [];
  for (let y = currentYear; y >= QUALIFY_CAL_YEAR_MIN; y--) years.push(y);
  const selYear = win.kind === 'trailing' ? currentYear : win.year;
  const selMonth = win.kind === 'month' ? win.month : 0; // 0 = All months (the year window)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-full border bg-background p-0.5" role="group" aria-label="Time window">
        {QUALIFY_WINDOW_OPTIONS.map((d) => {
          const active = win.kind === 'trailing' && win.days === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onChange(trailingWindow(d))}
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
          onClick={() => {
            if (!calendar) onChange({ kind: 'month', year: currentYear, month: new Date().getUTCMonth() + 1 });
          }}
          aria-pressed={calendar}
          className={[
            'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
            calendar ? 'bg-teal700 text-white shadow-ths-sm' : 'text-muted-foreground hover:text-ink900',
          ].join(' ')}
        >
          Month/Year
        </button>
      </div>
      {calendar ? (
        <div className="animate-ths-reveal flex items-center gap-2">
          <label className="text-xs font-semibold text-muted-foreground" htmlFor="q-win-month">
            Month
          </label>
          <select
            id="q-win-month"
            value={selMonth}
            onChange={(e) => {
              const m = Number(e.target.value);
              onChange(m === 0 ? { kind: 'year', year: selYear } : { kind: 'month', year: selYear, month: m });
            }}
            className="h-9 rounded-lg border bg-card px-2.5 text-[13px] text-ink900"
          >
            <option value={0}>All months</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <label className="text-xs font-semibold text-muted-foreground" htmlFor="q-win-year">
            Year
          </label>
          <select
            id="q-win-year"
            value={selYear}
            onChange={(e) => {
              const y = Number(e.target.value);
              onChange(selMonth === 0 ? { kind: 'year', year: y } : { kind: 'month', year: y, month: selMonth });
            }}
            className="h-9 rounded-lg border bg-card px-2.5 text-[13px] text-ink900"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
