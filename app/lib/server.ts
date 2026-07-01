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
import { collectionsYoy } from '../../src/collections/collectionsYoy.js';
import type { CollectionsYoy } from '../../src/collections/collectionsYoy.js';
import { facilityDimension, type FacilityDimensionRow } from '../../src/collections/facilities.js';
import { cmdPayerGapForMonth, cmdReportRows, type CmdApiConfig } from '../../src/collections/cmdPayer.js';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../src/collections/cmdExplorer.js';
import { decryptPhi } from '../../src/collections/phiCrypto.js';
import { cmdPayerMonth, type CmdPayerMonthResult } from '../../src/collections/cmdPayerRollup.js';
import { refreshCmdPayerRollup } from '../../src/collections/cmdPayerRefresh.js';
import { CMD_EXPLORER_CUSTOMERS } from '../../src/collections/cmdCustomers.js';
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
import { cmdExplorerCron } from '../../src/collections/cmdExplorerCron.js';
import { isAuthorized } from '../../src/bearerAuth.js';

let cachedExecutor: PgExecutor | undefined;
function readerExecutor(): PgExecutor {
  // verify-full TLS is applied centrally in makeReaderPool (src/ssl.ts).
  cachedExecutor ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return cachedExecutor;
}

// Least-privilege writer pool for the web app's CMD ingests — the ONLY write path
// in the web app. cmd_rollup_writer can INSERT/DELETE collections.cmd_payer_facility_monthly
// (migration 0013) and INSERT collections.cmd_explorer_rows (migration 0019); NOT
// claims_admin, NOT the reader. The URL comes from env only and is never logged;
// verify-full TLS via makeClient.
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

// ---------------------------------------------------------------------------
// Per-user RBAC lookup (claims.app_user, migration 0025).
//
// Resolves a signed-in Supabase user's role row by their verified auth uid. Read on the SAME
// least-privilege claims_reader pool (SELECT-only on app_user; no write path from the app —
// provisioning is admin-only). NON-PHI: this is staff identity + role, never patient data. A
// missing row => null (the caller treats that as UNPROVISIONED / default-deny). The DB CHECK
// constraints already bound role/entity to the known values; we re-narrow here so an unexpected
// value fails closed to null rather than widening access.
// ---------------------------------------------------------------------------
export type AppRole = 'super_admin' | 'admin' | 'user';
export type AppEntity = 'bxr' | 'indigo';

export interface AppUserRow {
  role: AppRole;
  /** null for super_admin; the entity for entity-scoped roles. */
  entity: AppEntity | null;
  /** Lowercased staff email stored alongside the role (display/audit convenience). */
  email: string;
}

function narrowRole(role: string | null): AppRole | null {
  return role === 'super_admin' || role === 'admin' || role === 'user' ? role : null;
}
function narrowEntity(entity: string | null): AppEntity | null {
  return entity === 'bxr' || entity === 'indigo' ? entity : null;
}

export async function appUserFor(userId: string): Promise<AppUserRow | null> {
  const { rows } = await readerExecutor().query<{
    role: string;
    entity: string | null;
    email: string;
  }>('select role, entity, email from claims.app_user where user_id = $1', [userId]);
  const row = rows[0];
  if (!row) return null;
  // Fail closed on any value outside the known unions (CHECK constraints make this unreachable).
  const role = narrowRole(row.role);
  if (!role) return null;
  return { role, entity: narrowEntity(row.entity), email: row.email };
}

// ---------------------------------------------------------------------------
// In-app user management (migration 0026). The list bridges to auth.users through the
// postgres-owned SECURITY DEFINER claims.list_app_users() (projects ONLY id/email/confirmed,
// never password data); writes go through the claims_admin-owned upsert/delete functions that
// enforce data integrity + the last-super-admin guard. All on the claims_reader pool (EXECUTE
// grants only — no direct table write). AUTHORIZATION (caller role / entity scope / no self-edit)
// is enforced by the calling Server Action (app/lib/admin-actions.ts), never here.
// ---------------------------------------------------------------------------

/** One row of the user-management list: an auth user + their dashboard role (null = unprovisioned). */
export interface ManagedUser {
  userId: string;
  email: string;
  emailConfirmed: boolean;
  /** ISO timestamp the auth account was created. */
  createdAt: string;
  role: AppRole | null;
  entity: AppEntity | null;
}

export async function listAppUsers(): Promise<ManagedUser[]> {
  const { rows } = await readerExecutor().query<{
    user_id: string;
    email: string;
    email_confirmed: boolean;
    created_at: Date | string;
    role: string | null;
    entity: string | null;
  }>(
    'select user_id, email, email_confirmed, created_at, role, entity from claims.list_app_users()',
    [],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailConfirmed: Boolean(r.email_confirmed),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    role: narrowRole(r.role),
    entity: narrowEntity(r.entity),
  }));
}

/** Assign/change a user's role (parameterized; the DB fn validates + guards the last super_admin). */
export async function upsertAppUser(
  userId: string,
  email: string,
  role: AppRole,
  entity: AppEntity | null,
): Promise<void> {
  await readerExecutor().query('select claims.upsert_app_user($1, $2, $3, $4)', [
    userId,
    email,
    role,
    entity,
  ]);
}

/** Revoke a user's role (delete the row → unprovisioned). The DB fn guards the last super_admin. */
export async function deleteAppUser(userId: string): Promise<void> {
  await readerExecutor().query('select claims.delete_app_user($1)', [userId]);
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

/**
 * Daily CMD Collections Explorer ingest route (Vercel Cron). GET only; gated on
 * CRON_SECRET with the same constant-time Bearer check the other cron uses
 * (isAuthorized). Pulls the live 14-column explorer report, encrypts the 3 PHI
 * identifiers in-process, and idempotently upserts into collections.cmd_explorer_rows
 * as the least-privilege cmd_rollup_writer role; busts the 'cmd-explorer' cache tag
 * after a successful insert. Returns non-PHI counts only. Auth + compose live here
 * (the composition root); the cmdExplorerCron logic stays transport-agnostic.
 */
export async function handleCmdExplorerCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  // GET only — reject any other verb before touching auth or the live API.
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  // Fail closed on a missing/empty secret, then constant-time Bearer compare.
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  try {
    const stats = await cmdExplorerCron({
      customers: CMD_EXPLORER_CUSTOMERS,
      fetchRows: (customerId) => cmdReportRows(cmdExplorerConfigFor(customerId)),
      writeDb: rollupWriterDb(),
      revalidate: () => revalidateTag('cmd-explorer'),
      revalidateDashboard: () => revalidateTag(DASHBOARD_CACHE_TAG),
      // Saved filter 10147499 windows on payment-received 1/1/2026→6/30/2027. Past that end the
      // filter silently stops returning newer dates; this drives a heads-up warning ~30d ahead.
      // Override via CMD_FILTER_WINDOW_END when the filter's window is extended in CMD.
      filterWindowEnd: process.env.CMD_FILTER_WINDOW_END?.trim() || '2027-06-30',
    });
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    // Generic to the client; message only to the server log (no PHI, no token).
    console.error('cmd-explorer cron failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
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

/**
 * Year-over-year collected totals for the overview cards' YoY trend (non-PHI).
 * Sourced from collections.payment_lines (the only multi-year collections-side
 * series — the live deposit series is 2026-only). Cached per `asOf` like the other
 * aggregates: the anchor changes ~daily, so each day's window memoizes once and the
 * shared DASHBOARD_CACHE_TAG busts it on ingest. Reader projects only non-PHI sums.
 */
export const dashboardCollectionsYoy = unstable_cache(
  async (asOf: string): Promise<CollectionsYoy> =>
    collectionsYoy(
      { as_of: asOf },
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard' },
    ),
  ['dashboard-collections-yoy'],
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
// CMD Collections Explorer (Derek's 14-column batch report) — DB-backed.
//
// Reads collections.cmd_explorer_rows (migration 0019): seeded from history
// (cmdExplorerSeed.ts) and kept current by the daily cron (handleCmdExplorerCron).
// The non-PHI grid is keyset-paginated and cached PER PAGE via unstable_cache (no PHI
// at rest); the cron busts the 'cmd-explorer' tag after any insert. The 3 PHI columns
// are stored as libsodium ciphertext and surface ONLY through the audited per-row
// reveal, which decrypts in-process and is NEVER cached. All reads run as claims_reader
// (SELECT only). cmdExplorerConfigFor() builds the cron's live fetch config PER CUSTOMER
// (one CMD customer == one facility); the cron loops CMD_EXPLORER_CUSTOMERS. The UI no longer
// polls the live CMD report.
// ---------------------------------------------------------------------------

/**
 * Live-fetch config for ONE CMD customer account. Report 10091971 / filter 10147499 is the
 * batch export (the 14 explorer columns + Check/EFT + Patient Payments) windowed on PAYMENT
 * RECEIVED date (1/1/2026 → 6/30/2027) — so it captures all 2026 collections, INCLUDING payments
 * received in 2026 on charges dated before 2026 (an earlier charge-date-windowed filter, 10147430,
 * dropped those — undercounting the collections chart by ~$6.9M). customerId varies per call so the
 * cron covers every facility. Per-customer poll budget is small (the cron loops 15 accounts within
 * the function deadline); CMD_EXPLORER_* env vars allow tuning report/filter/poll without a deploy.
 */
function cmdExplorerConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdApiConfig(),
    customerId,
    reportId: process.env.CMD_EXPLORER_REPORT_ID?.trim() || '10091971',
    filterId: process.env.CMD_EXPLORER_FILTER_ID?.trim() || '10147499',
    pollIntervalMs: Number(process.env.CMD_EXPLORER_POLL_INTERVAL_MS) || 3_000,
    maxPollAttempts: Number(process.env.CMD_EXPLORER_POLL_ATTEMPTS) || 8,
  };
}

/** One keyset page of the explorer grid + the cursor to fetch the next page (null at end). */
export interface CmdExplorerPage {
  rows: CmdExplorerRow[];
  nextCursor: number | null;
}

/**
 * Server-side filters for the explorer grid (non-PHI). `facility` is an EXACT match on
 * the cmd_explorer_rows.facility text column (its own vocabulary — distinct values come
 * from cmdExplorerFacilities, NOT the canonical facility dimension). `from`/`to` window
 * payment_received ([from, to)). All values are bound parameters; nulls are no-ops.
 */
export interface CmdExplorerFilter {
  facility?: string | null;
  from?: string | null; // 'YYYY-MM-DD' inclusive (payment_received >= from)
  to?: string | null; // 'YYYY-MM-DD' exclusive (payment_received < to)
}

const CMD_EXPLORER_PAGE_SIZE = 50;

// Explicit non-PHI column list — the bytea PHI columns are NEVER selected here. Dates and
// ingested_at are cast to text so the row shape is stable strings (not pg Date objects);
// numeric money stays a fixed-2-decimal string. id (bigserial) is the keyset + reveal key.
const CMD_EXPLORER_SELECT =
  "select id, to_char(charge_date, 'YYYY-MM-DD') as charge_date, " +
  "to_char(payment_received, 'YYYY-MM-DD') as payment_received, cpt_code, revenue_code, " +
  'facility, charge_amount, allowed_amount, insurance_payments, adjustments, ' +
  'patient_balance_due, primary_payer, ' +
  `to_char(ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at ` +
  'from collections.cmd_explorer_rows';

/** Raw DB shape — pg returns int8 (id) as a string; toExplorerRow narrows it to number. */
interface CmdExplorerDbRecord extends Omit<CmdExplorerRow, 'id'> {
  id: string;
}

function toExplorerRow(r: CmdExplorerDbRecord): CmdExplorerRow {
  return { ...r, id: Number(r.id) };
}

/**
 * Build the keyset page query with optional filters. Column/table names are fixed
 * literals; every VALUE (cursor, facility, dates, limit) is a bound $n parameter — no
 * interpolation, no SELECT *. Keyset (id < cursor) AND the filters are ANDed, so paging
 * walks the FILTERED set consistently (the filter is constant across a page sequence).
 */
function buildCmdExplorerQuery(
  cursor: number | null,
  filter: CmdExplorerFilter,
  limit: number,
): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (cursor !== null) conds.push(`id < ${add(cursor)}`);
  if (filter.facility) conds.push(`facility = ${add(filter.facility)}`);
  if (filter.from) conds.push(`payment_received >= ${add(filter.from)}::date`);
  if (filter.to) conds.push(`payment_received < ${add(filter.to)}::date`);
  const where = conds.length > 0 ? ` where ${conds.join(' and ')}` : '';
  const limitClause = ` order by id desc limit ${add(limit)}`;
  return { sql: `${CMD_EXPLORER_SELECT}${where}${limitClause}`, params };
}

async function loadCmdExplorerPage(
  cursor: number | null,
  filter: CmdExplorerFilter = {},
): Promise<CmdExplorerPage> {
  // Keyset: ORDER BY id DESC (newest snapshot first) so freshly cron-ingested rows surface on
  // the first page. WHERE id < cursor pages backward (omitted on the first page), ANDed with the
  // active filters. Over-fetch one row to learn whether a next page exists without a count(*).
  const limit = CMD_EXPLORER_PAGE_SIZE + 1;
  const { sql, params } = buildCmdExplorerQuery(cursor, filter, limit);
  const { rows } = await readerExecutor().query<CmdExplorerDbRecord>(sql, params);
  const hasMore = rows.length > CMD_EXPLORER_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, CMD_EXPLORER_PAGE_SIZE) : rows).map(toExplorerRow);
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
  return { rows: page, nextCursor };
}

/**
 * NON-PHI explorer page, cached 15 min PER (cursor, filter) key (no PHI at rest). The cron
 * busts the shared 'cmd-explorer' tag after any insert. The cursor is a plain number (the
 * bigserial id is far below 2^53 at this scale) so it serializes cleanly into the
 * unstable_cache key; the filter is a small plain object, also JSON-serializable.
 */
export const loadCmdExplorerNonPhi = unstable_cache(
  (cursor: number | null = null, filter: CmdExplorerFilter = {}): Promise<CmdExplorerPage> =>
    loadCmdExplorerPage(cursor, filter),
  ['cmd-explorer-nonphi'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

/**
 * Distinct facility strings present in the explorer rows (non-PHI), for the "All Collections"
 * facility filter. This vocabulary is the CMD report's own facility text — it does NOT match
 * the canonical facility dimension, so the All Collections filter uses these values directly.
 * Reader-only, fixed literal SQL (no params, no SELECT *), cached + tag-busted like the grid.
 */
export const cmdExplorerFacilities = unstable_cache(
  async (): Promise<string[]> => {
    const { rows } = await readerExecutor().query<{ facility: string | null }>(
      'select distinct facility from collections.cmd_explorer_rows order by facility',
      [],
    );
    return rows
      .map((r) => r.facility)
      .filter((f): f is string => typeof f === 'string' && f.trim() !== '');
  },
  ['cmd-explorer-facilities'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

/**
 * Resolve ONE row's PHI by bigserial id: decrypt the 3 ciphertext columns in-process,
 * write a synchronous (fail-closed) audit record, then return the identifiers. The PHI
 * is never cached and never logged; absent id → null. Runs as claims_reader.
 */
export async function revealCmdExplorerRow(
  id: number,
  actor: { email: string; userId: string },
): Promise<CmdExplorerPhi | null> {
  const { rows } = await readerExecutor().query<{
    patient_name: Buffer;
    member_id: Buffer;
    group_number: Buffer | null;
  }>(
    'select patient_name, member_id, group_number from collections.cmd_explorer_rows where id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const [patient_name, member_id_raw, group_number] = await Promise.all([
    decryptPhi(row.patient_name),
    decryptPhi(row.member_id),
    row.group_number ? decryptPhi(row.group_number) : Promise.resolve(null),
  ]);
  // Synchronous audit BEFORE returning PHI — a throw here denies the reveal (fail-closed).
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'reveal_cmd_explorer_row',
    detail: { id }, // non-PHI synthetic id only — never the values
  });
  return { patient_name, member_id_raw, group_number };
}

/** One revealed row: its bigserial id + the decrypted PHI identifiers. */
export interface CmdExplorerRevealedRow extends CmdExplorerPhi {
  id: number;
}

/**
 * Bulk reveal: decrypt the PHI for a SET of explorer ids (one page's worth) in-process,
 * write ONE fail-closed audit row for the batch, then return the identifiers. Backs the
 * grid's "Reveal all" action. The PHI is never cached and never logged; only the non-PHI
 * synthetic ids are audited. Runs as claims_reader. A decryption failure (e.g. a
 * LIBSODIUM_KEY that does not match the key the rows were ingested with) THROWS here and
 * is surfaced to the user by the action — never silently swallowed.
 */
export async function revealCmdExplorerRows(
  ids: number[],
  actor: { email: string; userId: string },
): Promise<CmdExplorerRevealedRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await readerExecutor().query<{
    id: string;
    patient_name: Buffer;
    member_id: Buffer;
    group_number: Buffer | null;
  }>(
    'select id, patient_name, member_id, group_number from collections.cmd_explorer_rows where id = any($1::bigint[])',
    [ids],
  );
  const out: CmdExplorerRevealedRow[] = [];
  for (const row of rows) {
    const [patient_name, member_id_raw, group_number] = await Promise.all([
      decryptPhi(row.patient_name),
      decryptPhi(row.member_id),
      row.group_number ? decryptPhi(row.group_number) : Promise.resolve(null),
    ]);
    out.push({ id: Number(row.id), patient_name, member_id_raw, group_number });
  }
  // ONE bulk audit BEFORE returning PHI (fail-closed): records who revealed how many rows
  // and which non-PHI synthetic ids — never the decrypted values.
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'reveal_cmd_explorer_rows',
    detail: { count: out.length, ids: out.map((o) => o.id) },
  });
  return out;
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
