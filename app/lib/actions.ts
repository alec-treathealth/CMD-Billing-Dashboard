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
 * The audit principal is the authenticated user's session email (resolved via
 * requireExecutive), so query_log names the REAL user. Until auth env is configured it
 * falls back to the prior fixed label so the staged rollout never breaks search/reveal.
 *
 * PHI discipline preserved: the agent action returns non-PHI summary only; the
 * results action's `identity` (client_history terms) is PHI and travels in the
 * action argument (a POST body under the hood), never a URL, and is never logged
 * or persisted here.
 */
import {
  browseClaims,
  collectionsDailyForMonth,
  dashboardCollectionsDaily,
  dashboardCollectionsKpis,
  dashboardCollectionsSummary,
  dashboardDistribution,
  dashboardPayerGap,
  facilitiesDimension,
  handleAgent,
  handleResults,
  payerCmdMonth,
  payerGapCmdForMonth,
  payerGapForRange,
  revealClaimById,
  searchClaimsDirect,
} from '@/lib/server';
import { requireExecutive } from '@/lib/executive';
import { supabaseAuthConfigured } from '@/lib/supabase/env';
import type {
  BrowseClaimsCursor,
  BrowseClaimsResult,
  BrowseClaimsSort,
} from '../../src/queries/browse_claims';
import { validateClaimFilter } from '../../src/queries/filters';
import type { ClaimFilter } from '../../src/queries/types';
import type { AgentResponseBody, AgentNeedsInputBody } from '../../src/routes/agentHandler';
import type { ResultsResponse, ResultsIdentity } from '../../src/routes/results';
import type {
  DistributionSummary,
  FunctionName,
  PayerGapSummary,
  SummaryStats,
} from '../../src/queries/types';
import type { CollectionsMonthlySummary } from '../../src/collections/summaryTypes';
import type { CollectionsDailyResult, CollectionsKpis } from '../../src/collections/dailyTypes';
import type { CmdPayerMonthResult } from '../../src/collections/cmdPayerRollup';
import type { FacilityDimensionRow } from '../../src/collections/facilities';

/**
 * Verified per-user audit principal: the authenticated session email, so query_log
 * attributes the REAL user (email is a staff identity, not patient PHI, and fits the
 * created_by bound). Until auth env is configured the staged rollout falls back to the
 * prior fixed label. Returns null only when auth IS configured but there is no authorized
 * session — PHI-touching actions then fail closed.
 */
async function sessionPrincipal(): Promise<string | null> {
  if (!supabaseAuthConfigured()) return 'phase5-ui';
  const gate = await requireExecutive();
  return gate.ok ? gate.user.email : null;
}

export type {
  FunctionName,
  SummaryStats,
  ResultsIdentity,
  DistributionSummary,
  PayerGapSummary,
  CollectionsMonthlySummary,
  CollectionsKpis,
  CollectionsDailyResult,
  BrowseClaimsResult,
  BrowseClaimsSort,
  BrowseClaimsCursor,
  ClaimFilter,
  FacilityDimensionRow,
};

export type AgentActionResult =
  | { kind: 'ok'; tool_name: FunctionName; query_id: string; summary_stats: SummaryStats }
  | { kind: 'needs_input'; tool_name: FunctionName; missing: string[] }
  | { kind: 'error'; error: string };

export type ClaimFacets = {
  facility: string[];
  payer: string[];
  source_year: number[];
};

export type ClaimFacetsResult = { ok: true; data: ClaimFacets } | { ok: false };

export type ResultsActionResult =
  | {
      ok: true;
      function_name: FunctionName | null;
      rows: Record<string, unknown>[];
      /** Resolved page size, offset, and whether a further page exists. */
      pageSize: number;
      offset: number;
      hasNext: boolean;
    }
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
 * Run the search agent over a natural-language question. Returns the chosen tool +
 * non-PHI summary + opaque query_id, OR a deterministic `needs_input` prompt when
 * the model picked an over-broad search_claims (the UI then shows a field-picker).
 * PHI never appears here.
 */
export async function runSearch(question: string): Promise<AgentActionResult> {
  if (typeof question !== 'string' || question.trim() === '') {
    return { kind: 'error', error: 'Enter a question to search.' };
  }
  const principal = await sessionPrincipal();
  if (!principal) {
    return { kind: 'error', error: 'Your session has expired — please sign in again.' };
  }
  try {
    const { status, body } = await handleAgent({
      method: 'POST',
      authorization: authHeader(),
      body: { question },
      createdBy: principal,
    });
    if (status === 200) {
      const b = body as AgentResponseBody | AgentNeedsInputBody;
      if (b.status === 'needs_input') {
        return { kind: 'needs_input', tool_name: b.tool_name, missing: b.missing };
      }
      return {
        kind: 'ok',
        tool_name: b.tool_name,
        query_id: b.query_id,
        summary_stats: b.summary_stats,
      };
    }
    return { kind: 'error', error: messageForStatus(status, 'The search could not be completed.') };
  } catch {
    // Includes a missing RESULTS_API_SECRET (handler throws). Never echo detail.
    return { kind: 'error', error: 'The search could not be completed.' };
  }
}

/**
 * Fetch ONE bounded page of the PHI rows behind a query_id. The reveal is paginated
 * (default 50 rows, capped server-side) so a broad result never ships its entire
 * matched slice at once; `offset` selects the page. For client_history the caller
 * MUST supply the re-collected identity terms (PHI) on EVERY page; they are
 * forwarded to the handler, which re-verifies them server-side and fail-closes to
 * empty rows on any mismatch. Row-level data is never cached or persisted here.
 */
export async function fetchRows(
  query_id: string,
  identity?: ResultsIdentity,
  offset = 0,
): Promise<ResultsActionResult> {
  if (typeof query_id !== 'string' || query_id.trim() === '') {
    return { ok: false, error: 'Missing query handle.' };
  }
  const principal = await sessionPrincipal();
  if (!principal) {
    return { ok: false, error: 'Your session has expired — please sign in again.' };
  }
  try {
    const { status, body } = await handleResults({
      method: 'POST',
      authorization: authHeader(),
      body: { query_id, offset, ...(identity ? { identity } : {}) },
      createdBy: principal,
    });
    if (status === 200) {
      const ok = body as ResultsResponse;
      // Normalize to plain JSON-safe values so the client never receives Date /
      // non-plain pg objects (guardrail). These rows are PHI: only returned to the
      // caller for display, never logged or persisted here.
      return {
        ok: true,
        function_name: ok.function_name,
        rows: toPlainRows(ok.rows),
        pageSize: ok.pageSize,
        offset: ok.offset,
        hasNext: ok.hasNext,
      };
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

/**
 * Per-payer gap bounded to a date_of_service window (non-PHI, reader-only, NOT
 * cached). Backs the payer chart's year/month range picker. `from`/`to` are
 * 'YYYY-MM-DD' bounds; either may be omitted (open-ended). Re-validated server-side
 * as bounded ClaimFilter dates before any query.
 */
export async function loadPayerGapRange(params: {
  from?: string;
  to?: string;
}): Promise<DashboardResult<PayerGapSummary>> {
  try {
    return { ok: true, data: await payerGapForRange(params.from, params.to) };
  } catch {
    return { ok: false };
  }
}

/**
 * Per-payer gap for one 2026 month, sourced from CollaborateMD (non-PHI summary).
 * Backs the By Payer chart's PAST-month view, where the matview lacks complete
 * 2026 data. Aggregated to payer totals server-side; on any failure (CMD not
 * configured, unreachable, or an unrecognized response) returns { ok: false } so
 * the caller can fall back to the matview date-range path. No PHI, no rows.
 */
export async function loadPayerGapCmd(
  year: number,
  month: number,
): Promise<DashboardResult<PayerGapSummary>> {
  try {
    return { ok: true, data: await payerGapCmdForMonth(year, month) };
  } catch {
    return { ok: false };
  }
}

/**
 * CMD per-payer gap + per-facility breakdown for one month, from the DB rollup
 * (collections.cmd_payer_facility_monthly). Backs the Master BXR Chart "By Payer"
 * bars AND the per-payer click-into drill-down (the by_facility rows are filtered
 * client-side per clicked payer — no extra fetch). Non-PHI, reader-only, not
 * cached. A month with no rollup rows returns an empty summary; the caller falls
 * back to the matview date-range path.
 */
export async function loadCmdPayerMonth(
  year: number,
  month: number,
): Promise<DashboardResult<CmdPayerMonthResult>> {
  try {
    return { ok: true, data: await payerCmdMonth(year, month) };
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

/** MTD/YTD collections KPIs by facility (Phase 7.1; non-PHI, reader-only). */
export async function loadCollectionsKpis(): Promise<DashboardResult<CollectionsKpis>> {
  try {
    return { ok: true, data: await dashboardCollectionsKpis() };
  } catch {
    return { ok: false };
  }
}

/** Latest-month daily collections rows (Phase 7.1; non-PHI, reader-only). */
export async function loadCollectionsDaily(): Promise<DashboardResult<CollectionsDailyResult>> {
  try {
    return { ok: true, data: await dashboardCollectionsDaily() };
  } catch {
    return { ok: false };
  }
}

/**
 * Canonical facility dimension (facility_code → name / care_setting (IP/OP) /
 * display_acronym) for the Master BXR chart's IP/OP split, Facility(IP)/Facility(OP)
 * filters, and acronym labels. Non-PHI reference, reader-only, cached.
 */
export async function loadFacilityDimension(): Promise<DashboardResult<FacilityDimensionRow[]>> {
  try {
    return { ok: true, data: await facilitiesDimension() };
  } catch {
    return { ok: false };
  }
}

/**
 * Daily collections rows for a specific month (non-PHI, reader-only, NOT cached).
 * Lets the collections daily view browse months other than the latest. `year`/
 * `month` are re-validated server-side as bounded integers before any query.
 */
export async function loadCollectionsDailyRange(params: {
  year: number;
  month: number;
}): Promise<DashboardResult<CollectionsDailyResult>> {
  try {
    return { ok: true, data: await collectionsDailyForMonth(params.year, params.month) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Claims Data Explorer action (Phase 7.4; keyset in 7.5) — NON-PHI browsing.
//
// Returns ONE bounded page of non-PHI claim rows via keyset pagination (cursor on
// the synthetic id). No PHI columns are projected (browse_claims excludes every
// patient identifier), so this never touches the reveal/audit path, and row-level
// data is neither cached nor shipped in bulk (the underlying query LIMITs to
// pageSize). Rows are normalized to JSON-safe scalars before crossing the action
// boundary, like fetchRows.
// ---------------------------------------------------------------------------

export type ClaimsPageActionResult =
  | { ok: true; data: BrowseClaimsResult }
  | { ok: false; error: string };

export async function loadClaimsPage(params: {
  filter?: ClaimFilter;
  sort?: BrowseClaimsSort;
  cursor?: BrowseClaimsCursor | null;
  pageSize?: number;
}): Promise<ClaimsPageActionResult> {
  try {
    const data = await browseClaims({
      filter: params.filter,
      sort: params.sort,
      cursor: params.cursor ?? null,
      pageSize: params.pageSize,
    });
    return { ok: true, data: { ...data, rows: toPlainRows(data.rows) } };
  } catch {
    return { ok: false, error: 'The claims could not be loaded.' };
  }
}

// ---------------------------------------------------------------------------
// Claim detail reveal action (Phase 8.0) — audited, single-claim PHI gate.
//
// The /claims/[claimId] page is non-PHI by default. This action is gate 1 of the
// explicit reveal: it mints an audited query_id scoped to EXACTLY ONE synthetic
// claim id by running the existing search_claims query function with an `id`
// filter (revealClaimById → finalize → claims.log_query). It returns ONLY the
// opaque query_id; the page then fetches the masked PHI row through the unchanged
// fetchRows / results path (gate 2 is the per-row reveal in ResultsTable). No
// row-level data, and no PHI, is produced, logged, or cached here. The id is
// validated as a bounded positive safe integer; anything else fails closed with no
// query created.
// ---------------------------------------------------------------------------

export type RevealClaimActionResult =
  | { ok: true; query_id: string }
  | { ok: false; error: string };

export async function revealClaim(claimId: number): Promise<RevealClaimActionResult> {
  if (!Number.isSafeInteger(claimId) || claimId < 1) {
    return { ok: false, error: 'That claim reference is not a valid claim id.' };
  }
  try {
    const { query_id } = await revealClaimById(claimId);
    return { ok: true, query_id };
  } catch {
    return { ok: false, error: 'The claim details could not be prepared right now.' };
  }
}

// ---------------------------------------------------------------------------
// /ask field-picker actions (Phase 7.6) — deterministic, NON-PHI.
//
// The field-picker collects only safe ClaimFilter inputs (facility / payer /
// year / dates / codes — NEVER patient identifiers) and re-dispatches search_claims
// directly (no model round-trip) through the SAME audited query function, so the
// "show rows" reveal path is unchanged. Facets come from the cached, non-PHI
// distribution; no row-level data is produced or cached here.
// ---------------------------------------------------------------------------

/**
 * Deterministically run search_claims from a field-picker-supplied filter. The
 * filter is re-validated at the boundary; if it is still empty (no constraint), we
 * return needs_input again rather than scan the whole table.
 */
export async function runClaimSearch(filter: ClaimFilter): Promise<AgentActionResult> {
  let validated: ClaimFilter;
  try {
    validated = validateClaimFilter(filter);
  } catch {
    return { kind: 'error', error: 'Those filters were not understood. Adjust them and try again.' };
  }
  if (Object.keys(validated).length === 0) {
    return { kind: 'needs_input', tool_name: 'search_claims', missing: ['facility', 'payer', 'source_year', 'date_from', 'date_to', 'hcpcs_code', 'revenue_code'] };
  }
  try {
    const { tool_name, query_id, summary_stats } = await searchClaimsDirect(validated);
    return { kind: 'ok', tool_name, query_id, summary_stats };
  } catch {
    return { kind: 'error', error: 'The search could not be completed.' };
  }
}

/**
 * Safe filter facets for the field-picker: distinct facility / payer / source_year
 * values from the CACHED, non-PHI distribution. Never returns PHI (facility/payer/
 * year are allowlisted dimensions; no patient identifiers are queried).
 */
export async function loadClaimFacets(): Promise<ClaimFacetsResult> {
  try {
    const [facilities, payers, years] = await Promise.all([
      dashboardDistribution('facility_name', 'count'),
      dashboardDistribution('payer_name', 'count'),
      dashboardDistribution('source_year', 'count'),
    ]);
    const strings = (s: DistributionSummary): string[] =>
      s.buckets.map((b) => b.value).filter((v): v is string => v !== null && v !== '');
    const source_year = years.buckets
      .map((b) => b.value)
      .filter((v): v is string => v !== null)
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => b - a);
    return { ok: true, data: { facility: strings(facilities), payer: strings(payers), source_year } };
  } catch {
    return { ok: false };
  }
}
