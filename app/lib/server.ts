/**
 * Server-side wiring for the Next.js API routes. This is the production
 * transport's composition root — the analogue of the retired Express harness's
 * `main()`. It builds, once per server process (singletons reused across warm
 * serverless invocations):
 *   - a claims_reader pg pool / executor (verify-full TLS via src/ssl.ts),
 *   - a real Anthropic client (from ANTHROPIC_API_KEY), and
 *   - the shared Bearer secret (RESULTS_API_SECRET) both routes gate on.
 *
 * The route handlers (../app/api/*) stay thin: they parse the HTTP request and
 * call handleAgent / handleResults here. All PHI-boundary, validation, and audit
 * logic lives in the transport-agnostic handlers under ../../src/routes.
 */
import { revalidateTag, unstable_cache } from 'next/cache';
import { DASHBOARD_CACHE_TAG } from '../../src/cacheTags.js';
import { makeAnthropicClientFromEnv } from '../../src/agent/index.js';
import type { AnthropicMessagesClient } from '../../src/agent/index.js';
import { distribution, searchClaims } from '../../src/queries/index.js';
import {
  distributionCountFromMatview,
  payerGapFromMatview,
} from '../../src/queries/dashboard_aggregates.js';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../src/queries/executor.js';
import type {
  ClaimFilter,
  DistributionField,
  DistributionMetric,
  DistributionSummary,
  PayerGapSummary,
  QueryContext,
  SearchClaimsSummary,
} from '../../src/queries/types.js';
import { collectionsMonthlySummary } from '../../src/collections/summary.js';
import type { CollectionsMonthlySummary } from '../../src/collections/summaryTypes.js';
import { collectionsDaily, collectionsKpis } from '../../src/collections/daily.js';
import type { CollectionsDailyResult, CollectionsKpis } from '../../src/collections/dailyTypes.js';
import { browseClaims as browseClaimsQuery, claimById } from '../../src/queries/browse_claims.js';
import type { BrowseClaimsArgs, BrowseClaimsResult } from '../../src/queries/browse_claims.js';
import { handleAgentRequest, type AgentHttpRequest } from '../../src/routes/agentHandler.js';
import {
  handleCollectionsSummaryRequest,
  type CollectionsSummaryHttpRequest,
} from '../../src/routes/collectionsSummaryHandler.js';
import {
  handleCollectionsDailyRequest,
  handleCollectionsKpisRequest,
  type CollectionsQueryHttpRequest,
} from '../../src/routes/collectionsQueryHandlers.js';
import type { ResultsContext } from '../../src/routes/results.js';
import { handleResultsRequest, type ResultsHttpRequest } from '../../src/routes/resultsHandler.js';
import {
  handleRevalidateRequest,
  type RevalidateHttpRequest,
} from '../../src/routes/revalidateHandler.js';

let cachedExecutor: PgExecutor | undefined;
function readerExecutor(): PgExecutor {
  // verify-full TLS is applied centrally in makeReaderPool (src/ssl.ts).
  cachedExecutor ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return cachedExecutor;
}

let cachedClient: AnthropicMessagesClient | undefined;
function agentClient(): AnthropicMessagesClient {
  cachedClient ??= makeAnthropicClientFromEnv();
  return cachedClient;
}

function bearerSecret(): string {
  const s = process.env.RESULTS_API_SECRET;
  if (!s || s.trim() === '') {
    throw new Error('Missing RESULTS_API_SECRET (set it in .env; never hardcode or log it)');
  }
  return s;
}

/** Agent route: NL question → one query function → non-PHI { tool_name, query_id, summary_stats }. */
export function handleAgent(req: AgentHttpRequest) {
  return handleAgentRequest(req, {
    client: agentClient(),
    makeQueryCtx: (createdBy: string): QueryContext => ({
      executor: readerExecutor(),
      createdBy,
    }),
    secret: bearerSecret(),
  });
}

/** Results route: query_id (+ optional client_history identity) → PHI rows. */
export function handleResults(req: ResultsHttpRequest) {
  const ctx: ResultsContext = { executor: readerExecutor() };
  return handleResultsRequest(req, { ctx, secret: bearerSecret() });
}

/**
 * Revalidate route (Phase 8.2): POST → invalidate the dashboard aggregate cache
 * tag immediately (called by the CMD ingest after the matview refresh), so the
 * dashboard reflects new data without waiting out the 15-minute fallback. Authed
 * with REVALIDATE_SECRET (distinct from the PHI Bearer secret) and restricted to
 * the closed tag allowlist. No DB, no PHI — only revalidateTag is invoked.
 */
export function handleRevalidate(req: RevalidateHttpRequest) {
  return handleRevalidateRequest(req, {
    secret: process.env.REVALIDATE_SECRET,
    allowedTags: REVALIDATE_ALLOWED_TAGS,
    defaultTag: DASHBOARD_CACHE_TAG,
    revalidate: (tag) => revalidateTag(tag),
  });
}

/** Collections summary route: optional date bounds → non-PHI monthly summary by facility. */
export function handleCollectionsSummary(req: CollectionsSummaryHttpRequest) {
  return handleCollectionsSummaryRequest(req, {
    ctx: { executor: readerExecutor(), createdBy: 'collections-summary-api' },
    secret: bearerSecret(),
  });
}

/** Collections daily route: optional facility/window → non-PHI daily rows. */
export function handleCollectionsDaily(req: CollectionsQueryHttpRequest) {
  return handleCollectionsDailyRequest(req, {
    ctx: { executor: readerExecutor(), createdBy: 'collections-daily-api' },
    secret: bearerSecret(),
  });
}

/** Collections KPIs route: optional as_of → non-PHI MTD/YTD by facility. */
export function handleCollectionsKpis(req: CollectionsQueryHttpRequest) {
  return handleCollectionsKpisRequest(req, {
    ctx: { executor: readerExecutor(), createdBy: 'collections-kpis-api' },
    secret: bearerSecret(),
  });
}

// ---------------------------------------------------------------------------
// Dashboard data path (non-PHI, summary-only).
//
// The default dashboard calls the vetted query functions DIRECTLY (not via the
// agent — no LLM, deterministic) and returns ONLY their non-PHI `summary_stats`.
// The `query_id` is intentionally dropped: the dashboard never fetches rows, so
// no PHI can ever be reached on this path. `summary_stats` is PHI-free by type.
// ---------------------------------------------------------------------------

function dashboardCtx(): QueryContext {
  // Same least-privilege claims_reader executor; a fixed non-PHI audit principal.
  return { executor: readerExecutor(), createdBy: 'phase5-dashboard' };
}

// Phase 7.3: the dashboard aggregate reads are wrapped in Next's unstable_cache.
// These are all ARG-FREE (or fixed-allowlist args) and return ONLY non-PHI
// `summary_stats` / aggregate shapes, so they are safe to cache and share across
// requests. A 15-minute revalidation window matches the Google-Sheets-fed ingest
// cadence; a shared tag lets a future n8n ingest fire revalidateTag() for exact
// freshness (out of scope here). The PHI/AI paths (runSearch / fetchRows /
// handleResults) are intentionally NOT cached.
const DASHBOARD_REVALIDATE_SECONDS = 15 * 60;

/**
 * The CLOSED allowlist of tags the /api/revalidate endpoint may invalidate. The
 * endpoint can never drop an unlisted tag — arbitrary tag names are rejected.
 * DASHBOARD_CACHE_TAG is the shared contract from src/cacheTags.ts.
 */
const REVALIDATE_ALLOWED_TAGS: ReadonlySet<string> = new Set([DASHBOARD_CACHE_TAG]);

/**
 * Per-payer billed/allowed/paid + collection gap + avg rate (non-PHI summary).
 * Phase 7.7: reads the pre-aggregated claims.mv_payer_gap matview (migration 0009)
 * instead of scanning claims.claims live. Same shape; no finalize()/query_id.
 */
export const dashboardPayerGap = unstable_cache(
  async (): Promise<PayerGapSummary> => payerGapFromMatview(readerExecutor()),
  ['dashboard-payer-gap'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/**
 * A single allowlisted-dimension distribution (non-PHI summary). The (field,
 * metric) args are part of the cache key, so each dimension caches independently.
 * Phase 7.7: the dashboard/facets only ever request the `count` metric, which is
 * served from claims.mv_distribution_count (migration 0009). Any other metric
 * (agent-only in practice) falls back to the live distribution function.
 */
export const dashboardDistribution = unstable_cache(
  async (
    field: DistributionField,
    metric: DistributionMetric,
  ): Promise<DistributionSummary> => {
    if (metric === 'count') {
      return distributionCountFromMatview(readerExecutor(), field);
    }
    const { summary_stats } = await distribution({ field, metric }, dashboardCtx());
    return summary_stats;
  },
  ['dashboard-distribution'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/** Monthly collections by facility (non-PHI summary; reader-only, no row fetch). */
export const dashboardCollectionsSummary = unstable_cache(
  async (): Promise<CollectionsMonthlySummary> =>
    collectionsMonthlySummary(
      {},
      { executor: readerExecutor(), createdBy: 'phase7-collections-dashboard' },
    ),
  ['dashboard-collections-summary'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/** MTD/YTD collections KPIs by facility (non-PHI; anchored to latest payment_date). */
export const dashboardCollectionsKpis = unstable_cache(
  async (): Promise<CollectionsKpis> =>
    collectionsKpis(
      {},
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard' },
    ),
  ['dashboard-collections-kpis'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/** Latest-month daily collections rows (non-PHI; date × facility × checks/eft/gross). */
export const dashboardCollectionsDaily = unstable_cache(
  async (): Promise<CollectionsDailyResult> =>
    collectionsDaily(
      {},
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard' },
    ),
  ['dashboard-collections-daily'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/**
 * Daily collections rows bounded to a single calendar month (non-PHI, reader-only).
 *
 * NOT cached: this is a per-request, user-selected window of collection ROWS, so it
 * stays off the cache like the claims browse path. `year`/`month` are validated as
 * bounded integers; the [from, next-month) window becomes the existing query's $n
 * date parameters (parameterized, never interpolated). Reads only daily_collections
 * + facilities; no patient data, no source_group_code.
 */
export async function collectionsDailyForMonth(
  year: number,
  month: number,
): Promise<CollectionsDailyResult> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('year must be an integer in [2000, 2100]');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('month must be an integer in [1, 12]');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const from = `${year}-${pad(month)}-01`;
  const to = `${nextYear}-${pad(nextMonth)}-01`; // exclusive upper bound
  return collectionsDaily(
    { from, to },
    { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard' },
  );
}

// ---------------------------------------------------------------------------
// Claims Data Explorer (Phase 7.4) — page-limited, NON-PHI claim browsing.
//
// This is intentionally NOT cached: it is a per-request, page/sort/filter-driven
// read of claim ROWS. Even though the projection is non-PHI, row-level claims
// data is never cached. It is also NOT on the two-gate PHI path — browse_claims
// projects only non-PHI columns, so no patient identifiers are reachable here.
// ---------------------------------------------------------------------------

/** One page of non-PHI claim rows (keyset/LIMIT, allowlisted sort/filter). */
export async function browseClaims(args: BrowseClaimsArgs): Promise<BrowseClaimsResult> {
  return browseClaimsQuery(args, { executor: readerExecutor(), createdBy: 'claims-explorer' });
}

/**
 * One claim's non-PHI projection by synthetic id (Phase 7.5), or null if absent.
 * Not cached; never selects patient identifiers (same allowlist as the browse list).
 */
export async function getClaim(id: number): Promise<Record<string, unknown> | null> {
  return claimById(id, { executor: readerExecutor(), createdBy: 'claims-explorer-detail' });
}

/**
 * Deterministic search_claims for the /ask field-picker (Phase 7.6): run the SAME
 * audited query function the agent would, but with a user-supplied filter and no
 * model round-trip. finalize() writes the query_log + audit line and returns the
 * opaque query_id, so the existing "show rows" reveal path is unchanged. Returns
 * ONLY the non-PHI summary + query_id; row-level data is never produced here.
 */
export async function searchClaimsDirect(
  filter: ClaimFilter,
): Promise<{ tool_name: 'search_claims'; query_id: string; summary_stats: SearchClaimsSummary }> {
  const { summary_stats, query_id } = await searchClaims(
    { filter },
    { executor: readerExecutor(), createdBy: 'ask-field-picker' },
  );
  return { tool_name: 'search_claims', query_id, summary_stats };
}

/**
 * Mint an audited query_id scoped to EXACTLY ONE synthetic claim id (Phase 8.0,
 * the /claims/[claimId] full-detail reveal). It runs the SAME vetted search_claims
 * query function the agent/field-picker use, but with an `id` equality filter, so
 * the two-gate PHI boundary is reused verbatim: finalize() writes the query_log row
 * (non-PHI args `{ filter: { id } }`) + one non-PHI audit line and returns the
 * opaque query_id, and the existing results route (fetchResults) re-runs the stored
 * query projecting the allowlisted columns WHERE id = $1 — at most one row.
 *
 * `id` is validated as a bounded positive safe integer here (and re-validated in
 * validateClaimFilter); anything else throws BEFORE any query_log row is created.
 * This never queries VOB/ref/rag/audit schemas — only claims.claims via the
 * existing audited path. Returns ONLY the non-PHI summary + query_id; no row-level
 * data is produced here.
 */
export async function revealClaimById(
  id: number,
): Promise<{ query_id: string; summary_stats: SearchClaimsSummary }> {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('revealClaimById: id must be a positive safe integer');
  }
  const { summary_stats, query_id } = await searchClaims(
    { filter: { id } },
    { executor: readerExecutor(), createdBy: 'claim-detail-reveal' },
  );
  return { query_id, summary_stats };
}
