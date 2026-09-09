/** Display formatting for Code Performance — pure, client-safe. Never truncates a dollar value. */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const EMPTY = '—';

export function fmtMoney(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? EMPTY : money.format(v);
}

export function fmtInt(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? EMPTY : int.format(v);
}

/** Percent already on the 0–100 scale. NEVER clamps — values over 100 are the point for paid_of_allowed. */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? EMPTY : `${v.toFixed(digits)}%`;
}

export function fmtDays(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? EMPTY : `${Math.round(v)} d`;
}

/** YYYY-MM-DD → "Mar 12, 2026" (calendar date, no timezone arithmetic). */
export function fmtIsoDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return EMPTY;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return EMPTY;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** YYYY-MM-01 → "Mar 2026". */
export function fmtMonth(iso: string): string {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  if (!y || !m) return iso;
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}
