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
  dashboardCollectionsDailyOverview,
  dashboardCollectionsKpis,
  dashboardCollectionsKpisOverview,
  dashboardCollectionsSummary,
  dashboardCollectionsYoy,
  dashboardDistribution,
  facilitiesDimension,
  handleAgent,
  handleResults,
  payerCmdMonth,
  payerGapCmdForMonth,
  payerGapForRange,
  revealClaimById,
  searchClaimsDirect,
  loadCmdExplorerNonPhi,
  loadCmdSearchSummary as loadCmdSearchSummary_,
  loadCohortCurve as loadCohortCurve_,
  loadCohortDrilldown as loadCohortDrilldown_,
  streamCollectionsAiAnalysis as streamCollectionsAiAnalysis_,
  CollectionsAiInputSchema,
  type CollectionsAiInput,
  cmdExplorerFacilities,
  cmdExplorerPayers,
  cmdExplorerCollectionsEmployers,
  cmdExplorerEmployerCoverage,
  recordAccess,
  revealCmdExplorerRow,
  revealCmdExplorerRows,
  searchCmdExplorerPatientName,
  type CmdNameSearchResult,
  resolveCmdExplorerSort,
  resolveCmdExplorerCursor,
  CMD_EXPLORER_SEARCH_COLUMNS,
  sanitizeGridColumns,
  gridViewsFor,
  saveGridViewRow,
  setDefaultGridViewRow,
  deleteGridViewRow,
  type CmdExplorerSort,
  type CmdExplorerFilter,
  type CmdExplorerCursor,
  type CmdExplorerSearchColumn,
  type CmdSearchSummary,
  type CmdSearchGroup,
  type CmdComboGroup,
  type CmdFacilityOption,
  type CmdEmployerOption,
  type CohortCurve,
  type CohortCurvePoint,
  type CohortDrilldownAggregate,
  type CohortDrilldownTable,
  type CohortDrilldownResult,
  type GridViewRow,
  loadAuditRowsNonPhi,
  loadAuditFacilityOptions,
  loadAuditPayerOptions,
  loadAuditPivot,
  loadAuditPatientDetail,
  revealAuditPatient,
  revealAuditRows as revealAuditRowsServer,
  type AuditPivot,
  type AuditRevealedPatient,
  type AuditRevealedRow,
  getEraUpcomingPayments,
  type EraUpcomingSummary,
  getUpcomingOverrides,
  type UpcomingOverrideSummary,
  getUpcomingManual,
  saveUpcomingManualRow,
  setUpcomingManualStatusRow,
  getManualDeposits,
  addManualDepositRow,
  removeManualDepositRow,
  type ManualDepositRow,
  removeUpcomingManualRow,
  type ManualForecastRow,
} from '@/lib/server';
import { facilityBelongsToEntity, facilityIsActiveForEntity } from '../../src/collections/cmdCustomers.js';
// The shared cache tag the collections aggregate reads are wrapped in (src/cacheTags.ts).
// A manual-deposit write MUST bust it: those reads are unstable_cache'd, so without this
// the operator records a payment and keeps staring at the previous MTD figure.
import { DASHBOARD_CACHE_TAG } from '../../src/cacheTags.js';
import { revalidateTag } from 'next/cache';
import { requireExecutive } from '@/lib/executive';
import { dashboardAccess } from '@/lib/access';
import { BXR_ENTITY_ID, clampView, viewToEntityIds, type DashboardView } from '@/lib/views';
import { supabaseAuthConfigured } from '@/lib/supabase/env';
import type { CmdExplorerPhi, CmdExplorerRow } from '../../src/collections/cmdExplorer';
import {
  resolveAuditCursor,
  resolveAuditSort,
  resolveAuditFilter,
  type AuditCursor,
  type AuditFilter,
  type AuditSort,
  type AuditGridRow,
  type AuditFacilityOption,
  type AuditPayerOption,
  type AuditOfficePivot,
  type AuditPayerCptPivot,
  type AuditRevPivot,
} from '../../src/billingAudit/auditQuery';
import type { AuditScope } from '../../src/billingAudit/auditConfig';
import {
  memberIdBlindIndex,
  alphaPrefixBlindIndex,
  groupNumberBlindIndex,
  patientNameBlindIndex,
  patientNamePrefixBlindIndex,
  patientNameNormalized,
  BlindIndexError,
} from '../../src/collections/blindIndex';
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
import type { CollectionsYoy } from '../../src/collections/collectionsYoy';
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

/**
 * PHI-reveal gate (RBAC). Every patient-identifier reveal — claims (fetchRows / revealClaim) and the
 * CMD explorer (revealCmdReportRow[s]) — must pass this: a provisioned, signed-in user whose role may
 * reveal PHI (admin or super_admin; see rbac.ts). Returns the real audit principal (email + uid) so the
 * downstream recordAccess names the actual person. Fails closed with a user-facing reason when the user
 * is unauthenticated, unprovisioned, a non-PHI `user` role, or when per-user auth is not configured (no
 * principal to audit). Plain `user` roles and the no-auth fallback can still browse all NON-PHI surfaces.
 */
type PhiPrincipal =
  | { ok: true; actor: { email: string; userId: string }; entityIds: string[] }
  | { ok: false; error: string };

async function requirePhiPrincipal(): Promise<PhiPrincipal> {
  const result = await dashboardAccess();
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === 'unprovisioned'
          ? 'Your account is not provisioned for this dashboard.'
          : 'Sign in to view patient identifiers.',
    };
  }
  const { access } = result;
  if (!access.user) {
    // No-auth staged rollout: no real principal to audit a reveal against → deny.
    return { ok: false, error: 'Patient identifiers require per-user sign-in.' };
  }
  if (!access.canRevealPhi) {
    return { ok: false, error: 'Your role does not permit revealing patient identifiers.' };
  }
  // Tenant scope for the reveal = the caller's FULL entitlement (union over their allowed views),
  // derived server-side from the role row — never client input. This is the PHI boundary: a reveal
  // can only ever unmask a row whose business_entity_id is in this set.
  const entityIds = [...new Set(access.allowedViews.flatMap(viewToEntityIds))];
  // Fail closed: a principal entitled to NO views (an entity-scoped role with a null entity — a
  // state the app_user CHECK forbids) must never reach the reveal path with an empty scope.
  if (entityIds.length === 0) {
    return { ok: false, error: 'Your account is not scoped to any data.' };
  }
  return { ok: true, actor: { email: access.user.email, userId: access.user.id }, entityIds };
}

/**
 * Non-PHI tenant scope for ALL collections reads (the explorer grid + facility filter AND the
 * aggregate overview readers — summary/kpis/daily/payer/freshness): the business_entity_id(s) for
 * the REQUESTED view, clamped SERVER-SIDE to the session's entitlement (via clampView), so a
 * hand-edited/forged `view` can never widen scope beyond what the role allows. `view` is a display
 * hint from the client; the entitlement is the authority. Returns null when there is no authorized
 * principal so the caller fails closed.
 *
 * FAIL CLOSED for the collections plane (matches app/lib/veris/tenant.ts): a request with NO real
 * signed-in principal gets NO scope — NOT the dashboard's permissive no-auth super_admin fallback.
 * Once Indigo data lands, an environment without Supabase auth configured must never expose a
 * tenant's collections rows (even non-PHI payer/revenue data), so a null user → null scope here.
 * (PHI reveal already fails closed the same way in requirePhiPrincipal.)
 */
async function viewEntityScope(view?: DashboardView): Promise<string[] | null> {
  const result = await dashboardAccess();
  if (!result.ok) return null;
  const { access } = result;
  // No real principal (no-auth staged-rollout fallback) → no scope. Fail closed for tenant data.
  if (!access.user) return null;
  const { allowedViews } = access;
  // Entitled to NO views (entity-scoped role with a null entity — forbidden by the app_user
  // CHECK) → fail closed. Without this, clampView's `?? DEFAULT_VIEW` fallback would resolve an
  // empty allowlist to 'consolidated' (BXR+Indigo), silently widening scope.
  if (allowedViews.length === 0) return null;
  const requested = view ?? allowedViews[0]!;
  return viewToEntityIds(clampView(requested, allowedViews));
}

export type {
  FunctionName,
  SummaryStats,
  ResultsIdentity,
  DistributionSummary,
  PayerGapSummary,
  CollectionsMonthlySummary,
  CollectionsKpis,
  CollectionsYoy,
  CollectionsDailyResult,
  BrowseClaimsResult,
  BrowseClaimsSort,
  BrowseClaimsCursor,
  ClaimFilter,
  FacilityDimensionRow,
  CmdSearchSummary,
  CmdSearchGroup,
  CmdComboGroup,
  CmdFacilityOption,
  CmdEmployerOption,
  CohortCurve,
  CohortCurvePoint,
  CohortDrilldownAggregate,
  CohortDrilldownTable,
  CohortDrilldownResult,
  GridViewRow,
  // 0096. `export type` is fully erased at compile time, so this does NOT violate the
  // 'use server' rule that a non-function VALUE export 500s every action on the page.
  ManualDepositRow,
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
  // PHI rows: gate on the RBAC reveal capability (admins + super-admins). A plain `user` role can
  // run searches (non-PHI summary) but cannot fetch the underlying patient rows.
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const { status, body } = await handleResults({
      method: 'POST',
      authorization: authHeader(),
      body: { query_id, offset, ...(identity ? { identity } : {}) },
      createdBy: gate.actor.email,
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
  view?: DashboardView,
): Promise<DashboardResult<CmdPayerMonthResult>> {
  const entityIds = await viewEntityScope(view);
  if (!entityIds) return { ok: false };
  try {
    return { ok: true, data: await payerCmdMonth(year, month, entityIds) };
  } catch {
    return { ok: false };
  }
}

/**
 * ERA-confirmed upcoming payments (Overview tile) — staging.era_835_payment only, the
 * payment-grain table where sum(BPR02) is safe by construction. `view` is a display hint;
 * the tenant scope is clamped SERVER-SIDE to the session's entitlement via viewEntityScope
 * (fail-closed: no principal / empty entitlement → { ok: false }, never a wide default).
 * Non-PHI payload: payer, date, method, amounts, counts. The unquantified_remits count
 * rides along under 013's read-path contract — the UI must surface it when > 0.
 */
export async function loadEraUpcoming(
  view?: DashboardView,
): Promise<DashboardResult<EraUpcomingSummary>> {
  try {
    const entityIds = await viewEntityScope(view);
    if (!entityIds || entityIds.length === 0) return { ok: false };
    return { ok: true, data: await getEraUpcomingPayments(entityIds) };
  } catch {
    return { ok: false };
  }
}

/**
 * Hand-keyed upcoming-payment FORECAST overrides (Overview tile) — staging.
 * expected_payment_override only, synced read-only from the "Upcoming Payments" sheet
 * (migration 023). The companion to loadEraUpcoming: that one is 835-CONFIRMED money, this
 * one is operator-ASSERTED money with no 835 yet.
 *
 * ADDITIVE-ONLY (Alec, 2026-08-03): render these alongside the ERA rows, visually distinct,
 * and do NOT sum the two totals into one headline — a forecast row whose 835 has landed is
 * double-counted until the operator removes it from the sheet. ERA reconciliation is
 * separate, later work.
 *
 * `view` is a display hint; tenant scope is clamped SERVER-SIDE to the session's entitlement
 * via viewEntityScope (fail-closed: no principal / empty entitlement → { ok: false }, never
 * a wide default). Non-PHI payload: facility, payer label, date, method, amount, and the
 * is_patient_specific boolean — never a patient name (the sync's parser drops it).
 */
export async function loadUpcomingOverrides(
  view?: DashboardView,
): Promise<DashboardResult<UpcomingOverrideSummary>> {
  try {
    const entityIds = await viewEntityScope(view);
    if (!entityIds || entityIds.length === 0) return { ok: false };
    return { ok: true, data: await getUpcomingOverrides(entityIds) };
  } catch {
    return { ok: false };
  }
}

/**
 * Super-admin edits to the upcoming-payment forecast (staging.expected_payment_manual,
 * migration 024). READ path — open to any entitled viewer, because these rows are non-PHI
 * billing configuration and the tile must show a corrected amount to everyone who can see the
 * tile at all. Only WRITING them is super-admin-gated (see saveUpcomingManual below).
 *
 * Tenant scope is clamped SERVER-SIDE via viewEntityScope; fail-closed on an empty scope.
 */
export async function loadUpcomingManual(
  view?: DashboardView,
): Promise<DashboardResult<{ rows: ManualForecastRow[] }>> {
  try {
    const entityIds = await viewEntityScope(view);
    if (!entityIds || entityIds.length === 0) return { ok: false };
    return { ok: true, data: { rows: await getUpcomingManual(entityIds) } };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve the ONE tenant a forecast edit belongs to, or null.
 *
 * A write must name exactly one tenant. The Consolidated view resolves to TWO entity ids, so
 * a write issued from it is ambiguous — and guessing (first id, or "both") would either
 * mis-attribute money or duplicate a human decision across two books. Reject it and make the
 * caller pick a tenant view. This is also the fail-closed path for an unprovisioned session.
 */
async function singleWriteEntity(view?: DashboardView): Promise<string | null> {
  const entityIds = await viewEntityScope(view);
  if (!entityIds || entityIds.length !== 1) return null;
  return entityIds[0] ?? null;
}

/** What the UI submits for one edit. Validated here before it reaches the DB function. */
export interface UpcomingManualInput {
  kind: 'add' | 'correct' | 'suppress';
  facilityCode: string;
  payerLabel: string;
  /** ISO 'YYYY-MM-DD'. */
  expectedDate: string;
  methodLabel?: 'EFT' | 'Check' | null;
  /** Fixed-point decimal STRING, never a float. Required for add/correct, null for suppress. */
  amount?: string | null;
  suppressReason?: 'landed' | 'incorrect' | 'cancelled' | null;
  /** Provenance stamp for a confirmed 'landed' match: 'date|facility|payer'. */
  matchedEraKey?: string | null;
}

/** Bounded, closed-set validation at the trust boundary. Returns null when the input is fine. */
function validateManualInput(i: UpcomingManualInput): string | null {
  if (!['add', 'correct', 'suppress'].includes(i.kind)) return 'bad_kind';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.expectedDate)) return 'bad_date';
  // Every externally-supplied string gets a length bound; these mirror 024's CHECKs so a
  // rejection surfaces here as a clean message rather than as a DB constraint violation.
  if (i.facilityCode.length < 1 || i.facilityCode.length > 64) return 'bad_facility';
  if (i.payerLabel.trim().length < 1 || i.payerLabel.length > 200) return 'bad_payer';
  if (i.methodLabel != null && i.methodLabel !== 'EFT' && i.methodLabel !== 'Check') {
    return 'bad_method';
  }
  if (i.amount != null && !/^\d{1,10}(\.\d{1,2})?$/.test(i.amount)) return 'bad_amount';
  if (i.kind === 'add' && (i.amount == null || i.methodLabel == null)) return 'add_needs_amount';
  if (i.kind === 'correct' && i.amount == null) return 'correct_needs_amount';
  if (i.kind === 'suppress') {
    if (i.amount != null) return 'suppress_has_amount';
    if (i.suppressReason == null) return 'suppress_needs_reason';
  }
  if (
    i.suppressReason != null &&
    !['landed', 'incorrect', 'cancelled'].includes(i.suppressReason)
  ) {
    return 'bad_reason';
  }
  return null;
}

/**
 * Create or re-decide one forecast edit. SUPER-ADMIN ONLY.
 *
 * Three layers, in this order, none of them redundant:
 *   1. role === 'super_admin' here — the policy decision, closest to the caller.
 *   2. a claims.access_audit row naming the real actor, written BEFORE the mutation so an
 *      attempt is recorded even if the write then fails. This is the only durable record of
 *      who changed a money figure.
 *   3. 024's per-kind CHECK constraint — the DB guarantees a malformed statement about the
 *      forecast cannot land whatever this code does.
 *
 * Returns a generic error string on failure: details go to the server log, never to the client.
 */
export async function saveUpcomingManual(
  input: UpcomingManualInput,
  view?: DashboardView,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const gate = await dashboardAccess();
  // `user` is typed optional on Access, so narrow it here rather than asserting: no verified
  // actor means no audit row is possible, and an unaudited money edit must not happen.
  if (!gate.ok || gate.access.role !== 'super_admin' || !gate.access.user) {
    return { ok: false, error: 'forbidden' };
  }
  const actor = gate.access.user;
  const invalid = validateManualInput(input);
  if (invalid) return { ok: false, error: invalid };
  const entityId = await singleWriteEntity(view);
  if (!entityId) return { ok: false, error: 'pick_a_tenant_view' };
  // CROSS-TENANT GUARD. 024 does not FK facility_code (the two payment feeds are deliberately
  // unjoined), and collections.facilities is tenant-agnostic reference data, so nothing else in
  // the stack can tell that CAMH is BXR's and 10034230 is Indigo's. Without this, a super admin
  // on the BXR view could file an Indigo facility's payment under BXR — money in the wrong book,
  // visible only as an odd row on a tile. The roster in cmdCustomers.ts is the source of truth.
  if (!facilityBelongsToEntity(input.facilityCode, entityId)) {
    return { ok: false, error: 'facility_not_in_tenant' };
  }
  // LIVENESS GUARD, deliberately separate from the tenancy guard above and with its own error.
  // This is a CREATE path: a retired CMD account can never receive a payment, so a forecast row
  // naming one would sit on the Upcoming tile as a permanently overdue item nothing can clear.
  // Ownership stays true for retired facilities (that is what keeps their history attributable),
  // so the tenancy check passes and only this one refuses — and it must NOT reuse
  // 'facility_not_in_tenant', which would tell the operator to switch to a view they are already
  // in. See facilityIsActiveForEntity in src/collections/cmdCustomers.ts.
  if (!facilityIsActiveForEntity(input.facilityCode, entityId)) {
    return { ok: false, error: 'facility_retired' };
  }
  try {
    await recordAccess({
      actorEmail: actor.email,
      actorUserId: actor.id,
      action: 'edit_upcoming_forecast',
      // NON-PHI only: what was decided, about which facility/payer/date, for how much.
      detail: {
        kind: input.kind,
        facility_code: input.facilityCode,
        payer_label: input.payerLabel,
        expected_date: input.expectedDate,
        amount: input.amount ?? null,
        suppress_reason: input.suppressReason ?? null,
        entity: entityId,
      },
    });
    const id = await saveUpcomingManualRow({
      businessEntityId: entityId,
      kind: input.kind,
      facilityCode: input.facilityCode,
      payerLabel: input.payerLabel.trim(),
      expectedDate: input.expectedDate,
      methodLabel: input.methodLabel ?? null,
      amount: input.amount ?? null,
      suppressReason: input.suppressReason ?? null,
      matchedEraKey: input.matchedEraKey ?? null,
      actorUserId: actor.id,
    });
    return { ok: true, id };
  } catch (err) {
    console.error('saveUpcomingManual failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'write_failed' };
  }
}

/**
 * Remove one forecast edit (reverting to whatever the sheet says). SUPER-ADMIN ONLY.
 *
 * SOFT since 033 — the row is tombstoned, not destroyed. The name is unchanged because the
 * operator-facing meaning is unchanged ("take this decision back"), and renaming it would
 * churn every call site to describe an implementation detail. What changed is that the
 * claims.access_audit row written just below now names an id that still resolves to a row.
 */
export async function deleteUpcomingManual(
  id: number,
  view?: DashboardView,
): Promise<{ ok: true; deleted: boolean } | { ok: false; error: string }> {
  const gate = await dashboardAccess();
  if (!gate.ok || gate.access.role !== 'super_admin' || !gate.access.user) {
    return { ok: false, error: 'forbidden' };
  }
  const actor = gate.access.user;
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'bad_id' };
  const entityId = await singleWriteEntity(view);
  if (!entityId) return { ok: false, error: 'pick_a_tenant_view' };
  try {
    await recordAccess({
      actorEmail: actor.email,
      actorUserId: actor.id,
      action: 'delete_upcoming_forecast_edit',
      detail: { manual_id: id, entity: entityId },
    });
    return { ok: true, deleted: await removeUpcomingManualRow(entityId, id, actor.id) };
  } catch (err) {
    console.error('deleteUpcomingManual failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'write_failed' };
  }
}

/** The 835 key format `suggestLandedMatches` stamps: 'YYYY-MM-DD|FACILITY|PAYER'. */
const ERA_KEY_MAX = 400;

/**
 * Record that an 835 does (or does not) cover a manual forecast add. SUPER-ADMIN ONLY.
 *
 * This is the CONFIRM half of suggest-then-confirm. `suggestLandedMatches` proposes a
 * candidate with 'high' or 'medium' confidence and never 'confirmed'; a human turns that into
 * 'matched'. 'needs_review' records a candidate WITHOUT asserting it — the row keeps counting
 * as expected money and simply carries a flag. 'expected' is the undo.
 *
 * WHY THIS IS NOT AUTOMATIC, restated because it is the load-bearing decision: the only stable
 * identifier on the confirmed side is era_835_payment.check_eft_trace_number, and the CMD
 * deposit feed that drives the chart has no identifier at all — not a claim id, not a trace
 * number, not even a payer. Amounts cannot stand in for one either: a remittance differs from
 * an expected billed amount by contractual adjustment as a matter of course. So a machine
 * cannot close this loop, and a wrong close silently deletes money from a forecast.
 */
export async function matchUpcomingManual(
  id: number,
  status: 'expected' | 'needs_review' | 'matched',
  matchedEraKey: string | null,
  view?: DashboardView,
): Promise<{ ok: true; updated: boolean } | { ok: false; error: string }> {
  const gate = await dashboardAccess();
  if (!gate.ok || gate.access.role !== 'super_admin' || !gate.access.user) {
    return { ok: false, error: 'forbidden' };
  }
  const actor = gate.access.user;
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'bad_id' };
  if (!['expected', 'needs_review', 'matched'].includes(status)) {
    return { ok: false, error: 'bad_status' };
  }
  // Bounded at the trust boundary, mirroring 024's CHECK, so an over-long key surfaces as a
  // clean message rather than a constraint violation.
  const key = status === 'expected' ? null : (matchedEraKey ?? '').trim();
  if (key !== null && (key.length < 1 || key.length > ERA_KEY_MAX)) {
    return { ok: false, error: 'bad_era_key' };
  }
  const entityId = await singleWriteEntity(view);
  if (!entityId) return { ok: false, error: 'pick_a_tenant_view' };
  try {
    await recordAccess({
      actorEmail: actor.email,
      actorUserId: actor.id,
      action: 'match_upcoming_forecast',
      // NON-PHI: a row id, a status, and an 835 natural key (date|facility|payer).
      detail: { manual_id: id, status, matched_era_key: key, entity: entityId },
    });
    return {
      ok: true,
      updated: await setUpcomingManualStatusRow(entityId, id, status, key, actor.id),
    };
  } catch (err) {
    console.error(
      'matchUpcomingManual failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, error: 'write_failed' };
  }
}

// --- MANUAL DEPOSITS (0096) --------------------------------------------------------------
//
// A manual deposit is money a super admin has IN HAND that CollaborateMD has not posted yet.
// Unlike a forecast row it lands in collections.daily_collections, so it counts in MTD, YTD,
// the All Facilities table and the Master chart — Alec, 2026-08-10: "if it doesn't add to the
// actual MTD total or All Facilities table it's useless."

/**
 * Live manual deposits for the clamped view. READ — open to any entitled viewer, matching
 * loadUpcomingManual: these are non-PHI facility-day aggregates and anyone who can see the
 * totals they contribute to should be able to see what makes them up. Only WRITING is gated.
 */
export async function loadManualDeposits(
  view?: DashboardView,
): Promise<DashboardResult<{ rows: ManualDepositRow[] }>> {
  try {
    const entityIds = await viewEntityScope(view);
    if (!entityIds || entityIds.length === 0) return { ok: false };
    return { ok: true, data: { rows: await getManualDeposits(entityIds) } };
  } catch {
    return { ok: false };
  }
}

/** ISO calendar date, and nothing else. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Dollars, up to two decimals. Mirrors 0096's positive-amount CHECK and the form's pattern. */
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * Record a deposit CMD has not posted yet. SUPER-ADMIN ONLY.
 *
 * Same three layers as saveUpcomingManual: role here, a claims.access_audit row written BEFORE
 * the mutation, and 0096's own CHECKs. Plus the two roster guards, for the same reasons —
 * daily_collections does not FK facility_code, so nothing else in the stack can tell that CAMH
 * is BXR's, and a retired CMD account can never receive a payment.
 */
export async function addManualDeposit(
  input: { facilityCode: string; paymentDate: string; method: 'EFT' | 'Check'; amount: string },
  view?: DashboardView,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const gate = await dashboardAccess();
  if (!gate.ok || gate.access.role !== 'super_admin' || !gate.access.user) {
    return { ok: false, error: 'forbidden' };
  }
  const actor = gate.access.user;
  if (input.facilityCode.length < 1 || input.facilityCode.length > 64) {
    return { ok: false, error: 'bad_facility' };
  }
  if (!ISO_DATE.test(input.paymentDate)) return { ok: false, error: 'bad_date' };
  if (input.method !== 'EFT' && input.method !== 'Check') return { ok: false, error: 'bad_method' };
  if (!MONEY.test(input.amount) || Number(input.amount) <= 0) {
    return { ok: false, error: 'bad_amount' };
  }
  const entityId = await singleWriteEntity(view);
  if (!entityId) return { ok: false, error: 'pick_a_tenant_view' };
  if (!facilityBelongsToEntity(input.facilityCode, entityId)) {
    return { ok: false, error: 'facility_not_in_tenant' };
  }
  if (!facilityIsActiveForEntity(input.facilityCode, entityId)) {
    return { ok: false, error: 'facility_retired' };
  }
  try {
    await recordAccess({
      actorEmail: actor.email,
      actorUserId: actor.id,
      action: 'add_manual_deposit',
      // NON-PHI: facility, day, method, money. daily_collections has no patient column.
      detail: {
        facility_code: input.facilityCode,
        payment_date: input.paymentDate,
        method: input.method,
        amount: input.amount,
        entity: entityId,
      },
    });
    const id = await addManualDepositRow({
      businessEntityId: entityId,
      facilityCode: input.facilityCode,
      paymentDate: input.paymentDate,
      method: input.method,
      amount: input.amount,
      actorUserId: actor.id,
    });
    // These rows are read through cached collections actions, so a write that does not bust
    // the tag would leave the operator staring at the old MTD figure and concluding it failed.
    revalidateTag(DASHBOARD_CACHE_TAG);
    return { ok: true, id };
  } catch (err) {
    // DP001 is add_manual_deposit's "a live manual deposit already holds this facility-day"
    // (migration 0098). It is a REFUSAL, not a failure: nothing was written and retrying is
    // guaranteed to fail the same way, so it must not wear `write_failed`'s "that may not have been
    // saved, reopen and check" wording — that invites the retry, and before 0098 the retry is what
    // produced a bare 23505 the operator could do nothing with.
    //
    // ⚠ MATCHED ON SQLSTATE, NEVER ON THE MESSAGE. The message names the row and its amount and
    // will be reworded; the code is the contract. It is read defensively because a pg error's
    // `code` is untyped on the way through node-pg.
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'DP001') {
      return { ok: false, error: 'deposit_exists' };
    }
    console.error('addManualDeposit failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'write_failed' };
  }
}

/** Soft-remove one manual deposit (e.g. once CMD has posted it). SUPER-ADMIN ONLY. */
export async function removeManualDeposit(
  id: number,
  view?: DashboardView,
): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  const gate = await dashboardAccess();
  if (!gate.ok || gate.access.role !== 'super_admin' || !gate.access.user) {
    return { ok: false, error: 'forbidden' };
  }
  const actor = gate.access.user;
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'bad_id' };
  const entityId = await singleWriteEntity(view);
  if (!entityId) return { ok: false, error: 'pick_a_tenant_view' };
  try {
    await recordAccess({
      actorEmail: actor.email,
      actorUserId: actor.id,
      action: 'remove_manual_deposit',
      detail: { deposit_id: id, entity: entityId },
    });
    const removed = await removeManualDepositRow(entityId, id, actor.id);
    revalidateTag(DASHBOARD_CACHE_TAG);
    return { ok: true, removed };
  } catch (err) {
    console.error('removeManualDeposit failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'write_failed' };
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

/** Monthly collections by facility (Phase 7; non-PHI, reader-only). Tenant-scoped by the clamped view. */
export async function loadCollectionsSummary(
  view?: DashboardView,
): Promise<DashboardResult<CollectionsMonthlySummary>> {
  const entityIds = await viewEntityScope(view);
  if (!entityIds) return { ok: false };
  try {
    return { ok: true, data: await dashboardCollectionsSummary(entityIds) };
  } catch {
    return { ok: false };
  }
}

/** MTD/YTD collections KPIs by facility (Phase 7.1; non-PHI, reader-only). Tenant-scoped by the clamped view. */
/**
 * `surface` selects the future-payment policy, and defaults to the stricter one. 'overview'
 * includes CMD's forward-dated deposits; 'collections' (the default) bounds at today. It is a
 * display choice over non-PHI aggregates, not an authorization boundary — tenant scope is still
 * derived server-side from the RBAC-clamped view — so a client passing either value is harmless.
 */
export async function loadCollectionsKpis(
  view?: DashboardView,
  surface: 'collections' | 'overview' = 'collections',
): Promise<DashboardResult<CollectionsKpis>> {
  const entityIds = await viewEntityScope(view);
  if (!entityIds) return { ok: false };
  try {
    const data =
      surface === 'overview'
        ? await dashboardCollectionsKpisOverview(entityIds)
        : await dashboardCollectionsKpis(entityIds);
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

/**
 * Year-over-year collected totals (non-PHI), anchored to `asOf` (the live KPI anchor =
 * max payment_date). Backs the YTD Gross card's YoY trend and the Year Forecast card's
 * prior-year comparison; sourced from payment_lines (multi-year). Reader-only, cached.
 * On any failure (or a malformed anchor) returns { ok: false } so the cards just drop
 * the YoY line rather than break the page.
 */
export async function loadCollectionsYoy(
  asOf: string,
  view?: DashboardView,
): Promise<DashboardResult<CollectionsYoy>> {
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { ok: false };
  const entityIds = await viewEntityScope(view);
  if (!entityIds) return { ok: false };
  // YoY sources collections.payment_lines, which has NO business_entity_id (it is NOT in the
  // 0027–0031 tenancy set) and holds BXR-only history. Show it only when BXR is in scope
  // (bxr / consolidated); hide for an Indigo-only view so BXR totals never render under Indigo.
  // (payment_lines tenancy is a separate follow-up; until then YoY is BXR-only by construction.)
  if (!entityIds.includes(BXR_ENTITY_ID)) return { ok: false };
  try {
    return { ok: true, data: await dashboardCollectionsYoy(asOf) };
  } catch {
    return { ok: false };
  }
}

/** Latest-month daily collections rows (Phase 7.1; non-PHI, reader-only). Tenant-scoped by the clamped view. */
export async function loadCollectionsDaily(
  view?: DashboardView,
  /** See loadCollectionsKpis — defaults to the stricter (today-bounded) policy. */
  surface: 'collections' | 'overview' = 'collections',
): Promise<DashboardResult<CollectionsDailyResult>> {
  const entityIds = await viewEntityScope(view);
  if (!entityIds) return { ok: false };
  try {
    const data =
      surface === 'overview'
        ? await dashboardCollectionsDailyOverview(entityIds)
        : await dashboardCollectionsDaily(entityIds);
    return { ok: true, data };
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
export async function loadCollectionsDailyRange(
  params: {
    year: number;
    month: number;
  },
  view?: DashboardView,
  /** See loadCollectionsKpis — defaults to the stricter (today-bounded) policy. */
  surface: 'collections' | 'overview' = 'collections',
): Promise<DashboardResult<CollectionsDailyResult>> {
  const entityIds = await viewEntityScope(view);
  if (!entityIds) return { ok: false };
  try {
    return {
      ok: true,
      data: await collectionsDailyForMonth(
        params.year,
        params.month,
        entityIds,
        surface === 'overview',
      ),
    };
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
  // Minting a reveal handle is the first step of a PHI reveal — gate it on the RBAC capability so a
  // non-PHI `user` role is denied up front (the row fetch is gated too, in fetchRows).
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
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

// ---------------------------------------------------------------------------
// CMD Collections Explorer (Derek's 14-column batch report) — DB-backed NON-PHI grid
// + audited per-row PHI reveal.
//
// loadCmdReport returns ONE keyset page of the non-PHI projection from
// collections.cmd_explorer_rows (cached 15 min server-side per cursor; no PHI at rest)
// plus the cursor for the next page. The 3 PHI columns are masked in the UI and fetched
// per-row via revealCmdReportRow, which requires an authorized session, decrypts the
// stored ciphertext server-side, and writes a durable audit record. Row identity is the
// bigserial id (not a content fingerprint); an absent id fails closed to "unavailable".
// ---------------------------------------------------------------------------

// Re-export the grid's sort/cursor types so the client imports them from the action module
// (the same seam the Claims explorer uses), never from the server-only '@/lib/server'.
export type { CmdExplorerSort, CmdExplorerCursor };

export type CmdReportResult =
  | { ok: true; rows: CmdExplorerRow[]; nextCursor: CmdExplorerCursor | null }
  | { ok: false; error: string };

/**
 * Filters for the "All Collections" grid (non-PHI). `facility` is a SET of facilities from the
 * explorer's own facility vocabulary (see loadCmdExplorerFacilities) — the multi-select dropdown
 * and a single-facility drill-down chip both feed it; an empty/absent array means "all facilities".
 * `year`/`month` window payment_received to that calendar month; `recencyDays` (7/14/30/90) is a
 * mutually-exclusive rolling window ending today, computed from the SERVER clock. All values are
 * re-validated here and bound as parameters in the reader.
 */
export interface CmdReportFilter {
  facility?: string[];
  year?: number;
  month?: number; // 1-12; requires year
  recencyDays?: number; // 7 | 14 | 30 | 90 — rolling window (server clock); overrides year/month
  /** Smart-search substring term (matched literally, ILIKE) across `searchColumns`. */
  q?: string;
  /** Which NON-PHI columns `q` searches (allowlisted server-side; PHI columns are rejected). */
  searchColumns?: string[];
  /** Exact drill-down refinements set by clicking a summary chip. A (CPT, Revenue-code) combo
   *  chip sets `cpt_code` AND `revenue_code` together (and clears both together). */
  cpt_code?: string;
  revenue_code?: string;
  primary_payer?: string;
  /** Multi-select payer tags (guided payer search) — set membership; empty/absent = all payers. */
  primary_payers?: string[];
  /**
   * Searchable-PHI terms (raw). Resolved SERVER-SIDE to blind-index tokens, gated to
   * PHI-entitled roles, and audited — the raw terms are never stored, logged, or sent to SQL.
   */
  phiSearch?: {
    memberId?: string;
    alphaPrefix?: string;
    groupNumber?: string;
  };
  /**
   * Employer segment + picked employers (migration 0101).
   *
   * ⚠ THESE WERE MISSING UNTIL 2026-08-17 AND THE FEATURE WAS INERT. The client has sent them since
   * #233, but this filter type did not declare them and the reader filter is built from an explicit
   * ALLOWLIST — so both were silently dropped at this boundary and the grid never filtered by
   * employer. The column still RENDERED, because the projection is unconditional, which is exactly
   * why it looked like it worked. If you add a filter to the client, add it here too.
   */
  employer_names?: string[];
  employerMode?: 'all' | 'employer' | 'individual';
  /** Row ids resolved by the PATIENT-NAME search. Non-PHI (bigserial keys); the name itself never
   *  travels in a filter. `[]` means "searched, matched nothing" and MUST be preserved. */
  row_ids?: string[];
}

/** Max employers one filter may name, and max row ids one name-search may pin. Bounded input:
 *  both arrive from the client and both become `= any($n)` arrays. */
const CMD_EMPLOYER_FILTER_MAX = 200;
const CMD_ROW_IDS_MAX = 2000; // mirrors CMD_NAME_SEARCH_ROW_CAP — a search cannot match more

/**
 * Copy the employer segment + picked employers into the reader filter, validated.
 *
 * The mode is checked against the closed set rather than cast: it reaches a SQL branch, and an
 * unknown value must degrade to 'all' (no condition) instead of throwing or, worse, being
 * interpolated. Employer names are values only — they are bound as `$n` — but they are still
 * length- and count-bounded because they come from the client.
 */
function applyEmployerFilter(
  filter: CmdReportFilter,
  readerFilter: { employer_names?: string[]; employerMode?: 'all' | 'employer' | 'individual' },
): boolean {
  const mode = filter.employerMode;
  if (mode === 'employer' || mode === 'individual') readerFilter.employerMode = mode;
  // 'all', undefined, or anything unrecognised → no condition at all.
  const names = filter.employer_names;
  if (Array.isArray(names) && names.length > 0) {
    if (names.length > CMD_EMPLOYER_FILTER_MAX) return false;
    const clean = names
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim())
      .filter((n) => n !== '' && n.length <= 200);
    // Picked employers only narrow WITHIN the Employer segment; outside it a stale selection must
    // not keep filtering (same guard the client applies, enforced again here).
    if (clean.length > 0 && readerFilter.employerMode === 'employer') readerFilter.employer_names = clean;
  }
  return true;
}

/**
 * Is this a string Postgres will accept as `bigint`?
 *
 * ⚠ A DIGIT-COUNT CHECK IS NOT ENOUGH, which is what this replaced. `^[0-9]{1,19}$` accepts
 * 9999999999999999999 — nineteen digits, but larger than bigint's max of 9223372036854775807. That
 * passes validation here and then raises 22003 `bigint out of range` when the array is cast at
 * query time: a 500 from a value the boundary claimed it had already validated. The max is 19
 * digits, so length and range are NOT interchangeable at the top of the domain.
 *
 * BigInt() is exact at this magnitude; Number() is not (it loses precision above 2^53, so
 * 9223372036854775808 would compare equal to the max and slip through).
 *
 * Rejects the empty string, signs, whitespace, decimals and exponent forms by construction — the
 * regex runs first, so BigInt() only ever sees plain digits and cannot throw.
 */
const PG_BIGINT_MAX = 9223372036854775807n;
function isPgBigintString(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[0-9]{1,19}$/.test(v)) return false;
  return BigInt(v) <= PG_BIGINT_MAX;
}

/**
 * Copy the patient-name search's resolved row ids into the reader filter.
 *
 * ⚠ AN EMPTY ARRAY IS MEANINGFUL and is deliberately NOT treated as "absent": it means the search
 * ran and matched nothing. Dropping it would widen the grid back to every row — the opposite of
 * what the user asked for. `undefined` (no search) is the only thing that omits the condition.
 * Ids are digit-strings (bigserial), validated so nothing but digits reaches a bigint[] cast.
 */
function applyRowIds(
  filter: CmdReportFilter,
  readerFilter: { row_ids?: string[] },
): boolean {
  const ids = filter.row_ids;
  if (ids === undefined) return true;
  if (!Array.isArray(ids)) return false;
  if (ids.length > CMD_ROW_IDS_MAX) return false;
  if (!ids.every(isPgBigintString)) return false;
  readerFilter.row_ids = ids;
  return true;
}

/** Max length for the free-text search term (bounded input — DoS/abuse guard). */
const CMD_SEARCH_TERM_MAX = 120;
/**
 * Min length before a free-text term runs as a substring search (mirrors CMD_SEARCH_TERM_MIN in the
 * pure query module + MIN_SEARCH_LEN in the client). A shorter term is treated as NO search (browse),
 * so the throwaway 1–2 char prefix scans never reach the DB even on a direct action call.
 */
const CMD_SEARCH_TERM_MIN = 3;

/**
 * Translate the client filter's smart-search fields into the reader filter, dropping anything
 * unsafe: the term is trimmed + length-bounded, and search columns are intersected with the
 * server allowlist (PHI/unknown keys silently dropped). Exact refinements are length-bounded.
 * Returns null on a hard rejection (over-long term).
 */
function applySearchFilter(
  filter: CmdReportFilter,
  readerFilter: { facility?: string[]; from?: string; to?: string; q?: string; searchColumns?: CmdExplorerSearchColumn[]; cpt_code?: string; revenue_code?: string; primary_payer?: string },
): boolean {
  if (typeof filter.cpt_code === 'string' && filter.cpt_code.trim() !== '') {
    if (filter.cpt_code.length > 100) return false;
    readerFilter.cpt_code = filter.cpt_code;
  }
  if (typeof filter.revenue_code === 'string' && filter.revenue_code.trim() !== '') {
    if (filter.revenue_code.length > 100) return false;
    readerFilter.revenue_code = filter.revenue_code;
  }
  if (typeof filter.primary_payer === 'string' && filter.primary_payer.trim() !== '') {
    if (filter.primary_payer.length > 200) return false;
    readerFilter.primary_payer = filter.primary_payer;
  }
  const term = typeof filter.q === 'string' ? filter.q.trim() : '';
  // A sub-minimum term is treated as no substring search (browse) — not an error — so short
  // throwaway prefixes never trigger the expensive aggregate scans. Longer-than-max is still rejected.
  if (term.length >= CMD_SEARCH_TERM_MIN) {
    if (term.length > CMD_SEARCH_TERM_MAX) return false;
    const cols = Array.isArray(filter.searchColumns)
      ? filter.searchColumns.filter(
          (c): c is CmdExplorerSearchColumn =>
            typeof c === 'string' && Object.prototype.hasOwnProperty.call(CMD_EXPLORER_SEARCH_COLUMNS, c),
        )
      : [];
    if (cols.length > 0) {
      readerFilter.q = term;
      readerFilter.searchColumns = cols;
    }
  }
  return true;
}

/** Max facilities acceptable in one multi-select (bounded input — both tenants have < 40 today). */
const CMD_FACILITY_SET_MAX = 200;
/** Max length of a single facility string (matches the exact-match bound used elsewhere). */
const CMD_FACILITY_NAME_MAX = 200;
/** Rolling recency windows offered by the quick-filter chips (server-computed; closed allowlist). */
const CMD_RECENCY_DAYS = new Set([7, 14, 30, 90]);

/**
 * Validate + copy the facility multi-select into the reader filter. An empty/absent array is a
 * no-op (means "all facilities" — the reader omits the condition), NOT a match-nothing filter.
 * Bounds the set size and each element's length. Returns false on a hard rejection.
 */
function applyFacilityFilter(filter: CmdReportFilter, readerFilter: { facility?: string[] }): boolean {
  if (!Array.isArray(filter.facility) || filter.facility.length === 0) return true;
  const facilities = filter.facility;
  if (facilities.length > CMD_FACILITY_SET_MAX) return false;
  for (const f of facilities) {
    if (typeof f !== 'string' || f.length === 0 || f.length > CMD_FACILITY_NAME_MAX) return false;
  }
  readerFilter.facility = facilities;
  return true;
}

/** Max payers in one multi-select (bounded input; a tenant has ~260 distinct today). */
const CMD_PAYER_SET_MAX = 300;
/** Max length of a single payer string (payer names are short; matches the exact-match discipline). */
const CMD_PAYER_NAME_MAX = 200;

/**
 * Validate + copy the payer multi-select into the reader filter — the payer analogue of
 * applyFacilityFilter. An empty/absent array is a no-op ("all payers", the reader omits the
 * condition), NOT a match-nothing filter. Bounds the set size and each element's length. Returns
 * false on a hard rejection.
 */
function applyPayerFilter(filter: CmdReportFilter, readerFilter: { primary_payers?: string[] }): boolean {
  if (!Array.isArray(filter.primary_payers) || filter.primary_payers.length === 0) return true;
  const payers = filter.primary_payers;
  if (payers.length > CMD_PAYER_SET_MAX) return false;
  for (const p of payers) {
    if (typeof p !== 'string' || p.length === 0 || p.length > CMD_PAYER_NAME_MAX) return false;
  }
  readerFilter.primary_payers = payers;
  return true;
}

/**
 * Resolve the payment_received window into the reader's `from`/`to` (ISO 'YYYY-MM-DD'). A
 * `recencyDays` chip (7/14/30/90) takes precedence and is computed from the SERVER clock — the client
 * never supplies the date, so the window can't be spoofed — as an open-ended "on or after
 * today − N days" (future-dated rows are already dropped at ingest). Otherwise a year+month selects
 * that calendar month ([from, to) exclusive upper). Returns false on invalid input. `today` is
 * injectable for determinism. Consolidates the month logic that the grid + summary loaders shared.
 */
function applyDateWindow(
  filter: CmdReportFilter,
  readerFilter: { from?: string; to?: string },
  today: Date = new Date(),
): boolean {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (filter.recencyDays !== undefined) {
    if (!CMD_RECENCY_DAYS.has(filter.recencyDays)) return false;
    const from = new Date(today);
    from.setUTCDate(from.getUTCDate() - filter.recencyDays);
    readerFilter.from = `${from.getUTCFullYear()}-${pad(from.getUTCMonth() + 1)}-${pad(from.getUTCDate())}`;
    return true;
  }
  if (filter.year !== undefined || filter.month !== undefined) {
    const { year, month } = filter;
    if (
      !Number.isInteger(year) || year! < 2000 || year! > 2100 ||
      !Number.isInteger(month) || month! < 1 || month! > 12
    ) {
      return false;
    }
    const nextYear = month === 12 ? year! + 1 : year!;
    const nextMonth = month === 12 ? 1 : month! + 1;
    readerFilter.from = `${year}-${pad(month!)}-01`;
    readerFilter.to = `${nextYear}-${pad(nextMonth)}-01`; // exclusive upper bound
  }
  return true;
}

type PhiIndexTokens = { memberIdBidx?: string; memberIdPrefixBidx?: string; groupNumberBidx?: string };
type PhiSearchResult = { ok: true; phiIndex?: PhiIndexTokens } | { ok: false; error: string };

/**
 * Resolve RAW searchable-PHI terms → keyed blind-index tokens, GATED to PHI-entitled roles and
 * AUDITED. The raw terms are never stored, logged, or sent to SQL — only the one-way HMAC token
 * is. Returns a no-op ({ok,phiIndex:undefined}) when no PHI terms were supplied; an error when a
 * non-entitled principal supplies PHI terms or the index key is unavailable. `doAudit` writes ONE
 * access row (field names only — never the term or token). Tenant SCOPE stays the caller's
 * view-clamped entityIds (passed separately); this gate only authorizes + names the audit.
 */
async function resolvePhiSearch(
  phiSearch: CmdReportFilter['phiSearch'],
  view: DashboardView | undefined,
  doAudit: boolean,
): Promise<PhiSearchResult> {
  const memberId = phiSearch?.memberId?.trim() ?? '';
  const alphaPrefix = phiSearch?.alphaPrefix?.trim() ?? '';
  const groupNumber = phiSearch?.groupNumber?.trim() ?? '';
  if (memberId === '' && alphaPrefix === '' && groupNumber === '') return { ok: true };
  if (memberId.length > 120 || alphaPrefix.length > 20 || groupNumber.length > 120) {
    return { ok: false, error: 'Invalid search.' };
  }
  // GATE: only a signed-in, PHI-entitled role may search PHI (same gate as reveal).
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  let tokens: PhiIndexTokens;
  try {
    tokens = {};
    const m = memberId !== '' ? memberIdBlindIndex(memberId) : null;
    const p = alphaPrefix !== '' ? alphaPrefixBlindIndex(alphaPrefix) : null;
    const g = groupNumber !== '' ? groupNumberBlindIndex(groupNumber) : null;
    if (m) tokens.memberIdBidx = m;
    if (p) tokens.memberIdPrefixBidx = p;
    if (g) tokens.groupNumberBidx = g;
  } catch (e) {
    // Missing/invalid INDEX_HMAC_KEY → PHI search unavailable (never leak the reason as PHI).
    if (e instanceof BlindIndexError) return { ok: false, error: 'Search is temporarily unavailable.' };
    throw e;
  }
  const fields = Object.keys(tokens);
  if (fields.length === 0) return { ok: true }; // nothing usable (e.g. alpha prefix < 3 chars)
  if (doAudit) {
    await recordAccess({
      actorEmail: gate.actor.email,
      actorUserId: gate.actor.userId,
      action: 'search_cmd_explorer_phi',
      detail: { fields, view: view ?? null }, // field NAMES only — never the term/token
    });
  }
  return { ok: true, phiIndex: tokens };
}

/**
 * Load ONE keyset page of the CMD Collections Explorer — NON-PHI columns only (cached 15 min
 * per cursor+filter+sort). `cursor` is the {id, value} of the previous page's last row
 * (null/omitted = first page); `sort` is an allowlisted column + direction (default: Payment
 * Received DESC). The result carries `nextCursor` (null at the end). The optional `filter`
 * scopes by facility and/or a payment-received month, applied server-side.
 */
export async function loadCmdReport(
  cursor: CmdExplorerCursor | null = null,
  filter: CmdReportFilter = {},
  sort?: CmdExplorerSort,
  view?: DashboardView,
): Promise<CmdReportResult> {
  // Tenant scope from the RBAC-clamped view (server-derived). Fail closed if unauthorized.
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) {
    return { ok: false, error: 'The collections report could not be loaded right now.' };
  }
  // Coerce the client-supplied cursor + sort to safe shapes before they reach SQL (a bad cursor
  // becomes "first page"; a bad/absent sort becomes the Payment-Received-DESC default).
  const safeCursor = resolveCmdExplorerCursor(cursor);
  const safeSort = resolveCmdExplorerSort(sort);
  // Re-validate + translate the filter into bounded date/string params for the reader.
  const readerFilter: {
    facility?: string[];
    from?: string;
    to?: string;
    q?: string;
    searchColumns?: CmdExplorerSearchColumn[];
    cpt_code?: string;
    revenue_code?: string;
    primary_payer?: string;
    primary_payers?: string[];
    phiIndex?: PhiIndexTokens;
    employer_names?: string[];
    employerMode?: 'all' | 'employer' | 'individual';
    row_ids?: string[];
  } = {};
  if (!applyFacilityFilter(filter, readerFilter)) return { ok: false, error: 'Invalid facility.' };
  if (!applyPayerFilter(filter, readerFilter)) return { ok: false, error: 'Invalid payer.' };
  if (!applySearchFilter(filter, readerFilter)) {
    return { ok: false, error: 'Invalid search.' };
  }
  if (!applyDateWindow(filter, readerFilter)) return { ok: false, error: 'Invalid date window.' };
  // Employer segment + picked employers (missing until 2026-08-17 — see CmdReportFilter).
  if (!applyEmployerFilter(filter, readerFilter)) return { ok: false, error: 'Invalid employer filter.' };
  // Patient-name search result ids. `[]` is preserved on purpose (searched, matched nothing).
  if (!applyRowIds(filter, readerFilter)) return { ok: false, error: 'Invalid name-search result.' };
  // PHI search (gated + audited here — this is the actual row-returning PHI access).
  const phi = await resolvePhiSearch(filter.phiSearch, view, true);
  if (!phi.ok) return { ok: false, error: phi.error };
  if (phi.phiIndex) readerFilter.phiIndex = phi.phiIndex;
  try {
    const page = await loadCmdExplorerNonPhi(safeCursor, readerFilter, safeSort, entityIds);
    return { ok: true, rows: page.rows, nextCursor: page.nextCursor };
  } catch {
    return { ok: false, error: 'The collections report could not be loaded right now.' };
  }
}

// --- Billing Audit work-table actions ---------------------------------------

export type { AuditCursor, AuditFilter, AuditSort, AuditGridRow, AuditFacilityOption, AuditPayerOption };

export type AuditRowsResult =
  | { ok: true; rows: AuditGridRow[]; nextCursor: AuditCursor | null }
  | { ok: false; error: string };

const AUDIT_LOAD_ERROR = 'The billing audit report could not be loaded right now.';

/**
 * Load ONE keyset page of the billing-audit work table — NON-PHI columns only (cached 15 min per
 * scope+cursor+filter+sort+tenant). `scope` (IP/OP) is the active subtab; `cursor` is the
 * {id,value} of the previous page's last row (null = first page); `sort` is allowlisted (default
 * charge_from_date DESC). Fails closed on an unauthorized principal (viewEntityScope → null).
 */
export async function loadAuditRows(
  scope: AuditScope,
  cursor: AuditCursor | null = null,
  filter: AuditFilter = {},
  sort?: AuditSort,
  view?: DashboardView,
): Promise<AuditRowsResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: AUDIT_LOAD_ERROR };
  const safeScope: AuditScope = scope === 'OP' ? 'OP' : 'IP';
  const safeCursor = resolveAuditCursor(cursor);
  const safeSort = resolveAuditSort(sort);
  const safeFilter = resolveAuditFilter(filter);
  try {
    const page = await loadAuditRowsNonPhi(safeCursor, safeFilter, safeSort, safeScope, entityIds);
    return { ok: true, rows: page.rows, nextCursor: page.nextCursor };
  } catch {
    return { ok: false, error: AUDIT_LOAD_ERROR };
  }
}

export interface AuditFilterOptions {
  facilities: AuditFacilityOption[];
  payers: AuditPayerOption[];
}
export type AuditFilterOptionsResult =
  | { ok: true; options: AuditFilterOptions }
  | { ok: false; error: string };

/** Facility + payer tag-picker options for the (scope, tenant) slice (non-PHI, cached). */
export async function loadAuditFilterOptions(
  scope: AuditScope,
  view?: DashboardView,
): Promise<AuditFilterOptionsResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: 'Filter options are unavailable right now.' };
  const safeScope: AuditScope = scope === 'OP' ? 'OP' : 'IP';
  try {
    const [facilities, payers] = await Promise.all([
      loadAuditFacilityOptions(safeScope, entityIds),
      loadAuditPayerOptions(safeScope, entityIds),
    ]);
    return { ok: true, options: { facilities, payers } };
  } catch {
    return { ok: false, error: 'Filter options are unavailable right now.' };
  }
}

export type { AuditPivot, AuditOfficePivot, AuditPayerCptPivot, AuditRevPivot };
export type AuditPivotResult = { ok: true; pivot: AuditPivot } | { ok: false; error: string };

/** Pivot-strip aggregates (by office / payer×CPT / rev) for the current filtered slice (non-PHI). */
export async function loadAuditPivotAction(
  scope: AuditScope,
  filter: AuditFilter = {},
  view?: DashboardView,
): Promise<AuditPivotResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: 'Pivot unavailable right now.' };
  const safeScope: AuditScope = scope === 'OP' ? 'OP' : 'IP';
  try {
    const pivot = await loadAuditPivot(resolveAuditFilter(filter), safeScope, entityIds);
    return { ok: true, pivot };
  } catch {
    return { ok: false, error: 'Pivot unavailable right now.' };
  }
}

// --- patient drill + reveal + gated search (PHI touchpoints) -----------------

export type { AuditRevealedPatient };
export type AuditPatientDetailResult = { ok: true; rows: AuditGridRow[] } | { ok: false; error: string };

/** All charge lines for one patient (by cmd_patient_id) — NON-PHI drill detail (masked). */
export async function loadAuditPatientDetailAction(
  scope: AuditScope,
  cmdPatientId: string,
  view?: DashboardView,
): Promise<AuditPatientDetailResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: AUDIT_LOAD_ERROR };
  const id = (cmdPatientId ?? '').trim();
  if (id === '' || id.length > 64) return { ok: false, error: AUDIT_LOAD_ERROR };
  const safeScope: AuditScope = scope === 'OP' ? 'OP' : 'IP';
  try {
    const rows = await loadAuditPatientDetail(safeScope, id, entityIds);
    return { ok: true, rows };
  } catch {
    return { ok: false, error: AUDIT_LOAD_ERROR };
  }
}

export type AuditRevealResult = { ok: true; patient: AuditRevealedPatient } | { ok: false; error: string };

/** Reveal one patient's identifiers for the drill — gated (canRevealPhi) + audited server-side. */
export async function revealAuditPatientAction(
  scope: AuditScope,
  cmdPatientId: string,
  view?: DashboardView,
): Promise<AuditRevealResult> {
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  const id = (cmdPatientId ?? '').trim();
  if (id === '' || id.length > 64) return { ok: false, error: 'Invalid patient.' };
  const safeScope: AuditScope = scope === 'OP' ? 'OP' : 'IP';
  try {
    // Tenant scope = the caller's PHI entitlement (gate.entityIds), NOT the display view — a reveal
    // can only ever unmask a patient whose business_entity_id is in that set. view labels the audit.
    const patient = await revealAuditPatient(safeScope, id, gate.actor, gate.entityIds);
    if (!patient) return { ok: false, error: 'Patient not found in your scope.' };
    return { ok: true, patient };
  } catch {
    return { ok: false, error: 'Could not reveal patient identifiers.' };
  }
}

export type { AuditRevealedRow };
export type AuditRevealRowsResult = { ok: true; rows: AuditRevealedRow[] } | { ok: false; error: string };

/**
 * Bulk-reveal a page's rows for the work-table "Reveal all" toggle (page-level PHI reveal,
 * mirrors collections revealCmdReportRows) — GATED (canRevealPhi) + AUDITED server-side. Ids are
 * validated to safe positive ints and bounded (≤200). Tenant scope is the caller's PHI entitlement
 * (gate.entityIds), so a row outside it is silently dropped — never another tenant's patient.
 */
export async function revealAuditRows(ids: number[]): Promise<AuditRevealRowsResult> {
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  const safe = Array.isArray(ids) ? ids.filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 200) : [];
  if (safe.length === 0) return { ok: true, rows: [] };
  try {
    return { ok: true, rows: await revealAuditRowsServer(safe, gate.actor, gate.entityIds) };
  } catch {
    return { ok: false, error: 'Could not reveal patient identifiers.' };
  }
}

export type AuditPatientSearchResult =
  | { ok: true; tokens: { patientNameBidx?: string[]; patientNamePrefixBidx?: string[] } }
  | { ok: false; error: string };

/**
 * Resolve a patient-name search term to opaque blind-index tokens the grid filters on — a PHI
 * operation, so GATED to canRevealPhi roles and AUDITED (search_audit_phi, field names only, never
 * the term). ≤3 normalized chars → 3-char PREFIX token; longer → EXACT full-name token. Mirrors the
 * collections resolvePhiSearch precedent. Returns {} (no-op) for an empty term.
 */
export async function searchAuditPatients(
  term: string,
  scope: AuditScope,
  view?: DashboardView,
): Promise<AuditPatientSearchResult> {
  const t = (term ?? '').trim();
  if (t === '') return { ok: true, tokens: {} };
  if (t.length > 120) return { ok: false, error: 'Invalid search.' };
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  const tokens: { patientNameBidx?: string[]; patientNamePrefixBidx?: string[] } = {};
  try {
    const norm = patientNameNormalized(t);
    if (norm && norm.length <= 3) {
      const pfx = patientNamePrefixBlindIndex(t);
      if (pfx) tokens.patientNamePrefixBidx = [pfx];
    } else {
      const exact = patientNameBlindIndex(t);
      if (exact) tokens.patientNameBidx = [exact];
    }
  } catch (e) {
    if (e instanceof BlindIndexError) return { ok: false, error: 'Search is temporarily unavailable.' };
    throw e;
  }
  const fields = Object.keys(tokens);
  if (fields.length === 0) return { ok: true, tokens: {} };
  await recordAccess({
    actorEmail: gate.actor.email,
    actorUserId: gate.actor.userId,
    action: 'search_audit_phi',
    detail: { fields, scope, view: view ?? null }, // field NAMES only — never the term/token
  });
  return { ok: true, tokens };
}

export type CmdSearchSummaryResult =
  | { ok: true; summary: CmdSearchSummary }
  | { ok: false; error: string };

/**
 * Smart-search summary — the aggregate "search engine" result for the current query/window
 * (count + money totals + top facilities/payers/CPTs), tenant-scoped SERVER-SIDE from the
 * RBAC-clamped view. Same filter validation as loadCmdReport, so the summary and the rows a
 * chip drills into always agree. Non-PHI; cached per (filter, tenant).
 */
export async function loadCmdSearchSummary(
  filter: CmdReportFilter = {},
  view?: DashboardView,
): Promise<CmdSearchSummaryResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: 'The search could not be run right now.' };
  const readerFilter: {
    facility?: string[];
    from?: string;
    to?: string;
    q?: string;
    searchColumns?: CmdExplorerSearchColumn[];
    cpt_code?: string;
    revenue_code?: string;
    primary_payer?: string;
    primary_payers?: string[];
    phiIndex?: PhiIndexTokens;
    employer_names?: string[];
    employerMode?: 'all' | 'employer' | 'individual';
    row_ids?: string[];
  } = {};
  if (!applyFacilityFilter(filter, readerFilter)) return { ok: false, error: 'Invalid facility.' };
  if (!applyPayerFilter(filter, readerFilter)) return { ok: false, error: 'Invalid payer.' };
  if (!applySearchFilter(filter, readerFilter)) return { ok: false, error: 'Invalid search.' };
  if (!applyDateWindow(filter, readerFilter)) return { ok: false, error: 'Invalid date window.' };
  // Employer segment + picked employers (missing until 2026-08-17 — see CmdReportFilter).
  if (!applyEmployerFilter(filter, readerFilter)) return { ok: false, error: 'Invalid employer filter.' };
  // Patient-name search result ids. `[]` is preserved on purpose (searched, matched nothing).
  if (!applyRowIds(filter, readerFilter)) return { ok: false, error: 'Invalid name-search result.' };
  // PHI search: gate (canRevealPhi) + resolve tokens; audit happens in loadCmdReport (the
  // row-returning access) so a single search isn't double-logged by the summary + the grid.
  const phi = await resolvePhiSearch(filter.phiSearch, view, false);
  if (!phi.ok) return { ok: false, error: phi.error };
  if (phi.phiIndex) readerFilter.phiIndex = phi.phiIndex;
  try {
    return { ok: true, summary: await loadCmdSearchSummary_(readerFilter, entityIds) };
  } catch {
    return { ok: false, error: 'The search could not be run right now.' };
  }
}

export type CollectionsAiAnalysisResult =
  | { ok: true; stream: ReadableStream<string> }
  | { ok: false; reason: 'insufficient' | 'error' | 'unauthorized' };

/**
 * Stream an AI analysis of the current green-card panel (cohort OR selection mode). The client
 * passes the SAME non-PHI aggregate it already rendered; {@link CollectionsAiInputSchema} is the PHI
 * firewall (strict — unknown keys are stripped, so no member id / alpha-prefix / patient name can
 * ride in). This is a NON-PHI aggregate → the model, so it uses the summary-read gate
 * (viewEntityScope), NOT the stricter PHI-reveal gate; tenant scope is derived server-side. The
 * real principal is resolved for the audit. Returns a text stream the panel renders progressively,
 * or a coarse, non-leaky reason (insufficient → fixed sentence; error/unauthorized → generic
 * notice). Every filter/search change makes the panel drop a prior summary and re-invoke — there is
 * no server-side caching here (each analysis is fresh + user-initiated).
 */
export async function generateCollectionsAiAnalysis(
  input: unknown,
  view?: DashboardView,
): Promise<CollectionsAiAnalysisResult> {
  // PHI firewall + shape validation FIRST — a malformed/oversized object never reaches the model.
  const parsed = CollectionsAiInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'error' };
  // Non-PHI tenant scope (same gate as the summary read), clamped server-side to the entitlement.
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, reason: 'unauthorized' };
  // Real principal for the durable audit (viewEntityScope already fails closed on no-auth).
  const access = await dashboardAccess();
  const user = access.ok ? access.access.user : null;
  if (!user) return { ok: false, reason: 'unauthorized' };
  return streamCollectionsAiAnalysis_(
    parsed.data satisfies CollectionsAiInput,
    { email: user.email, userId: user.id },
    entityIds,
  );
}

export type CohortCurveResult =
  | { ok: true; curve: CohortCurve }
  | { ok: false; error: string };

/**
 * Alpha-prefix cohort payer-behavior curve (Session D) — the MERGED attrition-rate / days-authorized
 * metric: allowed%/paid% across the claim sequence, rolled up over every patient sharing an alpha
 * prefix, on BOTH x-axes (claim/visit position + days-since-first). Tenant-scoped SERVER-SIDE from
 * the RBAC-clamped view. The raw alpha prefix is resolved to a keyed-HMAC blind-index TOKEN via the
 * SAME gated (canRevealPhi) + AUDITED path as the Patient Lookup — the raw value is never stored,
 * logged, or sent to SQL. Small-cohort suppression (min distinct patients/bucket) is enforced INSIDE
 * the query. Returns an EMPTY curve (never an error) when the prefix isn't usable (< 3 chars) or the
 * whole cohort is below the floor — the UI then shows "not enough data", never a partial disclosure.
 * NEVER returns a single patient's sequence or identity, under any role.
 */
export async function loadCohortCurve(
  alphaPrefix: string,
  view?: DashboardView,
): Promise<CohortCurveResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: 'The cohort view could not be loaded right now.' };
  // Gate (canRevealPhi) + resolve raw prefix -> opaque token + AUDIT (field names only, no term).
  const phi = await resolvePhiSearch({ alphaPrefix }, view, true);
  if (!phi.ok) return { ok: false, error: phi.error };
  const token = phi.phiIndex?.memberIdPrefixBidx;
  // No usable token (prefix < 3 chars, or nothing entitled/resolvable) → empty curve, not an error.
  if (!token) return { ok: true, curve: { by_position: [], by_days: [], cohort_patients: 0, totals: null } };
  try {
    return { ok: true, curve: await loadCohortCurve_(token, entityIds) };
  } catch {
    return { ok: false, error: 'The cohort view could not be loaded right now.' };
  }
}

export type CohortDrilldownActionResult =
  | { ok: true; drilldown: CohortDrilldownResult }
  | { ok: false; error: string };

/**
 * Drilldown for ONE clicked cohort-curve point (Session G) — an aggregate breakdown (payer mix,
 * CPT/rev mix) for that exact bucket, plus an optional patient table gated by a stricter, separate
 * floor (COHORT_DRILLDOWN_TABLE_MIN_PATIENTS). Same gate+audit shape as loadCohortCurve, but audited
 * as its OWN distinct access (`reveal_cmd_explorer_row(s)`-style, not piggybacked on the curve's
 * audit) — this is new disclosure surface (per-point breakdown, potentially per-row PHI-masked
 * data), so it gets its own audit trail entry independent of the curve fetch that preceded it.
 *
 * Tenant-scoped SERVER-SIDE from the RBAC-clamped view (same `entityIds` derivation as every other
 * collections reader); the reader independently re-derives `patients` for this exact bucket and
 * fails closed (null) if it doesn't clear COHORT_MIN_PATIENTS — a forged/stale bucket argument gets
 * nothing, never a partial answer.
 */
export async function loadCohortDrilldown(
  alphaPrefix: string,
  axis: 'position' | 'days',
  bucket: number,
  view?: DashboardView,
): Promise<CohortDrilldownActionResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false, error: 'The point detail could not be loaded right now.' };
  if (axis !== 'position' && axis !== 'days') return { ok: false, error: 'Invalid point.' };
  if (!Number.isInteger(bucket) || bucket < 0) return { ok: false, error: 'Invalid point.' };
  const phi = await resolvePhiSearch({ alphaPrefix }, view, true);
  if (!phi.ok) return { ok: false, error: phi.error };
  const token = phi.phiIndex?.memberIdPrefixBidx;
  if (!token) return { ok: false, error: 'That point is no longer available — try again.' };
  try {
    const drilldown = await loadCohortDrilldown_(token, entityIds, axis, bucket);
    if (!drilldown) return { ok: false, error: 'That point is no longer available — try again.' };
    return { ok: true, drilldown };
  } catch {
    return { ok: false, error: 'The point detail could not be loaded right now.' };
  }
}

export type CmdFacilitiesResult = { ok: true; facilities: CmdFacilityOption[] } | { ok: false };

/**
 * Facility options for the explorer's multi-select filter (non-PHI): the exact filterable facility
 * strings present in the caller's tenant, each enriched with a friendly name + care_setting (IP/OP/
 * BOTH, or null = Unclassified) for the dropdown's group affordances. Scoped to the RBAC-clamped
 * `view`'s entity ids (server-derived), so it lists only facilities the caller may see. Cached
 * reader-only; never returns PHI.
 */
export async function loadCmdExplorerFacilities(view?: DashboardView): Promise<CmdFacilitiesResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false };
  try {
    return { ok: true, facilities: await cmdExplorerFacilities(entityIds) };
  } catch {
    return { ok: false };
  }
}

export type CmdPayersResult = { ok: true; payers: string[] } | { ok: false };

/**
 * Payer options for the guided payer search (non-PHI): the distinct payer names present in the
 * caller's tenant, RBAC-clamped by `view` (server-derived entity scope). Cached reader-only; the
 * client loads this once and filters it as the user types. Never returns PHI.
 */
export async function loadCmdExplorerPayers(view?: DashboardView): Promise<CmdPayersResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false };
  try {
    return { ok: true, payers: await cmdExplorerPayers(entityIds) };
  } catch {
    return { ok: false };
  }
}

/** Max employer options one type-ahead keystroke may return. Bounds the payload AND the work. */
const COLLECTIONS_EMPLOYER_OPTIONS_LIMIT = 25;

export type CmdCollectionsEmployersResult = { ok: true; employers: string[] } | { ok: false };

/**
 * COLLECTIONS employer type-ahead (migration 0101) — reads collections.cmd_explorer_rows, NOT the
 * VOB. Ruled 2026-08-15: Collections reads collections data only; CMD is always the most current
 * source for collections, so a VOB-derived employer would both under-cover and disagree with the
 * grid beside it.
 *
 * Unlike facility/payer (~260 options each, loaded whole and filtered client-side), the employer
 * vocabulary is large, so this searches SERVER-SIDE per keystroke. The term floor is enforced HERE
 * as well as in the client: a 1–2 character term matches a huge fraction of the book and is the
 * single most expensive query on this surface, so the server must not depend on the client to gate
 * it. Returns [] rather than an error for a short term — a mid-typing request is not a failure.
 *
 * RBAC-clamped by `view` through the server-derived entity scope. Non-PHI: an employer is a
 * plan-level attribute in the same class as the payer name.
 */
export async function searchCollectionsEmployers(
  term: string,
  view?: DashboardView,
): Promise<CmdCollectionsEmployersResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false };
  const t = typeof term === 'string' ? term.trim() : '';
  if (t.length < CMD_SEARCH_TERM_MIN) return { ok: true, employers: [] };
  try {
    return {
      ok: true,
      employers: await cmdExplorerCollectionsEmployers(entityIds, t, COLLECTIONS_EMPLOYER_OPTIONS_LIMIT),
    };
  } catch {
    return { ok: false };
  }
}

export type CmdEmployerCoverageResult =
  | { ok: true; hasEmployerData: boolean; allHaveEmployerData: boolean }
  | { ok: false };

/**
 * Whether the caller's tenant has any employer data yet — gates the All/Employer/Individual toggle.
 *
 * Without this the Individual segment would silently mean "every row" until the backfill lands,
 * because `employer_name IS NULL` cannot distinguish "individual policy" from "not yet populated".
 * The UI uses this to disable the segment and say so, rather than render a filter that looks like
 * it works and is wrong.
 *
 * Fails CLOSED: an error returns ok:false and the client leaves the toggle on All. Defaulting to
 * "coverage exists" on failure would re-introduce exactly the misleading filter this prevents.
 */
export async function loadCollectionsEmployerCoverage(
  view?: DashboardView,
): Promise<CmdEmployerCoverageResult> {
  const entityIds = await viewEntityScope(view);
  if (entityIds === null) return { ok: false };
  try {
    const cov = await cmdExplorerEmployerCoverage(entityIds);
    return { ok: true, hasEmployerData: cov.hasEmployerData, allHaveEmployerData: cov.allHaveEmployerData };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Per-user saved grid views (Collections Explorer "Show columns" templates, migration 0046). ALL
// four actions scope to the caller's OWN authenticated identity, resolved SERVER-SIDE — they never
// accept a client-supplied user id, so one user can never read/modify/delete another's views. The
// writes go through the SECURITY DEFINER functions (server.ts wrappers); the columns array is
// allowlist-sanitized here before it is persisted. Fail closed with no principal (not signed in /
// unprovisioned / the no-auth staged-rollout fallback) — personal views require a real user.
// ---------------------------------------------------------------------------

/** The caller's own verified auth uid (the grid-view owner key), or null when there's no principal. */
async function currentUserId(): Promise<string | null> {
  const result = await dashboardAccess();
  if (!result.ok) return null;
  return result.access.user?.id ?? null;
}

/** Max saved views per user surfaced/creatable (bounded; a UI convenience, not a hard business cap). */
const GRID_VIEW_NAME_MAX = 80;

export type GridViewsResult = { ok: true; views: GridViewRow[] } | { ok: false };
export type GridViewMutationResult = { ok: true } | { ok: false; error: string };

/** List the signed-in user's saved column layouts (their own only). */
export async function listGridViews(): Promise<GridViewsResult> {
  const uid = await currentUserId();
  if (!uid) return { ok: false };
  try {
    return { ok: true, views: await gridViewsFor(uid) };
  } catch {
    return { ok: false };
  }
}

/**
 * Create or update (by name) one of the caller's saved views. `columns` is the full display order and
 * `hidden` the subset that is hidden — both allowlist-sanitized (unknown/dup/non-string keys dropped,
 * order preserved). A view must keep at least one column; `hidden` is intersected with `columns` so a
 * key can never be marked hidden without also being in the order, and at least one column stays visible.
 */
export async function saveGridView(
  name: string,
  columns: string[],
  hidden: string[] = [],
  makeDefault = false,
): Promise<GridViewMutationResult> {
  const uid = await currentUserId();
  if (!uid) return { ok: false, error: 'Sign in to save a view.' };
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > GRID_VIEW_NAME_MAX) {
    return { ok: false, error: `View name must be 1–${GRID_VIEW_NAME_MAX} characters.` };
  }
  const cols = sanitizeGridColumns(columns);
  if (cols.length === 0) return { ok: false, error: 'A view must include at least one column.' };
  const colSet = new Set<string>(cols);
  const hiddenCols = sanitizeGridColumns(hidden).filter((c) => colSet.has(c));
  // A view must keep at least one visible column (hiding everything is not a valid layout).
  if (hiddenCols.length >= cols.length) {
    return { ok: false, error: 'A view must keep at least one column visible.' };
  }
  try {
    await saveGridViewRow(uid, trimmed, cols, hiddenCols, Boolean(makeDefault));
    return { ok: true };
  } catch {
    return { ok: false, error: 'The view could not be saved right now.' };
  }
}

/** Make one of the caller's views their default (server fn errors if the name isn't theirs/absent). */
export async function setDefaultGridView(name: string): Promise<GridViewMutationResult> {
  const uid = await currentUserId();
  if (!uid) return { ok: false, error: 'Sign in to set a default view.' };
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { ok: false, error: 'Invalid view.' };
  try {
    await setDefaultGridViewRow(uid, trimmed);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Your default view could not be updated right now.' };
  }
}

/** Delete one of the caller's saved views by name (no-op if it isn't theirs / doesn't exist). */
export async function deleteGridView(name: string): Promise<GridViewMutationResult> {
  const uid = await currentUserId();
  if (!uid) return { ok: false, error: 'Sign in to delete a view.' };
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { ok: false, error: 'Invalid view.' };
  try {
    await deleteGridViewRow(uid, trimmed);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The view could not be deleted right now.' };
  }
}

export type RevealCmdRowResult =
  | { ok: true; phi: CmdExplorerPhi }
  | { ok: false; error: string };

export type RevealCmdRowsResult =
  | { ok: true; rows: Array<{ id: number } & CmdExplorerPhi> }
  | { ok: false; error: string };

/**
 * Reveal PHI for a SET of rows (the current page's ids) in one audited call — backs the
 * grid's "Reveal all" button. Requires an authorized session; writes one bulk audit row.
 * Returns a clear error on failure (e.g. a LIBSODIUM_KEY mismatch) so the UI can surface
 * it rather than silently appearing to do nothing.
 */
/**
 * PATIENT-NAME SEARCH over the Collections explorer — GATED (canRevealPhi) + AUDITED server-side.
 *
 * ⚠ THE SEARCH TERM IS PHI. It arrives in this Server Action's BODY and must never be put in the
 * URL, browser storage, a log line, or the audit `detail`. It is passed straight to the server
 * helper, compared against decrypted names in-process, and discarded. What comes BACK is only
 * bigserial row ids, which are non-PHI — that is what lets the caller re-query the grid without a
 * name ever crossing the wire a second time.
 *
 * Narrowing and the row cap are enforced in searchCmdExplorerPatientName (server-side), NOT here —
 * a client that skipped the check must not be able to trigger an unbounded decrypt.
 */
export async function searchCollectionsPatientName(
  term: string,
  filter: CmdReportFilter = {},
  view?: DashboardView,
): Promise<
  | { ok: true; result: CmdNameSearchResult }
  | { ok: false; error: string }
> {
  if (typeof term !== 'string' || term.trim() === '') {
    return { ok: false, error: 'Enter a name to search.' };
  }
  // Bounded input (OWASP): a name term has no legitimate reason to be long, and the value is PHI
  // we do not want to carry around at size.
  if (term.length > 120) {
    return { ok: false, error: 'That search term is too long.' };
  }
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  // Intersect the caller's FULL PHI entitlement with the view they are looking at, so the search
  // can never reach outside either bound.
  const viewIds = await viewEntityScope(view);
  if (viewIds === null) return { ok: false, error: 'Sign in to search patient names.' };
  const entityIds = gate.entityIds.filter((id) => viewIds.includes(id));
  if (entityIds.length === 0) return { ok: false, error: 'Your role does not permit this view.' };

  // Re-validate + translate the client filter exactly as loadCmdReport does, so the candidate set
  // this counts is the SAME set the grid is showing. Diverging here would mean telling the user
  // "1,900 rows" while the grid holds a different number.
  const readerFilter: {
    facility?: string[];
    from?: string;
    to?: string;
    q?: string;
    searchColumns?: CmdExplorerSearchColumn[];
    cpt_code?: string;
    revenue_code?: string;
    primary_payer?: string;
    primary_payers?: string[];
    phiIndex?: PhiIndexTokens;
    employer_names?: string[];
    employerMode?: 'all' | 'employer' | 'individual';
  } = {};
  if (!applyFacilityFilter(filter, readerFilter)) return { ok: false, error: 'Invalid facility.' };
  if (!applyPayerFilter(filter, readerFilter)) return { ok: false, error: 'Invalid payer.' };
  if (!applySearchFilter(filter, readerFilter)) return { ok: false, error: 'Invalid search.' };
  if (!applyDateWindow(filter, readerFilter)) return { ok: false, error: 'Invalid date window.' };
  if (!applyEmployerFilter(filter, readerFilter)) return { ok: false, error: 'Invalid employer filter.' };
  // `false` here = the caller passed PHI terms it is not entitled to resolve; already audited.
  const phi = await resolvePhiSearch(filter.phiSearch, view, true);
  if (!phi.ok) return { ok: false, error: phi.error };
  if (phi.phiIndex) readerFilter.phiIndex = phi.phiIndex;

  try {
    const result = await searchCmdExplorerPatientName(term, readerFilter, gate.actor, entityIds);
    return { ok: true, result };
  } catch {
    // Generic to the client; the real error may carry ciphertext context.
    return { ok: false, error: 'The name search could not be completed right now.' };
  }
}

export async function revealCmdReportRows(ids: number[]): Promise<RevealCmdRowsResult> {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: 'There is nothing to reveal.' };
  }
  if (ids.length > 200) {
    return { ok: false, error: 'Too many rows to reveal at once.' };
  }
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) {
    return { ok: false, error: 'Invalid row reference.' };
  }
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const rows = await revealCmdExplorerRows(ids, gate.actor, gate.entityIds);
    return { ok: true, rows };
  } catch {
    return { ok: false, error: 'The identifiers could not be revealed right now.' };
  }
}

/** Reveal ONE row's PHI by bigserial id. Requires an authorized session; audited. */
export async function revealCmdReportRow(id: number): Promise<RevealCmdRowResult> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'Invalid row reference.' };
  }
  const gate = await requirePhiPrincipal();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const phi = await revealCmdExplorerRow(id, gate.actor, gate.entityIds);
    if (!phi) {
      return { ok: false, error: 'Those identifiers are no longer available — reload and try again.' };
    }
    return { ok: true, phi };
  } catch {
    return { ok: false, error: 'The identifiers could not be revealed right now.' };
  }
}
