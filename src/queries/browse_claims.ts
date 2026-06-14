/**
 * browse_claims — a page-limited, NON-PHI listing of claim rows for the Claims
 * Data Explorer (Phase 7.4 MVP).
 *
 * This is deliberately NOT part of the two-gate PHI path. The existing PHI flow
 * (search_claims → query_id → results route) re-derives patient rows through the
 * SECURITY DEFINER audit chokepoint and ships the entire matched slice; it is the
 * right tool for an audited, identity-verified reveal, but the wrong tool for a
 * freely-paginated browse. So this function instead projects ONLY non-PHI columns
 * (none of PhiKey / PHI_BASE_COLUMNS appear in BROWSE_COLUMNS) and bounds every
 * read with LIMIT/OFFSET. No patient identifiers ever leave the database on this
 * path, so the boundary and audit behavior are untouched.
 *
 * Security: like the aggregation functions, column names are FIXED literals and
 * filter VALUES are $n parameters. The sort column/direction are validated against
 * a closed allowlist before being interpolated; page/pageSize are bounded ints.
 */
import { buildClaimFilter, validateClaimFilter } from './filters.js';
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

export interface BrowseClaimsArgs {
  filter?: ClaimFilter;
  sort?: BrowseClaimsSort;
  /** 0-based page index. */
  page?: number;
  /** Rows per page; defaults to 50, capped at 200. */
  pageSize?: number;
}

export interface BrowseClaimsResult {
  rows: Record<string, unknown>[];
  columns: string[];
  page: number;
  pageSize: number;
  /** True when at least one more row exists past this page (fetched limit+1). */
  hasNext: boolean;
  sort: BrowseClaimsSort;
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

function resolvePage(n: number | undefined): number {
  if (!Number.isInteger(n) || (n as number) < 0) return 0;
  return n as number;
}

/**
 * Build the parameterized listing query. `orderClause` is composed only from the
 * validated sort allowlist (fixed literals), never from raw input; filter values
 * and the limit/offset are the only $n parameters. Exposed for tests.
 */
export function browseClaimsSql(
  filterClause: string,
  orderClause: string,
  limitIndex: number,
  offsetIndex: number,
): string {
  return (
    `select ${BROWSE_COLUMNS.join(', ')} from claims.claims` +
    (filterClause ? ` where ${filterClause}` : '') +
    ` order by ${orderClause}` +
    ` limit $${limitIndex} offset $${offsetIndex}`
  );
}

export async function browseClaims(
  args: BrowseClaimsArgs,
  ctx: QueryContext,
): Promise<BrowseClaimsResult> {
  const filter = validateClaimFilter(args.filter);
  const sort = resolveSort(args.sort);
  const pageSize = resolvePageSize(args.pageSize);
  const page = resolvePage(args.page);

  const { clause, params } = buildClaimFilter(filter, 1);

  // Stable order: the chosen (allowlisted) column then `id` as a tiebreaker so
  // pages don't shuffle rows with equal sort keys. `id` alone needs no tiebreak.
  const dir = sort.direction === 'asc' ? 'asc' : 'desc';
  const orderClause =
    sort.column === 'id' ? `id ${dir}` : `${sort.column} ${dir} nulls last, id ${dir}`;

  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  const sql = browseClaimsSql(clause, orderClause, limitIndex, offsetIndex);

  // Fetch one extra row to detect whether a next page exists, without a count(*).
  const limit = pageSize + 1;
  const offset = page * pageSize;
  const { rows } = await ctx.executor.query<Record<string, unknown>>(sql, [
    ...params,
    limit,
    offset,
  ]);

  const hasNext = rows.length > pageSize;
  const pageRows = hasNext ? rows.slice(0, pageSize) : rows;

  return { rows: pageRows, columns: [...BROWSE_COLUMNS], page, pageSize, hasNext, sort };
}
