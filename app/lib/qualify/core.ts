/**
 * Qualify orchestration CORE — the action logic (sniff → audit → resolve → load → assemble → strip),
 * dependency-INJECTED so it is unit-testable with fakes (no live session, DB, or blind-index key).
 * The 'use server' actions.ts wires the REAL deps and exports thin Server Actions over these cores.
 *
 * This module has NO server-only runtime import (only pure app modules + type-only imports), so tests
 * can load it hermetically. All PHI/DB/crypto reach it only through the injected QualifyDeps.
 */
import { qualifyRating, QUALIFY_MIN_LINES } from './rating';
import { confidenceOf } from './confidence';
import { facilityLocation } from './facilityLocations';
import {
  isQualifyWindow,
  sniffQualifyKind,
  qualifyWindowBounds,
  QUALIFY_TENANT_SCOPE,
  QUALIFY_MEMBER_ID_MASK,
  QUALIFY_REVEAL_BATCH_CAP,
  type QualifyInput,
  type QualifyPayerInput,
  type QualifyFacilityCasesInput,
  type QualifyFacilityCases,
  type QualifyPatientCohortInput,
  type QualifyPatientCohort,
  type QualifyMatchKind,
  type QualifySnapshot,
  type QualifyResolved,
  type QualifyFacility,
  type QualifyClaim,
  type QualifyMovers,
  type QualifyMover,
  type QualifyInitial,
  type QualifyMarket,
  type QualifyWindowDays,
  type QualifyPhi,
  type QualifyRevealedRow,
  type RevealQualifyRowResult,
  type RevealQualifyRowsResult,
  type QualifyBookKpis,
  type QualifyFacilityTrend,
  type QualifyOverview,
} from './contract';
import type { QualifyPrincipal } from './principal';
import {
  QUALIFY_CASES_MAX,
  type QualifyFacilityRow,
  type QualifyClaimRow,
  type QualifyMoverRow,
  type QualifyBookKpisRow,
  type QualifyFacilityTrendRow,
} from '../../../src/collections/qualifyQuery';
import { COHORT_MIN_PATIENTS, type VobMarketFilter } from '../../../src/collections/cmdExplorerQuery';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../../../src/tenants';

/** Distinct audit action labels (post reveal-audit-action fix) — Qualify surfaces are attributable. */
export const SEARCH_QUALIFY_PHI = 'search_qualify_phi';
/** Resolve-by-payer audit — a payer LABEL was looked up (non-PHI, distinct from the PHI-term search). */
export const SEARCH_QUALIFY_PAYER = 'search_qualify_payer';
/** Facility drill audit — a payer's cases were narrowed to ONE facility (distinct, more-granular access). */
export const SEARCH_QUALIFY_FACILITY = 'search_qualify_facility';
/** Phase 3: a patient-group's lifetime prefix-cohort context was opened (distinct granular access). */
export const SEARCH_QUALIFY_COHORT = 'search_qualify_cohort';
export const REVEAL_QUALIFY_ROW = 'reveal_qualify_row';
export const REVEAL_QUALIFY_ROWS = 'reveal_qualify_rows';

const REVEAL_BATCH_CAP = QUALIFY_REVEAL_BATCH_CAP;

/** Everything the cores touch that isn't pure — injected so tests can fake it. */
export interface QualifyDeps {
  requirePrincipal: () => Promise<QualifyPrincipal>;
  /** Mint the opaque blind-index token (may throw if the key is unavailable → caught as "unavailable"). */
  mintToken: (query: string, kind: QualifyMatchKind) => string | null;
  /** Mint the EXACT group-number blind index (the employer proxy, Phase 2). Same key discipline as
   *  mintToken; null when the term normalizes to nothing. */
  mintGroupToken: (raw: string) => string | null;
  resolvePayer: (token: string, kind: QualifyMatchKind, entityIds: string[]) => Promise<string | null>;
  loadFacilities: (
    payer: string,
    from: string,
    to: string,
    entityIds: string[],
    market?: VobMarketFilter,
  ) => Promise<QualifyFacilityRow[]>;
  /** Fix A: raw facility of the searched identifier's most-recent in-window claim under the payer (or null). */
  loadIdentifierLandingFacility: (
    token: string,
    kind: QualifyMatchKind,
    payer: string,
    from: string,
    to: string,
    entityIds: string[],
  ) => Promise<string | null>;
  loadFacilityCases: (
    payer: string,
    facility: string,
    from: string,
    to: string,
    entityIds: string[],
    opts: {
      prefixToken: string | null;
      memberToken: string | null;
      groupToken: string | null;
      limit: number;
      allPayers?: boolean;
      market?: VobMarketFilter;
    },
  ) => Promise<QualifyClaimRow[]>;
  /** Phase 3: tenant-scoped lookup of ONE claim's alpha-prefix cohort token. Null = unknown/foreign
   *  claim id (fails closed to suppressed). The token never reaches the client. */
  loadClaimPrefixToken: (claimId: number, entityIds: string[]) => Promise<string | null>;
  /** Phase 3: the LIFETIME prefix-cohort context, already gated by the collections cohort floor —
   *  null = below COHORT_MIN_PATIENTS (the caller renders "not enough data"). */
  loadPatientCohort: (prefixBidx: string, entityIds: string[]) => Promise<QualifyPatientCohortRaw | null>;
  loadMovers: (
    thisFrom: string,
    thisTo: string,
    priorFrom: string,
    priorTo: string,
    entityIds: string[],
    market?: VobMarketFilter,
  ) => Promise<QualifyMoverRow[]>;
  /** Redesign overview: book-wide KPI percentages (dollars summed + dropped in SQL). One row. */
  loadBookKpis: (
    from: string,
    to: string,
    entityIds: string[],
    market?: VobMarketFilter,
  ) => Promise<QualifyBookKpisRow | null>;
  /** Redesign overview: per-facility rating trend rows (ratings only). payer null = book-wide. */
  loadFacilityTrends: (
    from: string,
    to: string,
    priorFrom: string,
    entityIds: string[],
    opts?: { payer?: string | null; market?: VobMarketFilter },
  ) => Promise<QualifyFacilityTrendRow[]>;
  recordAccess: (entry: {
    actorEmail: string;
    actorUserId: string;
    action: string;
    detail: Record<string, unknown>;
  }) => Promise<unknown>;
  revealRow: (
    id: number,
    actor: { email: string; userId: string },
    entityIds: string[],
    action: string,
  ) => Promise<QualifyPhi | null>;
  revealRows: (
    ids: number[],
    actor: { email: string; userId: string },
    entityIds: string[],
    action: string,
  ) => Promise<QualifyRevealedRow[]>;
  now: () => Date;
}

/** Raw, un-stripped lifetime cohort context the server loader returns (dollar sums intact — the
 *  CORE strips them for non-amounts viewers; the one choke-point pattern). */
export interface QualifyPatientCohortRaw {
  patients: number;
  billed: number | null;
  allowed: number | null;
  paid: number | null;
  byPayer: { label: string | null; count: number; charge: number }[];
  byCpt: { label: string | null; count: number; charge: number }[];
}

// ── pure assembly helpers ────────────────────────────────────────────────────

/** The ONE amounts choke point (R-AMOUNTS): null every dollar field. Runs LAST, in one place. */
function stripSnapshotAmounts(snap: QualifySnapshot): QualifySnapshot {
  return {
    ...snap,
    facilities: snap.facilities.map((f) => ({ ...f, billedAmount: null, allowedAmount: null })),
  };
}

/** The claims analog of stripSnapshotAmounts — the facility-drill choke point (R-AMOUNTS). Runs LAST. */
function stripClaimsAmounts(claims: QualifyClaim[]): QualifyClaim[] {
  return claims.map((c) => ({ ...c, billedAmount: null, allowedAmount: null }));
}

function emptySnapshot(hasAmounts: boolean): QualifySnapshot {
  return { resolved: null, facilities: [], identifierLandingFacility: null, viewerHasAmountsCapability: hasAmounts, tenantScope: QUALIFY_TENANT_SCOPE };
}

/** Non-PHI alpha-prefix echo (≤3 chars) — never the raw member id. */
function alphaEcho(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

/**
 * Map a facility's distinct tenant uuid(s) to a small NON-PHI label. Both tenants present → 'Mixed'
 * (a raw facility text served under both books — cross-tenant interleave is intended; the label never
 * groups or splits). An unrecognized/empty set → null (never fabricate a label). The canonical uuids
 * are the SAME two the cross-tenant scope pins.
 */
function entityLabel(entityIds: string[] | null | undefined): 'BXR' | 'Indigo' | 'Mixed' | null {
  if (!entityIds || entityIds.length === 0) return null;
  const hasBxr = entityIds.includes(BXR_ENTITY_ID);
  const hasIndigo = entityIds.includes(INDIGO_ENTITY_ID);
  if (hasBxr && hasIndigo) return 'Mixed';
  if (hasBxr) return 'BXR';
  if (hasIndigo) return 'Indigo';
  return null;
}

/**
 * Shape + rate + sort the facility rows. VALUE-FIRST (ruling 2026-07-19b): rank by rating = allowed%
 * desc (nulls last), tiebreak name. FLOOR: drop facilities under QUALIFY_MIN_LINES charge lines first, so
 * a degenerate "100% on 1 line" fluke never surfaces — but a genuinely small facility (>= the floor)
 * ranks on its merit, never demoted for being small.
 */
function assembleFacilities(rows: QualifyFacilityRow[]): QualifyFacility[] {
  return rows
    .filter((r) => r.line_count >= QUALIFY_MIN_LINES)
    .map((r) => ({
      rank: 0,
      name: r.facility_name ?? r.facility,
      facilityKey: r.facility, // raw rollup text — the join key for the facility-scoped cases drill
      city: facilityLocation(r.facility_code)?.city ?? null,
      state: facilityLocation(r.facility_code)?.state ?? null,
      pctAllowedOfBilled: r.pct_allowed,
      rating: qualifyRating(r.pct_allowed),
      streakSignal: null, // Q-E: always null in v1
      billedAmount: r.billed,
      allowedAmount: r.allowed,
      lineCount: r.line_count,
      // 0059 trust signal (non-dollar — survives the amounts strip for admissions_seat).
      confirmedClaims: r.confirmed_claims,
      estimateClaims: r.estimate_claims,
      unknownClaims: r.unknown_claims,
      careSetting: r.care_setting,
      entity: entityLabel(r.entity_ids),
    }))
    .sort((a, b) => {
      if (a.rating === null && b.rating !== null) return 1;
      if (b.rating === null && a.rating !== null) return -1;
      if (a.rating !== null && b.rating !== null && b.rating !== a.rating) return b.rating - a.rating;
      const bp = b.pctAllowedOfBilled ?? -1;
      const ap = a.pctAllowedOfBilled ?? -1;
      if (bp !== ap) return bp - ap;
      return a.name.localeCompare(b.name);
    })
    .map((f, i) => ({ ...f, rank: i + 1 }));
}

function assembleClaims(rows: QualifyClaimRow[]): QualifyClaim[] {
  // PER-RESPONSE patient aliasing: first-seen ordinal per member_id_bidx. The opaque token itself
  // NEVER leaves this function (wire-tested); a null/absent bidx gets its own singleton key so no
  // two unknown-member claims ever merge into a fake patient.
  const aliasByToken = new Map<string, number>();
  let nextAlias = 0;
  const aliasOf = (bidx: string | null): number => {
    if (bidx === null) return ++nextAlias; // singleton — never grouped
    const existing = aliasByToken.get(bidx);
    if (existing !== undefined) return existing;
    nextAlias += 1;
    aliasByToken.set(bidx, nextAlias);
    return nextAlias;
  };
  return rows.map((r) => ({
    id: r.id,
    patientKey: aliasOf(r.member_id_bidx),
    memberIdMasked: QUALIFY_MEMBER_ID_MASK,
    payerName: r.primary_payer, // non-PHI; the SAME rollup column the payer card resolves on (no re-lookup)
    facilityName: r.facility_name ?? r.facility,
    program: r.program,
    dos: r.dos,
    paymentDate: r.payment_date,
    pctAllowedOfBilled: r.pct_allowed,
    billedAmount: r.billed,
    allowedAmount: r.allowed,
    // The six-value tier collapses HERE (confidence.ts) — the client only ever sees the 3 states.
    confidence: confidenceOf(r.allowed_tier),
  }));
}

// ── cores ────────────────────────────────────────────────────────────────────

export async function getQualifySnapshotCore(deps: QualifyDeps, input: QualifyInput): Promise<QualifySnapshot> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const windowDays: QualifyWindowDays = input.windowDays;
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');

  const raw = (input.query ?? '').trim();
  if (raw === '' || raw.length > 120) return emptySnapshot(gate.hasAmounts);

  const kind = sniffQualifyKind(raw);
  let token: string | null;
  try {
    token = deps.mintToken(raw, kind);
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  if (!token) return emptySnapshot(gate.hasAmounts); // e.g. a <3-char prefix → nothing searched → no audit

  // A real PHI search executed → audit BEFORE any data (field NAME only; never term/token).
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_PHI,
    detail: { field: kind, window: windowDays },
  });

  const payerName = await deps.resolvePayer(token, kind, gate.entityIds);
  if (!payerName) return emptySnapshot(gate.hasAmounts); // known-nothing → VOB (resolved stays null)

  const { from, to } = qualifyWindowBounds(windowDays, deps.now());
  // Fix A: alongside the payer-wide ranking, look up WHERE the searched identifier's most-recent in-window
  // claim is (token already minted above). The claim ordering is byte-identical to the drill's.
  const [facRows, landingRaw] = await Promise.all([
    deps.loadFacilities(payerName, from, to, gate.entityIds, input.market),
    deps.loadIdentifierLandingFacility(token, kind, payerName, from, to, gate.entityIds),
  ]);

  const facilities = assembleFacilities(facRows);
  // Approach (ii): keep the landing facility ONLY if it is a ranked (floor-clearing) facility — i.e. present
  // in the assembled facilities[] set (same floor as assembleFacilities, no duplication). A below-floor-only
  // identifier (or none in-window) collapses to null → the frontends render the honest "widen the window" state.
  const identifierLandingFacility =
    landingRaw !== null && facilities.some((f) => f.facilityKey === landingRaw) ? landingRaw : null;
  const resolved: QualifyResolved = {
    payerName,
    matchedOn: kind,
    matchedValue: alphaEcho(raw),
    totalCharges: facilities.reduce((s, f) => s + f.lineCount, 0),
    facilityCount: facilities.length,
    windowStart: from,
    windowEnd: to,
  };
  const snap: QualifySnapshot = {
    resolved,
    facilities,
    identifierLandingFacility,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
  return gate.hasAmounts ? snap : stripSnapshotAmounts(snap); // stripAmounts LAST
}

/**
 * Resolve-by-primary-payer: load a payer's facilities DIRECTLY from its label (a QualifyMover's `label`,
 * i.e. a primary_payer value), bypassing the member-id/prefix PHI resolve. Reuses the SAME facility loader,
 * assembly, tenancy scope, and amounts choke point as getQualifySnapshotCore. No mintToken, no resolvePayer,
 * no SEARCH_QUALIFY_PHI — no PHI term is searched, so there is NO identifier to be exact about: the claims
 * panel on this path stays payer-wide (ruling 3), driven by the facility drill with no identifier narrow. A
 * real payer with no in-window facilities yields the non-null resolved + facilities:[] state (never VOB null).
 */
export async function getQualifySnapshotByPayerCore(
  deps: QualifyDeps,
  input: QualifyPayerInput,
): Promise<QualifySnapshot> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const windowDays: QualifyWindowDays = input.windowDays;
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');

  const payer = (input.payer ?? '').trim();
  if (payer === '' || payer.length > 120) return emptySnapshot(gate.hasAmounts);

  // Non-PHI lookup (payer label, not a member term) → distinct audit action; payer name is not PHI.
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_PAYER,
    detail: { payer, window: windowDays },
  });

  const { from, to } = qualifyWindowBounds(windowDays, deps.now());
  const facRows = await deps.loadFacilities(payer, from, to, gate.entityIds, input.market);

  const facilities = assembleFacilities(facRows);
  const resolved: QualifyResolved = {
    payerName: payer,
    matchedOn: 'payer',
    matchedValue: '', // no PHI prefix echo on the resolve-by-payer path
    totalCharges: facilities.reduce((s, f) => s + f.lineCount, 0),
    facilityCount: facilities.length,
    windowStart: from,
    windowEnd: to,
  };
  const snap: QualifySnapshot = {
    resolved,
    facilities,
    identifierLandingFacility: null, // resolve-by-payer carries NO identifier → payer-wide (ruling 3)
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
  return gate.hasAmounts ? snap : stripSnapshotAmounts(snap); // stripAmounts LAST
}

/**
 * Facility drill (THE rendered recent-claims panel on both surfaces): the resolved payer's CLAIMS at ONE
 * facility (the desktop facility row + mobile facility-card tap), claim grain. Masking (assembleClaims),
 * tenancy scope, and the amounts choke point (stripClaimsAmounts) run here; the axes are the raw-facility-text
 * filter plus the optional identifier narrow (prefix/exact member). A distinct SEARCH_QUALIFY_FACILITY audit
 * records the more-granular access (payer + facility are non-PHI; the narrow's field NAME only, never the term).
 */
export async function getQualifyFacilityCasesCore(
  deps: QualifyDeps,
  input: QualifyFacilityCasesInput,
): Promise<QualifyFacilityCases> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop (route guards are the primary gate)

  const windowDays: QualifyWindowDays = input.windowDays;
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');

  const payer = (input.payer ?? '').trim();
  const facility = (input.facility ?? '').trim();
  const empty: QualifyFacilityCases = {
    claims: [],
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    capped: false,
  };
  if (payer === '' || payer.length > 120 || facility === '' || facility.length > 200) return empty;

  // IDENTIFIER narrow (Direction B): mint the SAME blind index the resolve path uses — server-side, opaque.
  // The raw term (the caller's own typed value: the resolving search OR the manual prefix input — never row
  // PHI) reaches neither SQL nor the audit. EXACT member-id (member_id_bidx) takes precedence over the ≤3
  // alpha-PREFIX (member_id_prefix_bidx); mutually exclusive in practice. A term minting no token (e.g. a
  // <3-char prefix) yields no filter (parity with collections' alpha-prefix behavior).
  const memberId = (input.filter?.memberId ?? '').trim();
  const prefix = (input.filter?.prefix ?? '').trim();
  let memberToken: string | null = null;
  let prefixToken: string | null = null;
  let narrowField: QualifyMatchKind | null = null;
  try {
    if (memberId !== '' && memberId.length <= 120) {
      memberToken = deps.mintToken(memberId, 'member_id');
      if (memberToken) narrowField = 'member_id';
    } else if (prefix !== '' && prefix.length <= 40) {
      prefixToken = deps.mintToken(prefix, 'prefix');
      if (prefixToken) narrowField = 'prefix';
    }
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }
  // Group-number narrow (EXACT — the employer proxy; Phase 2). Independent of the member narrow
  // (ANDed in SQL). Same mint discipline: server-side, opaque, raw term never logged.
  const groupTerm = (input.filter?.group ?? '').trim();
  let groupToken: string | null = null;
  try {
    if (groupTerm !== '' && groupTerm.length <= 40) groupToken = deps.mintGroupToken(groupTerm);
  } catch {
    throw new Error('Qualify search is temporarily unavailable.'); // key/config error, never PHI
  }

  // Narrowing a payer to one facility is a distinct, more-granular access → its own audit action. When a
  // narrow is actually applied, record the FIELD NAME(S) only (never the term/token).
  const narrowFields = [...(narrowField ? [narrowField] : []), ...(groupToken ? ['group_number'] : [])];
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_FACILITY,
    detail: { payer, facility, window: windowDays, ...(narrowFields.length ? { fields: narrowFields } : {}) },
  });

  // The drill returns the WHOLE (facility, payer, window) set — no keyset pager — capped at QUALIFY_CASES_MAX.
  // allPayers (mobile) only drops the single-payer filter. The identifier narrow (when the session arrived via
  // a search) still applies (ruling 5). The builder over-fetches by one (limit+1) so `capped` is a length
  // check, not a count.
  const allPayers = input.allPayers === true;
  const { from, to } = qualifyWindowBounds(windowDays, deps.now());
  const claimRows = await deps.loadFacilityCases(payer, facility, from, to, gate.entityIds, {
    prefixToken,
    memberToken,
    groupToken,
    limit: QUALIFY_CASES_MAX,
    allPayers,
    market: input.market,
  });
  const capped = claimRows.length > QUALIFY_CASES_MAX;
  const pageRows = capped ? claimRows.slice(0, QUALIFY_CASES_MAX) : claimRows; // keep the MOST RECENT (payment desc)
  // Route through the ONE amounts choke point (stripClaimsAmounts) — stripAmounts LAST.
  const claims = gate.hasAmounts ? assembleClaims(pageRows) : stripClaimsAmounts(assembleClaims(pageRows));
  return {
    claims,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    capped,
  };
}

/**
 * Phase 3 — the patient-group "View cohort" slide-over: the member's LIFETIME alpha-prefix cohort
 * (payer-behavior peer group). Flow: gate → audit (field-level, non-PHI) → re-derive the prefix
 * token SERVER-SIDE from one claim id (never from the client) → load the floor-gated context →
 * strip dollars for non-amounts viewers. Every failure path (bad id, foreign id, below-floor
 * cohort) collapses to the SAME suppressed shape — a caller can't distinguish "not yours" from
 * "too small" (no oracle).
 */
export async function getQualifyPatientCohortCore(
  deps: QualifyDeps,
  input: QualifyPatientCohortInput,
): Promise<QualifyPatientCohort> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error); // fail-closed backstop

  const windowDays: QualifyWindowDays = input.windowDays;
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');
  const suppressed: QualifyPatientCohort = {
    suppressed: true,
    floor: COHORT_MIN_PATIENTS,
    patients: null,
    pctCollected: null,
    pctAllowed: null,
    pctPaid: null,
    byPayer: [],
    byCpt: [],
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
  if (!Number.isSafeInteger(input.claimId) || input.claimId < 1) return suppressed;

  // Audit BEFORE any data (the cohort context is a distinct, more-granular access). Non-PHI detail:
  // labels + window + the synthetic claim id (the reveal-audit precedent) — never a term or token.
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_COHORT,
    detail: {
      payer: (input.payer ?? '').slice(0, 120),
      facility: (input.facility ?? '').slice(0, 200),
      window: windowDays,
      claimId: input.claimId,
    },
  });

  const token = await deps.loadClaimPrefixToken(input.claimId, gate.entityIds);
  if (!token) return suppressed; // unknown / cross-tenant claim id — fail closed, same shape
  const raw = await deps.loadPatientCohort(token, gate.entityIds);
  if (!raw) return suppressed; // below the collections cohort floor — same shape

  const ratio = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? Math.round((num / den) * 10000) / 100 : null;
  const strip = !gate.hasAmounts;
  return {
    suppressed: false,
    floor: COHORT_MIN_PATIENTS,
    patients: raw.patients,
    pctCollected: ratio(raw.paid, raw.billed),
    pctAllowed: ratio(raw.allowed, raw.billed),
    pctPaid: ratio(raw.paid, raw.allowed),
    byPayer: raw.byPayer.map((g) => ({ label: g.label, count: g.count, charge: strip ? null : g.charge })),
    byCpt: raw.byCpt.map((g) => ({ label: g.label, count: g.count, charge: strip ? null : g.charge })),
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

export async function getQualifyMoversCore(
  deps: QualifyDeps,
  windowDays: QualifyWindowDays,
  market?: VobMarketFilter,
): Promise<QualifyMovers> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');

  const { from, to, priorFrom, priorTo } = qualifyWindowBounds(windowDays, deps.now());
  const rows = await deps.loadMovers(from, to, priorFrom, priorTo, gate.entityIds, market);
  const movers: QualifyMover[] = rows.map((r, i) => ({
    rank: i + 1,
    label: r.primary_payer,
    thisWindowPatients: r.this_patients,
    priorWindowPatients: r.prior_patients,
    deltaPatients: r.delta_patients,
    deltaPct: r.prior_patients > 0 ? Math.round((r.delta_patients / r.prior_patients) * 100) : null,
  }));
  // Movers carries NO dollar fields → nothing to strip; hasAmounts is informational only.
  return {
    windowStart: from,
    windowEnd: to,
    priorWindowStart: priorFrom,
    priorWindowEnd: priorTo,
    movers,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

/**
 * Combined ON-LOAD resolution (perf): movers + the auto-resolved top payer's snapshot + its rank-1
 * facility's seed cases, in ONE server round-trip. Composes the THREE existing cores back-to-back, so
 * gating, audits (SEARCH_QUALIFY_PAYER on the resolve, SEARCH_QUALIFY_FACILITY on the seed), and the
 * amounts choke points are byte-identical to the old client waterfall — only the client hops between
 * them are removed. No movers → the empty-prompt shape (all nulls). Mirrors the client's on-load logic:
 * resolve the top mover by payer, seed rank-1's cases (payer-wide; no identifier narrow on this path).
 */
export async function getQualifyInitialCore(
  deps: QualifyDeps,
  windowDays: QualifyWindowDays,
  market?: QualifyMarket,
): Promise<QualifyInitial> {
  const movers = await getQualifyMoversCore(deps, windowDays, market);
  const top = movers.movers[0]?.label ?? null;
  const empty: QualifyInitial = {
    movers: movers.movers, topPayer: top, snapshot: null,
    seedFacility: null, seedCases: [], seedCapped: false,
  };
  if (!top) return empty;

  const snapshot = await getQualifySnapshotByPayerCore(deps, { payer: top, windowDays, market });
  const rank1 = snapshot.resolved ? snapshot.facilities[0]?.facilityKey ?? null : null;
  if (!snapshot.resolved || !rank1) return { ...empty, snapshot };

  const cases = await getQualifyFacilityCasesCore(deps, {
    payer: snapshot.resolved.payerName,
    facility: rank1,
    windowDays,
    market,
  });
  return {
    movers: movers.movers,
    topPayer: top,
    snapshot,
    seedFacility: rank1,
    seedCases: cases.claims,
    seedCapped: cases.capped,
  };
}

// ── Redesign overview cores (book KPIs + facility trend + the combined on-load payload) ──────────

/** Shape a raw trend row → the client contract: attach city/state + entity label, compute the delta. */
function assembleTrend(r: QualifyFacilityTrendRow): QualifyFacilityTrend {
  const loc = facilityLocation(r.facility_code);
  const cur = r.cur_rating;
  const prior = r.prior_rating;
  return {
    facilityKey: r.facility,
    name: r.facility_name ?? r.facility,
    city: loc?.city ?? null,
    state: loc?.state ?? null,
    careSetting: r.care_setting,
    entity: entityLabel(r.entity_ids),
    dominantPayer: r.dominant_payer,
    lineCount: r.line_count,
    currentRating: cur,
    priorRating: prior,
    // Delta in whole-tenth points; null when there is no prior-window evidence (a NEW facility).
    deltaPts: cur !== null && prior !== null ? Math.round((cur - prior) * 10) / 10 : null,
    points: Array.isArray(r.points) ? r.points : [],
  };
}

/**
 * Book-wide KPI percentages for the window (redesign overview tiles). Gate-only (non-PHI aggregate,
 * parity with movers — no per-fetch PHI audit). Returns percentages only; the SQL never projects the
 * dollar sums, so this is admissions_seat-safe by construction.
 */
export async function getQualifyBookKpisCore(
  deps: QualifyDeps,
  windowDays: QualifyWindowDays,
  market?: QualifyMarket,
): Promise<QualifyBookKpis> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');
  const { from, to } = qualifyWindowBounds(windowDays, deps.now());
  const row = await deps.loadBookKpis(from, to, gate.entityIds, market);
  return {
    pctAllowedOfBilled: row?.pct_allowed_of_billed ?? null,
    pctPaidOfAllowed: row?.pct_paid_of_allowed ?? null,
    pctPaidOfBilled: row?.pct_paid_of_billed ?? null,
    windowStart: from,
    windowEnd: to,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
}

/**
 * Per-facility rating trend rows (redesign "Facilities Heating Up" + sparklines). Gate-only (ratings
 * only, non-PHI). `payer` null = book-wide (the overview row); set = the resolved payer's facilities
 * (per-facility sparklines in the panel). Order is preserved from SQL (rating-delta desc, new last).
 */
export async function getQualifyFacilityTrendsCore(
  deps: QualifyDeps,
  windowDays: QualifyWindowDays,
  opts?: { payer?: string | null; market?: QualifyMarket },
): Promise<QualifyFacilityTrend[]> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');
  const { from, to, priorFrom } = qualifyWindowBounds(windowDays, deps.now());
  const rows = await deps.loadFacilityTrends(from, to, priorFrom, gate.entityIds, {
    payer: opts?.payer ?? null,
    market: opts?.market,
  });
  return rows.map(assembleTrend);
}

/**
 * Combined ON-LOAD overview (ONE round-trip): book KPIs + trending facilities in parallel, then the
 * HYBRID resolve — the top trending facility's dominant payer is resolved and the cases are seeded to
 * THAT facility (not rank-1), so the surface lands showing the exact facility the top card names.
 * Composes the existing cores, so every gate/audit/strip is byte-identical to the manual flow. No
 * trend / no dominant payer → the KPIs + trends still return, with a null snapshot (empty prompt).
 */
export async function getQualifyOverviewCore(
  deps: QualifyDeps,
  windowDays: QualifyWindowDays,
  market?: QualifyMarket,
): Promise<QualifyOverview> {
  const [kpis, trends] = await Promise.all([
    getQualifyBookKpisCore(deps, windowDays, market),
    getQualifyFacilityTrendsCore(deps, windowDays, { payer: null, market }),
  ]);
  const empty: QualifyOverview = {
    kpis, trends, topFacility: null, topPayer: null, snapshot: null, seedFacility: null, seedCases: [], seedCapped: false,
  };
  // The hybrid focus is the FIRST trending facility that carries a resolvable dominant payer.
  const top = trends.find((t) => t.dominantPayer) ?? null;
  if (!top || !top.dominantPayer) return empty;

  const snapshot = await getQualifySnapshotByPayerCore(deps, { payer: top.dominantPayer, windowDays, market });
  if (!snapshot.resolved) return { ...empty, topPayer: top.dominantPayer, topFacility: top.facilityKey, snapshot };
  // Scope to the trend facility IF it ranks under its dominant payer this window; else the payer's rank-1.
  const focus = snapshot.facilities.some((f) => f.facilityKey === top.facilityKey)
    ? top.facilityKey
    : snapshot.facilities[0]?.facilityKey ?? null;
  if (!focus) return { ...empty, topPayer: top.dominantPayer, topFacility: top.facilityKey, snapshot };

  const cases = await getQualifyFacilityCasesCore(deps, {
    payer: snapshot.resolved.payerName,
    facility: focus,
    windowDays,
    market,
  });
  return {
    kpis, trends,
    topFacility: focus,
    topPayer: top.dominantPayer,
    snapshot,
    seedFacility: focus,
    seedCases: cases.claims,
    seedCapped: cases.capped,
  };
}

export async function revealQualifyRowCore(deps: QualifyDeps, id: number): Promise<RevealQualifyRowResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!Number.isInteger(id) || id < 0) return { ok: false, error: 'Invalid row.' };
  try {
    const phi = await deps.revealRow(id, gate.actor, gate.entityIds, REVEAL_QUALIFY_ROW);
    if (!phi) return { ok: false, error: 'That record is not available.' };
    return { ok: true, phi };
  } catch {
    return { ok: false, error: 'The identifiers could not be revealed right now.' };
  }
}

export async function revealQualifyRowsCore(deps: QualifyDeps, ids: number[]): Promise<RevealQualifyRowsResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'No rows to reveal.' };
  if (ids.length > REVEAL_BATCH_CAP) return { ok: false, error: 'Too many rows.' };
  if (!ids.every((i) => Number.isInteger(i) && i >= 0)) return { ok: false, error: 'Invalid row.' };
  try {
    const rows = await deps.revealRows(ids, gate.actor, gate.entityIds, REVEAL_QUALIFY_ROWS);
    return { ok: true, rows };
  } catch {
    return { ok: false, error: 'The identifiers could not be revealed right now.' };
  }
}
