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
 *   · Dollar-bearing fields are `number | null` (or pg-numeric `string | null` on grid rows) —
 *     null when the viewer is amounts-blind (admissions_seat; R-AMOUNTS, stripped server-side at
 *     the core's choke point). Ratios and counts deliberately SURVIVE the strip, the Qualify
 *     precedent.
 *
 * ⚠ FACILITY FACET SEMANTICS (fixed 2026-08-17 after live review): the facet value is the
 * ROLLUP'S FACILITY TEXT (e.g. 'LONESTAR MENTAL HEALTH LLC'), exactly what
 * `cmdExplorerBaseConds` matches and what Collections' own picker supplies — NEVER a
 * facility_code. The first build passed codes and every facility-scoped search silently matched
 * nothing. The text IS the display label; census rows still key on facility_code (their own
 * table).
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

/** The payment-received window facet — the Collections recency vocabulary (server-clamped). */
export const PAYER_INTEL_WINDOW_DAYS_OPTIONS = [7, 14, 30, 90] as const;
export const PAYER_INTEL_DEFAULT_WINDOW_DAYS = 90;

export function clampPayerIntelWindowDays(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return (PAYER_INTEL_WINDOW_DAYS_OPTIONS as readonly number[]).includes(n)
    ? n
    : PAYER_INTEL_DEFAULT_WINDOW_DAYS;
}

/** What the client SENDS to run a search (Server Action POST body — the only transport). Terms are
 *  raw here because the body never touches a URL/log; the server classifies, HMACs, and audits. */
export interface PayerIntelSearchInput {
  /** Free text from the search bar; the server classifies it (≤3 alnum → prefix; ≥5 digits →
   *  group number; otherwise payer-vocabulary match). Optional — chip-driven searches omit it. */
  term?: string | null;
  payer?: string | null;
  prefix?: string | null;
  /** Rollup facility TEXT values (see the header warning) — the same vocabulary Collections' picker uses. */
  facilities?: string[] | null;
  employerNames?: string[] | null;
  funding?: string[] | null;
  /** PHI-adjacent identifier: POST body only, HMAC'd server-side, NEVER echoed back raw — the
   *  result carries `groupNumberMasked`. */
  groupNumber?: string | null;
  /** CPT × revenue drill (single values — the Collections drill-chip shape). */
  cpt?: string | null;
  revenue?: string | null;
  /** Payment-received recency window; clamped server-side to 7/14/30/90 (default 90). */
  windowDays?: number | null;
}

/** The resolved, display-safe facet set the RESULT screen shows as ON FILE chips. */
export interface PayerIntelFacets {
  payer: string | null;
  /** ≤3-char alpha-prefix echo — the same non-PHI facet the Qualify UI renders openly. */
  prefix: string | null;
  /** Rollup facility TEXT values — value IS the display label. */
  facilities: string[];
  employerNames: string[];
  funding: string[];
  /** '•••• 4217' — last-4 echo of a group-number facet; the raw number stays client-held. */
  groupNumberMasked: string | null;
  cpt: string | null;
  revenue: string | null;
  windowDays: number;
}

/** Chip-dismiss vocabulary: which facet the × removed. */
export type PayerIntelFacetKey = 'payer' | 'prefix' | 'facility' | 'employer' | 'funding' | 'group' | 'cpt_rev';

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

/** One drill-down group row (Top payers / Top facilities). `charge` is null when stripped. */
export interface PayerIntelGroupItem {
  label: string | null;
  count: number;
  charge: number | null;
}

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
  /** Drill-down groups — the Collections summary's Top Payers / Top Facilities, clickable. */
  byPayer: PayerIntelGroupItem[];
  byFacility: PayerIntelGroupItem[];
  placement: PayerIntelPlacementItem[];
  combos: PayerIntelComboItem[];
  /**
   * The FIRST keyset page of row-level charge lines, returned BY THE SEARCH ITSELF.
   *
   * ⚠ This is deliberately not a second Server Action. The first build fetched page 1 through its
   * own `loadPayerIntelChargeRows` call chained off the search's resolution, and that second
   * round-trip is what produced the "charge lines will not load" report twice: the SQL was 50ms
   * (verified as both `postgres` and `claims_reader`) and the server logged no 5xx, so the
   * failure lived entirely in the extra hop. Folding page 1 into the search removes the hop, the
   * duplicate `resolvePayerIntelSearch` (which re-classified the term, re-loaded the payer
   * vocabulary and wrote a SECOND access-audit row for every PHI-tokened search), and the extra
   * page re-render Next.js performs after every action. `loadPayerIntelChargeRows` survives for
   * "Load more" only — a user-initiated click with its own visible pending state.
   */
  grid: PayerIntelGridPage;
  /** Window stamps for the column headers and the "how far back" disclosure: payment-received
   *  window [from, to) — `to` is EXCLUSIVE (today + 1, so today's payments ride). */
  window: { from: string; to: string; days: number };
  viewerHasAmountsCapability: boolean;
}

// ── Charge-line grid (the Collections grid, behind this tab's gate) ─────────────────────────────

/** One charge-grain grid row — the CmdExplorerRow shape re-stated client-safe. Money fields are
 *  pg-numeric STRINGS ('5190.00') or null — null EITHER because the row has no value OR because
 *  the viewer is amounts-blind (stripped). PHI columns are never in this shape; identifiers
 *  surface only via a future audited reveal. */
export interface PayerIntelGridRow {
  id: number;
  chargeDate: string;
  paymentReceived: string | null;
  cpt: string | null;
  revenue: string | null;
  payer: string | null;
  facility: string;
  employerName: string | null;
  chargeAmount: string | null;
  allowedAmount: string | null;
  insurancePayments: string | null;
  patientBalanceDue: string | null;
  pctAllowed: string | null;
  pctPaid: string | null;
}

export interface PayerIntelGridCursor {
  id: number;
  value: string | number | null;
}

export interface PayerIntelGridPage {
  rows: PayerIntelGridRow[];
  nextCursor: PayerIntelGridCursor | null;
}

/**
 * The charge-line columns a viewer may sort by, and the ONLY ones the header renders as buttons.
 *
 * This is the Collections allowlist (`CMD_EXPLORER_SORTABLE_COLUMNS`) restated client-side so a
 * Client Component never imports the query module. CPT / revenue / payer / facility / employer are
 * absent ON PURPOSE and must stay absent: the keyset cursor is built from the sort column's value,
 * so a column with no matching index turns every page fetch into a full sort of the tenant slice.
 * Adding one here without adding its index is a latency regression that only shows up in
 * production.
 */
export const PAYER_INTEL_GRID_SORTABLE = [
  'payment_received',
  'charge_date',
  'charge_amount',
  'allowed_amount',
  'pct_allowed',
  'pct_paid',
  'insurance_payments',
  'patient_balance_due',
] as const;
export type PayerIntelGridSortColumn = (typeof PAYER_INTEL_GRID_SORTABLE)[number];
export interface PayerIntelGridSort {
  column: PayerIntelGridSortColumn;
  direction: 'asc' | 'desc';
}
/** Newest payment first — the Collections default, and what the embedded first page always uses. */
export const PAYER_INTEL_GRID_DEFAULT_SORT: PayerIntelGridSort = {
  column: 'payment_received',
  direction: 'desc',
};

/** Clamp an untrusted sort to the allowlist. Returns the default rather than throwing: a sort is a
 *  view preference, and a stale/garbage one should show the grid, not an error. */
export function clampPayerIntelGridSort(value: unknown): PayerIntelGridSort {
  if (typeof value !== 'object' || value === null) return { ...PAYER_INTEL_GRID_DEFAULT_SORT };
  const v = value as { column?: unknown; direction?: unknown };
  const column = (PAYER_INTEL_GRID_SORTABLE as readonly string[]).includes(String(v.column))
    ? (v.column as PayerIntelGridSortColumn)
    : PAYER_INTEL_GRID_DEFAULT_SORT.column;
  const direction = v.direction === 'asc' || v.direction === 'desc' ? v.direction : PAYER_INTEL_GRID_DEFAULT_SORT.direction;
  return { column, direction };
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
 * The URL carries ONLY this non-PHI facet allowlist: payer label, prefix echo, facility text
 * labels, funding tags, the CPT×revenue drill, and the window. Employer names and group numbers
 * are EXCLUDED by ruling precedent (audit I7/R6 kept employer out of the Qualify URL codec; a
 * group number is an identifier) — a shared link restores those searches minus the excluded
 * facet, and the UI says so rather than pretending.
 */
export interface PayerIntelUrlState {
  payer: string | null;
  prefix: string | null;
  facilities: string[];
  funding: string[];
  cpt: string | null;
  revenue: string | null;
  windowDays: number;
}

const PREFIX_RE = /^[A-Z0-9]{1,3}$/;
const CODE_RE = /^[A-Za-z0-9]{1,10}$/;

export function encodePayerIntelUrl(state: PayerIntelUrlState): string {
  const p = new URLSearchParams();
  if (state.payer) p.set('payer', state.payer);
  if (state.prefix && PREFIX_RE.test(state.prefix)) p.set('prefix', state.prefix);
  for (const f of state.facilities) p.append('fac', f);
  for (const f of state.funding) p.append('funding', f);
  if (state.cpt && CODE_RE.test(state.cpt)) p.set('cpt', state.cpt);
  if (state.revenue && CODE_RE.test(state.revenue)) p.set('rev', state.revenue);
  if (state.windowDays !== PAYER_INTEL_DEFAULT_WINDOW_DAYS) p.set('w', String(state.windowDays));
  const s = p.toString();
  return s.length > 0 ? `?${s}` : '';
}

export function decodePayerIntelUrl(params: URLSearchParams): PayerIntelUrlState {
  const prefixRaw = (params.get('prefix') ?? '').toUpperCase();
  const cptRaw = params.get('cpt') ?? '';
  const revRaw = params.get('rev') ?? '';
  return {
    payer: params.get('payer'),
    prefix: PREFIX_RE.test(prefixRaw) ? prefixRaw : null,
    facilities: params.getAll('fac').filter((f) => f.length > 0 && f.length <= 200).slice(0, 20),
    funding: params.getAll('funding').filter((f) => f === 'Self-Funded' || f === 'Fully Insured'),
    cpt: CODE_RE.test(cptRaw) ? cptRaw.toUpperCase() : null,
    revenue: CODE_RE.test(revRaw) ? revRaw : null,
    windowDays: clampPayerIntelWindowDays(params.get('w')),
  };
}

/** True when any facet is active — the IDLE↔RESULT state switch reads this, not the raw term. */
export function hasAnyPayerIntelFacet(input: PayerIntelSearchInput): boolean {
  return Boolean(
    (input.payer && input.payer.trim().length > 0) ||
      (input.prefix && input.prefix.trim().length > 0) ||
      (input.facilities && input.facilities.length > 0) ||
      (input.employerNames && input.employerNames.length > 0) ||
      (input.funding && input.funding.length > 0) ||
      (input.groupNumber && input.groupNumber.trim().length > 0) ||
      (input.cpt && input.cpt.trim().length > 0) ||
      (input.term && input.term.trim().length > 0),
  );
}
