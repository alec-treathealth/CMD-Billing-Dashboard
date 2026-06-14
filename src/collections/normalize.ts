/**
 * Pure normalization for collections data. No I/O, no logging — unit-testable.
 * Reuses the claims-schema date parser and name splitter; adds the collections
 * money/member-id/percentage rules from the Phase 6 Findings.
 */
import { normalizeDate, splitPatientName } from '../normalize.js';

export type Coerced<T> = { ok: true; value: T } | { ok: false; reason: string };

export { normalizeDate, splitPatientName };

const DASH_ONLY = /^-+$/;

/**
 * Money. mode 'daily': blank or a "$ -" dash placeholder -> "0.00" (Finding G).
 * mode 'phi':   blank or "$ -" -> null. Strips $ and thousands commas, preserves
 * a real leading '-' (takebacks/reversals), accepts accounting parentheses.
 * Anything else non-numeric -> failure (hard reject, Finding D).
 */
export function normalizeMoney(raw: string, mode: 'daily' | 'phi'): Coerced<string | null> {
  const trimmed = raw.trim();
  const zeroOrNull = mode === 'daily' ? '0.00' : null;
  if (trimmed === '') return { ok: true, value: zeroOrNull };

  let s = trimmed;
  let parenNegative = false;
  if (/^\(.*\)$/.test(s)) {
    parenNegative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\$/g, '').replace(/,/g, '').trim();

  // "$ -" / "-" dash placeholder == zero (daily) / null (phi).
  if (s === '' || DASH_ONLY.test(s)) return { ok: true, value: zeroOrNull };

  if (parenNegative && !s.startsWith('-')) s = `-${s}`;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: `unparseable money value: ${JSON.stringify(raw)}` };
  }
  const num = Number(s);
  if (!Number.isFinite(num)) return { ok: false, reason: `non-finite money value: ${JSON.stringify(raw)}` };
  return { ok: true, value: num.toFixed(2) };
}

/**
 * Member ID (Finding E): raw = trimmed verbatim; norm = upper-cased with ALL
 * internal whitespace removed and any leading '-' stripped. Blank -> both null.
 *   "AB1234567 89" -> norm "AB123456789"; "-1112223" -> "1112223" (synthetic examples).
 */
export function normalizeMemberId(raw: string): { raw: string | null; norm: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { raw: null, norm: null };
  const norm = trimmed.toUpperCase().replace(/\s+/g, '').replace(/^-+/, '');
  return { raw: trimmed, norm: norm === '' ? null : norm };
}

/**
 * Negotiated percentage: strip a trailing '%', divide by 100 when '%' present;
 * otherwise store the numeric as-is. -> fixed(4) string for numeric(6,4). Blank
 * -> null; non-numeric -> failure.
 */
export function normalizePct(raw: string): Coerced<string | null> {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const hasPct = trimmed.includes('%');
  const s = trimmed.replace(/%/g, '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: `unparseable percentage: ${JSON.stringify(raw)}` };
  }
  const num = Number(s) / (hasPct ? 100 : 1);
  if (!Number.isFinite(num)) return { ok: false, reason: `non-finite percentage: ${JSON.stringify(raw)}` };
  return { ok: true, value: num.toFixed(4) };
}

/** Optional free text: blank -> null. */
export function optText(raw: string | undefined): string | null {
  const t = (raw ?? '').trim();
  return t === '' ? null : t;
}

/** Soft reconciliation flags (Finding D) — NEVER gate row acceptance. */
export function reconFlags(
  charge: string | null,
  allowed: string | null,
  insurancePaid: string | null,
  adjustment: string | null,
): { recon_ok: boolean | null; paid_gt_allowed: boolean | null } {
  const n = (v: string | null) => (v === null ? null : Number(v));
  const c = n(charge), a = n(allowed), p = n(insurancePaid), adj = n(adjustment);
  const recon_ok = a !== null && adj !== null && c !== null ? Math.abs(a + adj - c) <= 0.05 : null;
  const paid_gt_allowed = p !== null && a !== null ? p > a : null;
  return { recon_ok, paid_gt_allowed };
}
