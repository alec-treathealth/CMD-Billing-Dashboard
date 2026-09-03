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
  buildQualifyFacilityOptionsQuery,
  buildCmdPayerOptionsQuery,
  buildCmdEmployerOptionsQuery,
  buildCmdCollectionsEmployerVocabularyQuery,
  buildCmdExplorerGroupedQuery,
  cmdExplorerGroupSortValue,
  groupedSortStamp,
  type GroupedSortColumn,
  buildCmdEmployerCoverageQuery,
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
  type QualifyFacilityOption,
  type CmdEmployerOption,
  type VobMarketFilter,
  type CohortCurvePoint,
  type CohortCurve,
  type CohortTotals,
  type CohortTotalsRow,
  type CohortDrilldownAggregate,
  type CohortDrilldownTable,
  type CohortDrilldownResult,
  type CmdExplorerGroupPage,
  type CmdExplorerGroupRow,
} from '../../src/collections/cmdExplorerQuery.js';
import {
  groupEmployerNames,
  type CanonicalEmployer,
} from '../../src/collections/employerCanonical.js';
export type { CanonicalEmployer };
export type { CmdExplorerGroupPage, CmdExplorerGroupRow };
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
  resolveGroupedSort,
  resolveGroupedCursor,
  groupedSortStamp,
  GROUPED_AGG_SORT_MAX_WINDOW_DAYS,
  buildCmdSearchSummaryQueries,
} from '../../src/collections/cmdExplorerQuery.js';
import {
  buildResolutionOverviewQuery,
  buildResolutionQueueQuery,
  buildMemberUnresolvedKeysQuery,
  buildResolutionFacilityOptionsQuery,
  parseResolutionSearch,
  resolveResolutionSort,
  resolveResolutionCursor,
  memberDisplayToken,
  RESOLUTION_PAGE_SIZE,
  RESOLUTION_METHODS,
  type ResolutionRow,
  type ResolutionOverviewRow,
  type ResolutionChargeKey,
  type ResolutionChip,
  type ResolutionSort,
  type ResolutionCursor,
} from '../../src/collections/facilityResolutionQuery.js';
export {
  parseResolutionSearch,
  resolveResolutionSort,
  resolveResolutionCursor,
  memberDisplayToken,
  RESOLUTION_PAGE_SIZE,
  RESOLUTION_METHODS,
};
export type {
  ResolutionRow,
  ResolutionOverviewRow,
  ResolutionChargeKey,
  ResolutionChip,
  ResolutionSort,
  ResolutionCursor,
};
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
  QualifyFacilityOption,
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
  buildResolvePayerSpreadQuery,
  buildFacilityRankingQuery,
  buildIdentifierLandingFacilityQuery,
  buildFacilityCasesQuery,
  buildMoversQuery,
  buildBookKpisQuery,
  buildFacilityTrendQuery,
  buildQualifyMatchClientCountQuery,
} from '../../src/collections/qualifyQuery.js';
import type { QualifyPatientCohortRaw } from './qualify/core';
import type {
  QualifyTokenKind,
  QualifyResolvePayerRow,
  QualifyPayerSpreadRow,
  QualifyFacilityRow,
  QualifyClaimRow,
  QualifyMoverRow,
  QualifyBookKpisRow,
  QualifyOrientationScope,
  QualifyFacilityTrendRow,
  QualifyMatchSummaryRow,
  QualifyMatchClientCountRow,
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
import { cmdPayerGapForMonth, cmdReportRows, collectRowsAcrossCustomers, type CmdApiConfig, type CmdReportRow } from '../../src/collections/cmdPayer.js';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../src/collections/cmdExplorer.js';
import { aliasIndigoFacilityColumn, BXR_REPORT_COLUMNS, bxrExpectedColumnsFor } from '../../src/collections/cmdExplorer.js';
import { decryptPhi, encryptPhi } from '../../src/collections/phiCrypto.js';
import {
  cmdEra835ConfigFor,
  expandDateRange,
  newEra835IngestStats,
  recordEra835IngestRun,
  runEra835Ingest,
  seedEra835TenantRoster,
  type Era835TenantCounts,
} from '../../src/ingest/era_ingest.js';
import { CmdEra835Error, cmdDownload835, read835Files } from '../../src/collections/cmd835.js';
import {
  businessTodayIso,
  eraUpcomingPayments,
  mergeEraUpcoming,
  type EraUpcomingSummary,
} from '../../src/veris/era835Upcoming.js';
import {
  mergeUpcomingOverrides,
  upcomingOverrides,
  upcomingOverrideSync,
  type UpcomingOverrideSummary,
} from '../../src/veris/upcomingOverride.js';
import type {
  ManualForecastRow,
  ManualForecastDbRow,
} from '../../src/veris/upcomingForecast.js';
import { manualRowFromDb } from '../../src/veris/upcomingForecast.js';
import { cmdPayerMonth, type CmdPayerMonthResult } from '../../src/collections/cmdPayerRollup.js';
import { refreshCmdPayerRollup } from '../../src/collections/cmdPayerRefresh.js';
import { CMD_EXPLORER_CUSTOMERS, INDIGO_CUSTOMERS, BXR_CUSTOMERS, OWNED_CMD_CUSTOMERS, type CmdCustomer } from '../../src/collections/cmdCustomers.js';
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
import { reconcileDeposits } from '../../src/collections/reconcileDeposits.js';
import {
  handleReconcileDepositsRequest,
  type ReconcileDepositsHttpRequest,
} from '../../src/routes/reconcileDepositsHandler.js';
import {
  handleCmdPayerRefreshRequest,
  type CmdPayerRefreshHttpRequest,
} from '../../src/routes/cmdPayerRefreshHandler.js';
import {
  handleRefreshChargeRollupRequest,
  type RefreshChargeRollupHttpRequest,
} from '../../src/routes/refreshChargeRollupHandler.js';
import { refreshChargeRollup } from '../../src/collections/refreshChargeRollup.js';
import {
  buildPatientDirectoryFreshnessQuery,
  buildPatientDirectoryReadQuery,
  syncPatientDirectory,
  type PatientDirectorySyncStats,
} from '../../src/collections/patientDirectory.js';
import {
  handlePipelineTickRequest,
  type PipelineTickHttpRequest,
} from '../../src/routes/pipelineTickHandler.js';
import { runPipelineTick, DEFAULT_TICK_BUDGET_MS } from '../../src/collections/pipelineTick.js';
import { withEtlRun, classifyCronResult } from '../../src/collections/etlRun.js';
import {
  handleQualifyRatingHistoryRequest,
  type QualifyRatingHistoryHttpRequest,
} from '../../src/routes/qualifyRatingHistoryHandler.js';
import { runQualifyRatingHistory } from '../../src/collections/qualifyRatingHistory.js';
import { computePairPolicyRating, type QualifyPairRatingContext } from './qualify/board';
import {
  loadCurrentCodingDecisions,
  loadQualifyCensusAuth,
  loadQualifyFacilityOutcomes,
} from './qualify/loaders';
import { cmdExplorerCron } from '../../src/collections/cmdExplorerCron.js';
import { cmdCensusCron } from '../../src/collections/cmdCensusCron.js';
import { cmdRunReportToZip, readZipEntries } from '../../src/collections/cmdPayer.js';
import { billingAuditCron, recordAuditIngestRun, type PerCustomerOutcome } from '../../src/billingAudit/auditIngest.js';
import {
  auditCustomersFor,
  auditReportIds,
  consolidatedAuditReportIds,
  consolidatedOpWriteEnabled,
  AUDIT_CONSOLIDATED_CUSTOMERS,
  EXPECTED_EMPTY_AUDIT_CUSTOMERS,
  type AuditScope,
} from '../../src/billingAudit/auditConfig.js';
import { consolidatedAuditCron } from '../../src/billingAudit/auditConsolidated.js';
import { withTenant } from '../../src/veris/withTenant.js';
import { isAuthorized } from '../../src/bearerAuth.js';
import { assertRequiredEnvVars } from './env-preflight';

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
/**
 * Deposit reconciliation cron (Vercel Cron, daily). Gated on CRON_SECRET. Pulls CMD's
 * "what reflects in the bank" report per BXR customer, aggregates it through the SAME
 * aggregateDailyDeposits the explorer cron uses, and diffs facility-day totals against
 * collections.daily_collections.
 *
 * READ-ONLY: the reader pool only — no writer is opened and nothing is persisted, so this cron
 * cannot damage the feed it is checking. Findings surface as a log line (see
 * RECONCILE_ALERT_PREFIX); persisting history would need a new table, i.e. a migration, which is
 * deliberately out of scope.
 */
export function handleReconcileDeposits(req: ReconcileDepositsHttpRequest) {
  return handleReconcileDepositsRequest(req, {
    secret: process.env.CRON_SECRET,
    reconcile: () =>
      reconcileDeposits({
        customers: BXR_CUSTOMERS.map((c) => ({ customerId: c.customerId, facilityCode: c.facilityCode })),
        fetchRows: (customerId) => cmdReportRows(cmdReconcileConfigFor(customerId)),
        readStoredGross: async (from, to) => {
          // Explicit column list, fixed table name, values bound as $n (CLAUDE.md). Tenant-scoped
          // to BXR because the reconcile report is BXR's; source_tag='cmd' so a legacy workbook
          // row can never be mistaken for what the live cron wrote.
          const { rows } = await readerExecutor().query<{
            facility_code: string;
            payment_date: string;
            gross: string;
          }>(
            'select facility_code, to_char(payment_date, \'YYYY-MM-DD\') as payment_date, ' +
              'sum(gross_amount)::text as gross ' +
              'from collections.daily_collections ' +
              'where business_entity_id = $1 and source_tag = $2 ' +
              'and payment_date >= $3::date and payment_date <= $4::date ' +
              'and facility_code is not null ' +
              'group by facility_code, payment_date',
            [BXR_TENANT_ID, 'cmd', from, to],
          );
          return rows.map((r) => ({
            facility_code: r.facility_code,
            payment_date: r.payment_date,
            gross: Number(r.gross),
          }));
        },
        materialUsd: Number(process.env.RECONCILE_MATERIAL_USD) || undefined,
        totalUsd: Number(process.env.RECONCILE_TOTAL_USD) || undefined,
      }),
  });
}

export function handleCmdPayerRefresh(req: CmdPayerRefreshHttpRequest) {
  return handleCmdPayerRefreshRequest(req, {
    secret: process.env.CRON_SECRET,
    refresh: () =>
      refreshCmdPayerRollup({
        // WHOLE BOOK, all-or-nothing. writeRollup DELETEs per (month × tenant) across every
        // facility, so a single-account pull here would delete a complete month and write back
        // one facility's slice. collectRowsAcrossCustomers throws if ANY account fails, which
        // leaves writeRollup unreached and the month untouched.
        fetchRows: () => {
          const cfg = cmdApiConfig();
          return collectRowsAcrossCustomers(bxrPayerCustomerIds(), (customerId) =>
            cmdReportRows({ ...cfg, customerId }),
          );
        },
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
export function handleRefreshChargeRollup(
  req: RefreshChargeRollupHttpRequest,
  opts?: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  // Wrapped OUTSIDE the request handler, unlike the four CMD stages: this handler does its own
  // 405/401 gating internally, so there is no seam between auth and work to slot the run row into.
  // classifyCronResult still keys off the HTTP status, so a 401 would be recorded as an error — the
  // one case where a rejected request produces a row. Acceptable here and not worth restructuring a
  // production-critical handler for: this route is reached only by Vercel Cron and the tick, both of
  // which carry the secret, so a 401 on it is a real misconfiguration worth seeing in the log.
  return withStageRun('refresh-charge-rollup', opts, () =>
    handleRefreshChargeRollupRequest(req, {
    secret: process.env.CRON_SECRET,
    refresh: async () => {
      const stats = await refreshChargeRollup({ db: rollupWriterDb(), triggeredBy: 'cron' });
      // 0086: the facility-resolution matview joins the hourly cadence HERE — after the rollup it
      // derives from, as its OWN statements, and deliberately NOT inside
      // collections.refresh_cmd_explorer_charge_rollup() (that function's statements share one
      // transaction, so a failure there would roll back the production rollup refresh — the
      // transaction-coupling entry in veris-data-notes.md). BEST-EFFORT: a resolution-refresh
      // failure must not fail the rollup run (the write path also refreshes after every
      // assignment, and the run row above already closed ok=true). Non-fatal + loudly logged;
      // also tolerated before 0086 is applied (the function simply doesn't exist yet).
      try {
        await rollupWriterDb().query('select collections.refresh_facility_resolution()');
        await rollupWriterDb().query('vacuum (analyze) collections.cmd_facility_resolution');
      } catch (err) {
        console.error(
          'refresh-charge-rollup: facility-resolution refresh failed (rollup refresh unaffected):',
          err instanceof Error ? err.message : String(err),
        );
      }

      // 0105: the patient-name directory joins the hourly cadence HERE, for the same reason the
      // facility-resolution matview does — and specifically AFTER the rollup, which is an ordering
      // that matters. The directory is what a name search matches against; the rollup is what the
      // grid reads. Refreshing the directory first would open a window where a name resolves to a
      // patient whose charge lines the grid cannot yet show, i.e. a search that finds somebody and
      // then displays nothing. This order can only ever produce the harmless converse.
      //
      // BEST-EFFORT, and the fail-soft is not laziness: this is bolted onto a production-critical
      // cron, so it must be incapable of failing the rollup. The work is also fully resumable — the
      // watermark is committed after every batch — so a failed run costs at most one hour of new
      // patients being unsearchable, never a corrupted index. A missing table (0105 merged but not
      // applied) lands here too and is logged distinctly rather than as an outage.
      //
      // The reader and the writer are DIFFERENT ROLES on purpose: only claims_reader may SELECT the
      // encrypted patient_name, and only cmd_rollup_writer may INSERT the directory. See 0105.
      try {
        const dir: PatientDirectorySyncStats = await syncPatientDirectory({
          read: readerExecutor(),
          write: rollupWriterDb(),
          decrypt: decryptPhi,
        });
        console.log(
          `refresh-charge-rollup: patient directory scanned ${dir.rows_scanned} rows, ` +
            `inserted ${dir.names_inserted} names, watermark ${dir.last_row_id}, ` +
            `${dir.exhausted ? 'caught up' : 'BUDGET-STOPPED (resumes next hour)'}` +
            (dir.decrypt_failures > 0 ? `, decrypt failures ${dir.decrypt_failures}` : '') +
            (dir.skipped_no_member > 0 ? `, skipped-no-member ${dir.skipped_no_member}` : ''),
        );
      } catch (err) {
        console.error(
          'refresh-charge-rollup: patient-directory sync failed (rollup refresh unaffected):',
          err instanceof Error ? err.message : String(err),
        );
      }
      return stats;
    },
    }),
  );
}

/**
 * GET /api/cron/pipeline-tick — one slice of the completion-chained CMD pipeline.
 *
 * SHIPPED DISABLED (ETL_PIPELINE_ENABLED unset ⇒ no-op 200). The five standalone cron entries in
 * app/vercel.json keep running exactly as they do today; this PR instruments and builds, and the
 * cutover — deleting those five entries and setting the tick's real cadence — is a follow-up gated
 * on a day of measured collections.etl_run durations. Do not enable it and delete the five in the
 * same change: the tick's stage reserves are currently pessimistic placeholders, and the two
 * explorer reserves are the full 300s function ceiling because nothing has ever timed them.
 *
 * runStage dispatches to the SAME exported handlers the standalone routes call, with
 * triggeredBy: 'tick'. That is deliberate and is what keeps this PR honest about moving WHEN stages
 * run and never WHAT they do — there is no second code path for a stage to drift down. Each handler
 * re-checks the bearer itself, so the tick passes the secret through rather than bypassing auth.
 *
 * ROLES: lock/state/etl_run writes go through rollupWriterDb (cmd_rollup_writer, 0099 grants). The
 * stages keep whatever roles they already use. No PHI crosses this boundary.
 */
export function handlePipelineTick(req: PipelineTickHttpRequest) {
  const secret = process.env.CRON_SECRET;
  return handlePipelineTickRequest(req, {
    secret,
    enabled: envFlagEnabled(process.env.ETL_PIPELINE_ENABLED),
    tick: (holder) =>
      runPipelineTick({
        db: rollupWriterDb(),
        holder,
        budgetMs: envIntMs(process.env.ETL_PIPELINE_BUDGET_MS, DEFAULT_TICK_BUDGET_MS),
        runStage: async (stage) => {
          let runId: number | null = null;
          const opts: CronInvocationOptions = {
            // `holder` here is the HANDLER's clamped value — the literal 'manual' or 'cron'.
            // runPipelineTick derives its own unique lease token ('manual:<ts>:<uuid>') internally
            // and never hands it back, so matching a 'manual:' PREFIX here can never fire and every
            // hand-run tick would be misattributed to 'tick'. Compare the literal.
            triggeredBy: holder === 'manual' ? 'tick-manual' : 'tick',
            onRunId: (id) => {
              runId = id;
            },
          };
          // The secret is re-presented because each handler gates independently — the tick is a
          // caller, not a privileged bypass.
          const cronReq = { method: 'GET', authorization: `Bearer ${secret ?? ''}` };
          const result = await dispatchStage(stage, cronReq, opts);
          return { ...result, runId };
        },
      }),
  });
}

/**
 * Stage name -> the exact handler its standalone cron route calls. An unknown stage THROWS rather
 * than silently succeeding: pipeline_state is seeded from migration 0099 and the stage list lives in
 * etlStages.ts, so a name that reaches here without a handler is a wiring bug, and a tick that
 * quietly advanced past it would mark a stage that never ran as 'ok'.
 */
function dispatchStage(
  stage: string,
  req: { method: string; authorization: string },
  opts: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  switch (stage) {
    case 'cmd-explorer':
      return handleCmdExplorerCron(req, opts);
    case 'indigo-explorer':
      return handleIndigoExplorerCron(req, opts);
    case 'cmd-census':
      return handleCmdCensusCron(req, opts);
    case 'indigo-census':
      return handleIndigoCensusCron(req, opts);
    case 'refresh-charge-rollup':
      return handleRefreshChargeRollup(req, opts);
    default:
      throw new Error(`pipeline-tick: no handler wired for stage '${stage}'`);
  }
}

/** Truthy env flag: '1' / 'true' / 'on' / 'yes'. Anything else (including unset) is off. */
function envFlagEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Positive-integer ms env override; anything unparseable or <= 0 falls back to the default. */
function envIntMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Nightly Qualify policy-rating history snapshot (Vercel Cron, daily 05:10 — after the 04:45
 * matview refresh settles; DB-only, so the CMD-scoped :41–:59 rule and the partner slot do not
 * bind it). GET only; gated on CRON_SECRET with the same constant-time Bearer check.
 *
 * RATING PARITY IS WIRED HERE: the src work module (runQualifyRatingHistory) supplies per-facility
 * claim aggregates and THIS binder injects computePairPolicyRating — the same computeRatingV2 +
 * derivePolicyRating the interactive surface ships — so the stored number is the number a user
 * would see, never a parallel formula. Coding/census/outcomes context loads ONCE per run through
 * the exact loaders the interactive factorContext uses (each already fail-soft on its unapplied-
 * migration class); a context load failure beyond those degrades the affected factors to
 * unavailable (renormalized away) rather than failing the night's snapshot — the same posture
 * factorContext takes per request.
 *
 * ROLES: aggregate scan as claims_reader (readerExecutor — every table pre-granted for Qualify
 * reads); run-log + upserts as cmd_rollup_writer (rollupWriterDb, 0093 grants). No PHI crosses
 * this boundary: tokens in, counts/dates out (see qualifyRatingHistory.ts's PHI header).
 */
export function handleQualifyRatingHistory(req: QualifyRatingHistoryHttpRequest) {
  return handleQualifyRatingHistoryRequest(req, {
    secret: process.env.CRON_SECRET,
    run: async () => {
      // NO blanket .catch() here (review 2026-08-08, CONFIRMED finding): these loaders already
      // fail-soft to empty on the known unapplied-migration SQLSTATEs and DELIBERATELY rethrow
      // real outages (42501 included). Swallowing an outage would bake context-free ratings into
      // PERMANENT ok=true history — for persisted snapshots, failing the night (dates stay
      // missing, next run self-heals) beats persisting a silently degraded number. This is a
      // stricter posture than factorContext's per-request catch, on purpose: a request repaints
      // in a second; a frozen snapshot doesn't.
      const [coding, censusRows, outcomeRows] = await Promise.all([
        loadCurrentCodingDecisions(),
        loadQualifyCensusAuth(),
        loadQualifyFacilityOutcomes(),
      ]);
      const ctx: QualifyPairRatingContext = {
        coding,
        census: new Map(censusRows.map((r) => [r.facility_code, r])),
        outcomes: new Map(outcomeRows.map((r) => [r.facility_code, r])),
      };
      return runQualifyRatingHistory({
        readDb: readerExecutor(),
        writeDb: rollupWriterDb(),
        rate: ({ payer, facilities, asOf, windowDays }) =>
          computePairPolicyRating(payer, facilities, asOf, windowDays, ctx),
        entityIds: [BXR_TENANT_ID, INDIGO_TENANT_ID],
        triggeredBy: 'cron',
      });
    },
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
/**
 * How a cron stage was invoked. Passed by the pipeline tick; the standalone Vercel cron routes omit
 * it and get the 'cron' default, so their behaviour and their run rows are unchanged.
 */
export interface CronInvocationOptions {
  /** 'cron' (a standalone Vercel entry), 'tick' (the pipeline) or 'manual'. Stored on etl_run. */
  triggeredBy?: string;
  /** Receives the etl_run row id, so the tick can link pipeline_state to the exact run. */
  onRunId?: (runId: number | null) => void;
}

/**
 * Wrap a cron stage's WORK (never its auth) in a collections.etl_run row.
 *
 * Placed inside each handler AFTER the 405/401 gates on purpose: a rejected request is not a stage
 * invocation, and logging one would put unauthenticated probe traffic into the timing measurements.
 *
 * classifyCronResult is required because these handlers CATCH their own failures and return
 * `{status: 500}` rather than throwing — without it every failed ingest would be recorded as a
 * success. Every etl_run write is fail-soft (see etlRun.ts), so this wrapper cannot change what the
 * wrapped stage does, and in particular cannot break the production crons before 0099 is applied.
 */
function withStageRun(
  stage: string,
  opts: CronInvocationOptions | undefined,
  work: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  return withEtlRun(
    {
      db: rollupWriterDb(),
      stage,
      triggeredBy: opts?.triggeredBy ?? 'cron',
      classify: classifyCronResult,
      ...(opts?.onRunId ? { onRunId: opts.onRunId } : {}),
    },
    work,
  );
}

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
    /** Exact column-name set the report must project; omit to run unguarded. */
    expectedColumns?: readonly string[];
  },
  opts?: CronInvocationOptions,
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
  return withStageRun(tenant.label, opts, async () => {
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
      expectedColumns: tenant.expectedColumns,
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
  });
}

/** BXR daily explorer cron (/api/cron/cmd-explorer). Roster = CMD_EXPLORER_CUSTOMERS (BXR's 15). */
export function handleCmdExplorerCron(
  req: { method?: string; authorization?: string | null },
  opts?: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  return handleExplorerCronForTenant(req, {
    label: 'cmd-explorer',
    customers: CMD_EXPLORER_CUSTOMERS,
    configFor: cmdExplorerConfigFor,
    businessEntityId: BXR_TENANT_ID,
    // HEADER CONTRACT. Verified by probing report 10093959 across all 15 BXR customers on
    // 2026-08-01, and report 10094775 on customer 10027973 on 2026-08-15.
    // A projection change fails the customer BEFORE replaceCmdDailyForFacility's DELETE, so the
    // feed freezes (recoverable) instead of being overwritten with nulls (not).
    // If you deliberately add/remove a column in CMD, update the matching set in cmdExplorer.ts.
    //
    // Resolved FROM the configured report id rather than hardcoded: the guard is set-equality, so
    // a fixed pin is correct for exactly one report and would freeze the ingest for the whole gap
    // between the env flip and the deploy. bxrExpectedColumnsFor keeps the contract and the report
    // in lockstep, so the cutover (and any rollback) is a single env change.
    expectedColumns: bxrExpectedColumnsFor(process.env.CMD_EXPLORER_REPORT_ID?.trim() || '10093959'),
  }, opts);
}

/**
 * Indigo daily explorer cron (/api/cron/indigo-explorer). Roster = INDIGO_CUSTOMERS (29).
 * Indigo's report (10092391) labels the facility column "Customer Name"; the shared mapReportRows +
 * LOCKED fingerprint read facility ONLY from "Facility Name" and mapRow REQUIRES it — so an
 * unaliased Indigo pull would skip EVERY charge line (watch charge_skipped == rows_fetched).
 * aliasIndigoFacilityColumn maps it before mapping — the SAME transform the one-time seed used, so
 * cron re-pulls are fingerprint-idempotent (ON CONFLICT) against the loaded seed.
 */
export function handleIndigoExplorerCron(
  req: { method?: string; authorization?: string | null },
  opts?: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  return handleExplorerCronForTenant(req, {
    label: 'indigo-explorer',
    customers: INDIGO_CUSTOMERS,
    configFor: cmdIndigoConfigFor,
    businessEntityId: INDIGO_TENANT_ID,
    transformRows: aliasIndigoFacilityColumn,
    // expectedColumns DELIBERATELY OMITTED: Indigo runs report 10092391 (a different projection),
    // and its rows reach the cron POST-transform — aliasIndigoFacilityColumn ADDS 'Facility Name'
    // while keeping 'Customer Name', so the guarded set is the report's columns PLUS that one.
    // Pinning it from an unverified list would break a currently-healthy feed, so Indigo stays
    // unguarded until its set is probed and committed as a deliberate change. Known gap.
  }, opts);
}

/**
 * BXR LAST-MONTH catch-up explorer run (/api/cron/cmd-explorer-catchup). SCHEDULED daily at
 * `52 7 * * *` (2026-08-01) — the route header records why that hour is paired against era-835's
 * `50 8 * * *` and why the filter MUST be a RELATIVE "last month" one, never a fixed date range.
 * Same roster, writer, and idempotent daily replace as the hourly BXR explorer cron. It now carries
 * its OWN report id (CMD_EXPLORER_CATCHUP_REPORT_ID) as well as its own filter
 * (CMD_EXPLORER_LASTMONTH_FILTER_ID) — both env-required with no fallback, so a swap of the
 * explorer's report can no longer silently re-pair this cron (see requiredCatchupReportId). The
 * filter windows payment-received on LAST month — so the first runs of a new month re-supply payments that landed after the rolling
 * current-month window rolled over (the class of gap the 2026-07-30 FRCA $540 backfill closed by
 * hand). replaceCmdDailyForFacility's DELETE is span-scoped to the pulled rows, so a last-month
 * pull rewrites exactly last month's facility-days and cannot touch the current month.
 */
export function handleCmdExplorerCatchupCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleExplorerCronForTenant(req, {
    label: 'cmd-explorer-catchup',
    customers: CMD_EXPLORER_CUSTOMERS,
    configFor: cmdExplorerCatchupConfigFor,
    businessEntityId: BXR_TENANT_ID,
    // Column sets belong to the REPORT (the saved filter only windows rows), so the contract must
    // be resolved from THIS cron's OWN report id — the same one cmdExplorerCatchupConfigFor pulls
    // with. It deliberately does NOT read CMD_EXPLORER_REPORT_ID any more: since 2026-08-17 the
    // catch-up has its own required CMD_EXPLORER_CATCHUP_REPORT_ID, and resolving the header
    // contract from the explorer's var while PULLING with the catch-up's would reintroduce the very
    // coupling that hardening removed — one env var away from a guard that polices the wrong report.
    //
    // ⚠ Read WITHOUT the required-throw on purpose. This option object is built EAGERLY, before
    // handleExplorerCronForTenant checks the CRON_SECRET, so throwing here would answer an
    // UNAUTHENTICATED request with a 500 instead of a 401 and leak config state. The loud failure
    // is not lost — cmdExplorerCatchupConfigFor calls requiredCatchupReportId() per customer during
    // the pull, which is after auth. An unset var therefore still fails the run, and meanwhile
    // bxrExpectedColumnsFor falls back to the legacy set rather than to "no guard".
    expectedColumns: bxrExpectedColumnsFor(process.env.CMD_EXPLORER_CATCHUP_REPORT_ID?.trim() ?? ''),
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
    /**
     * Required-no-fallback env vars this tenant's configFor consumes. Checked ONCE up front so a
     * missing-env deploy fails BEFORE any CMD call with a single error line listing every gap,
     * instead of surfacing one at a time through the deep throws in requiredCensusReportId /
     * requiredCensusFilterId. Those deep throws stay as defense-in-depth for other call paths.
     */
    requiredEnvVars: readonly string[];
    /** Optional per-fetch row transform (Indigo: alias "Customer Name" → "Facility Name"). */
    transformRows?: (rows: CmdReportRow[]) => CmdReportRow[];
    /** Exact column-name set the census report must project; omit to run unguarded. */
    expectedColumns?: readonly string[];
  },
  opts?: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  return withStageRun(tenant.label, opts, async () => {
  try {
    assertRequiredEnvVars(tenant.label, tenant.requiredEnvVars);
    const stats = await cmdCensusCron({
      customers: tenant.customers,
      fetchRows: (customerId) => cmdReportRows(tenant.configFor(customerId)),
      writeDb: rollupWriterDb(),
      transformRows: tenant.transformRows,
      expectedColumns: tenant.expectedColumns,
      stalenessMs: censusStalenessMs(),
    });
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    console.error(`${tenant.label} cron failed:`, err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
  });
}

/** BXR census cron (/api/cron/cmd-census). Roster = BXR_CUSTOMERS (BXR's 15). */
export function handleCmdCensusCron(
  req: { method?: string; authorization?: string | null },
  opts?: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  return handleCensusCronForTenant(req, {
    label: 'cmd-census',
    customers: BXR_CUSTOMERS,
    // expectedColumns NOT WIRED YET — the guard exists in cmdCensusCron, but the census runs its
    // OWN saved filter (CMD_BXR_CENSUS_FILTER_ID), whose projection has never been probed. Column
    // sets belong to the report, so if that filter sits under 10093959 the answer is
    // `expectedColumns: BXR_REPORT_COLUMNS` — one line. Guessing it wrong would refuse a census
    // that would otherwise have recovered, so this stays off until one live run proves the shape.
    configFor: cmdBxrCensusConfigFor,
    // Must match the required-no-fallback throws inside cmdBxrCensusConfigFor. Keep in sync when
    // adding another env var to the BXR census config builder.
    requiredEnvVars: ['CMD_BXR_CENSUS_REPORT_ID', 'CMD_BXR_CENSUS_FILTER_ID'],
  }, opts);
}

/** Indigo census cron (/api/cron/indigo-census). Roster = INDIGO_CUSTOMERS (29); facility-column alias. */
export function handleIndigoCensusCron(
  req: { method?: string; authorization?: string | null },
  opts?: CronInvocationOptions,
): Promise<{ status: number; body: unknown }> {
  return handleCensusCronForTenant(req, {
    label: 'indigo-census',
    customers: INDIGO_CUSTOMERS,
    configFor: cmdIndigoCensusConfigFor,
    transformRows: aliasIndigoFacilityColumn,
    // Indigo deliberately still spreads cmdIndigoConfigFor's report (see the block comment above
    // requiredCensusReportId): only the filter is required-no-fallback here.
    requiredEnvVars: ['CMD_INDIGO_CENSUS_FILTER_ID'],
  }, opts);
}

// --- ERA-confirmed upcoming payments (Overview tile, staging.era_835_payment) --------

/**
 * Dedicated claims_reader pool for the Veris/staging read path. A SECOND pool on
 * purpose, not the shared PgExecutor: withTenant needs a RAW checked-out client (BEGIN →
 * transaction-local GUC → queries on that same client — the Supavisor 6543 discipline),
 * which PgExecutor deliberately does not hand out. Isolating it also means a saturated
 * shared reader pool (the ~30s collections aggregates) cannot starve this read, and vice
 * versa. Same verify-full TLS + timeouts via makeReaderPool; max 4, lazily connected.
 */
let cachedVerisReaderPool: Db | null = null;
function verisReaderPool(): Db {
  cachedVerisReaderPool ??= makeReaderPool(readerConnectionStringFromEnv());
  return cachedVerisReaderPool;
}

/**
 * ERA-confirmed upcoming payments for an ALREADY-CLAMPED entity scope (callers derive
 * entityIds via viewEntityScope — never from raw client input). One withTenant read per
 * entity (staging RLS is GUC-scoped, one tenant per transaction); Consolidated = the
 * per-tenant results merged in exact integer cents. Fails closed on an empty scope.
 *
 * LIVE read, deliberately uncached: the table changes once daily when the 835 ingest cron
 * writes (/api/cron/era-835, `50 8 * * *`), the read is two indexed aggregates over a small
 * table, and no cron revalidates a tag for this surface — an unstable_cache entry here would
 * serve stale money for an unbounded time after an ingest lands.
 *
 * "Upcoming" is anchored to the ops calendar day in America/Los_Angeles, not UTC — see
 * era835Upcoming's header. The cutoff is computed ONCE here and shared across tenants, so a
 * Consolidated read straddling midnight PT cannot scope its two tenants to different days.
 */
export async function getEraUpcomingPayments(entityIds: string[]): Promise<EraUpcomingSummary> {
  if (entityIds.length === 0) {
    // Mirrors assertEntityScope's posture: an empty scope must read NOTHING, loudly.
    throw new Error('getEraUpcomingPayments: empty entity scope');
  }
  const cutoffIso = businessTodayIso();
  const parts: EraUpcomingSummary[] = [];
  for (const id of entityIds) {
    // Sequential on purpose: at most 2 entities, and each read is its own short
    // transaction on the small shared pool — parallelism buys nothing here.
    parts.push(await eraUpcomingPayments(verisReaderPool(), id, cutoffIso));
  }
  return mergeEraUpcoming(parts);
}
export type { EraUpcomingSummary, EraUpcomingGroup } from '../../src/veris/era835Upcoming.js';

// --- Upcoming-payment FORECAST overrides (Overview tile, staging.expected_payment_override) --

/**
 * Hand-keyed forecast rows for an ALREADY-CLAMPED entity scope, synced FROM the "Upcoming
 * Payments" Google Sheet (migration 023). The FORECAST half of the "ERA-Confirmed Upcoming
 * Payers" tile; getEraUpcomingPayments above is the CONFIRMED half.
 *
 * ADDITIVE-ONLY (Alec, 2026-08-03): these rows are shown ALONGSIDE the ERA rows and never
 * suppress one. Do NOT add this total to EraUpcomingSummary.total in a single headline —
 * the two are different epistemic classes (835-confirmed vs. operator-asserted), and a
 * forecast row whose 835 has since landed is double-counted until the operator deletes it
 * from the sheet. Label them separately in the UI. ERA reconciliation is later work.
 *
 * Same shape as the ERA read on purpose: one withTenant read per entity (staging RLS is
 * GUC-scoped, one tenant per transaction), Consolidated = the per-tenant results merged in
 * exact integer cents, fails closed on an empty scope, and the cutoff is computed ONCE here
 * and shared across tenants — businessTodayIso(), the SAME anchor the ERA half uses, so the
 * two halves cannot disagree about what "upcoming" means across midnight PT.
 *
 * LIVE read, deliberately uncached, matching the ERA half: the table changes when the
 * hourly override cron writes, and no cron revalidates a tag for this surface, so an
 * unstable_cache entry would serve a stale forecast for an unbounded time.
 */
export async function getUpcomingOverrides(
  entityIds: string[],
): Promise<UpcomingOverrideSummary> {
  if (entityIds.length === 0) {
    // Mirrors assertEntityScope / getEraUpcomingPayments: an empty scope reads NOTHING, loudly.
    throw new Error('getUpcomingOverrides: empty entity scope');
  }
  const cutoffIso = businessTodayIso();
  const parts: UpcomingOverrideSummary[] = [];
  for (const id of entityIds) {
    // Sequential: at most 2 entities, each its own short transaction on the shared pool.
    parts.push(await upcomingOverrides(verisReaderPool(), id, cutoffIso));
  }
  return mergeUpcomingOverrides(parts);
}
export type {
  UpcomingOverrideSummary,
  UpcomingOverrideRow,
} from '../../src/veris/upcomingOverride.js';

// --- Super-admin forecast EDITS (staging.expected_payment_manual, migration 024) -------

/**
 * One tenant's super-admin edits to the forecast. Read-only here; the resolver that folds
 * these over the sheet feed is pure and runs at the UI edge (src/veris/upcomingForecast.ts).
 *
 * A SEPARATE TABLE FROM THE SHEET FEED, and that is the point: 023 is replace-per-sync, so a
 * hand-authored row there would be destroyed by the next hourly cron. 024 grants the cron
 * NOTHING on this table, which is a structural guarantee rather than a careful predicate.
 *
 * Explicit allowlisted columns, RLS-scoped by the GUC through withTenant, reader pool. Rows
 * are unbounded in principle but bounded in practice by the unique index (one decision per
 * kind + match key) and by there being ~9 sheet rows to decide about.
 */
export async function getUpcomingManual(entityIds: string[]): Promise<ManualForecastRow[]> {
  if (entityIds.length === 0) {
    // Mirrors assertEntityScope: an empty scope reads NOTHING, loudly.
    throw new Error('getUpcomingManual: empty entity scope');
  }
  const out: ManualForecastRow[] = [];
  for (const id of entityIds) {
    const rows = await withTenant(verisReaderPool(), id, async (client) => {
      // `id` is BIGINT and the driver hands int8 back as TEXT — narrow it HERE, at the read
      // boundary, the same way toExplorerRow / toAuditGridRow / the facility-resolution queue
      // do, and the same way saveUpcomingManualRow already types its own bigint return forty
      // lines below. Skipping this makes every "Remove edit" / "Remove row" / "Undo
      // correction" button on the tile a silent no-op: deleteUpcomingManual guards with
      // Number.isSafeInteger, and Number.isSafeInteger("15") is false. The generic is the
      // *Db* row on purpose, so returning res.rows unmapped is a tsc error, not a review miss.
      // 033 adds status/removed_at. Both are SELECTED, not filtered in SQL: the resolver
      // returns removed rows as their own output so an operator can see what was taken back
      // and by whom, which a `where removed_at is null` here would make impossible. The
      // volume argument that would justify filtering does not apply — this is one decision
      // per human judgement about ~9 sheet rows.
      const res = await client.query<ManualForecastDbRow>(
        `select id, kind, facility_code, payer_label, expected_date::text as expected_date,
                method_label, amount::text as amount, suppress_reason, matched_era_key,
                status, removed_at::text as removed_at
           from staging.expected_payment_manual
          where business_entity_id = $1::uuid
          order by expected_date asc, facility_code asc, payer_label asc, id asc`,
        [id],
      );
      return res.rows.map(manualRowFromDb);
    });
    out.push(...rows);
  }
  return out;
}
export type {
  ManualForecastRow,
  ResolvedForecastRow,
  LandedSuggestion,
} from '../../src/veris/upcomingForecast.js';

/**
 * Create or re-decide ONE super-admin forecast edit. Authorization is NOT decided here —
 * app/lib/actions.ts gates on role === 'super_admin' and writes the audit row. This is the
 * narrow mechanism: a claims_admin-owned SECURITY DEFINER function called on the SAME
 * least-privilege claims_reader pool used everywhere else, exactly like claims.upsert_app_user.
 *
 * The function runs as its owner and therefore BYPASSES RLS, so `businessEntityId` — derived
 * server-side from the RBAC-clamped view, never from the client — is what scopes the write.
 * The function re-validates it against core.business_entity before inserting.
 */
export async function saveUpcomingManualRow(input: {
  businessEntityId: string;
  kind: 'add' | 'correct' | 'suppress';
  facilityCode: string;
  payerLabel: string;
  expectedDate: string;
  methodLabel: string | null;
  amount: string | null;
  suppressReason: 'landed' | 'incorrect' | 'cancelled' | null;
  matchedEraKey: string | null;
  actorUserId: string;
}): Promise<string> {
  const { rows } = await readerExecutor().query<{ id: string }>(
    'select staging.upsert_expected_payment_manual(' +
      '$1::uuid, $2, $3, $4, $5::date, $6, $7::numeric, $8, $9, $10::uuid) as id',
    [
      input.businessEntityId,
      input.kind,
      input.facilityCode,
      input.payerLabel,
      input.expectedDate,
      input.methodLabel,
      input.amount,
      input.suppressReason,
      input.matchedEraKey,
      input.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('saveUpcomingManualRow: upsert returned no id');
  return id;
}

/**
 * Remove one edit — a SOFT delete since 033.
 *
 * Returns false when no LIVE row matched for this tenant, which covers both "already removed"
 * and "never existed" and makes a double-click harmless. 033's function carries the
 * `removed_at IS NULL` predicate, so a second call cannot overwrite the first remover's name.
 *
 * ⚠️ NOT staging.delete_expected_payment_manual. That function still exists and still works,
 * but it is a HARD delete: it destroys the row an existing claims.access_audit entry names,
 * leaving the audit trail pointing at an id that resolves to nothing. It stays available for a
 * deliberate hand-run purge; the app path must not use it.
 */
export async function removeUpcomingManualRow(
  businessEntityId: string,
  id: number,
  actorUserId: string,
): Promise<boolean> {
  const { rows } = await readerExecutor().query<{ removed: boolean }>(
    'select staging.remove_expected_payment_manual($1::uuid, $2::bigint, $3::uuid) as removed',
    [businessEntityId, id, actorUserId],
  );
  return rows[0]?.removed === true;
}

/**
 * Record a reconciliation decision against an 835 (033).
 *
 * 'matched' takes the forecast row out of the tile's count because the 835 is already there;
 * 'needs_review' leaves it counted and flags it; 'expected' is the undo. The DB function
 * refuses a non-'expected' status with no era key, and only touches kind='add'.
 *
 * NOTHING HERE DECIDES A MATCH. `suggestLandedMatches` proposes and a super admin confirms —
 * a wrong automatic match silently deletes money from a forecast (024's ruling, still live).
 */
export async function setUpcomingManualStatusRow(
  businessEntityId: string,
  id: number,
  status: 'expected' | 'needs_review' | 'matched',
  matchedEraKey: string | null,
  actorUserId: string,
): Promise<boolean> {
  const { rows } = await readerExecutor().query<{ updated: boolean }>(
    'select staging.set_expected_payment_manual_status(' +
      '$1::uuid, $2::bigint, $3, $4, $5::uuid) as updated',
    [businessEntityId, id, status, matchedEraKey, actorUserId],
  );
  return rows[0]?.updated === true;
}

// --- MANUAL DEPOSITS (collections.daily_collections, source_tag='manual', 0096) ---------

/** One operator-recorded deposit CMD has not posted yet. Non-PHI: facility, day, money. */
export interface ManualDepositRow {
  /** bigint — narrowed at the read boundary; see the note on the read below. */
  id: number;
  facility_code: string;
  payment_date: string;
  checks_amount: string;
  eft_amount: string;
  gross_amount: string;
  created_at: string;
  /**
   * A CMD deposit now exists for the same facility + day, so this row is probably counted
   * twice. NOT auto-removed (Alec, 2026-08-10): auto-suppressing would swallow a genuine
   * second same-day payment invisibly. The UI prompts; a human decides.
   */
  cmd_now_covers: boolean;
}

/**
 * Live manual deposits for an already-clamped entity scope, each flagged with whether CMD has
 * since posted a deposit for the same facility-day.
 *
 * Uses the 0096 partial index (business_entity_id, facility_code, payment_date)
 * WHERE source_tag='manual' AND removed_at IS NULL — and unlike 033's dropped index, the
 * predicate is genuinely present in this query, which is the whole reason it can be used.
 */
export async function getManualDeposits(entityIds: string[]): Promise<ManualDepositRow[]> {
  if (entityIds.length === 0) throw new Error('getManualDeposits: empty entity scope');
  const { rows } = await readerExecutor().query<Omit<ManualDepositRow, 'id'> & { id: string }>(
    `select d.id, d.facility_code, d.payment_date::text as payment_date,
            d.checks_amount::text as checks_amount, d.eft_amount::text as eft_amount,
            d.gross_amount::text as gross_amount, d.created_at::text as created_at,
            exists (
              select 1 from collections.daily_collections c
               where c.business_entity_id = d.business_entity_id
                 and c.facility_code = d.facility_code
                 and c.payment_date = d.payment_date
                 and c.source_tag = 'cmd'
                 and c.removed_at is null
            ) as cmd_now_covers
       from collections.daily_collections d
      where d.business_entity_id = any($1::uuid[])
        and d.source_tag = 'manual'
        and d.removed_at is null
      order by d.payment_date desc, d.facility_code asc, d.id asc`,
    [entityIds],
  );
  // int8 arrives as TEXT and this repo registers no type parser, so a raw pass-through would
  // put the STRING "21" in a field typed `number` — the exact lie that made every Remove
  // button on the forecast tile a silent no-op for two days (see upcomingForecast.ts).
  return rows.map((r) => {
    const id = Number(r.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`getManualDeposits: daily_collections.id is not a safe integer (${r.id})`);
    }
    return { ...r, id };
  });
}

/** Record a deposit CMD has not posted yet. Returns the new row id. */
export async function addManualDepositRow(input: {
  businessEntityId: string;
  facilityCode: string;
  paymentDate: string;
  method: 'EFT' | 'Check';
  amount: string;
  actorUserId: string;
}): Promise<string> {
  const { rows } = await readerExecutor().query<{ id: string }>(
    'select collections.add_manual_deposit($1::uuid, $2, $3::date, $4, $5::numeric, $6::uuid) as id',
    [
      input.businessEntityId,
      input.facilityCode,
      input.paymentDate,
      input.method,
      input.amount,
      input.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('addManualDepositRow: insert returned no id');
  return id;
}

/** Soft-remove one manual deposit. False when no LIVE manual row matched (idempotent). */
export async function removeManualDepositRow(
  businessEntityId: string,
  id: number,
  actorUserId: string,
): Promise<boolean> {
  const { rows } = await readerExecutor().query<{ removed: boolean }>(
    'select collections.remove_manual_deposit($1::uuid, $2::bigint, $3::uuid) as removed',
    [businessEntityId, id, actorUserId],
  );
  return rows[0]?.removed === true;
}

/**
 * GET /api/cron/upcoming-overrides — "Upcoming Payments" sheet → staging.
 * expected_payment_override. Auth: Bearer <CRON_SECRET>. GET only.
 *
 * THE GOOGLE SHEETS CONNECTOR, composed here. Reuses the EXACT env-only OAuth
 * refresh-token pattern already proven by handleBillingCodeDecisionsCron below —
 * GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_SHEETS_REFRESH_TOKEN are
 * shared with that cron (one Google client, one grant, scope spreadsheets.readonly), so the
 * only NEW env var is UPCOMING_PAYMENTS_SHEET_ID. Names never values; fail-fast when unset.
 * `googleapis` is imported lazily so it stays out of the cold-start path of every other
 * route in this module.
 *
 * Writes as the least-privilege cmd_rollup_writer (023 grants it SELECT/INSERT/DELETE on
 * this one table, GUC-scoped by RLS) — never claims_admin, never the service-role key.
 *
 * BXR-ONLY TODAY, deliberately explicit. Every one of the sheet's live rows is a BXR
 * facility, and the parser's alias table contains only BXR codes, so the tenant is passed
 * as a literal rather than inferred. An Indigo forecast tab would be a SECOND call with
 * INDIGO_TENANT_ID and its own tab + alias entries — not a widening of this one.
 *
 * FAIL-SOFT on the sheet: a fetch failure or header drift returns status 'parse_failed'
 * with zero writes, mapped to ok:false in the body — last good forecast stays on the tile.
 * Schedule lives in app/vercel.json (single source of truth) — do not restate it here.
 */
export async function handleUpcomingOverridesCron(req: {
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
    const sheetId = process.env.UPCOMING_PAYMENTS_SHEET_ID?.trim();
    if (!clientId || !clientSecret || !refreshToken || !sheetId) {
      throw new Error(
        'Upcoming-overrides sync env not configured: set GOOGLE_OAUTH_CLIENT_ID, ' +
          'GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_SHEETS_REFRESH_TOKEN, UPCOMING_PAYMENTS_SHEET_ID',
      );
    }
    const [{ google }, { readSheet }] = await Promise.all([
      import('googleapis'),
      import('../../src/sheets.js'),
    ]);
    const oauth = new google.auth.OAuth2(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const stats = await upcomingOverrideSync({
      // readSheet splits row 1 off as `header`; the override parser wants EVERY row with
      // true 1-based rowNums so it can validate the header itself and report real sheet
      // row numbers in rejects — reassemble. Same shim as the billing-code cron.
      fetchTab: async (tab) => {
        const res = await readSheet(sheetId, tab, oauth);
        return { rows: [{ rowNum: 1, cells: res.header }, ...res.rows] };
      },
      writeDb: rollupWriterDb(),
      businessEntityId: BXR_TENANT_ID,
    });
    // NO revalidateTag HERE, on purpose. getUpcomingOverrides is a LIVE uncached read (same
    // posture as getEraUpcomingPayments — see its comment above), so there is no cache entry
    // for this surface to bust and a revalidate call would be dead code implying otherwise.
    // If this read is ever wrapped in unstable_cache, add the tag in BOTH places at once.
    return { status: 200, body: { ok: stats.status !== 'parse_failed', ...stats } };
  } catch (err) {
    console.error(
      'upcoming-overrides cron failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { status: 500, body: { error: 'cron_failed' } };
  }
}

// --- 835 ERA ingest cron (staging.era_835_payment + era_835_adjustment) --------------

/** Wall-clock budget before runEra835Ingest stops launching NEW (date,customer) pulls.
 *  Mirrors cmdExplorerCron's DEFAULT_BUDGET_MS (210s inside the 300s function): the
 *  in-flight pull can still run to the 60s CMD timeout after the guard fires, so
 *  210 + 60 leaves ~30s headroom for the final DB batch + response. Budget-skipped
 *  pulls are counted (pulls_skipped_budget) and picked up on a later run — dedup by
 *  fingerprint makes re-pulls free. */
const ERA835_BUDGET_MS = 210_000;

/** Minimum gap between CMD calls. 1500ms — deliberate: 150ms pacing is what preceded
 *  the 2026-07-31 probe's 401 episode. NOT a throttle-avoidance tuning (the throttle
 *  theory was FALSIFIED — gentler pacing produced a HIGHER failure rate; finding 1);
 *  just a conservative floor while the real failure mode is unknown. */
const ERA835_INTER_CALL_DELAY_MS = 1_500;

/** ERAs land LATE relative to their receipt date (BPR16 observed spanning 06-18..07-30
 *  from a 07-21..27 receipt window), so each daily run re-pulls a trailing window.
 *  5 days; re-pulls are fingerprint-idempotent on both tables. */
const ERA835_LOOKBACK_DAYS = 5;

/**
 * Write the per-tenant run rows for one 835 ingest run (staging.era_835_ingest_run,
 * migration 022), FAIL-SOFT. A summary-write failure must never fail an ingest that already
 * succeeded, and must never turn a failed ingest into a different error — so this swallows
 * everything and logs the message only (0053's stated posture).
 *
 * The most likely reason to land in the catch is 022 not being applied yet; that degrades
 * to one logged line per run, not a broken cron. Do not rely on it — apply 022 first.
 */
async function writeEra835RunRow(
  startedAt: string,
  dates: string[] | undefined,
  byEntity: Record<string, Era835TenantCounts>,
  failure?: { error: string },
  label = 'era-835',
): Promise<void> {
  try {
    await recordEra835IngestRun(
      rollupWriterDb(),
      { startedAt, windowStart: dates?.[0] ?? null, windowEnd: dates?.at(-1) ?? null },
      byEntity,
      failure,
    );
  } catch (e) {
    console.error(
      `${label} cron: era_835_ingest_run write failed (non-fatal):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * One tenant's daily 835 ERA ingest. Shared body behind the two named wrappers below —
 * the same `…CronForTenant` + thin-wrapper shape the explorer and census pairs already use
 * (handleCmdCensusCron / handleIndigoCensusCron), so the two tenants cannot drift apart.
 *
 * GET only; gated on CRON_SECRET with the same constant-time Bearer check as every other
 * cron. Downloads each roster customer's 835s for the trailing window, parses the X12, and
 * idempotently lands BOTH grains as cmd_rollup_writer: one staging.era_835_payment row
 * per ST/SE transaction set (written UNCONDITIONALLY — a clean-paid remit with zero CAS
 * triplets still lands; that was defect 2), then its staging.era_835_adjustment triplets
 * carrying payment_id. Non-PHI counts only.
 *
 * TENANT SAFETY — nothing here is tenant-specific except the roster. runEra835Ingest
 * resolves the tenant PER CUSTOMER from `customer.businessEntityId`, insertEra835Transactions
 * sets `app.business_entity_id` transaction-locally per customer, and every RLS policy on
 * era_835_payment / _adjustment / _ingest_run is GUC-based (SQL Schemas 013 §6, 022). So a
 * mixed or per-tenant roster tags rows correctly with no policy, grant or migration change.
 *
 * ERROR POSTURE (finding 1 pending): failures are COUNTED PER CODE and never retried —
 * the root cause of the probe's 30%/42% failure episodes is unknown and the throttle
 * theory is falsified, so retry/backoff tuned to a wrong theory would only distort the
 * signal. A 401/403 aborts the WHOLE run via the fatal seam (the CmdEra835Error message
 * names the credential path: the CMD user behind CMD_API_TOKEN / CMD_API_USERNAME needs
 * the Payment role); everything else is per-pull isolated.
 */
async function handleEra835IngestCronForTenant(
  req: {
    method?: string;
    authorization?: string | null;
  },
  tenant: { label: string; customers: readonly CmdCustomer[] },
): Promise<{ status: number; body: unknown }> {
  if (req.method !== undefined && req.method.toUpperCase() !== 'GET') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !isAuthorized(req.authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  // Observability state, owned HERE so the catch block can still read real counters after a
  // mid-run throw (migration 022). runEra835Ingest accumulates into this object rather than
  // a private one; see its `stats` dep for why a returned-only summary was not enough.
  const startedAt = new Date().toISOString();
  const stats = newEra835IngestStats();
  // Seed the roster BEFORE the first thing that can throw, so a failure that predates the
  // ingest loop still writes one 'failed' row per tenant instead of none.
  seedEra835TenantRoster(stats, tenant.customers);
  let dates: string[] | undefined;
  try {
    // Fail fast on a misconfigured PHI key (mirrors the CLI's up-front probe) — better a
    // clean 500 before any CMD call than a mid-run abort after N pulls.
    await encryptPhi('era-835-cron-key-probe');

    // Trailing window, OLDEST FIRST — expandDateRange returns ascending. Order matters
    // under the budget guard: a budget-cut tail then skips the NEWEST dates, which stay
    // in the window for up to 4 more daily runs; newest-first would starve the OLDEST
    // date on the one run that is its last chance before it leaves the window.
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - (ERA835_LOOKBACK_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    dates = expandDateRange(start, end);

    // 1500ms floor between CMD calls (before every pull but the first). Inside the
    // download seam so the budget guard's wall clock naturally includes it.
    let firstCall = true;
    const download = async (customerId: string, date: string) => {
      if (!firstCall) await new Promise((r) => setTimeout(r, ERA835_INTER_CALL_DELAY_MS));
      firstCall = false;
      const res = await cmdDownload835(cmdEra835ConfigFor(customerId), { date });
      if (res.kind === 'empty') return { kind: 'empty' as const };
      return { kind: 'files' as const, files: read835Files(res.bytes, `${customerId}_${date}`) };
    };

    await runEra835Ingest({
      stats,
      customers: tenant.customers,
      dates,
      ingestedBy: 'era_835_cron',
      download,
      writeDb: rollupWriterDb(),
      budgetMs: ERA835_BUDGET_MS,
      // Credential/role rejection: abort the run. Retrying every remaining pull with a
      // rejected credential cannot succeed and burns the shared one-at-a-time CMD session.
      fatal: (err) =>
        err instanceof CmdEra835Error &&
        err.code === 'http_status' &&
        (err.status === 401 || err.status === 403),
    });
    // Persist the run summary, ONE ROW PER TENANT — FAIL-SOFT: the ingest already
    // succeeded, so a summary-write failure is logged (label only) and never fails the run
    // (0053's posture). Requires SQL Schemas/022 applied; before that it just logs.
    await writeEra835RunRow(startedAt, dates, stats.by_entity, undefined, tenant.label);
    return { status: 200, body: { ok: true, ...stats } };
  } catch (err) {
    // Generic to the client; message only to the server log (no PHI, no token, no URL).
    // The 401/403 CmdEra835Error message already names the credential path explicitly.
    console.error(`${tenant.label} cron failed:`, err instanceof Error ? err.message : String(err));
    // A FAILED run must be as visible as a successful one — a cron that dies every night
    // and writes nothing is exactly the silence 022 exists to end. Per-tenant attribution
    // is unavailable here (the throw may predate the loop), so every tenant in the seeded
    // roster gets a 'failed' row. The COUNTERS ARE REAL, not zeroed: stats is owned by
    // this handler, so whatever committed before the throw is recorded.
    await writeEra835RunRow(
      startedAt,
      dates,
      stats.by_entity,
      { error: err instanceof Error ? err.message : String(err) },
      tenant.label,
    );
    if (
      err instanceof CmdEra835Error &&
      err.code === 'http_status' &&
      (err.status === 401 || err.status === 403)
    ) {
      return { status: 500, body: { error: 'cron_failed', code: 'credential_rejected' } };
    }
    return { status: 500, body: { error: 'cron_failed' } };
  }
}

/**
 * BXR 835 ERA ingest (/api/cron/era-835 — SCHEDULED `50 8 * * *`). Roster = BXR_CUSTOMERS
 * (15) × ERA835_LOOKBACK_DAYS (5) = 75 sequential pulls, which fits ERA835_BUDGET_MS.
 * Behaviour is unchanged by the tenant refactor: same name, same signature, same roster.
 */
export function handleEra835IngestCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleEra835IngestCronForTenant(req, { label: 'era-835', customers: BXR_CUSTOMERS });
}

/**
 * Indigo 835 ERA ingest (/api/cron/indigo-era-835 — SCHEDULED `50 9 * * *`).
 * Roster = INDIGO_CUSTOMERS (29 active; the 3 retired rows are excluded by construction in
 * cmdCustomers.ts, so no edit here can resume CMD calls against a closed account).
 *
 * ⚠ WHY A SEPARATE ROUTE INSTEAD OF WIDENING era-835's ROSTER TO ALL_CMD_CUSTOMERS:
 * 44 customers × 5 dates = 220 sequential pulls, and at the ERA835_INTER_CALL_DELAY_MS floor
 * that is 330s of PACING ALONE — past both ERA835_BUDGET_MS (210s) and the route's
 * maxDuration (300s). Splitting per tenant is also the pattern the explorer and census crons
 * already use (cmd-explorer :00 / indigo-explorer :30). Do NOT "simplify" this back into one
 * route, and do NOT lower ERA835_INTER_CALL_DELAY_MS to make one route fit: 150ms pacing is
 * what preceded the 2026-07-31 401 episode and the throttle theory was FALSIFIED (gentler
 * pacing produced a HIGHER failure rate), so that constant is not a tuning knob.
 *
 * ⚠ EXPECT A SMALL pulls_skipped_budget ON THIS ROUTE, AND DO NOT READ IT AS A FAULT.
 * MEASURED 2026-08-15 (read-only probe, 29 Indigo customers × 3 dates): 87/87 pulls in 141s
 * = 1.62s per pull wall-clock, inter-call delay included. At 5 dates that is 145 pulls ≈ 235s
 * against ERA835_BUDGET_MS (210s), so roughly the last ~15 pulls of a run do not launch.
 * That degrades exactly as designed: expandDateRange returns ASCENDING, so the budget cut
 * skips the NEWEST date, which remains in the trailing window for up to 4 more daily runs and
 * is picked up as it ages — and every re-pull is free because both tables dedup on
 * row_fingerprint. Watch pulls_skipped_budget in staging.era_835_ingest_run; if it does NOT
 * fall toward zero as the window rolls, the fix is a second Indigo slot (split the roster),
 * NOT a shorter delay.
 *
 * COVERAGE + CREDENTIAL, both measured by that same probe and both previously unknown:
 * 26 of 29 customers returned remits — 244 remits, $1,347,567.45 positive (ACH $958,139.67 /
 * CHK $389,427.78), 53 zero-dollar remits, ZERO negatives, over a 3-day receipt window. And
 * 0 failures of any code across 87 pulls: no 401/403, so the CMD credential DOES carry the
 * Payment role on Indigo's account 474623. 25 of the 87 were empty-days classified correctly
 * against the existing KNOWN_EMPTY_DAY_DIGESTS allowlist, so Indigo needs no new digest.
 * Two independent runs 4 minutes apart agreed to the cent.
 */
export function handleIndigoEra835IngestCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleEra835IngestCronForTenant(req, {
    label: 'indigo-era-835',
    customers: INDIGO_CUSTOMERS,
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
 * its own thin wrapper + route for log/Cron-tab attribution, mirroring the explorer
 * crons. (The IP wrapper/route were decommissioned 2026-07-29 with the dead IP pair —
 * only OP remains on this path, soaking until the consolidated feed proves 5 clean
 * nights; see handleBillingAuditConsolidatedCron.)
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
      // Honest-empty accounting (recon item 6, 2026-07-29): WRC is expected-empty; any
      // other SUCCESS-empty customer that has landed rows before marks the run partial.
      expectedEmptyCustomerIds: EXPECTED_EMPTY_AUDIT_CUSTOMERS,
      hasPriorRows: (facilityCode) => auditFacilityHasRows(facilityCode),
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

/** OP audit ingest cron (/api/cron/billing-audit-op). Roster = AUDIT_OP_CUSTOMERS (9).
 *  Stays live until the consolidated feed proves 5 clean nights (cutover ruling
 *  2026-07-29); the dead IP pair's cron was decommissioned the same day. */
export function handleBillingAuditOpCron(req: {
  method?: string;
  authorization?: string | null;
}): Promise<{ status: number; body: unknown }> {
  return handleBillingAuditCronForScope(req, 'OP');
}

/** Has this facility EVER landed audit rows? — the honest-empty seed (recon item 6).
 *  Runs on the writer pool inside withTenant (the 0049 writer SELECT policy is
 *  GUC-scoped). Non-PHI: a boolean over facility_code. */
async function auditFacilityHasRows(facilityCode: string): Promise<boolean> {
  return withTenant(auditWriterDb(), BXR_TENANT_ID, async (client) => {
    const res = await client.query<{ has: boolean }>(
      'select exists(select 1 from claims.audit_row where business_entity_id = $1 and facility_code = $2) as has',
      [BXR_TENANT_ID, facilityCode],
    );
    return res.rows[0]?.has ?? false;
  });
}

/** Customer ids already processed (or legitimately empty) by an earlier CONSOLIDATED
 *  run TODAY (UTC) — the multi-pass nightly design: the schedule fires the route
 *  several times (the 17-customer × 2-filter sweep exceeds one 300s invocation) and
 *  each pass skips work a prior pass finished. Budget-skipped / failed customers are
 *  NOT in the set, so they retry on the next pass. */
async function consolidatedProcessedToday(): Promise<Set<string>> {
  return withTenant(auditWriterDb(), BXR_TENANT_ID, async (client) => {
    const res = await client.query<{ per_customer: PerCustomerOutcome[] }>(
      "select per_customer from claims.audit_ingest_run " +
        "where business_entity_id = $1 and scope = 'CONSOLIDATED' and started_at >= date_trunc('day', now())",
      [BXR_TENANT_ID],
    );
    const done = new Set<string>();
    for (const run of res.rows) {
      for (const c of run.per_customer ?? []) {
        if (c.outcome === 'processed' || c.outcome === 'empty') done.add(c.customer_id);
      }
    }
    return done;
  });
}

/**
 * CONSOLIDATED audit ingest cron (/api/cron/billing-audit-consolidated) — report
 * 10064394, filter B then C per customer, scope TOB-derived per row (recon 2026-07-29).
 * Multi-pass nightly: vercel.json fires this route more than once; each pass processes
 * roster customers no earlier pass finished today. OP-scope rows are fetched + counted
 * but written only when CMD_AUDIT_CONSOLIDATED_OP_WRITE is on (the soak deferral —
 * see auditConsolidated.ts). Env-var-only ids; CRON_SECRET-gated; non-PHI counts only.
 */
export async function handleBillingAuditConsolidatedCron(req: {
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
  const startedAt = new Date().toISOString();
  try {
    const ids = consolidatedAuditReportIds(process.env); // throws on missing env — names only
    const writerUser = await assertAuditWriterIdentity();
    const base = cmdApiConfig();
    const done = await consolidatedProcessedToday();
    const remaining = AUDIT_CONSOLIDATED_CUSTOMERS.filter((c) => !done.has(c.customerId));
    if (remaining.length === 0) {
      // A prior pass finished the roster — a quick no-op, deliberately NOT recorded as
      // an ingest run (nothing was ingested; the run rows that did the work exist).
      console.log('billing-audit consolidated cron: roster already completed today — no-op pass');
      return { status: 200, body: { ok: true, noop: true, completed_today: done.size } };
    }
    const stats = await consolidatedAuditCron({
      customers: remaining,
      fetchZip: (customerId, filterId) =>
        cmdRunReportToZip({
          ...base,
          customerId,
          reportId: ids.reportId,
          filterId,
          // Same dedicated audit poll tuning as the per-scope crons (heavier reports
          // than the collections explorer; ceiling 18×5s=90s, empty-grace 6).
          pollIntervalMs: Number(process.env.CMD_AUDIT_POLL_INTERVAL_MS) || 5_000,
          maxPollAttempts: Number(process.env.CMD_AUDIT_POLL_ATTEMPTS) || 18,
          emptyGraceAttempts: Number(process.env.CMD_AUDIT_EMPTY_GRACE) || 6,
        }),
      filterBId: ids.filterBId,
      filterCId: ids.filterCId,
      zipToCsvTexts: (zip) => readZipEntries(zip).map((e) => e.data.toString('utf8')),
      writeDb: auditWriterDb(),
      businessEntityId: BXR_TENANT_ID,
      sourceReportId: ids.reportId,
      writeOpScopeRows: consolidatedOpWriteEnabled(process.env),
      expectedEmptyCustomerIds: EXPECTED_EMPTY_AUDIT_CUSTOMERS,
      hasPriorRows: (facilityCode) => auditFacilityHasRows(facilityCode),
      revalidate: () => revalidateTag('billing-audit'),
    });
    try {
      await recordAuditIngestRun(
        auditWriterDb(),
        BXR_TENANT_ID,
        { scope: 'CONSOLIDATED', sourceReportId: ids.reportId, writerUser, startedAt },
        stats,
      );
    } catch (e) {
      console.error('billing-audit consolidated cron: audit_ingest_run write failed (non-fatal):', e instanceof Error ? e.message : String(e));
    }
    return { status: 200, body: { ok: true, writer_user: writerUser, ...stats } };
  } catch (err) {
    console.error('billing-audit consolidated cron failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'cron_failed' } };
  }
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

/** MTD/YTD collections KPIs by facility (non-PHI; anchored to latest payment_date). Per-tenant cache.
 *  Collections-tab variant: bounded at today, so CMD's forward-dated deposits are excluded. */
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
 * Overview variant of dashboardCollectionsKpis — INCLUDES forward-dated deposits.
 *
 * A SEPARATE unstable_cache with its own key part, deliberately, rather than a boolean argument
 * on the one above. Both surfaces call with the same entityIds, so sharing a cache entry would
 * let whichever surface rendered first decide what the other sees — the Collections tab could
 * serve Overview's future-inclusive figures, silently defeating the split. Distinct keys make
 * that impossible rather than merely unlikely.
 */
export const dashboardCollectionsKpisOverview = unstable_cache(
  async (entityIds: string[]): Promise<CollectionsKpis> =>
    collectionsKpis(
      { include_future_payments: true },
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard', entityIds },
    ),
  ['dashboard-collections-kpis-overview'],
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

/** Latest-month daily collections rows (non-PHI; date × facility × checks/eft/gross). Per-tenant cache.
 *  Collections-tab variant: bounded at today. */
export const dashboardCollectionsDaily = unstable_cache(
  async (entityIds: string[]): Promise<CollectionsDailyResult> =>
    collectionsDaily(
      {},
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard', entityIds },
    ),
  ['dashboard-collections-daily'],
  { revalidate: DASHBOARD_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/** Overview variant of dashboardCollectionsDaily — INCLUDES forward-dated deposits. Separate
 *  cache key for the reason given on dashboardCollectionsKpisOverview. */
export const dashboardCollectionsDailyOverview = unstable_cache(
  async (entityIds: string[]): Promise<CollectionsDailyResult> =>
    collectionsDaily(
      { include_future_payments: true },
      { executor: readerExecutor(), createdBy: 'phase71-collections-dashboard', entityIds },
    ),
  ['dashboard-collections-daily-overview'],
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
  /** Overview passes true so a forward-dated deposit inside the selected month is counted.
   *  Not cached, so unlike the two wrappers above this can safely be a plain argument. */
  includeFuturePayments = false,
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
    { from, to, include_future_payments: includeFuturePayments },
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
    // 2026-08-02: 10091828 / 10147241 went INVALID CRITERIA (the pair had been unexercised since
    // the 2026-06-25 manual CSV ingest; a dry run against it returned no identifier at all). These
    // are the rebuilt replacements, probed the same day: 1,063 rows, 8 columns, spanning
    // 2023-08 .. 2026-07 — so unlike the explorer filters this one is all-history, not a rolling
    // window. Two of its labels differ from the old report ('Charge Current Payer Name',
    // 'Payment Total Paid') and are registered as aliases in cmdPayer.ts PAYER_KEYS / PAID_KEYS.
    // The old ids are DEAD — do not restore them as fallbacks.
    reportId: process.env.CMD_REPORT_ID?.trim() || '10093971',
    filterId: process.env.CMD_FILTER_ID?.trim() || '10148488',
    auth,
    // CMD batch reporting is async (run → poll a base64 zip). Bound the poll so a
    // slow/contended report (one-at-a-time per partner, 20-min server cap) fails
    // fast and the dashboard falls back to the matview range instead of hanging.
    // The payer report typically completes in well under a minute.
    pollIntervalMs: Number(process.env.CMD_POLL_INTERVAL_MS) || 4_000,
    maxPollAttempts: Number(process.env.CMD_POLL_ATTEMPTS) || 12, // ~48s ceiling
  };
}

/** The BXR customer accounts a WHOLE-BOOK payer pull must cover. CMD scopes by customer and one
 *  customer == one facility, so both payer surfaces (this live gap read and the rollup cron) loop
 *  the roster; cmdApiConfig()'s single `customerId` covers exactly one facility. */
function bxrPayerCustomerIds(): string[] {
  return BXR_CUSTOMERS.map((c) => c.customerId);
}

export async function payerGapCmdForMonth(year: number, month: number): Promise<PayerGapSummary> {
  // WHOLE BOOK. Before 2026-08-02 this pulled cmdApiConfig()'s single account and, with the old
  // pair dead, always threw — so loadPayerGapCmd fell through to its matview fallback and the
  // one-facility scope never showed. Now that the pair resolves, a single-account pull would
  // return a plausible-looking ~1/10th of the book instead of falling back. Measured on the new
  // report: one account = $1.4M for 2026-05 against the book's $11.4M.
  return cmdPayerGapForMonth(year, month, cmdApiConfig(), bxrPayerCustomerIds());
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
 * Live-fetch config for ONE CMD customer account. Report 10093959 / filter 10148478 is the
 * batch export (the explorer columns + Check/EFT + Claim Status) windowed on PAYMENT
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
    // 2026-08-01: report 10091971 / filter 10147530 were LOST in CMD and every pairing under
    // 10091971 now returns INVALID CRITERIA — the BXR explorer cron ran 0/15 for ~3h. These are
    // the replacements (10093959 / 10148478), verified saved under all 15 BXR customers and
    // column-for-column value-matched against the old export before being adopted; see the ALIAS
    // PROVENANCE block in src/collections/cmdExplorer.ts. The old ids are DEAD — do not restore
    // them as fallbacks.
    //
    // ⚠ THE NOTE THAT USED TO SIT HERE WAS STALE AND IT MATTERED (corrected 2026-08-17, while
    // scoping the 10093959 → 10094775 repoint). It claimed "cmdBxrCensusConfigFor spreads this
    // config, so this reportId is the CENSUS's report too". It does spread it — and then
    // OVERRIDES both fields: `reportId: requiredCensusReportId('CMD_BXR_CENSUS_REPORT_ID')` and
    // `filterId: requiredCensusFilterId('CMD_BXR_CENSUS_FILTER_ID')`, neither with a fallback. The
    // census therefore takes NOTHING from this pairing but the credentials and poll tuning.
    // Changing CMD_EXPLORER_REPORT_ID moves the explorer alone; the stale note made that flip look
    // like it would drag the census onto an unsaved filter and stall it, which is precisely the
    // kind of phantom coupling that stops a correct change from being made.
    reportId: process.env.CMD_EXPLORER_REPORT_ID?.trim() || '10093959',
    filterId: process.env.CMD_EXPLORER_FILTER_ID?.trim() || '10148478',
    pollIntervalMs: Number(process.env.CMD_EXPLORER_POLL_INTERVAL_MS) || 3_000,
    maxPollAttempts: Number(process.env.CMD_EXPLORER_POLL_ATTEMPTS) || 8,
    emptyGraceAttempts: Number(process.env.CMD_EXPLORER_EMPTY_GRACE) || 4,
  };
}

/**
 * Live-fetch config for ONE Indigo CMD customer account (report 10092391 / filter 10148487 —
 * see the dated note on filterId below; predecessors 10147669 and 10147602 are retired).
 * Indigo's equivalent of BXR's 10093959/10148478, on the SAME CMD_API_* partner creds. Overridable
 * via CMD_INDIGO_REPORT_ID / CMD_INDIGO_FILTER_ID without a deploy; poll tuning is shared with the
 * BXR explorer cron (identical CMD batch behavior). customerId varies per call to cover all 30
 * Indigo facilities. The "Customer Name" → "Facility Name" alias is applied by the cron wrapper
 * (transformRows: aliasIndigoFacilityColumn), NOT here — this only selects the report/filter.
 */
function cmdIndigoConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdApiConfig(),
    customerId,
    reportId: process.env.CMD_INDIGO_REPORT_ID?.trim() || '10092391',
    // 2026-08-02: switched from 10147669 (a TRAILING ~4-week window: probed 2026-07-06 .. 2026-08-05,
    // 2,393 rows over 3 sampled accounts) to 10148487, Indigo's OWN current-period filter (probed
    // 2026-08-03 .. 2026-08-05, 211 rows over the same 3 accounts, 0 erroring, identical 22-column
    // projection). Indigo no longer rides a BXR-shaped trailing window.
    // TWO CONSEQUENCES, both verified, neither a blocker for the switch itself:
    //   1. This does NOT by itself surface the 08/03-08/05 payments. Both filters already return
    //      them; dropFuturePaymentRows (cmdExplorerCron.ts) drops every payment_received > today,
    //      so they land only once the calendar reaches each date.
    //   2. The trailing window was Indigo's ONLY self-heal for late-arriving prior-month
    //      adjustments — cmd-explorer-catchup is BXR-only (cmdExplorerCatchupConfigFor spreads
    //      cmdExplorerConfigFor). Until an Indigo catch-up exists, a July adjustment posted in
    //      August is never re-pulled.
    filterId: process.env.CMD_INDIGO_FILTER_ID?.trim() || '10148487',
    pollIntervalMs: Number(process.env.CMD_EXPLORER_POLL_INTERVAL_MS) || 3_000,
    maxPollAttempts: Number(process.env.CMD_EXPLORER_POLL_ATTEMPTS) || 8,
    emptyGraceAttempts: Number(process.env.CMD_EXPLORER_EMPTY_GRACE) || 4,
  };
}

/**
 * Live-fetch config for ONE BXR customer against CMD's "what reflects in the bank" report
 * (10050915). Filters saved under it: 10148489 "this month" (the daily default) and 10148490
 * "last month". Overridable via CMD_RECONCILE_REPORT_ID / CMD_RECONCILE_FILTER_ID.
 *
 * A default filter is safe here where the catch-up cron demands env — this path is READ-ONLY, so
 * the worst case of a wrong window is a useless comparison, not a bad write.
 *
 * Poll budget is its own: a clean single-customer pull measured 11-42s on 2026-08-03. The
 * >14-minute timeouts seen on 08-02 were contention from concurrent manual probes against CMD's
 * one-report-at-a-time partner slot, not this report being slow.
 */
function cmdReconcileConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdExplorerConfigFor(customerId),
    reportId: process.env.CMD_RECONCILE_REPORT_ID?.trim() || '10050915',
    filterId: process.env.CMD_RECONCILE_FILTER_ID?.trim() || '10148489',
    pollIntervalMs: Number(process.env.CMD_RECONCILE_POLL_INTERVAL_MS) || 5_000,
    maxPollAttempts: Number(process.env.CMD_RECONCILE_POLL_ATTEMPTS) || 12,
  };
}

/** The catch-up (last-month) saved-filter id — REQUIRED from env, no default. A fallback to the
 *  explorer's rolling current-month filter would make the catch-up silently re-ingest the CURRENT
 *  month under a route named "catchup", so a missing env var must fail the run loudly instead. */
function requiredLastMonthFilterId(): string {
  const v = process.env.CMD_EXPLORER_LASTMONTH_FILTER_ID?.trim();
  if (!v) throw new Error('Missing CMD_EXPLORER_LASTMONTH_FILTER_ID (the CMD last-month saved-filter id; set in env, no default)');
  return v;
}

/** The catch-up REPORT id — REQUIRED from env, no default and NO fallback to the explorer's.
 *
 *  ⚠ THIS EXISTS BECAUSE THE FALLBACK ALREADY BROKE THIS CRON ONCE. Until 2026-08-17 the catch-up
 *  spread cmdExplorerConfigFor and overrode only the filter, so it inherited CMD_EXPLORER_REPORT_ID
 *  automatically. When the explorer was repointed 10093959 → 10094775, the catch-up silently paired
 *  the NEW report with CMD_EXPLORER_LASTMONTH_FILTER_ID=10148481, a filter saved under the OLD one.
 *  CMD saved filters are report-SCOPED, so every pairing returns INVALID CRITERIA.
 *
 *  That is the SAME failure the census hit on 2026-08-01 (report 10091971 → 10093959, BXR census
 *  0/15 for ~13h), and the census's fix was exactly this: require the report id so a report swap
 *  cannot silently re-pair it. The coupling is the bug — a config that "helpfully" follows another
 *  cron's report is a config that changes meaning when someone else edits an env var.
 *
 *  Failing loudly is the point: a missing var throws per customer, the run ledger records
 *  status='error', and nothing is written. That is strictly better than a green run against a
 *  window nobody intended. */
function requiredCatchupReportId(): string {
  const v = process.env.CMD_EXPLORER_CATCHUP_REPORT_ID?.trim();
  if (!v) throw new Error('Missing CMD_EXPLORER_CATCHUP_REPORT_ID (the CMD report the last-month filter is saved under; set in env, no default — it must NOT fall back to the explorer report, see the 2026-08-17 incident)');
  return v;
}

/** Catch-up config: the BXR explorer's poll settings + creds, with the catch-up's OWN report id and
 *  the LAST-MONTH filter — both required from env, neither inherited. The report and filter must be
 *  a pairing that exists together in the CMD UI; they are read from two vars ON PURPOSE so that
 *  changing one without the other fails loudly instead of returning INVALID CRITERIA. Same daily
 *  replace + fingerprint idempotency as the explorer — only the payment-received window differs. */
function cmdExplorerCatchupConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdExplorerConfigFor(customerId),
    reportId: requiredCatchupReportId(),
    filterId: requiredLastMonthFilterId(),
  };
}

// ---------------------------------------------------------------------------
// CMD charge-CENSUS (Qualify v2 ②b) — Feed 2 live-fetch config.
//
// The census filter is a TRAILING CHARGE CENSUS (all payment states), not the explorer's
// payment-received window. Neither the census report id nor its filter id has a hardcoded default
// (no-fallback-throw): a census pull against the wrong pairing would silently mis-populate the
// openCount DENOMINATOR, so a missing env var must fail the run loudly instead.
// Env (set in Vercel, never hardcoded/logged): CMD_BXR_CENSUS_REPORT_ID, CMD_BXR_CENSUS_FILTER_ID,
// CMD_INDIGO_CENSUS_FILTER_ID.
//
// BXR NO LONGER SHARES THE EXPLORER'S REPORT (2026-08-01, incident-driven). It used to spread
// cmdExplorerConfigFor and override only the filter. CMD saved filters are report-SCOPED, so when
// report 10091971 was lost and the explorer was repointed to 10093959, the census silently inherited
// the NEW report while still naming a filter saved under the OLD one — every pairing returned
// INVALID CRITERIA and the BXR census ran 0/15 for ~13h (loud, no data loss: the run ledger keeps
// status='error', so isCustomerFresh never marks those customers fresh and the cron retries hourly).
// A fallback to the explorer's report would reintroduce exactly that coupling, hence required-throw.
//
// INDIGO DELIBERATELY STILL SPREADS cmdIndigoConfigFor. Its pairing (report 10092391 / census filter
// 10148129) is live and healthy, so making a report id REQUIRED there would take a working feed down
// on deploy. Asymmetric on purpose; the follow-up is a dedicated Indigo census report.
// ---------------------------------------------------------------------------

/** The census saved-filter id — REQUIRED from env, no default (see the block comment above). */
function requiredCensusFilterId(envVar: 'CMD_BXR_CENSUS_FILTER_ID' | 'CMD_INDIGO_CENSUS_FILTER_ID'): string {
  const v = process.env[envVar]?.trim();
  if (!v) throw new Error(`Missing ${envVar} (the CMD census saved-filter id; set in env, no default)`);
  return v;
}

/** The census REPORT id — REQUIRED from env, no default. Deliberately NOT defaulted to the explorer's
 *  report: that coupling is what broke the census on 2026-07-31 (see the block comment above). */
function requiredCensusReportId(envVar: 'CMD_BXR_CENSUS_REPORT_ID'): string {
  const v = process.env[envVar]?.trim();
  if (!v) throw new Error(`Missing ${envVar} (the CMD census report id; set in env, no default)`);
  return v;
}

/** BXR census config: the explorer's creds + poll tuning, but its OWN report AND filter (env, no
 *  fallback on either). Poll tuning stays shared — identical CMD batch behavior, one knob to turn. */
function cmdBxrCensusConfigFor(customerId: string): CmdApiConfig {
  return {
    ...cmdExplorerConfigFor(customerId),
    reportId: requiredCensusReportId('CMD_BXR_CENSUS_REPORT_ID'),
    filterId: requiredCensusFilterId('CMD_BXR_CENSUS_FILTER_ID'),
  };
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
  // ⚠ requireWindow: the Collections window must be CLOSED at both ends. Opted in HERE, at the
  // Collections boundary, rather than defaulted inside the shared builder — see
  // CmdExplorerBuilderOptions. Payer Intel and the retired-but-routable Qualify loaders call the
  // same builders and omit this, keeping their own window semantics.
  const { sql, params } = buildCmdExplorerQuery(cursor, filter, sort, limit, entityIds, {
    requireWindow: true,
  });
  const { rows } = await readerExecutor().query<CmdExplorerDbRecord>(sql, params);
  const hasMore = rows.length > CMD_EXPLORER_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, CMD_EXPLORER_PAGE_SIZE) : rows).map(toExplorerRow);
  const last = page[page.length - 1];
  const nextCursor: CmdExplorerCursor | null =
    hasMore && last ? { id: last.id, value: cmdExplorerSortValue(last, sort.column) } : null;
  return { rows: page, nextCursor };
}

/**
 * GROUPED explorer page — one row per (patient x payment date x facility x payer).
 *
 * Mirrors loadCmdExplorerPage exactly, including the over-fetch-by-one that detects a next page
 * without a count(*). The cursor is the SAME {id, value} shape: `id` is the group's representative
 * (max) rollup id and `value` is its payment date, which together are a total order.
 *
 * Sort is fixed to payment_received in v1 — see the builder for why ordering groups by an aggregate
 * is deferred rather than unsupported.
 */
async function loadCmdExplorerGroupedPage(
  cursor: CmdExplorerCursor | null,
  filter: CmdExplorerFilter,
  direction: 'asc' | 'desc',
  entityIds: string[],
  sortColumn: GroupedSortColumn,
): Promise<CmdExplorerGroupPage> {
  const limit = CMD_EXPLORER_PAGE_SIZE + 1;
  // ⚠ requireWindow: the Collections window must be CLOSED at both ends. Opted in HERE, at the
  // Collections boundary, rather than defaulted inside the shared builder — see
  // CmdExplorerBuilderOptions. Payer Intel and the retired-but-routable Qualify loaders call the
  // same builders and omit this, keeping their own window semantics.
  const { sql, params } = buildCmdExplorerGroupedQuery(cursor, filter, direction, limit, entityIds, {
    requireWindow: true,
    groupedSort: sortColumn,
  });
  const { rows } = await readerExecutor().query<CmdExplorerGroupRow & { id: string }>(sql, params);
  const hasMore = rows.length > CMD_EXPLORER_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, CMD_EXPLORER_PAGE_SIZE) : rows).map((r) => ({
    ...r,
    // pg returns bigint as a STRING even though the row type says number — Number() it once here so
    // no caller compares a string id (the cursor tiebreak depends on it being numeric).
    id: Number(r.id),
  }));
  const last = page[page.length - 1];
  // STAMPED WITH THE ORDERING THAT PRODUCED IT, so the next request can detect a cursor that
  // belongs to a different ordering instead of comparing the wrong quantity — see
  // resolveGroupedCursor.
  const nextCursor: CmdExplorerCursor | null =
    hasMore && last
      ? {
          id: last.id,
          value: cmdExplorerGroupSortValue(last, sortColumn),
          sort: groupedSortStamp(sortColumn, direction),
        }
      : null;
  return { rows: page, nextCursor };
}

/**
 * Cached grouped page. Same posture as loadCmdExplorerNonPhi: NO PHI is projected (the group key
 * uses member_id_bidx, an HMAC token, and it is never returned), entityIds is part of the cache key
 * so a BXR page can never be served to an Indigo request, and the cron busts the shared tag.
 */
export const loadCmdExplorerGroupedNonPhi = unstable_cache(
  (
    cursor: CmdExplorerCursor | null,
    filter: CmdExplorerFilter,
    direction: 'asc' | 'desc',
    entityIds: string[],
    // ⚠ PART OF THE CACHE KEY, AND IT HAS TO BE. unstable_cache keys on the ARGUMENT LIST, so a
    // sort column carried in any other way (a module constant, a field on `filter` set later, a
    // closure) would let a totals-ordered page be served for a date-ordered request at the same
    // cursor — wrong rows, in the wrong order, with no error and a 15-minute lifetime.
    sortColumn: GroupedSortColumn,
  ): Promise<CmdExplorerGroupPage> =>
    loadCmdExplorerGroupedPage(cursor, filter, direction, entityIds, sortColumn),
  ['cmd-explorer-grouped'],
  { revalidate: 900, tags: ['cmd-explorer'] },
);

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
  // ⚠ requireWindow: the Collections window must be CLOSED at both ends. Opted in HERE, at the
  // Collections boundary, rather than defaulted inside the shared builder — see
  // CmdExplorerBuilderOptions. Payer Intel and the retired-but-routable Qualify loaders call the
  // same builders and omit this, keeping their own window semantics.
  const { totals, groups, combo } = buildCmdSearchSummaryQueries(filter, entityIds, undefined, {
    requireWindow: true,
  });
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
 * Qualify's facility options — ONE ROW PER FACILITY, with every raw CMD spelling in `variants`.
 *
 * Separate from cmdExplorerFacilities on purpose: the Collections explorer keeps the raw-text-grain
 * option list (it is production and out of scope), while Qualify's picker needs the de-duplicated
 * shape so `LONESTAR MENTAL HEALTH` and `LONESTAR MENTAL HEALTH LLC` stop rendering as two
 * indistinguishable rows. Same vocabulary, same crosswalk, different GROUP BY — see
 * buildQualifyFacilityOptionsQuery.
 *
 * Own cache key, same 'cmd-facilities' tag and 1-hour timer as the explorer list: the vocabulary is
 * the same near-static set, so both should warm and expire together.
 */
export const qualifyFacilityOptions = unstable_cache(
  async (entityIds: string[]): Promise<QualifyFacilityOption[]> => {
    const { sql, params } = buildQualifyFacilityOptionsQuery(entityIds);
    const { rows } = await readerExecutor().query<{
      display: string | null;
      value: string;
      variants: string[] | null;
      care_setting: string | null;
    }>(sql, params);
    return rows.map((r) => ({
      value: r.value,
      // array_agg always contains at least the grouped row, but a null would silently drop the
      // facility from the filter rather than the list — fall back to the canonical value.
      variants: Array.isArray(r.variants) && r.variants.length > 0 ? r.variants : [r.value],
      display: r.display ?? r.value,
      care_setting:
        r.care_setting === 'IP' || r.care_setting === 'OP' || r.care_setting === 'BOTH' ? r.care_setting : null,
    }));
  },
  ['qualify-facility-options'],
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
/**
 * COLLECTIONS-NATIVE employer options (migration 0101) — the guided employer type-ahead on the
 * Collections explorer. Reads collections.cmd_explorer_rows.employer_name, the value CMD puts on
 * the report itself.
 *
 * ⚠ NOT cmdExplorerEmployers BELOW, and the two must not be merged. That one reads
 * vob.member_benefits_latest and serves QUALIFY. Ruled 2026-08-15: Collections reads collections
 * data only — CMD is the source of truth for collections, VOB is not. The coverage difference is
 * the point: the VOB set only knows members with a VOB on file.
 *
 * Server-side per-keystroke (the employer vocabulary is large), tenant-scoped through entityIds so
 * a picked option always has rows the caller can see. Rides its own cache tag: this vocabulary
 * changes on the PAYMENT cron (a new charge can introduce a new employer), unlike the VOB one
 * which only changes on the VOB sync. Reader-only.
 */
/**
 * The Collections employer vocabulary, CANONICALISED (2026-08-17).
 *
 * Loads every distinct raw spelling for the tenant scope (1,073 live, 118 ms index scan) and groups
 * them into canonical options — `TESLA INC` / `TESLA, INC.` / `TESLA,INC.` become one `TESLA`
 * carrying all three as `variants`. The client sends the VARIANTS as `employer_names`, so the SQL
 * predicate stays `employer_name = any(...)` and no migration or expression index is involved.
 *
 * Grouping happens HERE rather than in the client so the canonical rule has exactly one home and is
 * covered by the root hermetic suite (test/employerCanonical.test.ts). Cached like its siblings: the
 * vocabulary changes on the PAYMENT cron, when a new charge introduces a new employer.
 */
export const cmdExplorerCollectionsEmployerVocabulary = unstable_cache(
  async (entityIds: string[]): Promise<CanonicalEmployer[]> => {
    const { sql, params } = buildCmdCollectionsEmployerVocabularyQuery(entityIds);
    const { rows } = await readerExecutor().query<{ employer_name: string }>(sql, params);
    return groupEmployerNames(rows.map((r) => r.employer_name));
  },
  ['cmd-explorer-collections-employer-vocabulary'],
  { revalidate: 3600, tags: ['cmd-collections-employers'] },
);

/**
 * Does this tenant have ANY collections employer data yet? Gates the All/Employer/Individual
 * segment toggle so "Individual" is never offered while it would mean "the entire book".
 *
 * `employer_name IS NULL` reads as "individual policy" only once the CMD reports carry the column
 * AND the one-shot backfill has run; before that it means "not yet populated" and every row
 * qualifies. This boolean is what lets the UI tell those two states apart.
 *
 * Cached for an hour: the answer flips exactly once in this system's life (when the backfill
 * lands), so re-asking per request would be pure waste — and the negative answer is the expensive
 * one to compute, which is also the one served most often before cutover.
 */
export type CmdEmployerCoverage = {
  /** ANY selected tenant has employer values — gates whether the segment/type-ahead is shown. */
  hasEmployerData: boolean;
  /** EVERY selected tenant has them — gates the "Individual" LABEL. False in Consolidated while
   *  Indigo carries none, so an Indigo blank renders '—' instead of asserting "no employer". */
  allHaveEmployerData: boolean;
};

export const cmdExplorerEmployerCoverage = unstable_cache(
  async (entityIds: string[]): Promise<CmdEmployerCoverage> => {
    const { sql, params } = buildCmdEmployerCoverageQuery(entityIds);
    const { rows } = await readerExecutor().query<{
      has_employer_data: boolean;
      all_have_employer_data: boolean;
    }>(sql, params);
    return {
      hasEmployerData: rows[0]?.has_employer_data === true,
      allHaveEmployerData: rows[0]?.all_have_employer_data === true,
    };
  },
  ['cmd-explorer-employer-coverage'],
  { revalidate: 3600, tags: ['cmd-collections-employers'] },
);

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

/**
 * Upper bound on how many MEMBER POLICIES one patient-name search may resolve to.
 *
 * ⚠ THIS IS NOT THE OLD ROW CAP RENAMED — the unit changed, and that is the whole point of 0105.
 * The old CMD_NAME_SEARCH_ROW_CAP counted CHARGE LINES, so 2,000 of them was 0.3% of a 686,503-row
 * book and the search had to be gated behind "narrow by facility/payer/date first" to fit inside
 * it. This counts PATIENTS' member policies, and the entire book holds 10,941 of them — so 2,000 is
 * 18% of every policy in the system, a term so broad it cannot mean a person. The gate is gone
 * because the cap it existed to protect is gone.
 */
export const CMD_NAME_SEARCH_MEMBER_CAP = 2000;

/** Shortest term the search will run. One character matches most of the book and says nothing. */
export const CMD_NAME_SEARCH_MIN_TERM = 2;

export type CmdNameSearchResult =
  | {
      ok: true;
      /**
       * (tenant, member) PAIRS for the grid predicate. Non-PHI — the member value is a one-way HMAC.
       *
       * ⚠ THE TENANT IS PART OF THE ANSWER, not decoration. A member blind index is an HMAC of the
       * member id alone, so it is tenant-agnostic: 240 of 10,701 live tokens exist in BOTH tenants.
       * Returning bare tokens let a name matched in one tenant select the other's rows for those
       * 240, in Consolidated view where both are visible and the mix is invisible.
       */
      members: Array<{ entity: string; member: string }>;
      /** Distinct NAMES matched. Differs from members.length when a policy carries dependents. */
      matchedPatients: number;
      /**
       * Minutes since the directory sync last advanced. The sync runs hourly, so >180 means it has
       * failed roughly three times running.
       *
       * ⚠ NEITHER NUMBER IS THE ALARM ON ITS OWN — it takes BOTH, and each alone was wrong once. A partial directory is indistinguishable from a
       * complete one to the empty-guard, so a patient past the watermark reads as "no match" while
       * the UI promises the whole book — that is the silent miss this design exists to prevent. But
       * the FIRST version alarmed on lag > 0, which is true for most of every hour on a perfectly
       * healthy system (~6,000 lines/day, and nearly all of them belong to patients already indexed).
       * An always-on warning is not a safeguard; it is training to ignore warnings.
       */
      indexStaleMinutes: number;
      /** Charge lines not yet indexed. The SIZE of the exposure, meaningful only once stale. */
      indexLagRows: number;
      /**
       * DISTINCT PATIENT NAMES in the caller's tenant scope — the honest denominator for "N of M
       * matched". NOT the number of directory rows: the directory is keyed on (member, name), and
       * a name that appears under two member policies is two rows and one patient. Measured live
       * 2026-08-18: 11,161 rows, 9,986 distinct names — reporting the row count would over-state
       * the book by 12% in a number the user reads.
       */
      patientsInScope: number;
    }
  /** Matched more policies than may be listed. `count` is what the user must get below. */
  | { ok: false; reason: 'too_broad'; count: number; cap: number }
  | { ok: false; reason: 'term_too_short'; min: number }
  /**
   * The name index cannot answer. Kept DISTINCT from "no matches" on purpose — both render as an
   * empty grid, and conflating them would report "this patient is not in the book" when the truth
   * is "nothing has been indexed yet". `unavailable` means the 0105 tables are absent (merged but
   * not applied); `empty` means they exist and the sync has not populated them.
   */
  | { ok: false; reason: 'directory_unavailable' }
  | { ok: false; reason: 'directory_empty' };

/** Postgres SQLSTATE for "relation does not exist" — 0105 merged but not applied yet. */
const DIRECTORY_UNDEFINED_TABLE = '42P01';

/**
 * FULL-BOOK PATIENT-NAME SEARCH over the Collections explorer (migration 0105).
 *
 * ── WHAT CHANGED, AND WHY THE TWO OLD RESTRICTIONS ARE GONE ────────────────────────────────────
 * This used to decrypt CANDIDATE ROWS, which forced a 2,000-row ceiling and a "pick a facility /
 * payer / date first" gate. Both were consequences of the candidate set being ROWS. Measured live
 * 2026-08-18: the book is 686,503 charge lines but only 10,941 (tenant, member) pairs, and 11,000
 * libsodium decrypt + substring matches cost 10-17 ms warm. Decryption was never the constraint.
 * Reading the distinct set live WAS — 4,265 ms, seq scan plus a 106 MB external sort — so 0105
 * materialises it and this reads ~11k rows instead.
 *
 * Alec's two 2026-08-17 rulings are PRESERVED, not overturned:
 *   1. NO BLIND INDEX FOR MATCHING. `patient_name_bidx` still answers nothing here: an HMAC can
 *      only test equality on a whole normalized name, and this must match substrings ("smi").
 *      Matching is still done on DECRYPTED text. The directory's `name_fp` is a dedup key for the
 *      builder, never a search mechanism.
 *   2. NO IN-PROCESS DECRYPTED-NAME CACHE. Every search decrypts afresh. That ruling turned out to
 *      cost 15 ms, so there is nothing left to trade: a cache would hold the entire patient roster
 *      in plaintext in a long-lived server process to save a sixtieth of a second.
 *
 * The gate is gone because the thing it protected is gone. It was never a PHI control — it bounded
 * a decrypt, and the decrypt is now bounded by the directory's own grain.
 *
 * ── WHY THE RESULT IS MEMBER TOKENS, NOT ROW IDS ───────────────────────────────────────────────
 * A row-id list grows with charge lines (a single patient can carry 400), so it has to be capped
 * and the cap is what made the feature partial. A member-token list grows with PATIENTS. It also
 * lands on a column the grid's own rollup already carries and 0092 already indexes, so the grid
 * needs no join.
 *
 * The cost is a visible, bounded imprecision: 0.44% of members carry more than one patient name
 * (dependents on one subscriber policy), so matching a dependent returns that policy's whole set of
 * charge lines. That is an OVER-return and never a miss — the directory keys on the NAME, so every
 * distinct name is findable. Precise name-grain filtering would need cmd_explorer_rows.
 * patient_name_bidx backfilled (7.18% populated today, and its 0066 UPDATE grant to claims_reader
 * is inert under RLS — see 0105's header).
 *
 * ── PHI DISCIPLINE (unchanged, and the reason this is safe to expose) ──────────────────────────
 *   · The TERM arrives via a Server Action body: never logged, never in SQL, never in the URL,
 *     never audited into `detail`.
 *   · Decryption is in-process as claims_reader; plaintext is compared and DISCARDED.
 *   · Only one-way HMAC tokens leave this function. No name crosses the wire.
 *   · Audited fail-closed BEFORE returning, with counts only.
 *   · `entityIds` is server-derived (requirePhiPrincipal), so the directory read is tenant-scoped
 *     at the database and a token can only ever select rows the caller may already see.
 */
export async function searchCmdExplorerPatientName(
  term: string,
  actor: { email: string; userId: string },
  entityIds: string[],
): Promise<CmdNameSearchResult> {
  const needle = term.trim().toLowerCase();
  if (needle.length < CMD_NAME_SEARCH_MIN_TERM) {
    return { ok: false, reason: 'term_too_short', min: CMD_NAME_SEARCH_MIN_TERM };
  }

  const q = buildPatientDirectoryReadQuery(entityIds);
  let rows: Array<{
    business_entity_id: string;
    member_id_bidx: string;
    name_fp: string;
    patient_name: Buffer;
  }>;
  try {
    const res = await readerExecutor().query<{
      business_entity_id: string;
      member_id_bidx: string;
      name_fp: string;
      patient_name: Buffer;
    }>(q.sql, q.params);
    rows = res.rows;
  } catch (err) {
    // 42P01 means 0105 is merged but not applied. Returning "no matches" here would tell the user
    // that nobody in the book is called that, which is a lie a search must never tell.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === DIRECTORY_UNDEFINED_TABLE) {
      console.error('patient search: collections.cmd_patient_directory does not exist (migration 0105 not applied).');
      return { ok: false, reason: 'directory_unavailable' };
    }
    throw err;
  }

  // Applied BEFORE the decrypt loop: an unbuilt index must not be reported as an absent patient.
  if (rows.length === 0) return { ok: false, reason: 'directory_empty' };

  // Keyed by "entity\u0000member" so the SET dedupes PAIRS, not tokens — deduping on the token alone
  // would silently re-collapse the two tenants this whole change exists to keep apart.
  const memberPairs = new Map<string, { entity: string; member: string }>();
  const nameHits = new Set<string>();
  const namesInScope = new Set<string>();
  for (const r of rows) {
    namesInScope.add(r.name_fp);
    // One undecryptable row must not deny the whole search. Skipped silently — the error carries
    // ciphertext context and is deliberately NOT logged.
    let name: string;
    try {
      name = await decryptPhi(r.patient_name);
    } catch {
      continue;
    }
    if (name.toLowerCase().includes(needle)) {
      memberPairs.set(`${r.business_entity_id}\u0000${r.member_id_bidx}`, {
        entity: r.business_entity_id,
        member: r.member_id_bidx,
      });
      nameHits.add(r.name_fp);
    }
  }

  if (memberPairs.size > CMD_NAME_SEARCH_MEMBER_CAP) {
    return { ok: false, reason: 'too_broad', count: memberPairs.size, cap: CMD_NAME_SEARCH_MEMBER_CAP };
  }

  // How fresh is the index? Read AFTER the match so a healthy search pays nothing on the critical
  // path, and BEFORE the audit so the numbers are part of the recorded run.
  let indexStaleMinutes = 0;
  let indexLagRows = 0;
  try {
    const fq = buildPatientDirectoryFreshnessQuery();
    const fr = await readerExecutor().query<{ lag_rows: string; stale_minutes: number }>(fq.sql, fq.params);
    indexLagRows = Math.max(0, Number(fr.rows[0]?.lag_rows ?? 0));
    indexStaleMinutes = Math.max(0, Number(fr.rows[0]?.stale_minutes ?? 0));
  } catch {
    // Non-fatal: a failed freshness probe must not deny a search that already has its answer. Both
    // report 0 (= "believed current"), which is what the caller assumed before this existed — never
    // a fabricated non-zero that would raise a false incomplete-index warning.
    indexStaleMinutes = 0;
    indexLagRows = 0;
  }

  // Fail-closed audit BEFORE returning. Counts only — NEVER the term, a name, or a token.
  await recordAccess({
    actorEmail: actor.email,
    actorUserId: actor.userId,
    action: 'search_cmd_explorer_patient_name',
    detail: { scanned: rows.length, matched_patients: nameHits.size, matched_members: memberPairs.size },
  });
  return {
    ok: true,
    members: [...memberPairs.values()],
    matchedPatients: nameHits.size,
    patientsInScope: namesInScope.size,
    indexStaleMinutes,
    indexLagRows,
  };
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

/** EVERY payer behind the token, ranked (row [0] === resolveQualifyPayer by construction). The
 *  widening: 80.6% of member-weighted searches land on a prefix billing under more than one payer,
 *  and the narrow resolve above discarded all but the top one. Reader-scoped; token stays opaque. */
export async function loadQualifyPayerSpread(
  token: string,
  kind: QualifyTokenKind,
  entityIds: string[],
): Promise<QualifyPayerSpreadRow[]> {
  const q = buildResolvePayerSpreadQuery(token, kind, entityIds);
  const { rows } = await readerExecutor().query<QualifyPayerSpreadRow>(q.sql, q.params);
  return rows;
}

/** Per-facility dollar-weighted ranking rows for a resolved payer, in-window, cross-tenant. */
export async function loadQualifyFacilities(
  /** NULL = comparable-cohort (market narrow) or identifier-wide (token narrow) — the builder's
   *  chokepoint enforces that one of the two scopes is present. */
  payer: string | null,
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
  /** NULL = identifier-wide (the v3 Skip): the most-recent in-window claim under ANY label. */
  payer: string | null,
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

/** Compose-bar EVIDENCE count: distinct clients backing the composed match (readout gauge). Qualify-OWNED
 *  count over the SAME cmdExplorerBaseConds predicate as the match count (buildQualifyMatchClientCountQuery
 *  — does NOT touch Collections' summary builder). member_id_bidx is COUNTED, never projected. Cross-tenant
 *  via entityIds. 0 on empty (never null → the gauge always has a number). */
export async function loadQualifyMatchClientCount(filter: CmdExplorerFilter, entityIds: string[]): Promise<number> {
  const { sql, params } = buildQualifyMatchClientCountQuery(filter, entityIds);
  const { rows } = await readerExecutor().query<QualifyMatchClientCountRow>(sql, params);
  return rows[0]?.distinct_patients ?? 0;
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
  opts: { payer?: string | null } = {},
): Promise<QualifyFacilityTrendRow[]> {
  // Phase 2 (Design B): payer-only scope (exactly-one-payer) — NO market; the ticker is never
  // employer/funding-narrowed. The builder also enforces the both-window distinct-patient delta gate.
  const q = buildFacilityTrendQuery(from, to, priorFrom, entityIds, { payer: opts.payer ?? null });
  // The per-facility distinct-patient sort in this CTE spills to disk even at the 30-day window (the
  // pooler's ~3.5MB work_mem < the sort's footprint); at the 12-month window it spills ~34MB. A
  // TRANSACTION-SCOPED work_mem bump keeps the short-window sort in memory and roughly halves the
  // 12-month one — zero query-shape change. SET LOCAL is reset at COMMIT, so it cannot leak across the
  // transaction pooler (see PgExecutor.queryWithWorkMem). 32MB × the pool's max:4 concurrency = a
  // bounded worst case. This is the SOLE query granted the override.
  const { rows } = await readerExecutor().queryWithWorkMem<QualifyFacilityTrendRow>('32MB', q.sql, q.params);
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

// --- Facility Resolution (0084-0086) -----------------------------------------------
// The attribution engine's UI surface: overview + queue read the 0086 matview as claims_reader;
// manual assignments write through the 0085 SECURITY-DEFINER function (the 0047 grid-view
// precedent — claims_reader holds EXECUTE, never table DML); every write is followed by the 0086
// refresh function so the page the operator lands back on already reflects the assignment.
// TENANCY: the matview carries no RLS — every query here binds entityIds derived server-side.
// PHI: member_id_bidx only (HMAC token); no identifier, no name, ever. Notes are never logged.

/** Cache tag for the overview rollup; busted after every assignment write. */
const FACILITY_RESOLUTION_TAG = 'facility-resolution';

/** Per-method overview (charge grain), cached 15 min per entity scope. */
export const loadFacilityResolutionOverview = unstable_cache(
  async (entityIds: string[]): Promise<ResolutionOverviewRow[]> => {
    const { sql, params } = buildResolutionOverviewQuery(entityIds);
    const { rows } = await readerExecutor().query<ResolutionOverviewRow>(sql, params);
    return rows;
  },
  ['facility-resolution-overview'],
  { revalidate: 900, tags: [FACILITY_RESOLUTION_TAG] },
);

/** One queue page (keyset). Deliberately UNCACHED: the queue must reflect an assignment the
 *  moment the operator returns to it, and the (chips, sort, cursor) key space is unbounded. */
export interface ResolutionQueuePage {
  rows: ResolutionRow[];
  nextCursor: ResolutionCursor | null;
}

/** pg returns int8 as text; narrow id/assignment_id to numbers for the wire shape. */
interface ResolutionDbRecord extends Omit<ResolutionRow, 'id' | 'assignment_id'> {
  id: string;
  assignment_id: string | null;
}

export async function loadFacilityResolutionQueue(
  applied: readonly ResolutionChip[],
  sort: ResolutionSort | undefined,
  cursor: ResolutionCursor | null,
  entityIds: string[],
): Promise<ResolutionQueuePage> {
  const { sql, params } = buildResolutionQueueQuery(applied, sort, cursor, entityIds);
  const { rows } = await readerExecutor().query<ResolutionDbRecord>(sql, params);
  const hasMore = rows.length > RESOLUTION_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, RESOLUTION_PAGE_SIZE) : rows).map((r) => ({
    ...r,
    id: Number(r.id),
    assignment_id: r.assignment_id === null ? null : Number(r.assignment_id),
  }));
  const s = resolveResolutionSort(sort);
  const last = page[page.length - 1];
  const nextCursor: ResolutionCursor | null =
    hasMore && last ? { id: last.id, value: last[s.column] } : null;
  return { rows: page, nextCursor };
}

/** The assignment picker's canonical facility list: the ENTITY'S OWN facilities only (the 0086
 *  cross-book guard, applied to humans too — a BXR charge must never be assigned to an Indigo
 *  office). Codes come from the checked-in roster (cmdCustomers.ts), names from
 *  collections.facilities. Cached 15 min per scope.
 *
 *  Reads OWNED_CMD_CUSTOMERS, not the polling roster: a facility removed from CMD polling is
 *  still the tenant's, and a stray historical charge for it must stay assignable. Narrowing this
 *  to the polling roster would make the containment check in facility-resolution-actions.ts
 *  reject a legitimate in-book assignment as "not on this book's roster". */
export const loadResolutionFacilityOptions = unstable_cache(
  async (entityIds: string[]): Promise<Array<{ facility_code: string; facility_name: string }>> => {
    // No `!== undefined` guard: CmdCustomer.businessEntityId is a required string, so the conjunct
    // was always true and only read as though optional entries were handled. No Set-dedup either:
    // OWNED_CMD_CUSTOMERS is asserted duplicate-free on BOTH keys in test/upcomingForecast.test.ts.
    const codes = OWNED_CMD_CUSTOMERS.filter((c) => entityIds.includes(c.businessEntityId)).map(
      (c) => c.facilityCode,
    );
    if (codes.length === 0) return [];
    const { sql, params } = buildResolutionFacilityOptionsQuery(codes);
    const { rows } = await readerExecutor().query<{ facility_code: string; facility_name: string }>(
      sql,
      params,
    );
    return rows;
  },
  ['facility-resolution-facility-options'],
  { revalidate: 900, tags: [FACILITY_RESOLUTION_TAG] },
);

/** Bulk-by-member expansion: every UNRESOLVED charge key for the given members. Fails loud past
 *  the 0085 save bound (500 keys) rather than truncating a member's charges. */
export async function expandMemberUnresolvedKeys(
  entityIds: string[],
  memberBidxes: string[],
): Promise<ResolutionChargeKey[]> {
  const { sql, params } = buildMemberUnresolvedKeysQuery(entityIds, memberBidxes);
  const { rows } = await readerExecutor().query<ResolutionChargeKey>(sql, params);
  if (rows.length > 500) {
    throw new Error('expandMemberUnresolvedKeys: selection exceeds the 500-charge assignment bound');
  }
  return rows;
}

/** Write manual assignments (0085 definer function) and refresh the resolution matview (0086)
 *  so the caller's next read is already consistent. Returns the number written. The refresh is
 *  its own statement (REFRESH CONCURRENTLY cannot share a transaction) and its failure is
 *  surfaced — an assignment the queue doesn't reflect would look like a lost write. */
export async function saveFacilityAssignmentsAndRefresh(input: {
  userId: string;
  email: string;
  facilityCode: string;
  note: string;
  charges: ResolutionChargeKey[];
}): Promise<number> {
  const exec = readerExecutor();
  const res = await exec.query<{ save_facility_assignments: number }>(
    'select collections.save_facility_assignments($1, $2, $3, $4, $5::jsonb) as save_facility_assignments',
    [
      input.userId,
      input.email,
      input.facilityCode,
      input.note,
      JSON.stringify(
        input.charges.map((c) => ({
          business_entity_id: c.business_entity_id,
          member_id_bidx: c.member_id_bidx,
          charge_date: c.charge_date,
          cpt_key: c.cpt_key,
          revenue_key: c.revenue_key,
          facility_label: 'No Facility',
          charge_amount: c.charge_amount,
        })),
      ),
    ],
  );
  const written = Number(res.rows[0]?.save_facility_assignments ?? 0);
  await exec.query('select collections.refresh_facility_resolution()', []);
  revalidateTag(FACILITY_RESOLUTION_TAG);
  // ⚠ AND THE COLLECTIONS GRID — a SECOND tag, because they are genuinely different caches and
  // busting one does not touch the other.
  //
  // This is the originally reported symptom, in one line. Since 2026-08-30 the Collections
  // Facility cell falls back to this matview's attribution, so an assignment saved here CHANGES
  // WHAT THAT GRID RENDERS. But the grid's entries are `unstable_cache(..., { revalidate: 900,
  // tags: ['cmd-explorer'] })` (loadCmdExplorerNonPhi / loadCmdExplorerGroupedNonPhi), and
  // FACILITY_RESOLUTION_TAG is 'facility-resolution' — a different string. Without this call the
  // operator assigns a facility, the workbench updates immediately, and the grid keeps showing
  // 'No Facility' for up to FIFTEEN MINUTES with no way to force it. That reads as "the assignment
  // didn't work", which is exactly the failure this whole change set out to fix.
  //
  // One literal covers both grid modes: the row and grouped caches share the 'cmd-explorer' tag.
  //
  // SCOPED TO THE WRITE PATH ONLY, deliberately. The hourly :45 cron ALSO refreshes this matview
  // and busts NEITHER tag — that gap is real but it is the freshness-watermark follow-up, not this
  // line. Here we know a human just changed attribution and is waiting to see it.
  revalidateTag('cmd-explorer');
  return written;
}
