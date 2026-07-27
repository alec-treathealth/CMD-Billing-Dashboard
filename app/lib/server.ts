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
import {
  AUDIT_PAGE_SIZE,
  auditSortValue,
  buildAuditRowsQuery,
  buildAuditFacilityOptionsQuery,
  buildAuditPayerOptionsQuery,
  buildAuditPivotQueries,
  buildAuditPatientDetailQuery,
  type AuditCursor,
  type AuditFilter,
  type AuditSort,
  type AuditGridRow,
  type AuditPage,
  type AuditFacilityOption,
  type AuditPayerOption,
  type AuditOfficePivot,
  type AuditPayerCptPivot,
  type AuditRevPivot,
} from '../../src/billingAudit/auditQuery.js';
import Anthropic from '@anthropic-ai/sdk';
import { DASHBOARD_CACHE_TAG } from '../../src/cacheTags.js';
import { makeAnthropicClientFromEnv } from '../../src/agent/index.js';
import type { AnthropicMessagesClient } from '../../src/agent/index.js';
import {
  AI_MAX_TOKENS,
  buildAiMessages,
  isSufficientForAi,
  type CollectionsAiInput,
} from '../../src/collections/aiAnalysis.js';
export {
  CollectionsAiInputSchema,
  INSUFFICIENT_COPY,
  SELECTION_MIN_CHARGES,
  AI_SECTIONS,
  parseAiSections,
  type CollectionsAiInput,
} from '../../src/collections/aiAnalysis.js';
import { distribution, searchClaims } from '../../src/queries/index.js';
import {
  distributionCountFromMatview,
  payerGapForFilter,
} from '../../src/queries/dashboard_aggregates.js';
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../src/queries/executor.js';
// Pure explorer query builders live in a Next-free module so they're unit-testable; this file
// adds the DB execution + caching and re-exports the public seam (below) so callers keep
// importing these names from '@/lib/server'.
import {
  buildCmdExplorerQuery,
  buildCmdSearchSummaryQueries,
  buildCmdFacilityOptionsQuery,
  buildCmdPayerOptionsQuery,
  buildCmdEmployerOptionsQuery,
  buildCohortCurveQueries,
  buildCohortTotalsQuery,
  buildCohortDrilldownQueries,
  cmdExplorerSortValue,
  deriveYield,
  CMD_EXPLORER_PAGE_SIZE,
  COHORT_MIN_PATIENTS,
  COHORT_DRILLDOWN_TABLE_MIN_PATIENTS,
  clearsCohortFloor,
  clearsDrilldownTableFloor,
  type CmdExplorerFilter,
  type CmdExplorerSort,
  type CmdExplorerCursor,
  type CmdExplorerPage,
  type CmdSearchSummary,
  type CmdSearchGroup,
  type CmdComboGroup,
  type CmdFacilityOption,
  type CmdEmployerOption,
  type VobMarketFilter,
  type CohortCurvePoint,
  type CohortCurve,
  type CohortTotals,
  type CohortTotalsRow,
  type CohortDrilldownAggregate,
  type CohortDrilldownTable,
  type CohortDrilldownResult,
} from '../../src/collections/cmdExplorerQuery.js';
export {
  CMD_EXPLORER_SEARCH_COLUMNS,
  CMD_EXPLORER_SORTABLE_COLUMNS,
  CMD_EXPLORER_DEFAULT_SORT,
  CMD_SEARCH_TOP_N,
  CMD_EXPLORER_COLUMN_KEYS,
  CMD_FUNDING_MARKETS,
  sanitizeGridColumns,
  resolveCmdExplorerSort,
  resolveCmdExplorerCursor,
  buildCmdSearchSummaryQueries,
} from '../../src/collections/cmdExplorerQuery.js';
export type {
  CmdExplorerFilter,
  CmdExplorerSearchColumn,
  CmdExplorerSort,
  CmdExplorerSortColumn,
  CmdExplorerCursor,
  CmdExplorerPage,
  CmdSearchGroup,
  CmdComboGroup,
  CmdSearchSummary,
  CmdFacilityOption,
  CmdEmployerOption,
  CohortCurvePoint,
  CohortCurve,
  CohortTotals,
  CohortDrilldownAggregate,
  CohortDrilldownTable,
  CohortDrilldownResult,
} from '../../src/collections/cmdExplorerQuery.js';
import {
  buildResolvePayerQuery,
  buildFacilityRankingQuery,
  buildIdentifierLandingFacilityQuery,
  buildFacilityCasesQuery,
  buildMoversQuery,
  buildBookKpisQuery,
  buildFacilityTrendQuery,
} from '../../src/collections/qualifyQuery.js';
import type { QualifyPatientCohortRaw } from './qualify/core';
import type {
  QualifyTokenKind,
  QualifyResolvePayerRow,
  QualifyFacilityRow,
  QualifyClaimRow,
  QualifyMoverRow,
  QualifyBookKpisRow,
  QualifyOrientationScope,
  QualifyFacilityTrendRow,
  QualifyMatchSummaryRow,
} from '../../src/collections/qualifyQuery.js';
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
import { cmdPayerGapForMonth, cmdReportRows, type CmdApiConfig, type CmdReportRow } from '../../src/collections/cmdPayer.js';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../src/collections/cmdExplorer.js';
import { aliasIndigoFacilityColumn } from '../../src/collections/cmdExplorer.js';
import { decryptPhi } from '../../src/collections/phiCrypto.js';
import { cmdPayerMonth, type CmdPayerMonthResult } from '../../src/collections/cmdPayerRollup.js';
import { refreshCmdPayerRollup } from '../../src/collections/cmdPayerRefresh.js';
import { CMD_EXPLORER_CUSTOMERS, INDIGO_CUSTOMERS, BXR_CUSTOMERS, type CmdCustomer } from '../../src/collections/cmdCustomers.js';
// src-side canonical tenant ids (agree with app/lib/views.ts — dual-declaration note in
// src/tenants.ts). Each cron's writes are stamped + GUC-scoped to its tenant explicitly
// (migration-B era), never inferred; the Indigo roster also carries per-customer ids.
import { BXR_ENTITY_ID as BXR_TENANT_ID, INDIGO_ENTITY_ID as INDIGO_TENANT_ID } from '../../src/tenants.js';
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
import {
  handleRefreshChargeRollupRequest,
  type RefreshChargeRollupHttpRequest,
} from '../../src/routes/refreshChargeRollupHandler.js';
import { refreshChargeRollup } from '../../src/collections/refreshChargeRollup.js';
import { cmdExplorerCron } from '../../src/collections/cmdExplorerCron.js';
import { cmdCensusCron } from '../../src/collections/cmdCensusCron.js';
import { cmdRunReportToZip, readZipEntries } from '../../src/collections/cmdPayer.js';
import { billingAuditCron, recordAuditIngestRun } from '../../src/billingAudit/auditIngest.js';
import { auditCustomersFor, auditReportIds, type AuditScope } from '../../src/billingAudit/auditConfig.js';
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
// Alec-only user log dashboard read path (migration 0056).
//
// `claims.access_audit` remains directly unreadable to claims_reader; this calls the bounded
// SECURITY DEFINER projection `claims.list_access_audit()`. The page/action layer is the authority
// for the Alec-only app-user gate. Rows are non-PHI by 0017 contract: staff identity, action,
// timestamp, and a detail blob that must contain only operational metadata/counts.
// ---------------------------------------------------------------------------
export interface AccessAuditRow {
  id: string;
  createdAt: string;
  actorEmail: string;
  actorUserId: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface ListAccessAuditInput {
  limit?: number;
  offset?: number;
  actorEmail?: string | null;
  action?: string | null;
  fromIso?: string | null;
  toIso?: string | null;
}

export interface ListAccessAuditResult {
  rows: AccessAuditRow[];
  total: number;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), min), max);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function listAccessAudit(input: ListAccessAuditInput = {}): Promise<ListAccessAuditResult> {
  const limit = boundedInt(input.limit, 50, 1, 200);
  const offset = boundedInt(input.offset, 0, 0, 100_000);
  const { rows } = await readerExecutor().query<{
    id: string;
    created_at: Date | string;
    actor_email: string;
    actor_user_id: string;
    action: string;
    detail: unknown;
    total_count: string | number | null;
  }>(
    'select id, created_at, actor_email, actor_user_id, action, detail, total_count ' +
      'from claims.list_access_audit($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)',
    [
      limit,
      offset,
      input.actorEmail?.trim() || null,
      input.action?.trim() || null,
      input.fromIso ?? null,
      input.toIso ?? null,
    ],
  );
  return {
    total: Number(rows[0]?.total_count ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      actorEmail: r.actor_email,
      actorUserId: r.actor_user_id,
      action: r.action,
      detail: jsonObject(r.detail),
    })),
  };
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
export type AppRole = 'super_admin' | 'admin' | 'user' | 'admissions_seat';
export type AppEntity = 'bxr' | 'indigo';

export interface AppUserRow {
  role: AppRole;
  /** null for super_admin; the entity for entity-scoped roles. */
  entity: AppEntity | null;
  /** Lowercased staff email stored alongside the role (display/audit convenience). */
  email: string;
}

function narrowRole(role: string | null): AppRole | null {
  return role === 'super_admin' || role === 'admin' || role === 'user' || role === 'admissions_seat'
    ? role
    : null;
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

// ---------------------------------------------------------------------------
// Per-user saved grid views (migration 0046) — the Collections Explorer's "Show columns" templates.
// READS: direct claims_reader SELECT, app-scoped by the caller's uid (mirrors appUserFor — the
// WHERE is the scope). WRITES: the claims_admin-owned SECURITY DEFINER save/set-default/delete
// functions, EXECUTE'd on the reader pool (no direct DML), every op scoped to the p_user the Server
// Action passes — ALWAYS the caller's own verified uid, NEVER client input. Non-PHI (column keys +
// the user's own label). `columns` crosses as jsonb (stringified, cast $n::jsonb).
// ---------------------------------------------------------------------------

/**
 * One saved column layout. `columns` is the display column order; `hidden` is which of those keys are
 * hidden. `hidden` is NULL for LEGACY rows (migration 0046, before hidden_columns existed) where
 * `columns` held only the visible columns in order — the caller reconstructs the full order + hidden
 * set from a null `hidden` (see cmd-explorer's applyView). A non-null array is the new (0047) format.
 */
export interface GridViewRow {
  name: string;
  columns: string[];
  hidden: string[] | null;
  isDefault: boolean;
}

const toStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];

/** List the caller's saved views (app-scoped by uid; default first, then alphabetical). */
export async function gridViewsFor(userId: string): Promise<GridViewRow[]> {
  const { rows } = await readerExecutor().query<{
    view_name: string;
    columns: unknown;
    hidden_columns: unknown;
    is_default: boolean;
  }>(
    'select view_name, columns, hidden_columns, is_default from claims.user_grid_views ' +
      'where app_user_id = $1 order by is_default desc, view_name',
    [userId],
  );
  return rows.map((r) => ({
    name: r.view_name,
    columns: toStringArray(r.columns),
    // Preserve NULL (legacy) vs array (new). NULL signals the caller to derive the hidden set from
    // whichever allowlisted columns are absent from `columns` (0046 semantics); an array is explicit.
    hidden: r.hidden_columns == null ? null : toStringArray(r.hidden_columns),
    isDefault: Boolean(r.is_default),
  }));
}

/**
 * Create/update the caller's named view. `columns` (full display order) and `hidden` (a subset) are
 * pre-sanitized by the action; the DB fn re-bounds the shape. Uses the 5-arg save_grid_view (0047).
 */
export async function saveGridViewRow(
  userId: string,
  name: string,
  columns: string[],
  hidden: string[],
  makeDefault: boolean,
): Promise<void> {
  await readerExecutor().query('select claims.save_grid_view($1, $2, $3::jsonb, $4::jsonb, $5)', [
    userId,
    name,
    JSON.stringify(columns),
    JSON.stringify(hidden),
    makeDefault,
  ]);
}

/** Set the caller's default view by name (DB fn raises if the name doesn't exist). */
export async function setDefaultGridViewRow(userId: string, name: string): Promise<void> {
  await readerExecutor().query('select claims.set_default_grid_view($1, $2)', [userId, name]);
}

/** Delete the caller's view by name (no-op if absent). */
export async function deleteGridViewRow(userId: string, name: string): Promise<void> {
  await readerExecutor().query('select claims.delete_grid_view($1, $2)', [userId, name]);
}

/**
 * Reap app_user rows for `email` that were orphaned by an out-of-band auth deletion (their uid no
 * longer exists in auth.users), keeping `keepUserId`. Prevents duplicate rows when an email whose
 * auth account was deleted directly in Supabase is re-invited. The DB fn (0029) only ever deletes
 * provably-orphaned rows. Returns the number of orphans removed.
 */
export async function deleteOrphanAppUsers(email: string, keepUserId: string): Promise<number> {
  const { rows } = await readerExecutor().query<{ deleted: number }>(
    'select claims.delete_orphan_app_users($1, $2) as deleted',
    [email, keepUserId],
  );
  return Number(rows[0]?.deleted ?? 0);
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
        businessEntityId: BXR_TENANT_ID, // BXR-only report config (cmdApiConfig)
      }),
  });
}

/**
 * Dedicated charge-rollup refresh route (Vercel Cron, hourly at :45 — after the :00 BXR and :30
 * Indigo explorer ingests settle). GET only; gated on CRON_SECRET with the same constant-time
 * Bearer check. Calls the 0050 SECURITY-DEFINER refresh function UNCONDITIONALLY as the
 * least-privilege cmd_rollup_writer and writes one collections.rollup_refresh_run row per attempt —
 * the durable, queryable freshness record that replaces the swallowed inline refresh (removed from
 * cmdExplorerCron). No PHI crosses this boundary; only non-PHI run stats are returned.
 */
export function handleRefreshChargeRollup(req: RefreshChargeRollupHttpRequest) {
  return handleRefreshChargeRollupRequest(req, {
    secret: process.env.CRON_SECRET,
    refresh: () => refreshChargeRollup({ db: rollupWriterDb(), triggeredBy: 'cron' }),
  });
}

/**
 * Tenant-parameterized CMD Collections Explorer ingest (Vercel Cron). GET only; gated on
 * CRON_SECRET with the same constant-time Bearer check (isAuthorized). For the given tenant it
 * pulls the live per-customer report, encrypts the 3 PHI identifiers in-process, idempotently
 * upserts charge lines into collections.cmd_explorer_rows AND replaces per-facility Check+EFT
 * deposits in collections.daily_collections — as the least-privilege cmd_rollup_writer role —
 * then busts the shared 'cmd-explorer' + dashboard-aggregates cache tags. Returns non-PHI counts
 * only. Auth + compose live here (the composition root); cmdExplorerCron stays transport-agnostic.
 *
 * Each tenant gets its OWN thin wrapper + route (/api/cron/cmd-explorer, /api/cron/indigo-explorer)
 * so a failing run is attributable by route name in the logs + the Vercel Cron tab, with ZERO
 * logic duplication — the only per-tenant inputs are the roster, the report/filter config, the
 * tenant stamp, and (Indigo only) a row transform. Separate schedules keep the two off the shared
 * one-report-at-a-time CMD partner session (BXR :00, Indigo :30).
 */
async function handleExplorerCronForTenant(
  req: { method?: string; authorization?: string | null },
  tenant: {
    /** Human label for the failure log line — distinct per tenant for log attribution. */
    label: string;
    /** The CMD customer accounts to loop (one report/filter run each). */
    customers: readonly CmdCustomer[];
    /** Per-customer live-fetch config (report/filter/poll) for this tenant. */
    configFor: (customerId: string) => CmdApiConfig;
    /** Run-level DEFAULT tenant stamp; a customer's own businessEntityId still overrides it. */
    businessEntityId: string;
    /** Optional per-fetch row transform (Indigo: alias "Customer Name" → "Facility Name"). */
    transformRows?: (rows: CmdReportRow[]) => CmdReportRow[];
  },
): Promise<{ status: number; body: unknown }> {
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
    const transform = tenant.transformRows;
    const stats = await cmdExplorerCron({
      customers: tenant.customers,
      fetchRows: async (customerId) => {
        const rows = await cmdReportRows(tenant.configFor(customerId));
        return transform ? transform(rows) : rows;
      },
      writeDb: rollupWriterDb(),
      businessEntityId: tenant.businessEntityId,
      revalidate: () => revalidateTag('cmd-explorer'),
      revalidateDashboard: () => revalidateTag(DASHBOARD_CACHE_TAG),
      // Both rosters use a ROLLING (current-month) payment-received window, so there is no fixed
      // end date to expire — the window-expiry warning does not apply. The STALE warning (newest
      // payment_date lagging `now`) still fires. Set CMD_FILTER_WINDOW_END only for a fixed window.
      filterWindowEnd: process.env.CMD_FILTER_WINDOW_END?.trim() || undefined,
    });
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    // Generic to the client; message only to the server log (no PHI, no token). The tenant label
    // makes a hard failure attributable to the right cron in the shared log stream.
    console.error(`${tenant.label} cron failed:`, err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
}

/** BXR daily explorer cron (/api/cron/cmd-explorer). Roster = CMD_EXPLORER_CUSTOMERS (BXR's 15). */
export function handleCmdExplorerCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleExplorerCronForTenant(req, {
    label: 'cmd-explorer',
    customers: CMD_EXPLORER_CUSTOMERS,
    configFor: cmdExplorerConfigFor,
    businessEntityId: BXR_TENANT_ID,
  });
}

/**
 * Indigo daily explorer cron (/api/cron/indigo-explorer). Roster = INDIGO_CUSTOMERS (37).
 * Indigo's report (10092391) labels the facility column "Customer Name"; the shared mapReportRows +
 * LOCKED fingerprint read facility ONLY from "Facility Name" and mapRow REQUIRES it — so an
 * unaliased Indigo pull would skip EVERY charge line (watch charge_skipped == rows_fetched).
 * aliasIndigoFacilityColumn maps it before mapping — the SAME transform the one-time seed used, so
 * cron re-pulls are fingerprint-idempotent (ON CONFLICT) against the loaded seed.
 */
export function handleIndigoExplorerCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleExplorerCronForTenant(req, {
    label: 'indigo-explorer',
    customers: INDIGO_CUSTOMERS,
    configFor: cmdIndigoConfigFor,
    businessEntityId: INDIGO_TENANT_ID,
    transformRows: aliasIndigoFacilityColumn,
  });
}

/**
 * Tenant-parameterized CMD charge-CENSUS ingest (Vercel Cron, Qualify v2 ②b). Sibling of
 * handleExplorerCronForTenant, same auth (GET only + constant-time CRON_SECRET Bearer), same
 * least-privilege writer (cmd_rollup_writer). It pulls the CENSUS saved-filter per customer and
 * UPSERTs charges into collections.cmd_charge_census (the openCount denominator), recording each
 * per-customer pull in collections.cmd_census_run. Freshness-gated (a customer a prior run completed
 * OK inside the staleness window is skipped) + budget-guarded, so a full sweep amortizes over
 * however many hourly invocations it takes. cmdCensusCron stays transport-agnostic; auth + compose
 * live here. NO cache revalidate: Qualify reads the census LIVE (no unstable_cache tag). Returns
 * non-PHI counts only; the tenant label attributes a hard failure to the right cron in the log stream.
 */
async function handleCensusCronForTenant(
  req: { method?: string; authorization?: string | null },
  tenant: {
    /** Human label for the failure log line — distinct per tenant for log attribution. */
    label: string;
    /** The CMD customer accounts to loop (each entry carries its owning businessEntityId). */
    customers: readonly CmdCustomer[];
    /** Per-customer live-fetch config (report/CENSUS-filter/poll) for this tenant. */
    configFor: (customerId: string) => CmdApiConfig;
    /** Optional per-fetch row transform (Indigo: alias "Customer Name" → "Facility Name"). */
    transformRows?: (rows: CmdReportRow[]) => CmdReportRow[];
  },
): Promise<{ status: number; body: unknown }> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  try {
    const stats = await cmdCensusCron({
      customers: tenant.customers,
      fetchRows: (customerId) => cmdReportRows(tenant.configFor(customerId)),
      writeDb: rollupWriterDb(),
      transformRows: tenant.transformRows,
      stalenessMs: censusStalenessMs(),
    });
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    console.error(`${tenant.label} cron failed:`, err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
}

/** BXR census cron (/api/cron/cmd-census). Roster = BXR_CUSTOMERS (BXR's 15). */
export function handleCmdCensusCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleCensusCronForTenant(req, {
    label: 'cmd-census',
    customers: BXR_CUSTOMERS,
    configFor: cmdBxrCensusConfigFor,
  });
}

/** Indigo census cron (/api/cron/indigo-census). Roster = INDIGO_CUSTOMERS (32); facility-column alias. */
export function handleIndigoCensusCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleCensusCronForTenant(req, {
    label: 'indigo-census',
    customers: INDIGO_CUSTOMERS,
    configFor: cmdIndigoCensusConfigFor,
    transformRows: aliasIndigoFacilityColumn,
  });
}

// Least-privilege writer pool for the BILLING AUDIT plane (claims.audit_row /
// billing_code_decision / flag) — the dedicated claims_audit_writer role (migration
// 0049), NEVER cmd_rollup_writer (collections blast radius stays untouched), NEVER
// claims_admin. URL from env only; verify-full TLS via makeClient.
let cachedAuditWriterDb: Db | undefined;
function auditWriterDb(): Db {
  const url = process.env.CLAIMS_AUDIT_WRITER_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Missing CLAIMS_AUDIT_WRITER_DATABASE_URL (set in env; never hardcode or log it)');
  }
  cachedAuditWriterDb ??= makeClient(url);
  return cachedAuditWriterDb;
}

/**
 * Preflight IDENTITY GUARD — asserts the audit writer pool is a least-privilege
 * claims_audit_writer identity (has the role, NOT a superuser, NOT claims_admin/postgres)
 * BEFORE any billing-audit write. A misconfigured CLAIMS_AUDIT_WRITER_DATABASE_URL that
 * pointed at an admin/superuser would fail the run loudly instead of writing PHI over a
 * privileged connection. Returns current_user so the (authed) caller can surface exactly
 * which role wrote. Membership-based (not a hardcoded login name) so it survives a role
 * rename, while still reporting the concrete user. Throws → the handler's catch → 500.
 */
async function assertAuditWriterIdentity(): Promise<string> {
  const res = await auditWriterDb().query<{
    u: string; is_super: boolean; has_writer: boolean; is_admin: boolean;
  }>(
    `select current_user as u,
            coalesce((select rolsuper from pg_roles where rolname = current_user), false) as is_super,
            pg_has_role(current_user, 'claims_audit_writer', 'USAGE') as has_writer,
            pg_has_role(current_user, 'claims_admin', 'MEMBER') as is_admin`,
  );
  const row = res.rows[0];
  if (!row || !row.has_writer || row.is_super || row.is_admin) {
    throw new Error(
      `audit writer identity check failed (user=${row?.u ?? '?'}, super=${row?.is_super}, ` +
        `has_writer=${row?.has_writer}, is_admin=${row?.is_admin}) — refusing to write`,
    );
  }
  return row.u;
}

/**
 * Scope-parameterized Billing Audit ingest (Vercel Cron). GET only; CRON_SECRET-gated
 * (constant-time Bearer). Loops the scope's LOCKED roster (auditConfig — scope IS the
 * roster), running the scope's report+filter once per customer, and Option-B-upserts
 * charge lines into claims.audit_row as claims_audit_writer. Report/filter ids are
 * ENV-VAR-ONLY (auditReportIds throws on a missing var — no hardcoded fallback, a
 * deliberate break from the collections pattern). Non-PHI counts only. Each scope gets
 * its own thin wrapper + route (/api/cron/billing-audit-ip, /api/cron/billing-audit-op)
 * for log/Cron-tab attribution, mirroring the explorer crons.
 */
async function handleBillingAuditCronForScope(
  req: { method?: string; authorization?: string | null },
  scope: AuditScope,
): Promise<{ status: number; body: unknown }> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const startedAt = new Date().toISOString();
  try {
    const ids = auditReportIds(scope, process.env); // throws on missing env — fail fast, names only
    const writerUser = await assertAuditWriterIdentity(); // in-process identity assert BEFORE any write
    const base = cmdApiConfig(); // CMD_API_* credentials + base URL (report/filter overridden below)
    const stats = await billingAuditCron({
      scope,
      customers: auditCustomersFor(scope),
      fetchZip: (customerId) =>
        cmdRunReportToZip({
          ...base,
          customerId,
          reportId: ids.reportId,
          filterId: ids.filterId,
          // DEDICATED audit poll tuning (NOT the explorer's 8×3s=24s). The 46/39-col audit
          // reports are heavier to generate than the collections explorer report; the fast
          // explorer ceiling poll-timed-out the largest facilities (CAMH/NASH/TBH,
          // 2026-07-14). 18×5s = 90s ceiling per customer, empty-grace 6 (also absorbs the
          // SUCCESS-empty poll race that made PCMH read empty despite having data). The 270s
          // wall-clock guard still caps total run time — a customer that can't finish inside
          // the budget budget-skips and catches up next run (idempotent upsert).
          pollIntervalMs: Number(process.env.CMD_AUDIT_POLL_INTERVAL_MS) || 5_000,
          maxPollAttempts: Number(process.env.CMD_AUDIT_POLL_ATTEMPTS) || 18,
          emptyGraceAttempts: Number(process.env.CMD_AUDIT_EMPTY_GRACE) || 6,
        }),
      zipToCsvTexts: (zip) => readZipEntries(zip).map((e) => e.data.toString('utf8')),
      writeDb: auditWriterDb(),
      businessEntityId: BXR_TENANT_ID,
      sourceReportId: ids.reportId,
      revalidate: () => revalidateTag('billing-audit'),
    });
    // Persist the run summary (observability) — FAIL-SOFT: the ingest already succeeded, so a
    // summary-write failure is logged (label only) and never fails the run. Requires 0053 applied.
    try {
      await recordAuditIngestRun(
        auditWriterDb(),
        BXR_TENANT_ID,
        { scope, sourceReportId: ids.reportId, writerUser, startedAt },
        stats,
      );
    } catch (e) {
      console.error(`billing-audit-${scope.toLowerCase()} cron: audit_ingest_run write failed (non-fatal):`, e instanceof Error ? e.message : String(e));
    }
    return { status: 200, body: { ok: true, writer_user: writerUser, ...stats } };
  } catch (err) {
    console.error(`billing-audit-${scope.toLowerCase()} cron failed:`, err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
}

/** IP audit ingest cron (/api/cron/billing-audit-ip). Roster = AUDIT_IP_CUSTOMERS (8). */
export function handleBillingAuditIpCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleBillingAuditCronForScope(req, 'IP');
}

/** OP audit ingest cron (/api/cron/billing-audit-op). Roster = AUDIT_OP_CUSTOMERS (9). */
export function handleBillingAuditOpCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleBillingAuditCronForScope(req, 'OP');
}

/**
 * Billing-code-decision sync cron (/api/cron/billing-code-decisions). GET only;
 * CRON_SECRET-gated. Reads the "JT Master Issues" decision-matrix tabs (EH canonical;
 * JT col O for stops — Alec's locked ruling) via a Google OAuth installed-app REFRESH
 * TOKEN supplied out of band in env (org policy forbids service-account keys):
 * GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_SHEETS_REFRESH_TOKEN /
 * BILLING_SHEET_ID — all env-only, fail-fast, names never values. googleapis loads
 * DYNAMICALLY inside this handler so the heavy client never rides the other routes'
 * bundles. Writes as claims_audit_writer; fail-soft parse keeps last good data.
 */
export async function handleBillingCodeDecisionsCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
    const refreshToken = process.env.GOOGLE_SHEETS_REFRESH_TOKEN?.trim();
    const sheetId = process.env.BILLING_SHEET_ID?.trim();
    if (!clientId || !clientSecret || !refreshToken || !sheetId) {
      throw new Error(
        'Billing-code sync env not configured: set GOOGLE_OAUTH_CLIENT_ID, ' +
          'GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_SHEETS_REFRESH_TOKEN, BILLING_SHEET_ID',
      );
    }
    const [{ google }, { readSheet }, { decisionSync }] = await Promise.all([
      import('googleapis'),
      import('../../src/sheets.js'),
      import('../../src/billingAudit/decisionSync.js'),
    ]);
    const oauth = new google.auth.OAuth2(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const writerUser = await assertAuditWriterIdentity(); // in-process identity assert BEFORE any write
    const stats = await decisionSync({
      // readSheet splits off row 1 as "header"; the matrix parser is block-based and
      // needs EVERY row with true 1-based rowNums — reassemble.
      fetchTab: async (tab) => {
        const res = await readSheet(sheetId, tab, oauth);
        return { rows: [{ rowNum: 1, cells: res.header }, ...res.rows] };
      },
      writeDb: auditWriterDb(),
      businessEntityId: BXR_TENANT_ID,
    });
    if (stats.status !== 'parse_failed' && stats.upserted > 0) revalidateTag('billing-audit');
    return { status: 200, body: { ok: stats.status !== 'parse_failed', writer_user: writerUser, ...stats } };
  } catch (err) {
    console.error('billing-code-decisions cron failed:', err instanceof Error ? err.message : String(err));
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

/**
 * Monthly collections by facility (non-PHI summary; reader-only, no row fetch). `entityIds` is the
 * RBAC-clamped tenant scope; it is an argument to the cached function, so each tenant scope caches
 * SEPARATELY (BXR / Indigo / Consolidated never share a cache entry).
 */
export const dashboardCollectionsSummary = unstable_cache(
  async (entityIds: string[]): Promise<CollectionsMonthlySummary> =>
    collectionsMonthlySummary(
      {},
      { executor: readerExecutor(), createdBy: 'phase7-collections-dashboard', entityIds },
    ),
  ['dashboard-collections-summary'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/** MTD/YTD collections KPIs by facility (non-PHI; anchored to latest payment_date). Per-tenant cache. */
export const dashboardCollectionsKpis = unstable_cache(
  async (entityIds: string[]): Promise<CollectionsKpis> =>
    collectionsKpis(
      {},
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard', entityIds },
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

/** Latest-month daily collections rows (non-PHI; date × facility × checks/eft/gross). Per-tenant cache. */
export const dashboardCollectionsDaily = unstable_cache(
  async (entityIds: string[]): Promise<CollectionsDailyResult> =>
    collectionsDaily(
      {},
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard', entityIds },
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
  entityIds: string[],
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
    { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard', entityIds },
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
export async function payerCmdMonth(
  year: number,
  month: number,
  entityIds: string[],
): Promise<CmdPayerMonthResult> {
  return cmdPayerMonth(year, month, {
    executor: readerExecutor(),
    createdBy: 'phase71-collections-dashboard',
    entityIds,
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
 * Live-fetch config for ONE CMD customer account. Report 10091971 / filter 10147530 is the
 * batch export (the 14 explorer columns + Check/EFT + Patient Payments) windowed on PAYMENT
 * RECEIVED date via a ROLLING window (current-month) — so each run re-supplies the current
 * month's collections and the append-only explorer + span-scoped daily replace self-heal any
 * missed run. (Predecessor 10147499 under-returned per account; a charge-date-windowed 10147430
 * dropped 2026 payments on pre-2026 charges — undercounting the chart by ~$6.9M.) customerId
 * varies per call so the cron covers every facility. Per-customer poll budget is small (the cron
 * loops 15 accounts within the function deadline); CMD_EXPLORER_* env vars tune report/filter/poll
 * without a deploy. emptyGraceAttempts rides out CMD's transient SUCCESS-empty "not ready yet"
 * response (which once aborted a whole run on poll 1) before treating an account as truly empty.
 */
function cmdExplorerConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdApiConfig(),
    customerId,
    reportId: process.env.CMD_EXPLORER_REPORT_ID?.trim() || '10091971',
    filterId: process.env.CMD_EXPLORER_FILTER_ID?.trim() || '10147530',
    pollIntervalMs: Number(process.env.CMD_EXPLORER_POLL_INTERVAL_MS) || 3_000,
    maxPollAttempts: Number(process.env.CMD_EXPLORER_POLL_ATTEMPTS) || 8,
    emptyGraceAttempts: Number(process.env.CMD_EXPLORER_EMPTY_GRACE) || 4,
  };
}

/**
 * Live-fetch config for ONE Indigo CMD customer account (report 10092391 / filter 10147669 —
 * replaced 10147602 after 2 facilities were added to the account; 10147602 was Indigo's own but is
 * being retired). Indigo's equivalent of BXR's 10091971/10147530, on the SAME CMD_API_* partner
 * creds. Overridable
 * via CMD_INDIGO_REPORT_ID / CMD_INDIGO_FILTER_ID without a deploy; poll tuning is shared with the
 * BXR explorer cron (identical CMD batch behavior). customerId varies per call to cover all 36
 * Indigo facilities. The "Customer Name" → "Facility Name" alias is applied by the cron wrapper
 * (transformRows: aliasIndigoFacilityColumn), NOT here — this only selects the report/filter.
 */
function cmdIndigoConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdApiConfig(),
    customerId,
    reportId: process.env.CMD_INDIGO_REPORT_ID?.trim() || '10092391',
    filterId: process.env.CMD_INDIGO_FILTER_ID?.trim() || '10147669',
    pollIntervalMs: Number(process.env.CMD_EXPLORER_POLL_INTERVAL_MS) || 3_000,
    maxPollAttempts: Number(process.env.CMD_EXPLORER_POLL_ATTEMPTS) || 8,
    emptyGraceAttempts: Number(process.env.CMD_EXPLORER_EMPTY_GRACE) || 4,
  };
}

// ---------------------------------------------------------------------------
// CMD charge-CENSUS (Qualify v2 ②b) — Feed 2 live-fetch config.
//
// The census reuses each tenant's EXISTING explorer report/poll/creds and swaps ONLY the saved
// filter: the census filter is a TRAILING CHARGE CENSUS (all payment states), not the explorer's
// payment-received window. The census filter id has NO hardcoded default (no-fallback-throw): a
// census pull against the wrong filter would silently mis-populate the openCount DENOMINATOR, so a
// missing env var must fail the run loudly rather than fall back to the explorer's payment filter.
// Env (set in Vercel, never hardcoded/logged): CMD_BXR_CENSUS_FILTER_ID, CMD_INDIGO_CENSUS_FILTER_ID.
// ---------------------------------------------------------------------------

/** The census saved-filter id — REQUIRED from env, no default (see the block comment above). */
function requiredCensusFilterId(envVar: 'CMD_BXR_CENSUS_FILTER_ID' | 'CMD_INDIGO_CENSUS_FILTER_ID'): string {
  const v = process.env[envVar]?.trim();
  if (!v) throw new Error(`Missing ${envVar} (the CMD census saved-filter id; set in env, no default)`);
  return v;
}

/** BXR census config: the explorer's report/poll/creds with the CENSUS filter (env, no fallback). */
function cmdBxrCensusConfigFor(customerId: string): CmdApiConfig {
  return { ...cmdExplorerConfigFor(customerId), filterId: requiredCensusFilterId('CMD_BXR_CENSUS_FILTER_ID') };
}

/** Indigo census config: cmdIndigoConfigFor's report/poll with the CENSUS filter (env, no fallback).
 *  The "Customer Name" → "Facility Name" alias is applied by the cron wrapper (transformRows), not here. */
function cmdIndigoCensusConfigFor(customerId: string): CmdApiConfig {
  return { ...cmdIndigoConfigFor(customerId), filterId: requiredCensusFilterId('CMD_INDIGO_CENSUS_FILTER_ID') };
}

/** Optional freshness-window override for the census cron, in HOURS. Unset ⇒ the cron's 24h default;
 *  "0" forces a full re-pull (nothing counts fresh — a manual catch-up). Bad/negative values ignored. */
function censusStalenessMs(): number | undefined {
  const raw = process.env.CMD_CENSUS_STALENESS_HOURS?.trim();
  if (!raw) return undefined;
  const h = Number(raw);
  return Number.isFinite(h) && h >= 0 ? h * 3_600_000 : undefined;
}

/** Raw DB shape — pg returns int8 (id) as a string; toExplorerRow narrows it to number. */
interface CmdExplorerDbRecord extends Omit<CmdExplorerRow, 'id'> {
  id: string;
}

function toExplorerRow(r: CmdExplorerDbRecord): CmdExplorerRow {
  return { ...r, id: Number(r.id) };
}

async function loadCmdExplorerPage(
  cursor: CmdExplorerCursor | null,
  filter: CmdExplorerFilter,
  sort: CmdExplorerSort,
  entityIds: string[],
): Promise<CmdExplorerPage> {
  // Keyset on (sort column, id): ORDER BY <sortcol> <dir> NULLS LAST, id <dir>. Default is
  // Payment Received DESC (most-recent payments first). The cursor continues strictly after the
  // previous page's last row; over-fetch one row to detect a next page without a count(*).
  const limit = CMD_EXPLORER_PAGE_SIZE + 1;
  const { sql, params } = buildCmdExplorerQuery(cursor, filter, sort, limit, entityIds);
  const { rows } = await readerExecutor().query<CmdExplorerDbRecord>(sql, params);
  const hasMore = rows.length > CMD_EXPLORER_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, CMD_EXPLORER_PAGE_SIZE) : rows).map(toExplorerRow);
  const last = page[page.length - 1];
  const nextCursor: CmdExplorerCursor | null =
    hasMore && last ? { id: last.id, value: cmdExplorerSortValue(last, sort.column) } : null;
  return { rows: page, nextCursor };
}

/**
 * NON-PHI explorer page, cached 15 min PER (cursor, filter, sort, entityIds) key (no PHI at
 * rest). The cron busts the shared 'cmd-explorer' tag after any insert. The cursor is a small
 * {id, value} object, the filter a small plain object, the sort a {column, direction} pair, and
 * entityIds a small string[] — all JSON-serializable, so they key the unstable_cache entry
 * cleanly. entityIds is part of the key so each tenant scope caches SEPARATELY (a BXR page is
 * never served to an Indigo request and vice versa).
 */
export const loadCmdExplorerNonPhi = unstable_cache(
  (
    cursor: CmdExplorerCursor | null,
    filter: CmdExplorerFilter,
    sort: CmdExplorerSort,
    entityIds: string[],
  ): Promise<CmdExplorerPage> => loadCmdExplorerPage(cursor, filter, sort, entityIds),
  ['cmd-explorer-nonphi'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

// --- Billing Audit reader (Phase-4 work table) ------------------------------
// NON-PHI keyset page over claims.audit_row (charge-line grain), tenant + scope pinned in
// SQL. The encrypted PHI columns are NEVER selected — the grid masks the patient; the drill
// reveals identifiers through the separate gated + audited path. Cached per (cursor, filter,
// sort, scope, entityIds); the ingest cron busts the shared 'billing-audit' tag after a write.

interface AuditGridDbRecord extends Omit<AuditGridRow, 'id'> {
  id: string; // pg returns int8 (id) as a string; toAuditGridRow narrows it to number
}
function toAuditGridRow(r: AuditGridDbRecord): AuditGridRow {
  return { ...r, id: Number(r.id) };
}

async function loadAuditRowsPage(
  cursor: AuditCursor | null,
  filter: AuditFilter,
  sort: AuditSort,
  scope: AuditScope,
  entityIds: string[],
): Promise<AuditPage> {
  // Keyset on (sort column, id); default charge_from_date DESC (most-recent DOS first). Over-fetch
  // one row to detect a next page without a count(*). Tenant + scope are mandatory WHERE predicates.
  const limit = AUDIT_PAGE_SIZE + 1;
  const { sql, params } = buildAuditRowsQuery(cursor, filter, sort, limit, scope, entityIds);
  const { rows } = await readerExecutor().query<AuditGridDbRecord>(sql, params);
  const hasMore = rows.length > AUDIT_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, AUDIT_PAGE_SIZE) : rows).map(toAuditGridRow);
  const last = page[page.length - 1];
  const nextCursor: AuditCursor | null =
    hasMore && last ? { id: last.id, value: auditSortValue(last, sort.column) } : null;
  return { rows: page, nextCursor };
}

/** NON-PHI audit page, cached 15 min per (cursor, filter, sort, scope, entityIds). entityIds +
 *  scope are part of the key so a BXR/IP page is never served to an Indigo/OP request. */
export const loadAuditRowsNonPhi = unstable_cache(
  (
    cursor: AuditCursor | null,
    filter: AuditFilter,
    sort: AuditSort,
    scope: AuditScope,
    entityIds: string[],
  ): Promise<AuditPage> => loadAuditRowsPage(cursor, filter, sort, scope, entityIds),
  ['billing-audit-rows-nonphi'],
  { revalidate: 900, tags: ['billing-audit'] },
);

/** Facility tag-picker options for the (scope, tenant) slice — code + friendly label + count. */
export const loadAuditFacilityOptions = unstable_cache(
  async (scope: AuditScope, entityIds: string[]): Promise<AuditFacilityOption[]> => {
    const { sql, params } = buildAuditFacilityOptionsQuery(scope, entityIds);
    const { rows } = await readerExecutor().query<AuditFacilityOption>(sql, params);
    return rows;
  },
  ['billing-audit-facility-options'],
  { revalidate: 900, tags: ['billing-audit'] },
);

/** Payer tag-picker options for the (scope, tenant) slice — payer_name + count, busiest first. */
export const loadAuditPayerOptions = unstable_cache(
  async (scope: AuditScope, entityIds: string[]): Promise<AuditPayerOption[]> => {
    const { sql, params } = buildAuditPayerOptionsQuery(scope, entityIds);
    const { rows } = await readerExecutor().query<AuditPayerOption>(sql, params);
    return rows;
  },
  ['billing-audit-payer-options'],
  { revalidate: 900, tags: ['billing-audit'] },
);

export interface AuditPivot {
  by_office: AuditOfficePivot[];
  by_payer_cpt: AuditPayerCptPivot[];
  by_rev: AuditRevPivot[];
}

/** Pivot-strip aggregates for the current (scope, tenant, filter) slice — the three click-to-filter
 *  breakdowns fan out CONCURRENTLY over the same WHERE, so wall-clock stays ~one scan. Non-PHI. */
export const loadAuditPivot = unstable_cache(
  async (filter: AuditFilter, scope: AuditScope, entityIds: string[]): Promise<AuditPivot> => {
    const { byOffice, byPayerCpt, byRev } = buildAuditPivotQueries(filter, scope, entityIds);
    const exec = readerExecutor();
    const [office, payerCpt, rev] = await Promise.all([
      exec.query<AuditOfficePivot>(byOffice.sql, byOffice.params),
      exec.query<AuditPayerCptPivot>(byPayerCpt.sql, byPayerCpt.params),
      exec.query<AuditRevPivot>(byRev.sql, byRev.params),
    ]);
    return { by_office: office.rows, by_payer_cpt: payerCpt.rows, by_rev: rev.rows };
  },
  ['billing-audit-pivot'],
  { revalidate: 900, tags: ['billing-audit'] },
);

/** All charge lines for ONE patient (by cmd_patient_id) in a scope — the drill detail. NON-PHI
 *  (same masked projection as the grid), tenant + scope pinned. Cached per (scope, patient, tenant). */
export const loadAuditPatientDetail = unstable_cache(
  async (scope: AuditScope, cmdPatientId: string, entityIds: string[]): Promise<AuditGridRow[]> => {
    const { sql, params } = buildAuditPatientDetailQuery(cmdPatientId, scope, entityIds);
    const { rows } = await readerExecutor().query<AuditGridDbRecord>(sql, params);
    return rows.map(toAuditGridRow);
  },
  ['billing-audit-patient-detail'],
  { revalidate: 900, tags: ['billing-audit'] },
);

export interface AuditRevealedPatient {
  patient_name: string;
  patient_dob: string | null;
  member_id: string | null;
}

/**
 * Reveal ONE patient's encrypted identifiers (name / DOB / member id) for the drill, decrypted
 * in-process as claims_reader, scoped to the caller's entitled entityIds so a reveal can never
 * unmask another tenant's patient. Writes ONE fail-closed audit row (action reveal_audit_row,
 * id-only detail — the cmd_patient_id business key + scope, NEVER the decrypted values) BEFORE
 * returning. A decryption failure throws (surfaced by the action, never silently swallowed).
 */
export async function revealAuditPatient(
  scope: AuditScope,
  cmdPatientId: string,
  actor: { email: string; userId: string },
  entityIds: string[],
): Promise<AuditRevealedPatient | null> {
  const { rows } = await readerExecutor().query<{
    patient_name_enc: Buffer;
    patient_dob_enc: Buffer | null;
    member_id_enc: Buffer | null;
  }>(
    'select patient_name_enc, patient_dob_enc, member_id_enc from claims.audit_row ' +
      'where business_entity_id = any($1::uuid[]) and audit_scope = $2 and cmd_patient_id = $3 limit 1',
    [entityIds, scope, cmdPatientId],
  );
  const row = rows[0];
  if (!row) return null;
  const [patient_name, patient_dob, member_id] = await Promise.all([
    decryptPhi(row.patient_name_enc),
    row.patient_dob_enc ? decryptPhi(row.patient_dob_enc) : Promise.resolve(null),
    row.member_id_enc ? decryptPhi(row.member_id_enc) : Promise.resolve(null),
  ]);
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'reveal_audit_row',
    detail: { cmd_patient_id: cmdPatientId, scope }, // id-only — never the decrypted values
  });
  return { patient_name, patient_dob, member_id };
}

export interface AuditRevealedRow {
  id: number;
  patient_name: string;
  member_id: string | null;
}

/**
 * Bulk reveal for the work-table "Reveal all" toggle (page-level, mirrors the collections
 * revealCmdExplorerRows): decrypt patient_name (+ member_id) for a page's audit_row ids in-process
 * as claims_reader, write ONE fail-closed audit row for the batch, then return the identifiers. Ids
 * outside the caller's entitled entityIds are silently dropped (a batch can never unmask another
 * tenant's patients). A decryption failure THROWS (surfaced by the action, never swallowed).
 */
export async function revealAuditRows(
  ids: number[],
  actor: { email: string; userId: string },
  entityIds: string[],
): Promise<AuditRevealedRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await readerExecutor().query<{ id: string; patient_name_enc: Buffer; member_id_enc: Buffer | null }>(
    'select id, patient_name_enc, member_id_enc from claims.audit_row ' +
      'where id = any($1::bigint[]) and business_entity_id = any($2::uuid[])',
    [ids, entityIds],
  );
  const out: AuditRevealedRow[] = [];
  for (const row of rows) {
    const [patient_name, member_id] = await Promise.all([
      decryptPhi(row.patient_name_enc),
      row.member_id_enc ? decryptPhi(row.member_id_enc) : Promise.resolve(null),
    ]);
    out.push({ id: Number(row.id), patient_name, member_id });
  }
  // ONE bulk audit BEFORE returning PHI (fail-closed) — non-PHI synthetic ids + count only.
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'reveal_audit_rows',
    detail: { count: out.length, ids: out.map((o) => o.id) },
  });
  return out;
}

// --- Smart search summary ---------------------------------------------------
// The "search engine" result: instead of paging through noisy rows, the search first returns
// an AGGREGATE summary of everything matching (count + money totals) plus the top facilities /
// payers / CPT codes, each of which the UI turns into a clickable drill-down chip (an exact
// refinement that then loads the detail grid). All non-PHI; same tenant scope + filters as the
// grid, so the summary and the rows it drills into always agree.

async function loadCmdSearchSummaryData(
  filter: CmdExplorerFilter,
  entityIds: string[],
): Promise<CmdSearchSummary> {
  const { totals, groups, combo } = buildCmdSearchSummaryQueries(filter, entityIds);
  const exec = readerExecutor();
  // All five aggregates fan out CONCURRENTLY over the same tenant-scoped WHERE — the (CPT, Rev)
  // combo query joins the existing Promise.all, so wall-clock stays ~one scan (they run in
  // parallel), not the sum. Each is the same cost class (parallel seq scan → hashaggregate over
  // the tenant slice); the combo groups by two keys but is otherwise identical.
  const [t, byFacility, byPayer, byCpt, byCombo] = await Promise.all([
    exec.query<{
      total_count: number;
      total_charge: number;
      total_allowed: number;
      total_paid: number;
      total_balance: number;
    }>(totals.sql, totals.params),
    exec.query<CmdSearchGroup>(groups.facility.sql, groups.facility.params),
    exec.query<CmdSearchGroup>(groups.primary_payer.sql, groups.primary_payer.params),
    exec.query<CmdSearchGroup>(groups.cpt_code.sql, groups.cpt_code.params),
    exec.query<CmdComboGroup>(combo.sql, combo.params),
  ]);
  const row = t.rows[0];
  const total_charge = row?.total_charge ?? 0;
  const total_allowed = row?.total_allowed ?? 0;
  const total_paid = row?.total_paid ?? 0;
  return {
    total_count: row?.total_count ?? 0,
    total_charge,
    total_allowed,
    total_paid,
    total_balance: row?.total_balance ?? 0,
    // SELECTION-MODE green cards — derived from the SAME totals via the shared helper (no new query),
    // so %Collected == total_paid/total_charge reconciles with the Insurance Paid ÷ Charged tiles.
    yield_pct: deriveYield({ billed: total_charge, allowed: total_allowed, paid: total_paid }),
    by_facility: byFacility.rows,
    by_payer: byPayer.rows,
    by_cpt: byCpt.rows,
    by_combo: byCombo.rows,
  };
}

/**
 * Cached search summary, keyed PER (filter, entityIds) like the grid page — no PHI at rest,
 * tag-busted by the cron after any insert. Each tenant scope caches separately.
 */
export const loadCmdSearchSummary = unstable_cache(
  (filter: CmdExplorerFilter, entityIds: string[]): Promise<CmdSearchSummary> =>
    loadCmdSearchSummaryData(filter, entityIds),
  // -v3: widened the payload with total_allowed + server-derived yield_pct (selection-mode green
  //      cards) — bump so a cached v2 summary (no allowed / no yield) can't reach the new UI.
  // -v2: summary moved to the 0050 charge-grain rollup (counts/sums are logical charges) — the key
  // bump keeps a pre-deploy snapshot-grain summary (up to 15 min old) from reaching the new UI copy.
  ['cmd-explorer-search-summary-v3'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

// --- Collections AI analysis (server-only Anthropic stream) -----------------
// The green-card panel's "Generate AI Analysis" action. Streams a short TL;DR / Signals / Risks
// read of the ALREADY-computed non-PHI aggregate (cohort OR selection). Server-only: the API key
// never leaves this process, and the input is validated by the aiAnalysis PHI firewall before it
// reaches this layer (the action calls CollectionsAiInputSchema.parse). No tools → no
// tool_choice/thinking conflict. NOT cached — every run is a fresh, user-initiated analysis.

export type CollectionsAiStreamResult =
  | { ok: false; reason: 'insufficient' | 'error' }
  | { ok: true; stream: ReadableStream<string> };

/**
 * Stream one collections AI analysis. Enforces the data-sufficiency gate server-side (defense in
 * depth — the UI also gates the button), then streams Anthropic text deltas back through a
 * ReadableStream the Server Action forwards to the client. Token counts + model + tenant land in a
 * PHI-free cost-governance log line on finish (mirrors the agent's emitAgentAudit); a durable audit
 * row names the invoker. Any model/transport failure closes the stream with a GENERIC error — the
 * real cause is logged server-side only, never surfaced to the client.
 */
export async function streamCollectionsAiAnalysis(
  input: CollectionsAiInput,
  actor: { email: string; userId: string },
  businessEntityIds: string[],
): Promise<CollectionsAiStreamResult> {
  if (!isSufficientForAi(input)) return { ok: false, reason: 'insufficient' };

  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  let sdk: Anthropic;
  try {
    sdk = new Anthropic(); // reads ANTHROPIC_API_KEY from env; never logged
  } catch (err) {
    console.error('collections_ai_analysis: client init failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: 'error' };
  }
  const { system, user } = buildAiMessages(input);

  // Durable audit of the invocation (best-effort: a transient audit failure must not kill a non-PHI,
  // already-on-screen aggregate analysis). Detail is non-PHI: mode + entity scope + model only.
  try {
    await recordAccess({
      actorEmail: actor.email,
      actorUserId: actor.userId,
      action: 'collections_ai_analysis',
      detail: { mode: input.mode, entity_ids: businessEntityIds, model },
    });
  } catch (err) {
    console.error('collections_ai_analysis: audit write failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        const ms = sdk.messages.stream({
          model,
          max_tokens: AI_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        });
        for await (const event of ms) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(event.delta.text);
          }
        }
        const final = await ms.finalMessage();
        // PHI-free cost-governance line (mirrors emitAgentAudit): mode + tenant + model + tokens.
        console.log(
          JSON.stringify({
            kind: 'collections_ai_analysis',
            mode: input.mode,
            business_entity_ids: businessEntityIds,
            model,
            input_tokens: final.usage?.input_tokens,
            output_tokens: final.usage?.output_tokens,
          }),
        );
        controller.close();
      } catch (err) {
        console.error('collections_ai_analysis: stream failed:', err instanceof Error ? err.message : String(err));
        controller.error(new Error('ai_analysis_failed')); // generic to the client
      }
    },
  });
  return { ok: true, stream };
}

// --- alpha-prefix cohort payer-behavior curve (Session D) -------------------
// Reads BOTH cohort rollups (claim/visit position + days-since-first) for one alpha-prefix
// blind-index token. Suppression is enforced IN the query (HAVING >= floor); the extra
// `.filter(patients >= COHORT_MIN_PATIENTS)` below is DEFENSE-IN-DEPTH — redundant with the query,
// so a future query edit can never let a sub-threshold bucket reach the client. cohort_patients is
// the position-1 bucket's distinct-patient count (every patient has a 1st visit) — 0 when the whole
// cohort was suppressed (both arrays then empty → the panel shows "not enough data", never a leak).

async function loadCohortCurveData(prefixBidx: string, entityIds: string[]): Promise<CohortCurve> {
  const { byPosition, byDays } = buildCohortCurveQueries(prefixBidx, entityIds);
  const totalsQ = buildCohortTotalsQuery(prefixBidx, entityIds);
  const exec = readerExecutor();
  const [pos, days, tot] = await Promise.all([
    exec.query<CohortCurvePoint>(byPosition.sql, byPosition.params),
    exec.query<CohortCurvePoint>(byDays.sql, byDays.params),
    exec.query<CohortTotalsRow>(totalsQ.sql, totalsQ.params),
  ]);
  const safe = (rows: CohortCurvePoint[]) => rows.filter((r) => r.patients >= COHORT_MIN_PATIENTS);
  const by_position = safe(pos.rows);
  const cohort_patients = by_position[0]?.patients ?? 0;
  // Whole-cohort end-to-end yield: TRUE unbounded totals (no position cap / suppression), gated by the
  // SAME min-patient floor as the curve so a sub-threshold prefix can't render a false-precision stat.
  // A guarded ratio is null when its denominator is <= 0 (never a divide-by-zero or a negative).
  const t = tot.rows[0];
  // Same derivation the SELECTION-MODE cards use (shared deriveYield) — one formula, one rounding,
  // one guard, so cohort and selection percentages can never drift. Output is byte-identical to the
  // inline ratio this replaced.
  const totals: CohortTotals | null =
    cohort_patients >= COHORT_MIN_PATIENTS && t
      ? deriveYield({ billed: t.billed, allowed: t.allowed, paid: t.paid })
      : null;
  return { by_position, by_days: safe(days.rows), cohort_patients, totals };
}

/**
 * Cached cohort curve, keyed per (prefix token, entityIds). The token is an opaque keyed-HMAC (no
 * raw PHI at rest); the output is a min-5-suppressed aggregate. Tag-busted with the rest of the
 * explorer on cron insert. NOTE: the PHI GATE + AUDIT live in the action (loadCohortCurve), which
 * runs on EVERY call before this cache is consulted — so a cache hit never skips the audit.
 */
export const loadCohortCurve = unstable_cache(
  (prefixBidx: string, entityIds: string[]): Promise<CohortCurve> => loadCohortCurveData(prefixBidx, entityIds),
  // -v4: added whole-cohort `totals` (end-to-end yield) to the payload — bump so a cached v3 curve
  //      (no totals) can't reach the new stat cards.
  // -v3: cohort queries moved to the 0050 charge-grain rollup (netted dollars, charge-line counts);
  // the key bump keeps a pre-deploy snapshot-grain curve (up to 15 min old) from reaching the new UI.
  // (-v2 was the Phase 2 paid_total/pct_zero_paid/pct_patient_shifted shape change.)
  ['cmd-explorer-cohort-curve-v4'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

// --- cohort-point drilldown (Session G) -------------------------------------
// Behind ONE clicked cohort-curve point: an aggregate breakdown (payer mix, CPT×Rev mix) for that
// EXACT bucket, re-deriving `patients` server-side (never trusting the caller's bucket alone) as
// the authoritative gate — mirrors the curve's OWN COHORT_MIN_PATIENTS floor exactly (a bucket that
// never rendered on the curve can't be drilled into), plus an OPTIONAL patient table gated by the
// separate, stricter COHORT_DRILLDOWN_TABLE_MIN_PATIENTS. Returns null when the bucket doesn't clear
// the aggregate floor (a forged/stale bucket argument) — the action then reports a generic error,
// never a partial or wrong-shaped answer.

async function loadCohortDrilldownData(
  prefixBidx: string,
  entityIds: string[],
  axis: 'position' | 'days',
  bucket: number,
): Promise<CohortDrilldownResult | null> {
  const { stats, byPayer, byCptRevenue, rows } = buildCohortDrilldownQueries(prefixBidx, entityIds, axis, bucket);
  const exec = readerExecutor();
  const statsRes = await exec.query<{
    patients: number;
    claims: number;
    pct_allowed: number | null;
    pct_paid: number | null;
    paid_total: number;
    pct_zero_paid: number;
    pct_patient_shifted: number;
  }>(stats.sql, stats.params);
  const s = statsRes.rows[0];
  // Fail closed: no rows at all, or below the SAME floor the curve itself enforces.
  if (!s || !clearsCohortFloor(s.patients)) return null;

  const [payerRes, cptRes] = await Promise.all([
    exec.query<CmdSearchGroup>(byPayer.sql, byPayer.params),
    exec.query<CmdComboGroup>(byCptRevenue.sql, byCptRevenue.params),
  ]);

  const aggregate: CohortDrilldownAggregate = {
    bucket,
    patients: s.patients,
    claims: s.claims,
    pct_allowed: s.pct_allowed,
    pct_paid: s.pct_paid,
    paid_total: s.paid_total,
    pct_zero_paid: s.pct_zero_paid,
    pct_patient_shifted: s.pct_patient_shifted,
    by_payer: payerRes.rows,
    by_cpt_revenue: cptRes.rows,
  };

  // The patient table is a SEPARATE, stricter gate — row-level disclosure (even PHI-masked) carries
  // more re-identification risk than an aggregate ratio. Only fetch rows once THIS bucket clears it;
  // otherwise the client never even receives a row id to reveal.
  if (!clearsDrilldownTableFloor(s.patients)) {
    return { aggregate, table: { kind: 'suppressed', floor: COHORT_DRILLDOWN_TABLE_MIN_PATIENTS } };
  }
  const rowsRes = await exec.query<CmdExplorerRow>(rows.sql, rows.params);
  return { aggregate, table: { kind: 'rows', rows: rowsRes.rows } };
}

/**
 * Cached drilldown, keyed per (prefix token, axis, bucket, entityIds). Tag-busted with the rest of
 * the explorer on cron insert. NOTE: the PHI GATE + AUDIT live in the action (loadCohortDrilldown in
 * actions.ts), which runs on EVERY call before this cache is consulted — a cache hit never skips it.
 */
export const loadCohortDrilldown = unstable_cache(
  (
    prefixBidx: string,
    entityIds: string[],
    axis: 'position' | 'days',
    bucket: number,
  ): Promise<CohortDrilldownResult | null> => loadCohortDrilldownData(prefixBidx, entityIds, axis, bucket),
  // -v2: drilldown aggregates moved to the 0050 charge-grain rollup (same bump rationale as the curve).
  ['cmd-explorer-cohort-drilldown-v2'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

/**
 * Facility options for the explorer's multi-select filter (non-PHI). The DISTINCT facility list is
 * the CMD report's own facility text, scoped to the caller's entitled `entityIds` (bound param, part
 * of the cache key) — the exact values the grid/summary filter on. Each is LEFT JOINed to the
 * canonical dimension purely to enrich a friendly name + care_setting (IP/OP/BOTH) for the dropdown's
 * "select all IP/OP" groups; an unmatched facility carries care_setting=null ("Unclassified/Other")
 * and is still individually selectable. Reader-only, no SELECT *; cached + tag-busted like the grid.
 * See buildCmdFacilityOptionsQuery for the tenant-isolation rationale of the join.
 */
export const cmdExplorerFacilities = unstable_cache(
  async (entityIds: string[]): Promise<CmdFacilityOption[]> => {
    const { sql, params } = buildCmdFacilityOptionsQuery(entityIds);
    const { rows } = await readerExecutor().query<{
      facility: string;
      facility_name: string | null;
      care_setting: string | null;
    }>(sql, params);
    return rows.map((r) => ({
      facility: r.facility,
      facility_name: r.facility_name,
      care_setting:
        r.care_setting === 'IP' || r.care_setting === 'OP' || r.care_setting === 'BOTH'
          ? r.care_setting
          : null,
    }));
  },
  ['cmd-explorer-facilities'],
  // The facility vocabulary is near-static — a new facility STRING appears only the first time
  // ingestion sees one (rare), NOT on the daily payment refresh. Deliberately OFF the 'cmd-explorer'
  // tag the 30-min ingest cron busts: sharing it rebuilt this ~627k-row DISTINCT scan (~2.1s) on
  // every pass, so any visitor right after a cron run ate the full cost. A dedicated tag + a longer
  // timer means the dropdown is a warm cache hit ~always; a brand-new facility surfaces within the
  // hour (its rows are already in the grid regardless — this only gates the filter dropdown's list).
  { revalidate: 3600, tags: ['cmd-facilities'] },
);

/**
 * Payer options for the guided payer search (non-PHI): the distinct payer names present in the
 * caller's tenant slice (RBAC-clamped `entityIds`, part of the cache key). Like the facility
 * vocabulary, the payer set is near-static — a new payer name is rare and NOT a daily-refresh
 * event — so this rides its own 'cmd-payers' tag + 1-hour timer (NOT the 'cmd-explorer' tag the
 * 30-min cron busts), keeping the ~627k-row DISTINCT scan a warm hit rather than rebuilding it
 * every ingest. The client loads this once and filters it as the user types. Reader-only, non-PHI.
 */
export const cmdExplorerPayers = unstable_cache(
  async (entityIds: string[]): Promise<string[]> => {
    const { sql, params } = buildCmdPayerOptionsQuery(entityIds);
    const { rows } = await readerExecutor().query<{ primary_payer: string }>(sql, params);
    return rows.map((r) => r.primary_payer);
  },
  ['cmd-explorer-payers'],
  { revalidate: 3600, tags: ['cmd-payers'] },
);

/**
 * Employer options for the guided EMPLOYER type-ahead (non-PHI). UNLIKE facility/payer (~260 each,
 * loaded whole and filtered client-side), there are ~11.6k distinct employers, so this is a
 * SERVER-SIDE, per-keystroke search: the action passes the typed `term` (gated to >= min length) and
 * a `limit`. Scoped to employers that actually appear for the caller's own members via the
 * VOB↔collections member_id_bidx link (part of the cache key through entityIds), so a picked option
 * always has rows. Employer is a plan-level dimension stored plaintext (like payer/facility) — NOT
 * PHI. Rides its own 'cmd-employers' tag (the VOB set changes only on the VOB sync, not the payment
 * cron), each (entityIds, term, limit) a separate warm entry. Reader-only.
 */
export const cmdExplorerEmployers = unstable_cache(
  async (entityIds: string[], term: string, limit: number): Promise<CmdEmployerOption[]> => {
    const { sql, params } = buildCmdEmployerOptionsQuery(entityIds, term, limit);
    const { rows } = await readerExecutor().query<CmdEmployerOption>(sql, params);
    return rows;
  },
  ['cmd-explorer-employers'],
  { revalidate: 3600, tags: ['cmd-employers'] },
);

/**
 * Resolve ONE row's PHI by bigserial id: decrypt the 3 ciphertext columns in-process,
 * write a synchronous (fail-closed) audit record, then return the identifiers. The PHI
 * is never cached and never logged; absent id → null. Runs as claims_reader.
 *
 * `entityIds` is the caller's entitled tenant scope (server-derived from the session; see
 * requirePhiPrincipal). A row outside that scope resolves to null — so an entity user can
 * never unmask another tenant's patient identifiers even with a hand-crafted id.
 */
export async function revealCmdExplorerRow(
  id: number,
  actor: { email: string; userId: string },
  entityIds: string[],
  // Audit action label; defaults to the collections surface. The Qualify reveal passes
  // 'reveal_qualify_row' so the audit trail distinguishes the two surfaces (same audited-decrypt path).
  action = 'reveal_cmd_explorer_row',
): Promise<CmdExplorerPhi | null> {
  const { rows } = await readerExecutor().query<{
    patient_name: Buffer;
    member_id: Buffer;
    group_number: Buffer | null;
  }>(
    'select patient_name, member_id, group_number from collections.cmd_explorer_rows ' +
      'where id = $1 and business_entity_id = any($2::uuid[])',
    [id, entityIds],
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
    action,
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
 * synthetic ids are audited. Runs as claims_reader. Ids outside the caller's entitled
 * `entityIds` (server-derived; see requirePhiPrincipal) are silently dropped, so a batch can
 * never unmask another tenant's identifiers. A decryption failure (e.g. a LIBSODIUM_KEY that
 * does not match the key the rows were ingested with) THROWS here and is surfaced to the user
 * by the action — never silently swallowed.
 */
export async function revealCmdExplorerRows(
  ids: number[],
  actor: { email: string; userId: string },
  entityIds: string[],
  // Audit action label; Qualify passes 'reveal_qualify_rows' (default is the collections surface).
  action = 'reveal_cmd_explorer_rows',
): Promise<CmdExplorerRevealedRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await readerExecutor().query<{
    id: string;
    patient_name: Buffer;
    member_id: Buffer;
    group_number: Buffer | null;
  }>(
    'select id, patient_name, member_id, group_number from collections.cmd_explorer_rows ' +
      'where id = any($1::bigint[]) and business_entity_id = any($2::uuid[])',
    [ids, entityIds],
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
    action,
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

// ---------------------------------------------------------------------------
// Qualify read layer (data loaders). Execute the pure builders in src/collections/qualifyQuery on the
// least-privilege claims_reader pool. The CROSS-TENANT [BXR, Indigo] scope is supplied by the caller
// (requireQualifyPrincipal), never derived here; the builders re-assert it via assertEntityScope.
// These return RAW rows — the action layer (app/lib/qualify/actions.ts) computes rating/rank, attaches
// city/state, shapes the contract, and strips dollars for admissions_seat. Not cached in v1
// (per-search, low volume); the search audit + gate live in the action and run on every call.
// ---------------------------------------------------------------------------

/** Dominant payer for a member/prefix blind-index token (UNWINDOWED identity). null = never-seen id. */
export async function resolveQualifyPayer(
  token: string,
  kind: QualifyTokenKind,
  entityIds: string[],
): Promise<string | null> {
  const q = buildResolvePayerQuery(token, kind, entityIds);
  const { rows } = await readerExecutor().query<QualifyResolvePayerRow>(q.sql, q.params);
  return rows[0]?.primary_payer ?? null;
}

/** Per-facility dollar-weighted ranking rows for a resolved payer, in-window, cross-tenant. */
export async function loadQualifyFacilities(
  payer: string,
  from: string,
  to: string,
  entityIds: string[],
  market: VobMarketFilter = {},
  token: string | null = null,
  kind: QualifyTokenKind | null = null,
): Promise<QualifyFacilityRow[]> {
  const q = buildFacilityRankingQuery(payer, from, to, entityIds, market, token, kind);
  const { rows } = await readerExecutor().query<QualifyFacilityRow>(q.sql, q.params);
  return rows;
}

/** Fix A: the raw facility text of the searched identifier's most-recent in-window claim under the resolved
 *  payer, or null when the identifier has no in-window claim (the core then also drops it if it isn't a
 *  ranked facility). Reader-scoped, cross-tenant. The token is opaque (minted upstream); never logged. */
export async function loadQualifyIdentifierLandingFacility(
  token: string,
  kind: QualifyTokenKind,
  payer: string,
  from: string,
  to: string,
  entityIds: string[],
): Promise<string | null> {
  const q = buildIdentifierLandingFacilityQuery(token, kind, payer, from, to, entityIds);
  const { rows } = await readerExecutor().query<{ facility: string }>(q.sql, q.params);
  return rows[0]?.facility ?? null;
}

/** One page of recent CLAIMS (claim grain) for a resolved payer AT ONE FACILITY, in-window (masked; reveal
 *  via id). `opts` carries the optional identifier blind-index tokens (prefix or exact member), the forward
 *  keyset cursor, and the page size; the builder over-fetches by one (limit+1) so the core computes hasMore
 *  without a count. */
export async function loadQualifyFacilityCases(
  filter: CmdExplorerFilter,
  entityIds: string[],
  opts: { nameToken?: string | null; allPayers?: boolean; limit?: number },
): Promise<QualifyClaimRow[]> {
  const q = buildFacilityCasesQuery(filter, entityIds, opts);
  const { rows } = await readerExecutor().query<QualifyClaimRow>(q.sql, q.params);
  // bigint `id` (the rollup charge id) comes back as a string from pg → coerce.
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Compose-bar live match count: the `totals` row of Collections' shared summary builder over the SAME
 *  cmdExplorerBaseConds predicate Qualify's cases query uses (so count + list agree). Cross-tenant via the
 *  entityIds array. One row (or null on empty). Dollars ride raw; the CORE strips them for non-amounts. */
export async function loadQualifyMatchSummary(
  filter: CmdExplorerFilter,
  entityIds: string[],
): Promise<QualifyMatchSummaryRow | null> {
  const { totals } = buildCmdSearchSummaryQueries(filter, entityIds);
  const { rows } = await readerExecutor().query<QualifyMatchSummaryRow>(totals.sql, totals.params);
  return rows[0] ?? null;
}

/** Top PAYER movers by distinct-patient delta across two adjacent windows, cross-tenant. */
export async function loadQualifyMovers(
  thisFrom: string,
  thisTo: string,
  priorFrom: string,
  priorTo: string,
  entityIds: string[],
  market: VobMarketFilter = {},
): Promise<QualifyMoverRow[]> {
  const q = buildMoversQuery(thisFrom, thisTo, priorFrom, priorTo, entityIds, { market });
  const { rows } = await readerExecutor().query<QualifyMoverRow>(q.sql, q.params);
  return rows;
}

/** Phase 2 overview: KPI percentages + distinct-patient count for the composed orientation slice
 *  (payer + facility + window; NO employer/funding — Design B), cross-tenant. Dollars are summed +
 *  dropped in SQL — only the three ratios + the count come back. One row (or null on an empty slice). */
export async function loadQualifyBookKpis(
  scope: QualifyOrientationScope,
  entityIds: string[],
): Promise<QualifyBookKpisRow | null> {
  const q = buildBookKpisQuery(scope, entityIds);
  const { rows } = await readerExecutor().query<QualifyBookKpisRow>(q.sql, q.params);
  return rows[0] ?? null;
}

/** Redesign overview: per-facility rating trend rows (ratings only), cross-tenant. `payer` null =
 *  book-wide (the Heating-Up row); a payer = the resolved panel's per-facility sparklines. */
export async function loadQualifyFacilityTrends(
  from: string,
  to: string,
  priorFrom: string,
  entityIds: string[],
  opts: { payer?: string | null; market?: VobMarketFilter } = {},
): Promise<QualifyFacilityTrendRow[]> {
  const q = buildFacilityTrendQuery(from, to, priorFrom, entityIds, {
    payer: opts.payer ?? null,
    market: opts.market ?? {},
  });
  const { rows } = await readerExecutor().query<QualifyFacilityTrendRow>(q.sql, q.params);
  return rows;
}

/** Phase 3 (qualify cohort sheet): ONE claim's alpha-prefix cohort token, TENANT-SCOPED — a foreign
 *  or unknown rollup id returns null (the core fails closed to the suppressed shape). Fixed-literal
 *  columns, bound values; the token goes to the CORE only, never the client. */
export async function loadQualifyClaimPrefixToken(claimId: number, entityIds: string[]): Promise<string | null> {
  const { rows } = await readerExecutor().query<{ member_id_prefix_bidx: string | null }>(
    'select member_id_prefix_bidx from collections.cmd_explorer_charge_rollup ' +
      'where id = $1 and business_entity_id = any($2::uuid[]) limit 1',
    [claimId, entityIds],
  );
  return rows[0]?.member_id_prefix_bidx ?? null;
}

/**
 * Phase 3 (qualify cohort sheet): the LIFETIME prefix-cohort context — patients gate + end-to-end
 * dollar sums + payer/CPT mixes — REUSING the collections cohort machinery wholesale:
 *  - gate: buildCohortDrilldownQueries(…,'position',1).stats — the position-1 bucket's distinct
 *    patients IS the cohort's patient count (every patient has a first visit), re-derived
 *    server-side exactly like the collections drilldown (never trusted from the caller);
 *  - yield: buildCohortTotalsQuery (unbounded lifetime sums, the same source as the curve's cards);
 *  - mixes: buildCmdSearchSummaryQueries scoped by the prefix blind index (the hardened top-N
 *    group builders; charge dollars stripped in the CORE for non-amounts viewers).
 * Returns null when the cohort is below COHORT_MIN_PATIENTS — the SAME floor the cohort curve
 * enforces, so this sheet can never render a slice the curve itself would suppress.
 */
export async function loadQualifyPatientCohort(
  prefixBidx: string,
  entityIds: string[],
): Promise<QualifyPatientCohortRaw | null> {
  const exec = readerExecutor();
  const gateQ = buildCohortDrilldownQueries(prefixBidx, entityIds, 'position', 1).stats;
  const gateRes = await exec.query<{ patients: number }>(gateQ.sql, gateQ.params);
  const patients = gateRes.rows[0]?.patients ?? 0;
  if (patients < COHORT_MIN_PATIENTS) return null;

  const totalsQ = buildCohortTotalsQuery(prefixBidx, entityIds);
  const { groups } = buildCmdSearchSummaryQueries({ phiIndex: { memberIdPrefixBidx: prefixBidx } }, entityIds);
  const [tot, payer, cpt] = await Promise.all([
    exec.query<CohortTotalsRow>(totalsQ.sql, totalsQ.params),
    exec.query<CmdSearchGroup>(groups.primary_payer.sql, groups.primary_payer.params),
    exec.query<CmdSearchGroup>(groups.cpt_code.sql, groups.cpt_code.params),
  ]);
  const t = tot.rows[0];
  return {
    patients,
    billed: t?.billed ?? null,
    allowed: t?.allowed ?? null,
    paid: t?.paid ?? null,
    byPayer: payer.rows.map((g) => ({ label: g.label, count: g.count, charge: g.charge })),
    byCpt: cpt.rows.map((g) => ({ label: g.label, count: g.count, charge: g.charge })),
  };
}
