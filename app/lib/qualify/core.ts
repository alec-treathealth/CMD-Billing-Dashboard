/**
 * Qualify orchestration CORE — the action logic (sniff → audit → resolve → load → assemble → strip),
 * dependency-INJECTED so it is unit-testable with fakes (no live session, DB, or blind-index key).
 * The 'use server' actions.ts wires the REAL deps and exports thin Server Actions over these cores.
 *
 * This module has NO server-only runtime import (only pure app modules + type-only imports), so tests
 * can load it hermetically. All PHI/DB/crypto reach it only through the injected QualifyDeps.
 */
import { qualifyRating } from './rating';
import { facilityLocation } from './facilityLocations';
import {
  isQualifyWindow,
  sniffQualifyKind,
  qualifyWindowBounds,
  QUALIFY_TENANT_SCOPE,
  QUALIFY_MEMBER_ID_MASK,
  type QualifyInput,
  type QualifyMatchKind,
  type QualifySnapshot,
  type QualifyResolved,
  type QualifyFacility,
  type QualifyCase,
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
  QualifyCaseRow,
  QualifyMoverRow,
} from '../../../src/collections/qualifyQuery';

/** Distinct audit action labels (post reveal-audit-action fix) — Qualify surfaces are attributable. */
export const SEARCH_QUALIFY_PHI = 'search_qualify_phi';
export const REVEAL_QUALIFY_ROW = 'reveal_qualify_row';
export const REVEAL_QUALIFY_ROWS = 'reveal_qualify_rows';

const REVEAL_BATCH_CAP = 50;

/** Everything the cores touch that isn't pure — injected so tests can fake it. */
export interface QualifyDeps {
  requirePrincipal: () => Promise<QualifyPrincipal>;
  /** Mint the opaque blind-index token (may throw if the key is unavailable → caught as "unavailable"). */
  mintToken: (query: string, kind: QualifyMatchKind) => string | null;
  resolvePayer: (token: string, kind: QualifyMatchKind, entityIds: string[]) => Promise<string | null>;
  loadFacilities: (payer: string, from: string, to: string, entityIds: string[]) => Promise<QualifyFacilityRow[]>;
  loadCases: (payer: string, from: string, to: string, entityIds: string[]) => Promise<QualifyCaseRow[]>;
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
    cases: snap.cases.map((c) => ({ ...c, billedAmount: null, allowedAmount: null })),
  };
}

function emptySnapshot(hasAmounts: boolean): QualifySnapshot {
  return { resolved: null, facilities: [], cases: [], viewerHasAmountsCapability: hasAmounts, tenantScope: QUALIFY_TENANT_SCOPE };
}

/** Non-PHI alpha-prefix echo (≤3 chars) — never the raw member id. */
function alphaEcho(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

/** Shape + rate + sort the facility rows. Q-G: rank by rating desc (nulls last), tiebreak pct then name. */
function assembleFacilities(rows: QualifyFacilityRow[]): QualifyFacility[] {
  return rows
    .map((r) => ({
      rank: 0,
      name: r.facility_name ?? r.facility,
      city: facilityLocation(r.facility_code)?.city ?? null,
      state: facilityLocation(r.facility_code)?.state ?? null,
      pctAllowedOfBilled: r.pct_allowed,
      rating: qualifyRating(r.pct_allowed, r.line_count),
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

function assembleCases(rows: QualifyCaseRow[]): QualifyCase[] {
  return rows.map((r) => ({
    id: r.id,
    memberIdMasked: QUALIFY_MEMBER_ID_MASK,
    facilityName: r.facility_name ?? r.facility,
    program: r.program,
    lastDos: r.last_dos,
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
  const [facRows, caseRows] = await Promise.all([
    deps.loadFacilities(payerName, from, to, gate.entityIds),
    deps.loadCases(payerName, from, to, gate.entityIds),
  ]);

  const facilities = assembleFacilities(facRows);
  const cases = assembleCases(caseRows);
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
    cases,
    viewerHasAmountsCapability: gate.hasAmounts,
    tenantScope: QUALIFY_TENANT_SCOPE,
  };
  return gate.hasAmounts ? snap : stripSnapshotAmounts(snap); // stripAmounts LAST
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
