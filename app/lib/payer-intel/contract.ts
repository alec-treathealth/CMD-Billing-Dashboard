/**
 * Payer Intel contract — the single source of truth for the types the /payer-intel tab's server
 * cores and client components consume IDENTICALLY. Deliberately NOT `'use server'` and imports
 * nothing server-only (the qualify/contract.ts discipline) — client components import THIS, never
 * gate.ts / loaders.ts.
 *
 * PHI POSTURE ON THE WIRE:
 *   · Search TERMS (group numbers, member identifiers) travel ONLY in Server Action POST bodies —
 *     never in these result types beyond a masked echo, never in a URL. The URL codec below
 *     carries the non-PHI facet allowlist ONLY.
 *   · Dollar-bearing fields are `number | null` — null when the viewer is amounts-blind
 *     (admissions_seat; R-AMOUNTS, stripped server-side at the core's choke point). Ratios and
 *     counts deliberately SURVIVE the strip, the Qualify precedent.
 */
import type { QualifyPolicyTapeResult } from '../qualify/board';
import type { QualifyIqBand } from '../qualify/ratingV2';
import type { CohortTotals } from '../../../src/collections/cmdExplorerQuery';

// ── Facets ───────────────────────────────────────────────────────────────────────────────────────

export type PayerIntelEntityType =
  | 'prefix'
  | 'payer'
  | 'employer'
  | 'funding'
  | 'group'
  | 'facility'
  | 'individual';

/** What the client SENDS to run a search (Server Action POST body — the only transport). Terms are
 *  raw here because the body never touches a URL/log; the server classifies, HMACs, and audits. */
export interface PayerIntelSearchInput {
  /** Free text from the search bar; the server classifies it (≤3 alnum → prefix; ≥5 digits →
   *  group number; otherwise payer-vocabulary match). Optional — chip-driven searches omit it. */
  term?: string | null;
  payer?: string | null;
  prefix?: string | null;
  facilityCodes?: string[] | null;
  employerNames?: string[] | null;
  funding?: string[] | null;
  /** PHI-adjacent identifier: POST body only, HMAC'd server-side, NEVER echoed back raw — the
   *  result carries `groupNumberMasked`. */
  groupNumber?: string | null;
}

/** The resolved, display-safe facet set the RESULT screen shows as ON FILE chips. */
export interface PayerIntelFacets {
  payer: string | null;
  /** ≤3-char alpha-prefix echo — the same non-PHI facet the Qualify UI renders openly. */
  prefix: string | null;
  facilityCodes: string[];
  /** Display labels parallel to facilityCodes (roster names; code echoed when unmapped). */
  facilityLabels: string[];
  employerNames: string[];
  funding: string[];
  /** '•••• 4217' — last-4 echo of a group-number facet; the raw number stays client-held. */
  groupNumberMasked: string | null;
}

/** Chip-dismiss vocabulary: which facet the × removed. */
export type PayerIntelFacetKey = 'payer' | 'prefix' | 'facility' | 'employer' | 'funding' | 'group';

// ── IDLE board ───────────────────────────────────────────────────────────────────────────────────

/** One "facilities losing ground" tick. `billedCurrent` is null for amounts-blind viewers.
 *  `declineReason` is ALWAYS null in v1 — no server-side attribution exists; the tick renders
 *  without a why-tag rather than fabricating one (build-spec rule). */
export interface PayerIntelDeclinerItem {
  facility: string;
  facilityCode: string | null;
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
  pctCurrent: number | null;
  pctPrior: number | null;
  deltaPts: number;
  lineCount: number;
  distinctMembers: number;
  billedCurrent: number | null;
  declineReason: string | null;
}

export type PayerIntelCensusStatus = 'full' | 'open';

/** One census strip row. `pendingAdmits` is a TYPED SEAM: the Monday aggregation drops non-admitted
 *  statuses before anything is stored, so it is null until that pipeline change ships — render an
 *  em dash, never 0. Outpatient rows: bedCapacity null + openBeds null-rendered ("beds do not
 *  apply"), occupancy null. */
export interface PayerIntelCensusRow {
  facilityCode: string;
  facilityName: string;
  boardFamily: 'residential' | 'outpatient' | null;
  admittedCount: number | null;
  openBeds: number | null;
  bedCapacity: number | null;
  pendingAdmits: number | null;
  /** admitted ÷ capacity × 100 (whole %), residential only. */
  occupancyPct: number | null;
  status: PayerIntelCensusStatus | null;
  syncedAt: string | null;
}

export interface PayerIntelSavedSearch {
  /** bigint over the wire as a STRING (node-pg int8) — keep it a string end-to-end. */
  id: string;
  payer: string | null;
  prefixEcho: string | null;
  planClass: string | null;
  entityType: PayerIntelEntityType | null;
  resolved: boolean | null;
  starred: boolean;
  searchedAt: string;
}

export interface PayerIntelBoard {
  /** Reuses the Qualify tape result shape verbatim — same enrichment, same fail-soft posture
   *  (`available:false` ⟺ mig 0093 absent; applied-but-empty ⟺ items: []). */
  gainers: QualifyPolicyTapeResult;
  decliners: {
    items: PayerIntelDeclinerItem[];
    windowDays: number;
    thresholdPts: number;
  };
  census: {
    rows: PayerIntelCensusRow[];
    /** The newest synced_at across rows — the strip's "live from admissions boards" stamp. */
    syncedAt: string | null;
  };
  searches: {
    starred: PayerIntelSavedSearch[];
    recent: PayerIntelSavedSearch[];
  };
  viewerHasAmountsCapability: boolean;
}

// ── RESULT ───────────────────────────────────────────────────────────────────────────────────────

export interface PayerIntelPlacementItem {
  facility: string;
  facilityCode: string | null;
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
  lineCount: number;
  distinctMembers: number;
  pctCollected: number | null;
  /** Dollars — null when stripped. */
  paidPerPatient: number | null;
  billed: number | null;
  /** Live census join (null when the facility has no census row). */
  openBeds: number | null;
  bedCapacity: number | null;
  pendingAdmits: number | null;
  censusSyncedAt: string | null;
  /** The capacity×collectability contradiction flags the mock centers on. */
  flag: 'best_yield_full' | 'open_beds_worst_yield' | null;
}

export interface PayerIntelComboItem {
  cpt: string | null;
  revenue: string | null;
  count: number;
  /** Dollars — null when stripped. */
  charge: number | null;
  pctAllowed: number | null;
  pctPaid: number | null;
  pctZeroPaid: number;
}

export interface PayerIntelResult {
  facets: PayerIntelFacets;
  /** Did the search resolve a payer (directly or via prefix→payer resolution)? Drives the saved-
   *  search card's "resolved / no payer resolved" meta and the AI context branch. */
  resolved: boolean;
  totals: {
    lineCount: number;
    distinctMembers: number;
    /** Dollars — null when stripped. */
    billed: number | null;
  };
  /** The three payer-behavior percentages (allowed÷billed · paid÷allowed · paid÷billed) — ratios,
   *  they survive the amounts strip by design. */
  yieldPct: CohortTotals;
  rating: {
    value: number | null;
    band: QualifyIqBand | null;
    /** vs the tape's delta horizon (90d) when the prior snapshot exists. */
    deltaPts: number | null;
    asOf: string | null;
    /** 'pair' (prefix × payer) · 'payer' (line-weighted book mean) · 'none'. */
    subject: 'pair' | 'payer' | 'none';
  };
  placement: PayerIntelPlacementItem[];
  combos: PayerIntelComboItem[];
  /** Window stamps for the column headers: trailing columns carry the window end date; live
   *  columns carry the census synced_at (PST rendering is the client's job). */
  window: { from: string; to: string };
  viewerHasAmountsCapability: boolean;
}

// ── AI cohort read ───────────────────────────────────────────────────────────────────────────────

export type PayerIntelAiSignalTone = 'ok' | 'watch' | 'risk';

export interface PayerIntelAiSignal {
  tone: PayerIntelAiSignalTone;
  text: string;
}

/** The fixed output shape the panel renders. Parsed server-side from the model text; a payload
 *  that cannot be parsed into EXACTLY this shape returns `{ok:false, reason:'malformed'}` and the
 *  panel shows a retry state — raw model text never reaches the client. */
export interface PayerIntelAiRead {
  tldr: string;
  /** Exactly 3, ordered by dollar impact (the prompt's contract; the parser enforces the count). */
  signals: PayerIntelAiSignal[];
  basis: string;
}

/** One cohort bucket for the collapsed "Show underlying data" tables — the exact aggregates the
 *  model received (viewer-stripped payload; nothing here the read itself did not see). */
export interface PayerIntelAiBucket {
  bucket: number;
  patients: number;
  lines: number;
  pctAllowed: number | null;
  pctPaid: number | null;
  pctZeroPaid: number;
}

export type PayerIntelAiResult =
  | {
      ok: true;
      read: PayerIntelAiRead;
      /** Null when the search carried no prefix (no cohort curve exists for it). */
      underlying: { byVisit: PayerIntelAiBucket[]; byDays: PayerIntelAiBucket[] } | null;
    }
  | { ok: false; reason: 'denied' | 'insufficient' | 'malformed' | 'failed' };

// ── URL codec (facet keys only — the shareable-search contract) ─────────────────────────────────

/**
 * The URL carries ONLY this non-PHI facet allowlist: payer label, prefix echo, facility codes,
 * funding tags. Employer names and group numbers are EXCLUDED by ruling precedent (audit I7/R6
 * kept employer out of the Qualify URL codec; a group number is an identifier) — a shared link
 * restores those searches minus the excluded facet, and the UI says so rather than pretending.
 */
export interface PayerIntelUrlState {
  payer: string | null;
  prefix: string | null;
  facilityCodes: string[];
  funding: string[];
}

const PREFIX_RE = /^[A-Z0-9]{1,3}$/;

export function encodePayerIntelUrl(state: PayerIntelUrlState): string {
  const p = new URLSearchParams();
  if (state.payer) p.set('payer', state.payer);
  if (state.prefix && PREFIX_RE.test(state.prefix)) p.set('prefix', state.prefix);
  for (const f of state.facilityCodes) p.append('fac', f);
  for (const f of state.funding) p.append('funding', f);
  const s = p.toString();
  return s.length > 0 ? `?${s}` : '';
}

export function decodePayerIntelUrl(params: URLSearchParams): PayerIntelUrlState {
  const prefixRaw = (params.get('prefix') ?? '').toUpperCase();
  return {
    payer: params.get('payer'),
    prefix: PREFIX_RE.test(prefixRaw) ? prefixRaw : null,
    facilityCodes: params.getAll('fac').filter((f) => f.length > 0 && f.length <= 40).slice(0, 20),
    funding: params.getAll('funding').filter((f) => f === 'Self-Funded' || f === 'Fully Insured'),
  };
}

/** True when any facet is active — the IDLE↔RESULT state switch reads this, not the raw term. */
export function hasAnyPayerIntelFacet(input: PayerIntelSearchInput): boolean {
  return Boolean(
    (input.payer && input.payer.trim().length > 0) ||
      (input.prefix && input.prefix.trim().length > 0) ||
      (input.facilityCodes && input.facilityCodes.length > 0) ||
      (input.employerNames && input.employerNames.length > 0) ||
      (input.funding && input.funding.length > 0) ||
      (input.groupNumber && input.groupNumber.trim().length > 0) ||
      (input.term && input.term.trim().length > 0),
  );
}
