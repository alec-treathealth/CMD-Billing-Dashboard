/**
 * Qualify orchestration CORE — the action logic (sniff → audit → resolve → load → assemble → strip),
 * dependency-INJECTED so it is unit-testable with fakes (no live session, DB, or blind-index key).
 * The 'use server' actions.ts wires the REAL deps and exports thin Server Actions over these cores.
 *
 * This module has NO server-only runtime import (only pure app modules + type-only imports), so tests
 * can load it hermetically. All PHI/DB/crypto reach it only through the injected QualifyDeps.
 */
import { qualifyRating, QUALIFY_MIN_LINES } from './rating';
import { facilityLocation } from './facilityLocations';
import {
  isQualifyWindow,
  sniffQualifyKind,
  qualifyWindowBounds,
  QUALIFY_TENANT_SCOPE,
  QUALIFY_MEMBER_ID_MASK,
  type QualifyInput,
  type QualifyPayerInput,
  type QualifyFacilityCasesInput,
  type QualifyFacilityCases,
  type QualifyCasesCursor,
  type QualifyMatchKind,
  type QualifySnapshot,
  type QualifyResolved,
  type QualifyFacility,
  type QualifyClaim,
  type QualifyMovers,
  type QualifyMover,
  type QualifyWindowDays,
  type QualifyPhi,
  type QualifyRevealedRow,
  type RevealQualifyRowResult,
  type RevealQualifyRowsResult,
} from './contract';
import type { QualifyPrincipal } from './principal';
import type {
  QualifyFacilityRow,
  QualifyClaimRow,
  QualifyMoverRow,
} from '../../../src/collections/qualifyQuery';

/** Distinct audit action labels (post reveal-audit-action fix) — Qualify surfaces are attributable. */
export const SEARCH_QUALIFY_PHI = 'search_qualify_phi';
/** Resolve-by-payer audit — a payer LABEL was looked up (non-PHI, distinct from the PHI-term search). */
export const SEARCH_QUALIFY_PAYER = 'search_qualify_payer';
/** Facility drill audit — a payer's cases were narrowed to ONE facility (distinct, more-granular access). */
export const SEARCH_QUALIFY_FACILITY = 'search_qualify_facility';
export const REVEAL_QUALIFY_ROW = 'reveal_qualify_row';
export const REVEAL_QUALIFY_ROWS = 'reveal_qualify_rows';

const REVEAL_BATCH_CAP = 50;

/** Cases page size (mirrors QUALIFY_CASES_LIMIT in qualifyQuery.ts). The loader OVER-FETCHES by one
 *  (buildFacilityCasesQuery binds limit+1) so hasMore is a length check here, never a count query. */
const QUALIFY_CASES_PAGE_SIZE = 15;

/** All-payers facility view (mobile) page size: one larger page, capped at the reveal batch cap so a
 *  single "Reveal all" stays within REVEAL_BATCH_CAP. hasMore over this cap drives the "N recent" label. */
const QUALIFY_ALL_PAYERS_PAGE_SIZE = REVEAL_BATCH_CAP;

/** Everything the cores touch that isn't pure — injected so tests can fake it. */
export interface QualifyDeps {
  requirePrincipal: () => Promise<QualifyPrincipal>;
  /** Mint the opaque blind-index token (may throw if the key is unavailable → caught as "unavailable"). */
  mintToken: (query: string, kind: QualifyMatchKind) => string | null;
  resolvePayer: (token: string, kind: QualifyMatchKind, entityIds: string[]) => Promise<string | null>;
  loadFacilities: (payer: string, from: string, to: string, entityIds: string[]) => Promise<QualifyFacilityRow[]>;
  loadFacilityCases: (
    payer: string,
    facility: string,
    from: string,
    to: string,
    entityIds: string[],
    opts: { prefixToken: string | null; memberToken: string | null; cursor: QualifyCasesCursor | null; limit: number; allPayers?: boolean },
  ) => Promise<QualifyClaimRow[]>;
  loadMovers: (
    thisFrom: string,
    thisTo: string,
    priorFrom: string,
    priorTo: string,
    entityIds: string[],
  ) => Promise<QualifyMoverRow[]>;
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
  return { resolved: null, facilities: [], viewerHasAmountsCapability: hasAmounts, tenantScope: QUALIFY_TENANT_SCOPE };
}

/** Non-PHI alpha-prefix echo (≤3 chars) — never the raw member id. */
function alphaEcho(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

/** Shape-clamp an untrusted client cursor (mirrors resolveCmdExplorerCursor): a malformed cursor
 *  becomes null (first page) rather than reaching SQL. id must be a safe int ≥ 1; lastDos null|string. */
function clampCasesCursor(cursor: QualifyCasesCursor | null | undefined): QualifyCasesCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!Number.isSafeInteger(cursor.id) || cursor.id < 1) return null;
  const ld = cursor.lastDos;
  if (ld !== null && typeof ld !== 'string') return null;
  return { lastDos: ld ?? null, id: cursor.id };
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
  return rows.map((r) => ({
    id: r.id,
    memberIdMasked: QUALIFY_MEMBER_ID_MASK,
    payerName: r.primary_payer, // non-PHI; the SAME rollup column the payer card resolves on (no re-lookup)
    facilityName: r.facility_name ?? r.facility,
    program: r.program,
    dos: r.dos,
    pctAllowedOfBilled: r.pct_allowed,
    billedAmount: r.billed,
    allowedAmount: r.allowed,
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
  const facRows = await deps.loadFacilities(payerName, from, to, gate.entityIds);

  const facilities = assembleFacilities(facRows);
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
  const facRows = await deps.loadFacilities(payer, from, to, gate.entityIds);

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
    nextCursor: null,
    hasMore: false,
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

  // Narrowing a payer to one facility is a distinct, more-granular access → its own audit action. When an
  // identifier narrow is actually applied, record the FIELD NAME only (never the term/token).
  await deps.recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: SEARCH_QUALIFY_FACILITY,
    detail: { payer, facility, window: windowDays, ...(narrowField ? { fields: [narrowField] } : {}) },
  });

  // All-payers (mobile) loads ONE larger page with no cursor — the sheet groups + filters client-side. The
  // identifier narrow (when the session arrived via a search) still applies (ruling 5).
  const allPayers = input.allPayers === true;
  const pageSize = allPayers ? QUALIFY_ALL_PAYERS_PAGE_SIZE : QUALIFY_CASES_PAGE_SIZE;
  const cursor = allPayers ? null : clampCasesCursor(input.cursor);
  const { from, to } = qualifyWindowBounds(windowDays, deps.now());
  // Ask for one page; the builder over-fetches by one (limit+1) so hasMore is a length check, not a count.
  const claimRows = await deps.loadFacilityCases(payer, facility, from, to, gate.entityIds, {
    prefixToken,
    memberToken,
    cursor,
    limit: pageSize,
    allPayers,
  });
  const hasMore = claimRows.length > pageSize;
  const pageRows = hasMore ? claimRows.slice(0, pageSize) : claimRows;
  // Route through the ONE amounts choke point (stripClaimsAmounts) — stripAmounts LAST.
  const claims = gate.hasAmounts ? assembleClaims(pageRows) : stripClaimsAmounts(assembleClaims(pageRows));
  // nextCursor from the LAST kept row — non-PHI (DOS + synthetic id). Null at the end of the walk.
  const last = claims[claims.length - 1];
  const nextCursor: QualifyCasesCursor | null =
    hasMore && last ? { lastDos: last.dos, id: last.id } : null;
  return {
    claims,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
    nextCursor,
    hasMore,
  };
}

export async function getQualifyMoversCore(deps: QualifyDeps, windowDays: QualifyWindowDays): Promise<QualifyMovers> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);
  if (!isQualifyWindow(windowDays)) throw new Error('Invalid window.');

  const { from, to, priorFrom, priorTo } = qualifyWindowBounds(windowDays, deps.now());
  const rows = await deps.loadMovers(from, to, priorFrom, priorTo, gate.entityIds);
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
