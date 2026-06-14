'use server';

/**
 * Server Actions — the ONLY data path the browser uses (gate 1, option a).
 *
 * The page and its client components never call /api/agent or /api/results
 * directly, and never hold RESULTS_API_SECRET. Instead they invoke these actions,
 * which run server-side and delegate to the already-tested composition root
 * (lib/server.ts → handleAgent / handleResults). The Bearer secret is read from
 * the server environment here purely to satisfy the in-process handler's own auth
 * check; it is never serialized into a response, so it cannot reach the client
 * bundle. All PHI-boundary, validation, and generic-error-collapsing logic is
 * reused from the handlers — this file adds no new SQL and no new PHI handling.
 *
 * The audit principal is a fixed app label for now ('phase5-ui', gate 3); when
 * real per-user auth lands it should be derived from the session instead.
 *
 * PHI discipline preserved: the agent action returns non-PHI summary only; the
 * results action's `identity` (client_history terms) is PHI and travels in the
 * action argument (a POST body under the hood), never a URL, and is never logged
 * or persisted here.
 */
import {
  dashboardCollectionsSummary,
  dashboardDistribution,
  dashboardPayerGap,
  handleAgent,
  handleResults,
} from '@/lib/server';
import type { AgentResponseBody } from '../../src/routes/agentHandler';
import type { ResultsResponse, ResultsIdentity } from '../../src/routes/results';
import type {
  DistributionSummary,
  FunctionName,
  PayerGapSummary,
  SummaryStats,
} from '../../src/queries/types';
import type { CollectionsMonthlySummary } from '../../src/collections/summaryTypes';

/** Fixed audit principal until session auth exists (gate 3). */
const AUDIT_PRINCIPAL = 'phase5-ui';

export type {
  FunctionName,
  SummaryStats,
  ResultsIdentity,
  DistributionSummary,
  PayerGapSummary,
  CollectionsMonthlySummary,
};

export type AgentActionResult =
  | { ok: true; tool_name: FunctionName; query_id: string; summary_stats: SummaryStats }
  | { ok: false; error: string };

export type ResultsActionResult =
  | { ok: true; function_name: FunctionName | null; rows: Record<string, unknown>[] }
  | { ok: false; error: string };

/** Map a handler status to a user-facing message (handlers never leak internals). */
function messageForStatus(status: number, fallback: string): string {
  switch (status) {
    case 400:
      return 'That request was not understood. Try rephrasing your question.';
    case 401:
      return 'Server is not configured to authorize this request.';
    case 405:
      return 'Unsupported request method.';
    default:
      return fallback;
  }
}

/**
 * Normalize a results row to plain, JSON-safe scalars before it crosses the
 * Server Action boundary to the client. node-postgres returns `date` columns as
 * Date objects and could return other non-plain values; we convert Date → a
 * 'YYYY-MM-DD' string and bigint → string, leave primitives/null as-is, and
 * stringify anything else. Pure transform — the row content is never logged.
 */
function toPlainValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

function toPlainRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) out[key] = toPlainValue(row[key]);
    return out;
  });
}

/** Bearer header presented to the in-process handler (server-side only). */
function authHeader(): string {
  // Read here only to satisfy the handler's own constant-time check. If it is
  // missing the handler throws; we collapse that to a generic config error below.
  return `Bearer ${process.env.RESULTS_API_SECRET ?? ''}`;
}

/**
 * Run the search agent over a natural-language question. Returns the chosen tool,
 * an opaque query_id, and the non-PHI summary. PHI never appears here.
 */
export async function runSearch(question: string): Promise<AgentActionResult> {
  if (typeof question !== 'string' || question.trim() === '') {
    return { ok: false, error: 'Enter a question to search.' };
  }
  try {
    const { status, body } = await handleAgent({
      method: 'POST',
      authorization: authHeader(),
      body: { question },
      createdBy: AUDIT_PRINCIPAL,
    });
    if (status === 200) {
      const ok = body as AgentResponseBody;
      return {
        ok: true,
        tool_name: ok.tool_name,
        query_id: ok.query_id,
        summary_stats: ok.summary_stats,
      };
    }
    return { ok: false, error: messageForStatus(status, 'The search could not be completed.') };
  } catch {
    // Includes a missing RESULTS_API_SECRET (handler throws). Never echo detail.
    return { ok: false, error: 'The search could not be completed.' };
  }
}

/**
 * Fetch the PHI rows behind a query_id. For client_history the caller MUST supply
 * the re-collected identity terms (PHI); they are forwarded to the handler, which
 * re-verifies them server-side and fail-closes to empty rows on any mismatch.
 */
export async function fetchRows(
  query_id: string,
  identity?: ResultsIdentity,
): Promise<ResultsActionResult> {
  if (typeof query_id !== 'string' || query_id.trim() === '') {
    return { ok: false, error: 'Missing query handle.' };
  }
  try {
    const { status, body } = await handleResults({
      method: 'POST',
      authorization: authHeader(),
      body: identity ? { query_id, identity } : { query_id },
      createdBy: AUDIT_PRINCIPAL,
    });
    if (status === 200) {
      const ok = body as ResultsResponse;
      // Normalize to plain JSON-safe values so the client never receives Date /
      // non-plain pg objects (guardrail). These rows are PHI: only returned to the
      // caller for display, never logged or persisted here.
      return { ok: true, function_name: ok.function_name, rows: toPlainRows(ok.rows) };
    }
    return { ok: false, error: messageForStatus(status, 'The rows could not be loaded.') };
  } catch {
    return { ok: false, error: 'The rows could not be loaded.' };
  }
}

// ---------------------------------------------------------------------------
// Dashboard actions — non-PHI, aggregate-only, no row fetch, no LLM.
//
// Each is ARG-FREE with a hardcoded query (zero client input → no injection
// surface) and returns ONLY the non-PHI summary. A failure collapses to
// { ok: false } so one widget can fail without breaking the page or leaking
// detail. The dashboard never calls fetchRows, so PHI is unreachable here.
// ---------------------------------------------------------------------------

export type DashboardResult<T> = { ok: true; data: T } | { ok: false };

/** Per-payer billed/allowed/paid, collection gap, avg rate, and total claims. */
export async function loadPayerGap(): Promise<DashboardResult<PayerGapSummary>> {
  try {
    return { ok: true, data: await dashboardPayerGap() };
  } catch {
    return { ok: false };
  }
}

/** Claim volume by source year. */
export async function loadClaimsByYear(): Promise<DashboardResult<DistributionSummary>> {
  try {
    return { ok: true, data: await dashboardDistribution('source_year', 'count') };
  } catch {
    return { ok: false };
  }
}

/** Top procedure (HCPCS) codes by claim count. */
export async function loadTopHcpcs(): Promise<DashboardResult<DistributionSummary>> {
  try {
    return { ok: true, data: await dashboardDistribution('hcpcs_code', 'count') };
  } catch {
    return { ok: false };
  }
}

/** Top revenue codes by claim count. */
export async function loadTopRevenue(): Promise<DashboardResult<DistributionSummary>> {
  try {
    return { ok: true, data: await dashboardDistribution('revenue_code', 'count') };
  } catch {
    return { ok: false };
  }
}

/** Monthly collections by facility (Phase 7; non-PHI, reader-only). */
export async function loadCollectionsSummary(): Promise<DashboardResult<CollectionsMonthlySummary>> {
  try {
    return { ok: true, data: await dashboardCollectionsSummary() };
  } catch {
    return { ok: false };
  }
}
