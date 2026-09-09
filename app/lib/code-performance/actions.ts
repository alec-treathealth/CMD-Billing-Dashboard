'use server';

/**
 * Code Performance Server Actions — the browser's ONLY data path for /code-performance (standing
 * rule, nextjs-app.md; ruled over REST routes 2026-09-08). Thin binders: gate → clamp every client
 * value → core with real deps. ⚠ A `'use server'` file may export ONLY async functions — one
 * non-function export 500s every action on the page (memory: use-server-export-kills-all-actions);
 * sync factories live in deps.ts.
 *
 * Two entry points, matching the two endpoints originally specified:
 *   getCodePerformanceBoard(tenant, window, facilities)          → pairing rows + summary + freshness
 *   getCodePerformancePairDetail(tenant, window, facilities, pair) → payers + facilities + monthly
 * The drill-down is a SEPARATE call on purpose — BXR alone has 151 distinct raw payer strings, so
 * payer detail never rides in the board payload.
 *
 * Every action returns a typed union and never echoes an internal error to the client. No PHI is
 * read or returned: pairings, payer names, facility names and money aggregates only.
 */
import {
  resolveCodePerfWindow,
  sanitizeCodePerfFacilities,
  sanitizeCodePerfPairKey,
} from '../../../src/collections/codePerformanceQuery.js';
import type { CodePerfBoardResult, CodePerfPairResult } from './contract';
import { getCodePerfBoardCore, getCodePerfPairDetailCore } from './core';
import { buildCodePerfRealDeps } from './deps';
import { requireCodePerfPrincipal } from './gate';
import { codePerfEntityId, resolveCodePerfTenant } from './principal';

function pick(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

export async function getCodePerformanceBoard(input: unknown): Promise<CodePerfBoardResult> {
  const principal = await requireCodePerfPrincipal();
  if (!principal) return { ok: false, reason: 'forbidden' };
  const o = pick(input);
  const tenant = resolveCodePerfTenant(o.tenant, principal.tenants);
  if (!tenant) return { ok: false, reason: 'forbidden' };
  const clean = {
    tenant,
    window: resolveCodePerfWindow(o.window),
    facilities: sanitizeCodePerfFacilities(o.facilities),
  };
  try {
    const board = await getCodePerfBoardCore(buildCodePerfRealDeps(), codePerfEntityId(tenant), tenant, clean);
    return { ok: true, board };
  } catch (err) {
    console.error('getCodePerformanceBoard failed', err instanceof Error ? err.message : '');
    return { ok: false, reason: 'error' };
  }
}

export async function getCodePerformancePairDetail(input: unknown): Promise<CodePerfPairResult> {
  const principal = await requireCodePerfPrincipal();
  if (!principal) return { ok: false, reason: 'forbidden' };
  const o = pick(input);
  const tenant = resolveCodePerfTenant(o.tenant, principal.tenants);
  if (!tenant) return { ok: false, reason: 'forbidden' };
  const clean = {
    tenant,
    window: resolveCodePerfWindow(o.window),
    facilities: sanitizeCodePerfFacilities(o.facilities),
    pair: sanitizeCodePerfPairKey(o.pair),
  };
  try {
    const detail = await getCodePerfPairDetailCore(buildCodePerfRealDeps(), codePerfEntityId(tenant), clean);
    return { ok: true, detail };
  } catch (err) {
    console.error('getCodePerformancePairDetail failed', err instanceof Error ? err.message : '');
    return { ok: false, reason: 'error' };
  }
}
