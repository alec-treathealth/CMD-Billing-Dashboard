/**
 * Shared date-window presets for the Billing Audit filter bar. Pure (no 'use client') so BOTH the
 * client filter bar AND the server page can compute the SAME default window — the server seeds the
 * initial grid page with exactly the window the client starts on (YTD), so seeded rows match the
 * displayed filter with no first-render refetch/mismatch. The window filters charge_from_date (DOS).
 */
export type Preset = 'ytd' | '7' | '14' | '30' | 'all';

export const DEFAULT_PRESET: Preset = 'ytd';

/** Inclusive [from,to] ISO window for a preset, relative to `today` (defaults to now). */
export function presetWindow(p: Preset, today: Date = new Date()): { dateFrom: string | null; dateTo: string | null } {
  if (p === 'all') return { dateFrom: null, dateTo: null };
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (p === 'ytd') return { dateFrom: `${today.getFullYear()}-01-01`, dateTo: iso(today) };
  const from = new Date(today);
  from.setDate(from.getDate() - Number(p));
  return { dateFrom: iso(from), dateTo: iso(today) };
}
