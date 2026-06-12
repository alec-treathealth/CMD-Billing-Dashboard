/**
 * Phase 3 results route — the callable PHI path (transport-agnostic; src/server.ts
 * is a thin dev harness over it).
 *
 * A query function returns a non-PHI `summary_stats` + an opaque `query_id`; this
 * module turns that `query_id` back into the underlying PHI rows. It does so by:
 *
 *   1. Looking the handle up via `claims.get_query_log($1)` on the claims_reader
 *      connection. That definer function fail-closes on its own (no rows when the
 *      handle is expired, or when a `client_history` row has a NULL identity_hash),
 *      so a missing row here means "do not serve" — we return an empty result.
 *   2. Resolving the results-route column allowlist for the stored `function_name`
 *      (getColumns throws on any unregistered name — rejected before any data SQL).
 *   3. RE-EXECUTING the original parameterized query from the stored, re-validated
 *      `arguments`, but projecting ONLY the allowlisted columns (never SELECT *).
 *      PHI is never cached at rest — it is re-derived on each fetch.
 *
 * Two shapes, two code paths: this route returns PHI rows ONLY. No summary fields
 * appear here, and the summary path never sees these rows. The boundary is held by
 * construction — the column allowlist + a typed PHI-row response.
 *
 * PHI discipline: no row content is ever logged. The audit line for a fetch is
 * exactly { timestamp, query_id, function_name, row_count, created_by }. Stored
 * arguments are re-bound as $n parameters — never interpolated. Execution is
 * always as claims_reader (never the service role).
 *
 * client_history is special: its patient search terms are never stored in
 * query_log.arguments (they are PHI), so the query cannot be reconstructed from
 * stored args. The caller must RE-SUPPLY the identity terms (`input.identity`);
 * the route recomputes the identity hash in-process (identity.ts) and verifies it
 * against the stored value via claims.verify_identity (migration 0005) — which
 * compares server-side so the stored hash never leaves the DB — and serves rows
 * ONLY when that returns true. Absent identity, a wrong identity, or a failed
 * verification all fail-closed to an EMPTY result (never wrong/unverified PHI).
 */
import { buildClaimFilter, validateClaimFilter } from '../queries/filters.js';
import { getColumns } from '../queries/columns.js';
import { computeIdentityHash, normalizeMemberId } from '../queries/identity.js';
import {
  READMISSION_CONFIDENCE_CASE,
  READMISSION_PAIR_JOIN,
  validateGapDays,
} from '../queries/readmission_candidates.js';
import type { ClaimFilter, FunctionName, QueryExecutor } from '../queries/types.js';

/** Fixed pg_trgm threshold for client_history (mirrors the query function default). */
const CLIENT_HISTORY_DEFAULT_THRESHOLD = 0.4;

/** A PHI result row — opaque column bag; never logged, never sent to an LLM. */
export type PhiRow = Record<string, unknown>;

/**
 * Re-supplied identity terms for a client_history fetch. PHI VALUES — used only to
 * recompute the identity hash and as bound query parameters; never stored or
 * logged. Ignored for every other function.
 */
export interface ResultsIdentity {
  patient_last: string;
  member_id_norm?: string;
}

export interface ResultsInput {
  /** The opaque handle returned by a query function. */
  query_id: string;
  /** User/session identifier for the audit trail — NEVER PHI. */
  created_by: string;
  /** Required for client_history (verified before serving); ignored otherwise. */
  identity?: ResultsIdentity;
}

export interface ResultsResponse {
  rows: PhiRow[];
  /** The function that produced the handle; null when the handle is missing/expired. */
  function_name: FunctionName | null;
  query_id: string;
}

/** Per-call context. `executor` MUST be the claims_reader connection. */
export interface ResultsContext {
  executor: QueryExecutor;
  now?: () => Date;
  /** Audit sink; defaults to one JSON line on stdout. */
  audit?: (line: string) => void;
}

/** The non-PHI shape get_query_log returns (identity_hash is intentionally absent). */
interface QueryLogRow {
  id: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  function_name: FunctionName;
  arguments: Record<string, unknown>;
  summary_stats: Record<string, unknown>;
}

const stdoutAudit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function emitAudit(
  ctx: ResultsContext,
  fields: { query_id: string; function_name: FunctionName | null; row_count: number; created_by: string },
): void {
  const line = JSON.stringify({
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    query_id: fields.query_id,
    function_name: fields.function_name,
    row_count: fields.row_count,
    created_by: fields.created_by,
  });
  (ctx.audit ?? stdoutAudit)(line);
}

/**
 * Row-level query for the filter-only functions (distribution, payer_gap_analysis,
 * search_claims). Projects exactly the allowlisted columns over the stored filter.
 * Exposed for the fixture to assert exact SQL.
 */
export function filterResultsSql(columns: readonly string[], filterClause: string): string {
  return (
    `select ${columns.join(', ')} from claims.claims` +
    (filterClause ? ` where ${filterClause}` : '')
  );
}

/**
 * Row-level query for readmission_candidates: re-runs the chronological self-join
 * and projects each allowlisted column for BOTH pair sides (`a_` / `b_`), plus the
 * computed `confidence` tier and the bound `gap_days` ($1). `id` surfaces per side
 * as `a_id` / `b_id`. Reuses the summary builder's CASE + join so the grading can
 * never diverge. Exposed for the fixture to assert exact SQL.
 */
export function readmissionResultsSql(columns: readonly string[], filterClause: string): string {
  const filtered = filterClause
    ? `select * from claims.claims where ${filterClause}`
    : `select * from claims.claims`;
  const projection = columns.map((c) => `a.${c} as a_${c}, b.${c} as b_${c}`).join(', ');
  return (
    `with f as (${filtered}), ` +
    `pairs as (` +
    `select ` +
    `${READMISSION_CONFIDENCE_CASE}, ` +
    `($1)::int as gap_days, ` +
    `${projection} ` +
    `from f a ` +
    `${READMISSION_PAIR_JOIN}` +
    `) ` +
    `select * from pairs where confidence is not null`
  );
}

/**
 * Row-level query for client_history: the SAME WHERE as the summary builder
 * (similarity on patient_last $1 >= threshold $2, optional member_id_norm $3,
 * then the filter), but projecting the allowlisted columns instead of the
 * per-year aggregate. Exposed for the fixture to assert exact SQL.
 */
export function clientHistoryResultsSql(
  columns: readonly string[],
  hasMember: boolean,
  filterClause: string,
): string {
  const conds = ['claims.similarity(patient_last, $1) >= $2'];
  if (hasMember) conds.push('member_id_norm = $3');
  if (filterClause) conds.push(filterClause);
  return `select ${columns.join(', ')} from claims.claims where ${conds.join(' and ')}`;
}

/** Reconstruct the parameterized row-level query from stored, re-validated args. */
function buildResultsQuery(
  functionName: FunctionName,
  columns: readonly string[],
  args: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  // Re-validate the stored filter at this boundary (defense in depth) before binding.
  const filter: ClaimFilter = validateClaimFilter((args.filter ?? {}) as ClaimFilter);

  if (functionName === 'readmission_candidates') {
    const gapDays = validateGapDays(args.gap_days as number | undefined);
    // gap_days is $1; filter values follow from $2 (mirrors the summary builder).
    const { clause, params } = buildClaimFilter(filter, 2);
    return { sql: readmissionResultsSql(columns, clause), params: [gapDays, ...params] };
  }

  // distribution / payer_gap_analysis / search_claims: the drill-down is the rows
  // in the filtered slice. field/metric don't constrain rows, so only the filter
  // is re-bound (from $1).
  const { clause, params } = buildClaimFilter(filter, 1);
  return { sql: filterResultsSql(columns, clause), params };
}

/**
 * client_history fetch: require re-supplied identity terms, verify them against
 * the stored identity_hash (server-side, via claims.verify_identity), and serve
 * the row-level query ONLY on a true verification. Every fail-closed branch
 * returns an EMPTY result for the (valid) client_history handle.
 */
async function fetchClientHistory(
  ctx: ResultsContext,
  query_id: string,
  created_by: string,
  columns: readonly string[],
  args: Record<string, unknown>,
  identity: ResultsIdentity | undefined,
): Promise<ResultsResponse> {
  const empty = (): ResultsResponse => {
    emitAudit(ctx, { query_id, function_name: 'client_history', row_count: 0, created_by });
    return { rows: [], function_name: 'client_history', query_id };
  };

  // Identity terms are mandatory here; absent/blank -> fail-closed empty.
  if (
    identity === undefined ||
    typeof identity.patient_last !== 'string' ||
    identity.patient_last.trim() === ''
  ) {
    return empty();
  }

  const patientLast = identity.patient_last.trim();
  const memberNorm = normalizeMemberId(identity.member_id_norm);
  const hasMember = memberNorm.length > 0;

  // Recompute the binding hash in-process (identity.ts is the single source of
  // truth) and verify it server-side. The stored hash never leaves the DB.
  const identityHash = computeIdentityHash(patientLast, memberNorm, query_id);
  const { rows: verifyRows } = await ctx.executor.query<{ ok: boolean }>(
    'select claims.verify_identity($1, $2) as ok',
    [query_id, identityHash],
  );
  if (verifyRows[0]?.ok !== true) {
    return empty(); // wrong identity, expired, or unverifiable — do not serve.
  }

  // Verified — re-run the row query with the SAME WHERE the summary used.
  const filter = validateClaimFilter((args.filter ?? {}) as ClaimFilter);
  const threshold =
    typeof args.match_threshold === 'number' ? args.match_threshold : CLIENT_HISTORY_DEFAULT_THRESHOLD;
  const params: unknown[] = [patientLast, threshold];
  let nextIndex = 3;
  if (hasMember) {
    params.push(memberNorm);
    nextIndex = 4;
  }
  const { clause, params: filterParams } = buildClaimFilter(filter, nextIndex);
  params.push(...filterParams);

  const sql = clientHistoryResultsSql(columns, hasMember, clause);
  const { rows } = await ctx.executor.query<PhiRow>(sql, params);

  emitAudit(ctx, { query_id, function_name: 'client_history', row_count: rows.length, created_by });
  return { rows, function_name: 'client_history', query_id };
}

/**
 * Turn a query_id into its PHI result rows. Returns an empty result (fail-closed)
 * when the handle is missing, expired, or otherwise withheld by get_query_log, and
 * (for client_history) when identity verification is absent or fails. Throws only
 * on an unregistered function_name.
 */
export async function fetchResults(
  input: ResultsInput,
  ctx: ResultsContext,
): Promise<ResultsResponse> {
  const { query_id, created_by, identity } = input;

  // 1. Resolve the handle. get_query_log is the SECURITY DEFINER point lookup and
  //    already fail-closes on expiry / unverifiable client_history rows.
  const { rows: logRows } = await ctx.executor.query<QueryLogRow>(
    'select id, created_at, expires_at, created_by, function_name, arguments, summary_stats ' +
      'from claims.get_query_log($1)',
    [query_id],
  );
  const log = logRows[0];
  if (log === undefined) {
    // Missing, expired, or a client_history row with no verifiable identity_hash.
    emitAudit(ctx, { query_id, function_name: null, row_count: 0, created_by });
    return { rows: [], function_name: null, query_id };
  }

  const functionName = log.function_name;

  // 2. Column allowlist — rejects any unregistered function_name before any data SQL.
  const columns = getColumns(functionName);

  // 3. client_history takes the identity-verification path; identity is ignored
  //    for every other function.
  if (functionName === 'client_history') {
    return fetchClientHistory(ctx, query_id, created_by, columns, log.arguments, identity);
  }

  // 4. Re-execute the original parameterized query, projecting only allowlisted columns.
  const { sql, params } = buildResultsQuery(functionName, columns, log.arguments);
  const { rows } = await ctx.executor.query<PhiRow>(sql, params);

  // 5. One audit line — counts only, never row content.
  emitAudit(ctx, { query_id, function_name: functionName, row_count: rows.length, created_by });

  return { rows, function_name: functionName, query_id };
}
