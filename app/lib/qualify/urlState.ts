/**
 * Qualify URL STATE (compose-bar era) — shareable / refresh-surviving FILTER state, encoded as query
 * params. PURE (no React/Next imports) so the allowlist is enforced + root-tested here, not implied.
 *
 * ┌─ PHI ALLOWLIST (HARD CONSTRAINT — "PHI never in URLs") ────────────────────────────────────────┐
 * │ ONLY the NON-PHI compose selections may appear: facility · payer · funding (each a repeated     │
 * │ key), plus window · loc. These are all resolved, non-PHI values (raw rollup facility text,      │
 * │ payer/funding labels, the serialized window token, the LOC lens). NEVER a member id, alpha      │
 * │ prefix, group number, or client name — the compose bar's PHI terms have NO field here BY TYPE,  │
 * │ and the parser ignores every other param. A shared link restores the selection arrays; the PHI  │
 * │ narrows never leave the searcher's browser.                                                     │
 * │                                                                                                 │
 * │ ⚠ EMPLOYER IS EXCLUDED (audit 2026-08-12, P0-4). `employer_norm` is byte-identical to the       │
 * │ `employer_name` this repo's own phi.ts lists as a PHI column (the options query aliases one AS  │
 * │ the other), and resolution.ts (I7) + the D2 resolution query module's R6 already rule employers │
 * │ out of every URL: ?employer=<small employer>&facility=<rehab>&payer=<carrier> in history/       │
 * │ Referer/edge logs is a re-identification vector on an OON book. The chips still work            │
 * │ — the selection lives in component state; it simply never rides the URL, so a shared link       │
 * │ restores everything BUT the employer chips.                                                     │
 * └─────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Writes ride router.replace (never push) and fire on selection/window/loc change — never on a PHI
 * keystroke (PHI has no field here, so it structurally cannot be written).
 */
import {
  parseQualifyWindow,
  serializeQualifyWindow,
  trailingWindow,
  type QualifyWindow,
} from './contract';
import type { QualifyLocFilter } from './groupClaims';

/** The URL-encodable fields — the NON-PHI compose selections + view prefs. NO PHI field exists. */
export interface QualifyUrlState {
  facilities: string[]; // raw rollup facility text (== QualifyFacility.facilityKey), non-PHI
  payers: string[]; // plaintext primary_payer labels, non-PHI
  employers: string[]; // IN-MEMORY ONLY — never serialized or parsed (PHI-adjacent; header ⚠, P0-4)
  funding: string[]; // 'Self-Funded' | 'Fully Insured', non-PHI
  window: QualifyWindow;
  loc: QualifyLocFilter;
}

/** Bounded label length + array count (defense-in-depth; real values are far shorter/fewer). */
const MAX_LABEL = 200;
const MAX_ITEMS = 200;

const LOC_TOKENS: Record<string, Exclude<QualifyLocFilter, null>> = {
  ip: 'IP',
  op: 'OP',
  both: 'BOTH',
};

/** Trim, drop blanks/overlong, dedupe, cap count — the URL mirror of the core's boundArray. */
function boundLabels(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s === '' || s.length > MAX_LABEL || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Serialize the NON-PHI selections + view prefs → the query string (repeated keys for the arrays;
 * empty/default fields omitted so the URL stays clean). Returns '' when there is nothing shareable
 * (no selection AND no LOC lens) — a bare window is not worth a URL.
 */
export function buildQualifySearchParams(s: QualifyUrlState): string {
  const facilities = boundLabels(s.facilities);
  const payers = boundLabels(s.payers);
  const funding = boundLabels(s.funding);
  // s.employers is deliberately NOT read — see the header ⚠ (P0-4). An employer-only selection is
  // therefore "nothing shareable": the URL must not even reveal that an employer filter is active.
  const anySelection = facilities.length + payers.length + funding.length > 0;
  if (!anySelection && !s.loc) return ''; // nothing shareable → clean URL
  const p = new URLSearchParams();
  for (const v of facilities) p.append('facility', v);
  for (const v of payers) p.append('payer', v);
  for (const v of funding) p.append('funding', v);
  p.set('window', serializeQualifyWindow(s.window));
  if (s.loc) p.set('loc', s.loc.toLowerCase());
  return p.toString();
}

/**
 * Parse (and VALIDATE) URL params → state. Fail-closed everywhere: unknown loc/window tokens collapse to
 * the default; over-long/blank labels are dropped; every non-allowlisted param is ignored. Never throws.
 */
export function parseQualifySearchParams(params: URLSearchParams): QualifyUrlState {
  const facilities = boundLabels(params.getAll('facility'));
  const payers = boundLabels(params.getAll('payer'));
  // An inbound ?employer= is ignored like every other non-allowlisted param (P0-4) — old shared
  // links degrade to the rest of their selection instead of resurrecting the employer filter.
  const employers: string[] = [];
  const funding = boundLabels(params.getAll('funding'));
  const window = parseQualifyWindow(params.get('window')) ?? trailingWindow(30);
  const locToken = (params.get('loc') ?? '').toLowerCase();
  const loc: QualifyLocFilter = LOC_TOKENS[locToken] ?? null;
  return { facilities, payers, employers, funding, window, loc };
}
