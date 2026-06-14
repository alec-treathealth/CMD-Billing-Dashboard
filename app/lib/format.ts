/**
 * Small display formatters for the non-PHI summary views. All accept `unknown`
 * because numeric/date values may arrive as numbers, numeric strings (pg returns
 * `numeric` as text), or null — never assume a runtime number.
 */

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** US dollar amount, 2 d.p. Null/non-numeric → em dash. */
export function money(value: unknown): string {
  const n = toNumber(value);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Integer-ish count with thousands separators. Null → em dash. */
export function count(value: unknown): string {
  const n = toNumber(value);
  if (n === null) return '—';
  return n.toLocaleString('en-US');
}

/** A collection rate (0..1) as a percentage, 1 d.p. Null → em dash. */
export function rate(value: unknown): string {
  const n = toNumber(value);
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

/** A pct-of-total value already expressed as a percentage. Null → em dash. */
export function percent(value: unknown): string {
  const n = toNumber(value);
  if (n === null) return '—';
  return `${n.toFixed(2)}%`;
}

/** Any plain scalar for display; null/undefined → em dash. */
export function plain(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}
