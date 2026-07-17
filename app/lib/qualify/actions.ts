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
  loadQualifyMovers,
  recordAccess,
  revealCmdExplorerRow,
  revealCmdExplorerRows,
} from '@/lib/server';
import { memberIdBlindIndex, alphaPrefixBlindIndex } from '../../../src/collections/blindIndex';
import {
  getQualifySnapshotCore,
  getQualifyMoversCore,
  revealQualifyRowCore,
  revealQualifyRowsCore,
  type QualifyDeps,
} from '@/lib/qualify/core';
import type {
  QualifyInput,
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
  loadMovers: loadQualifyMovers,
  recordAccess,
  revealRow: (id, actor, entityIds, action) => revealCmdExplorerRow(id, actor, entityIds, action),
  revealRows: (ids, actor, entityIds, action) => revealCmdExplorerRows(ids, actor, entityIds, action),
  now: () => new Date(),
};

export async function getQualifySnapshot(input: QualifyInput): Promise<QualifySnapshot> {
  return getQualifySnapshotCore(realDeps, input);
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
