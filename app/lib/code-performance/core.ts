/**
 * Code Performance core — runs the src builders through injected deps and shapes the results into
 * the contract. No auth here (gate.ts + actions.ts own that), no pg here (deps.ts owns that): this is
 * testable with a fake `query`. Everything is scoped by the entityId the caller already clamped.
 */
import {
  CODE_PERF_WINDOWS,
  buildCodeDescriptionQuery,
  buildCodePerfFacilityOptionsQuery,
  buildCodePerfFacilityQuery,
  buildCodePerfFreshnessQuery,
  buildCodePerfMonthlyQuery,
  buildCodePerfPairingQuery,
  buildCodePerfPayerQuery,
  buildCodePerfWindowSummaryQuery,
  isImmatureWindow,
  shapeCodePerfPairingRow,
  toNum,
  type CodePerfScope,
} from '../../../src/collections/codePerformanceQuery.js';
import type {
  CodePerfBoard,
  CodePerfBoardInput,
  CodePerfPairDetail,
  CodePerfPairInput,
  CodePerfTenant,
} from './contract';
import {
  isoDate,
  shapeDescriptions,
  shapeFacilityRow,
  shapeFreshness,
  shapeMonthRows,
  shapePayerRow,
  shapeSummary,
} from './shape';

export interface CodePerfDeps {
  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

type Raw = Record<string, unknown>;

function scopeFor(entityId: string, input: CodePerfBoardInput): CodePerfScope {
  return { entityId, windowDays: CODE_PERF_WINDOWS[input.window], facilities: input.facilities };
}

export async function getCodePerfBoardCore(
  deps: CodePerfDeps,
  entityId: string,
  tenant: CodePerfTenant,
  input: CodePerfBoardInput,
): Promise<CodePerfBoard> {
  const scope = scopeFor(entityId, input);
  const run = (q: { sql: string; params: unknown[] }) => deps.query<Raw>(q.sql, q.params);
  const [summary, pairing, options, freshness, descriptions] = await Promise.all([
    run(buildCodePerfWindowSummaryQuery(scope)),
    run(buildCodePerfPairingQuery(scope)),
    run(buildCodePerfFacilityOptionsQuery(scope)),
    run(buildCodePerfFreshnessQuery([entityId])),
    run(buildCodeDescriptionQuery(entityId)),
  ]);
  const summaryRow = summary.rows[0];
  const shapedSummary = shapeSummary(summaryRow, entityId);
  return {
    tenant,
    window: input.window,
    windowDays: scope.windowDays,
    windowStart: isoDate(summaryRow?.window_start),
    windowEnd: isoDate(summaryRow?.window_end),
    facilitiesApplied: input.facilities,
    summary: shapedSummary,
    immatureWindow: isImmatureWindow(shapedSummary.matured_share),
    rows: pairing.rows.map((r) => shapeCodePerfPairingRow(r, entityId)),
    facilityOptions: options.rows.map((r) => ({
      facility: typeof r.facility === 'string' ? r.facility : null,
      charges: toNum(r.charges) ?? 0,
      billed: toNum(r.billed) ?? 0,
    })),
    freshness: shapeFreshness(freshness.rows[0]),
    descriptions: shapeDescriptions(descriptions.rows),
  };
}

export async function getCodePerfPairDetailCore(
  deps: CodePerfDeps,
  entityId: string,
  input: CodePerfPairInput,
): Promise<CodePerfPairDetail> {
  const scope = scopeFor(entityId, input);
  const run = (q: { sql: string; params: unknown[] }) => deps.query<Raw>(q.sql, q.params);
  const [payers, facilities, monthly, freshness] = await Promise.all([
    run(buildCodePerfPayerQuery(scope, input.pair)),
    run(buildCodePerfFacilityQuery(scope, input.pair)),
    run(buildCodePerfMonthlyQuery(scope, input.pair)),
    run(buildCodePerfFreshnessQuery([entityId])),
  ]);
  const fresh = shapeFreshness(freshness.rows[0]);
  const facilityRows = facilities.rows.map((r) => shapeFacilityRow(r, entityId));
  return {
    pair: input.pair,
    payers: payers.rows.map((r) => shapePayerRow(r, entityId)),
    facilities: facilityRows,
    belowFloor: toNum(facilities.rows[0]?.below_floor) ?? 0,
    monthly: shapeMonthRows(monthly.rows, fresh.maxChargeDate),
  };
}
