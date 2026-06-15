/**
 * browse_claims — a page-limited, NON-PHI listing of claim rows for the Claims
 * Data Explorer (Phase 7.4; keyset pagination + single-claim lookup in 7.5).
 *
 * This is deliberately NOT part of the two-gate PHI path. The existing PHI flow
 * (search_claims → query_id → results route) re-derives patient rows through the
 * SECURITY DEFINER audit chokepoint and ships the entire matched slice; it is the
 * right tool for an audited, identity-verified reveal, but the wrong tool for a
 * freely-paginated browse. So this function instead projects ONLY non-PHI columns
 * (none of PhiKey / PHI_BASE_COLUMNS appear in BROWSE_COLUMNS) and bounds every
 * read with LIMIT. No patient identifiers ever leave the database on this path, so
 * the boundary and audit behavior are untouched.
 *
 * Pagination is KEYSET (cursor) on the synthetic `id`, combined with the active
 * sort column as a tuple boundary so deep pages stay cheap and stable. There is no
 * OFFSET. Previous-page navigation is handled by the client holding a stack of the
 * (non-PHI) cursors it used, so this layer only ever paginates forward.
 *
 * Security: like the aggregation functions, column names are FIXED literals and
 * filter/cursor VALUES are $n parameters. The sort column/direction are validated
 * against a closed allowlist before being interpolated; pageSize and cursor.id are
 * bounded integers; claimById validates its id as a bounded positive integer.
 */
import { validateClaimFilter } from './filters.js';
import type { ClaimFilter, QueryContext } from './types.js';

/**
 * The explorer projection — every column is non-PHI (allowlisted). Patient
 * identifiers (patient_name/last/first, member_id_*, group_number, employer_name)
 * are intentionally excluded; they are reachable only via the audited results path.
 */
export const BROWSE_COLUMNS: readonly string[] = [
  'id',
  'source_year',
  'date_of_service',
  'facility_name',
  'payer_name',
  'hcpcs_code',
  'revenue_code',
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'adjustment',
  'balance_due_pt',
  'collection_rate',
];

/** Columns the UI may sort by (closed allowlist; fixed literals only). */
const SORTABLE_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'source_year',
  'date_of_service',
  'facility_name',
  'payer_name',
  'hcpcs_code',
  'revenue_code',
  'charge_amount',
  'allowed_amount',
  'paid_amount',
  'collection_rate',
]);

export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_SORT: BrowseClaimsSort = { column: 'date_of_service', direction: 'desc' };

export interface BrowseClaimsSort {
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * Forward keyset cursor: the sort-column value and synthetic id of the LAST row of
 * the page just shown. Both are non-PHI (the sort column is allowlisted). `value`
 * is a JSON-safe scalar (dates already 'YYYY-MM-DD'); null means that row sat in
 * the trailing NULLS-LAST block.
 */
export interface BrowseClaimsCursor {
  id: number;
  value: string | number | null;
}

export interface BrowseClaimsArgs {
  filter?: ClaimFilter;
  sort?: BrowseClaimsSort;
  /** Rows per page; defaults to 50, capped at 200. */
  pageSize?: number;
  /** Forward cursor (last row of the previous page); absent/null = first page. */
  cursor?: BrowseClaimsCursor | null;
}

export interface BrowseClaimsResult {
  rows: Record<string, unknown>[];
  columns: string[];
  pageSize: number;
  /** True when at least one more row exists past this page (fetched limit+1). */
  hasNext: boolean;
  sort: BrowseClaimsSort;
  /** Cursor to fetch the next page, or null when this is the last page. */
  nextCursor: BrowseClaimsCursor | null;
}

/** Clamp the sort to the allowlist; fall back to the default for anything else. */
function resolveSort(sort: BrowseClaimsSort | undefined): BrowseClaimsSort {
  if (
    sort !== undefined &&
    SORTABLE_COLUMNS.has(sort.column) &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    return { column: sort.column, direction: sort.direction };
  }
  return { ...DEFAULT_SORT };
}

function resolvePageSize(n: number | undefined): number {
  if (!Number.isInteger(n) || (n as number) < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n as number, MAX_PAGE_SIZE);
}

/** Accept a cursor only if shaped safely; otherwise ignore it (treat as first page). */
function resolveCursor(cursor: BrowseClaimsCursor | null | undefined): BrowseClaimsCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!Number.isSafeInteger(cursor.id) || cursor.id < 1) return null;
  const v = cursor.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number') return null;
  return { id: cursor.id, value: v ?? null };
}

/** Normalize a row's sort value into a JSON-safe scalar for use as a cursor. */
function toCursorValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

/**
 * Build the keyset boundary so the query continues strictly AFTER the cursor row
 * in the active ordering (`<col> <dir> nulls last, id <dir>`). Parameterized from
 * `startIndex`. Handles the NULLS-LAST block explicitly for both directions.
 */
function buildCursorClause(
  sort: BrowseClaimsSort,
  cursor: BrowseClaimsCursor,
  startIndex: number,
): { clause: string; params: unknown[] } {
  const cmp = sort.direction === 'asc' ? '>' : '<';

  // Sorting by the unique key itself: a plain comparison is sufficient.
  if (sort.column === 'id') {
    return { clause: `id ${cmp} $${startIndex}`, params: [cursor.id] };
  }

  const col = sort.column; // allowlisted literal

  // Cursor row was in the trailing NULL block: only later NULL rows remain.
  if (cursor.value === null) {
    return { clause: `(${col} is null and id ${cmp} $${startIndex})`, params: [cursor.id] };
  }

  // Cursor row had a non-null sort value: rows beyond it on the sort key, ties
  // broken by id, plus the entire NULL block (which sorts after any non-null).
  const valueIndex = startIndex;
  const idIndex = startIndex + 1;
  const clause =
    `(${col} ${cmp} $${valueIndex} ` +
    `or (${col} = $${valueIndex} and id ${cmp} $${idIndex}) ` +
    `or ${col} is null)`;
  return { clause, params: [cursor.value, cursor.id] };
}

/**
 * Build a parameterized WHERE fragment for the browse explorer. Uses ILIKE
 * substring matching for facility_name and payer_name so partial text (e.g.
 * "Saddle") matches any facility/payer containing that substring. The `%`
 * wildcards are fixed SQL literals; only the search value is a $n parameter.
 * All other filter fields use exact/range comparisons as before.
 *
 * This is intentionally separate from buildClaimFilter (filters.ts), which
 * uses exact-match for the agent's search_claims tool — keeping agent behavior
 * unchanged while the explorer gains substring search.
 */
function buildBrowseClaimFilter(
  filter: ClaimFilter,
  startIndex: number,
): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;

  if (filter.facility !== undefined) {
    conds.push(`facility_name ilike '%' || $${i++} || '%'`);
    params.push(filter.facility);
  }
  if (filter.payer !== undefined) {
    conds.push(`payer_name ilike '%' || $${i++} || '%'`);
    params.push(filter.payer);
  }
  if (filter.date_from !== undefined) {
    conds.push(`date_of_service >= $${i++}`);
    params.push(filter.date_from);
  }
  if (filter.date_to !== undefined) {
    conds.push(`date_of_service <= $${i++}`);
    params.push(filter.date_to);
  }
  if (filter.source_year !== undefined) {
    conds.push(`source_year = $${i++}`);
    params.push(filter.source_year);
  }
  if (filter.hcpcs_code !== undefined) {
    conds.push(`lower(hcpcs_code) = lower($${i++})`);
    params.push(filter.hcpcs_code);
  }
  if (filter.revenue_code !== undefined) {
    conds.push(`lower(revenue_code) = lower($${i++})`);
    params.push(filter.revenue_code);
  }
  return { clause: conds.join(' and '), params };
}

/**
 * Build the parameterized listing query. `whereClause` and `orderClause` are
 * composed only from fixed literals + the validated sort allowlist; all VALUES
 * are $n parameters. Exposed for tests.
 */
export function browseClaimsSql(
  whereClause: string,
  orderClause: string,
  limitIndex: number,
): string {
  return (
    `select ${BROWSE_COLUMNS.join(', ')} from claims.claims` +
    (whereClause ? ` where ${whereClause}` : '') +
    ` order by ${orderClause}` +
    ` limit $${limitIndex}`
  );
}

export async function browseClaims(
  args: BrowseClaimsArgs,
  ctx: QueryContext,
): Promise<BrowseClaimsResult> {
  const filter = validateClaimFilter(args.filter);
  const sort = resolveSort(args.sort);
  const pageSize = resolvePageSize(args.pageSize);
  const cursor = resolveCursor(args.cursor);

  const { clause: filterClause, params: filterParams } = buildBrowseClaimFilter(filter, 1);

  const conds: string[] = [];
  const params: unknown[] = [...filterParams];
  if (filterClause) conds.push(filterClause);
  if (cursor !== null) {
    const c = buildCursorClause(sort, cursor, params.length + 1);
    conds.push(c.clause);
    params.push(...c.params);
  }
  const whereClause = conds.join(' and ');

  // Stable order: the chosen (allowlisted) column then `id` as a tiebreaker so
  // pages don't shuffle rows with equal sort keys. `id` alone needs no tiebreak.
  const dir = sort.direction === 'asc' ? 'asc' : 'desc';
  const orderClause =
    sort.column === 'id' ? `id ${dir}` : `${sort.column} ${dir} nulls last, id ${dir}`;

  // Fetch one extra row to detect whether a next page exists, without a count(*).
  const limitIndex = params.length + 1;
  const sql = browseClaimsSql(whereClause, orderClause, limitIndex);
  const limit = pageSize + 1;
  const { rows } = await ctx.executor.query<Record<string, unknown>>(sql, [...params, limit]);

  const hasNext = rows.length > pageSize;
  const pageRows = hasNext ? rows.slice(0, pageSize) : rows;

  let nextCursor: BrowseClaimsCursor | null = null;
  if (hasNext && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    const id = Number(last.id);
    if (Number.isSafeInteger(id)) {
      nextCursor = { id, value: toCursorValue(last[sort.column]) };
    }
  }

  return { rows: pageRows, columns: [...BROWSE_COLUMNS], pageSize, hasNext, sort, nextCursor };
}

/** SQL for a single-claim non-PHI lookup by synthetic id. Exposed for tests. */
export function claimByIdSql(): string {
  return `select ${BROWSE_COLUMNS.join(', ')} from claims.claims where id = $1`;
}

/**
 * Fetch ONE claim's non-PHI projection by synthetic id, or null if it does not
 * exist. `id` is validated as a bounded positive integer; the same non-PHI column
 * allowlist as the browse list — no patient identifiers are ever selected.
 */
export async function claimById(
  id: number,
  ctx: QueryContext,
): Promise<Record<string, unknown> | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { rows } = await ctx.executor.query<Record<string, unknown>>(claimByIdSql(), [id]);
  return rows[0] ?? null;
}
