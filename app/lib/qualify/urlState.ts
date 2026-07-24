/**
 * Qualify URL STATE (Change F) — shareable / refresh-surviving drilldown state, encoded as query
 * params. PURE (no React/Next imports) so the allowlist is enforced + root-tested here, not implied.
 *
 * ┌─ PHI ALLOWLIST (HARD CONSTRAINT — "PHI never in URLs") ────────────────────────────────────────┐
 * │ EXACTLY four keys may appear: payer · facility · window · loc. All four are RESOLVED, non-PHI  │
 * │ values (payer label, raw rollup facility text, the serialized window token, the LOC lens).     │
 * │ NEVER the raw search query, a member id, a client name, matchedValue, or a patientKey — the    │
 * │ builder takes only these four fields BY TYPE, and the parser ignores every other param. A      │
 * │ shared link re-resolves via resolveByPayer(payerName) (the non-PHI label path); the original   │
 * │ search term is never replayed and never leaves the searcher's browser.                         │
 * └─────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Writes ride router.replace (never push) and fire only on RESOLVED-state change — never per
 * keystroke (the autosearch debounce is a separate concern).
 */
import {
  parseQualifyWindow,
  serializeQualifyWindow,
  trailingWindow,
  type QualifyWindow,
} from './contract';
import type { QualifyLocFilter } from './groupClaims';

/** The four (and ONLY four) URL-encodable fields. */
export interface QualifyUrlState {
  payer: string | null; // resolved payer LABEL (non-PHI) — never a search term
  facility: string | null; // Change-E scope: QualifyFacility.facilityKey (raw rollup text, non-PHI)
  window: QualifyWindow;
  loc: QualifyLocFilter;
}

/** Bounded label lengths (defense-in-depth on the parse side; real values are far shorter). */
const MAX_LABEL = 200;

const LOC_TOKENS: Record<string, Exclude<QualifyLocFilter, null>> = {
  ip: 'IP',
  op: 'OP',
  both: 'BOTH',
};

/**
 * Serialize resolved state → the query string (ONLY the four allowlisted keys; empty/default fields
 * are omitted so the URL stays clean). Returns '' when there is nothing shareable (no resolved payer).
 */
export function buildQualifySearchParams(s: QualifyUrlState): string {
  if (!s.payer) return ''; // nothing resolved → no URL state (never encode a bare window/loc)
  const p = new URLSearchParams();
  p.set('payer', s.payer.slice(0, MAX_LABEL));
  if (s.facility) p.set('facility', s.facility.slice(0, MAX_LABEL));
  p.set('window', serializeQualifyWindow(s.window));
  if (s.loc) p.set('loc', s.loc.toLowerCase());
  return p.toString();
}

/**
 * Parse (and VALIDATE) URL params → state. Fail-closed everywhere: an unknown loc/window token or an
 * over-long label collapses to the default rather than being trusted. Every non-allowlisted param is
 * ignored. Never throws.
 */
export function parseQualifySearchParams(params: URLSearchParams): QualifyUrlState {
  const rawPayer = params.get('payer');
  const payer = rawPayer && rawPayer.trim() !== '' && rawPayer.length <= MAX_LABEL ? rawPayer.trim() : null;
  const rawFacility = params.get('facility');
  const facility =
    payer && rawFacility && rawFacility.trim() !== '' && rawFacility.length <= MAX_LABEL ? rawFacility.trim() : null;
  const window = parseQualifyWindow(params.get('window')) ?? trailingWindow(30);
  const locToken = (params.get('loc') ?? '').toLowerCase();
  const loc: QualifyLocFilter = LOC_TOKENS[locToken] ?? null;
  return { payer, facility, window, loc };
}
