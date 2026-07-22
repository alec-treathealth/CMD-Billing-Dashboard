/**
 * Qualify mobile Phase 4 — PURE pagination over the ranked facility list (the 5-up pages the
 * swipe-left gesture walks). No React; root-suite-tested directly (the qualifyGuards pattern).
 * Pages CLAMP at the ends (no wrap — wrapping on a swipe disorients; the dots + label show position).
 */
export const QUALIFY_MOBILE_PAGE_SIZE = 5;

export function pageCount(total: number, size: number = QUALIFY_MOBILE_PAGE_SIZE): number {
  if (total <= 0 || size <= 0) return 0;
  return Math.ceil(total / size);
}

/** Clamp a requested page into [0, pageCount-1]; an empty list clamps to 0. */
export function clampPage(page: number, total: number, size: number = QUALIFY_MOBILE_PAGE_SIZE): number {
  const n = pageCount(total, size);
  if (n === 0) return 0;
  if (!Number.isFinite(page) || page < 0) return 0;
  return Math.min(Math.floor(page), n - 1);
}

export function pageSlice<T>(list: readonly T[], page: number, size: number = QUALIFY_MOBILE_PAGE_SIZE): T[] {
  const p = clampPage(page, list.length, size);
  return list.slice(p * size, p * size + size);
}

/** "1–5 of 23" / "21–23 of 23" / "0 of 0" — the page-position label under the list. */
export function pageLabel(page: number, total: number, size: number = QUALIFY_MOBILE_PAGE_SIZE): string {
  if (total <= 0) return '0 of 0';
  const p = clampPage(page, total, size);
  const from = p * size + 1;
  const to = Math.min(total, (p + 1) * size);
  return `${from}–${to} of ${total}`;
}
