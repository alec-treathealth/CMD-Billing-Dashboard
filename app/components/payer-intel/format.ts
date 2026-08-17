/**
 * Payer Intel display formatters — pure, client-safe, shared by every section so a dollar or
 * percentage never formats two ways on one page. Null in → em dash out (a stripped dollar and a
 * guarded ratio both render '—', never 0).
 */

export const EM_DASH = '—';

export function fmtMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return EM_DASH;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** Compact money for rail micro-lines: $339K / $1.7M. */
export function fmtMoneyCompact(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return EM_DASH;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

export function fmtPct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return EM_DASH;
  return `${v.toFixed(digits)}%`;
}

export function fmtInt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return EM_DASH;
  return Math.round(v).toLocaleString('en-US');
}

/** 'HH:MM PST' from a UTC ISO stamp — the census strip's live-column vocabulary. The zone is
 *  pinned to America/Los_Angeles (the business zone every Qualify window anchors on). */
export function fmtPstTime(iso: string | null): string {
  if (iso === null) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  const time = d.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${time} PT`;
}

/** 'MM-DD HH:MM' local-business rendering for saved-search timestamps. */
export function fmtSearchStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return parts.replace(',', '');
}
