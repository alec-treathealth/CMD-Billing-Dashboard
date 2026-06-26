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
  payerGapForFilter,
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
import { facilityDimension, type FacilityDimensionRow } from '../../src/collections/facilities.js';
import { cmdPayerGapForMonth, cmdReportRows, type CmdApiConfig } from '../../src/collections/cmdPayer.js';
import {
  mapReportRows,
  toNonPhi,
  type CmdExplorerFullRow,
  type CmdExplorerNonPhiRow,
  type CmdExplorerPhi,
} from '../../src/collections/cmdExplorer.js';
import { cmdPayerMonth, type CmdPayerMonthResult } from '../../src/collections/cmdPayerRollup.js';
import { refreshCmdPayerRollup } from '../../src/collections/cmdPayerRefresh.js';
import { makeClient, type Db } from '../../src/collections/db.js';
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
import {
  handleCmdPayerRefreshRequest,
  type CmdPayerRefreshHttpRequest,
} from '../../src/routes/cmdPayerRefreshHandler.js';

let cachedExecutor: PgExecutor | undefined;
function readerExecutor(): PgExecutor {
  // verify-full TLS is applied centrally in makeReaderPool (src/ssl.ts).
  cachedExecutor ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return cachedExecutor;
}

// Least-privilege writer pool for the daily CMD rollup refresh — the ONLY write
// path in the web app. cmd_rollup_writer (migration 0013) can INSERT/DELETE only
// collections.cmd_payer_facility_monthly; NOT claims_admin, NOT the reader. The
// URL comes from env only and is never logged; verify-full TLS via makeClient.
let cachedWriterDb: Db | undefined;
function rollupWriterDb(): Db {
  const url = process.env.CMD_ROLLUP_WRITER_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Missing CMD_ROLLUP_WRITER_DATABASE_URL (set in env; never hardcode or log it)');
  }
  cachedWriterDb ??= makeClient(url);
  return cachedWriterDb;
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

// ---------------------------------------------------------------------------
// Durable per-user access audit (claims.access_audit, migration 0017).
//
// Records ONE permanent row per audited executive action: the real authenticated
// user (email + Supabase uid), the action, and a NON-PHI detail blob. Written via
// the SECURITY DEFINER claims.log_access function on the SAME least-privilege
// claims_reader pool used everywhere else — the reader has no direct table rights.
// This is the durable replacement for the hardcoded 'phase5-ui' principal; unlike
// query_log it never expires. NEVER put PHI in `detail` (action metadata / path /
// counts only). Awaited and fail-closed: callers on a sensitive surface should
// treat a throw as "deny the access".
// ---------------------------------------------------------------------------
export interface AccessAuditEntry {
  /** Real authenticated user email (already verified + lowercased upstream). */
  actorEmail: string;
  /** Supabase auth user id (uuid). */
  actorUserId: string;
  /** Short action verb, e.g. 'view_account'. */
  action: string;
  /** NON-PHI request context only. */
  detail?: Record<string, unknown>;
}

export async function recordAccess(entry: AccessAuditEntry): Promise<string> {
  const { rows } = await readerExecutor().query<{ id: string }>(
    'select claims.log_access($1, $2, $3, $4::jsonb) as id',
    [entry.actorEmail, entry.actorUserId, entry.action, JSON.stringify(entry.detail ?? {})],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('recordAccess: claims.log_access returned no id');
  }
  return id;
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

/**
 * Daily CMD payer rollup refresh route (Vercel Cron). Gated on CRON_SECRET. Pulls
 * the live CMD report, aggregates to the non-PHI rollup IN-PROCESS, and refreshes
 * the trailing window of months as the least-privilege cmd_rollup_writer role. No
 * PHI crosses this boundary; only non-PHI stats are returned.
 */
export function handleCmdPayerRefresh(req: CmdPayerRefreshHttpRequest) {
  return handleCmdPayerRefreshRequest(req, {
    secret: process.env.CRON_SECRET,
    refresh: () =>
      refreshCmdPayerRollup({
        fetchRows: () => cmdReportRows(cmdApiConfig()),
        writeDb: rollupWriterDb(),
      }),
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
 * Per-payer gap bounded to a date_of_service window (non-PHI summary; reader-only,
 * NOT cached). Backs the payer chart's year/month range picker. `from`/`to` are
 * 'YYYY-MM-DD' bounds (either may be omitted); they are re-validated as ClaimFilter
 * dates and bound as $n parameters in payerGapForFilter. Scans claims.claims live
 * (the matview has no date dimension); no finalize()/query_id — never reveals rows.
 */
export async function payerGapForRange(from?: string, to?: string): Promise<PayerGapSummary> {
  const filter: ClaimFilter = {};
  if (from) filter.date_from = from;
  if (to) filter.date_to = to;
  return payerGapForFilter(readerExecutor(), filter);
}

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
 * Canonical facility dimension (facility_code -> name / care_setting (IP/OP) /
 * display_acronym), from collections.facilities (migration 0016). Backs the Master
 * BXR chart's IP/OP split, Facility(IP)/Facility(OP) filters, and acronym labels.
 * Static reference data — cached like the other aggregates; non-PHI, reader-only.
 */
export const facilitiesDimension = unstable_cache(
  async (): Promise<FacilityDimensionRow[]> =>
    facilityDimension({ executor: readerExecutor(), createdBy: 'phase71-facilities-dimension' }),
  ['facilities-dimension'],
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

/**
 * CollaborateMD (CMD) per-payer gap for one 2026 month (non-PHI summary).
 *
 * Reads the CMD_* credentials from the SERVER env here (composition-root pattern)
 * and injects them into the env-free reader in src/collections/cmdPayer.ts. The
 * secrets never reach the browser and are never logged. Throws if no credentials
 * are configured — the caller (loadPayerGapCmd) collapses that to { ok: false },
 * and the UI falls back to the matview date-range path, so an unconfigured (or
 * still-unverified) CMD integration never breaks the By Payer view.
 *
 * NOT cached: like payerGapForRange, this is a per-request, user-selected window.
 * Aggregation to payer totals happens inside cmdPayerGapForMonth — only the
 * non-PHI PayerGapSummary leaves the server.
 */
function cmdApiConfig(): CmdApiConfig {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdApiConfig['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else {
    throw new Error(
      'CMD API credentials not configured (set CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD)',
    );
  }
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId: process.env.CMD_CUSTOMER_ID?.trim() || '10027973',
    reportId: process.env.CMD_REPORT_ID?.trim() || '10091828',
    filterId: process.env.CMD_FILTER_ID?.trim() || '10147241',
    auth,
    // CMD batch reporting is async (run → poll a base64 zip). Bound the poll so a
    // slow/contended report (one-at-a-time per partner, 20-min server cap) fails
    // fast and the dashboard falls back to the matview range instead of hanging.
    // The payer report typically completes in well under a minute.
    pollIntervalMs: Number(process.env.CMD_POLL_INTERVAL_MS) || 4_000,
    maxPollAttempts: Number(process.env.CMD_POLL_ATTEMPTS) || 12, // ~48s ceiling
  };
}

export async function payerGapCmdForMonth(year: number, month: number): Promise<PayerGapSummary> {
  return cmdPayerGapForMonth(year, month, cmdApiConfig());
}

/**
 * CMD per-payer gap + per-facility breakdown for one month, read from the DB
 * rollup (collections.cmd_payer_facility_monthly, ingested from the CMD report
 * CSV). This is the Master BXR Chart "By Payer" data source — fast, non-PHI, and
 * independent of the live CMD API. Reads as claims_reader; NOT cached (per-request
 * user-selected month, mirroring payerGapForRange / collectionsDailyForMonth).
 * Returns an empty result for a month with no rollup rows, so the caller can fall
 * back to the matview date-range path.
 */
export async function payerCmdMonth(year: number, month: number): Promise<CmdPayerMonthResult> {
  return cmdPayerMonth(year, month, {
    executor: readerExecutor(),
    createdBy: 'phase71-collections-dashboard',
  });
}

// ---------------------------------------------------------------------------
// CMD Collections Explorer (Derek's 14-column batch report).
//
// Same credentials/customer as the payer rollup; a DISTINCT saved report + filter.
// The non-PHI projection is cached via unstable_cache (no PHI at rest). The FULL
// report (incl. PHI) lives only in a VOLATILE in-process cache (15 min) — never
// persisted, never unstable_cache'd — so a per-row reveal resolves without re-running
// the slow, one-at-a-time report. Reveal matches by content fingerprint, so it fails
// closed to null and can never return a different patient's identifiers.
// ---------------------------------------------------------------------------
function cmdExplorerConfig(): CmdApiConfig {
  return {
    ...cmdApiConfig(),
    reportId: process.env.CMD_EXPLORER_REPORT_ID?.trim() || '10091971',
    filterId: process.env.CMD_EXPLORER_FILTER_ID?.trim() || '10147377',
  };
}

const CMD_EXPLORER_TTL_MS = 15 * 60_000;
let cmdExplorerFull: { at: number; rows: CmdExplorerFullRow[] } | null = null;

async function getCmdExplorerFull(): Promise<CmdExplorerFullRow[]> {
  const now = Date.now();
  if (cmdExplorerFull && now - cmdExplorerFull.at < CMD_EXPLORER_TTL_MS) return cmdExplorerFull.rows;
  const rows = mapReportRows(await cmdReportRows(cmdExplorerConfig()));
  cmdExplorerFull = { at: now, rows };
  return rows;
}

/** NON-PHI projection of the CMD explorer report, cached 15 min (no PHI at rest). */
export const loadCmdExplorerNonPhi = unstable_cache(
  async (): Promise<CmdExplorerNonPhiRow[]> => toNonPhi(await getCmdExplorerFull()),
  ['cmd-explorer-nonphi'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

/** Resolve ONE row's PHI by content fingerprint + write a durable audit record. */
export async function revealCmdExplorerRow(
  rowId: string,
  actor: { email: string; userId: string },
): Promise<CmdExplorerPhi | null> {
  const match = (await getCmdExplorerFull()).find((r) => r.rowId === rowId);
  if (!match) return null;
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'reveal_cmd_explorer_row',
    detail: { rowId }, // non-PHI fingerprint only — never the values
  });
  return match.phi;
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
