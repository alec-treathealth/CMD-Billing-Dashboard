'use server';

/**
 * Qualify SERVER ACTIONS — the browser's only data path for the Qualify tab (desktop, Prompt 3) and
 * the mobile PWA (Prompt 4); both consume the IDENTICAL contract (contract.ts). Thin wrappers: they
 * build the REAL dependencies and delegate to the dependency-injected cores (core.ts), where the
 * orchestration, the Q-A gate, the single stripAmounts choke point, and the audits live and are
 * unit-tested. A 'use server' module may export ONLY async functions — types + cores live elsewhere.
 */
import { requireQualifyPrincipal } from '@/lib/qualify/gate';
import {
  resolveQualifyPayer,
  loadQualifyFacilities,
  loadQualifyCases,
  loadQualifyFacilityCases,
  loadQualifyMovers,
  recordAccess,
  revealCmdExplorerRow,
  revealCmdExplorerRows,
} from '@/lib/server';
import { memberIdBlindIndex, alphaPrefixBlindIndex } from '../../../src/collections/blindIndex';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  getQualifyFacilityCasesCore,
  getQualifyMoversCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  type QualifyDeps,
} from '@/lib/qualify/core';
import type {
  QualifyInput,
  QualifyPayerInput,
  QualifyFacilityCasesInput,
  QualifyFacilityCases,
  QualifySnapshot,
  QualifyMovers,
  QualifyWindowDays,
  RevealQualifyRowResult,
  RevealQualifyRowsResult,
} from '@/lib/qualify/contract';

const realDeps: QualifyDeps = {
  requirePrincipal: requireQualifyPrincipal,
  mintToken: (query, kind) => (kind === 'prefix' ? alphaPrefixBlindIndex(query) : memberIdBlindIndex(query)),
  resolvePayer: resolveQualifyPayer,
  loadFacilities: loadQualifyFacilities,
  loadCases: loadQualifyCases,
  loadFacilityCases: loadQualifyFacilityCases,
  loadMovers: loadQualifyMovers,
  recordAccess,
  revealRow: (id, actor, entityIds, action) => revealCmdExplorerRow(id, actor, entityIds, action),
  revealRows: (ids, actor, entityIds, action) => revealCmdExplorerRows(ids, actor, entityIds, action),
  now: () => new Date(),
};

export async function getQualifySnapshot(input: QualifyInput): Promise<QualifySnapshot> {
  return getQualifySnapshotCore(realDeps, input);
}

/** Resolve-by-payer: load a payer's facilities/cases directly from its label (the Heating-up path). */
export async function getQualifySnapshotByPayer(input: QualifyPayerInput): Promise<QualifySnapshot> {
  return getQualifySnapshotByPayerCore(realDeps, input);
}

/** Facility drill: the resolved payer's cases narrowed to ONE facility (the mobile facility-card tap). */
export async function getQualifyFacilityCases(input: QualifyFacilityCasesInput): Promise<QualifyFacilityCases> {
  return getQualifyFacilityCasesCore(realDeps, input);
}

export async function getQualifyMovers(windowDays: QualifyWindowDays): Promise<QualifyMovers> {
  return getQualifyMoversCore(realDeps, windowDays);
}

export async function revealQualifyRow(id: number): Promise<RevealQualifyRowResult> {
  return revealQualifyRowCore(realDeps, id);
}

export async function revealQualifyRows(ids: number[]): Promise<RevealQualifyRowsResult> {
  return revealQualifyRowsCore(realDeps, ids);
}
