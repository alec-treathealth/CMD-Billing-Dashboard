/**
 * Pure SQL builders + types for the CMD Collections explorer grid and its "smart search"
 * summary. NO Next.js, NO pg, NO I/O — just string building over a closed allowlist, so this
 * module is unit-testable in a plain Node test runner (the compliance-critical surface:
 * injection safety, the PHI-column exclusion, and LIKE-metachar escaping live here).
 *
 * app/lib/server.ts imports these and adds the DB execution + caching; it re-exports the public
 * names so callers keep importing them from '@/lib/server'. Every COLUMN name emitted here is a
 * fixed literal (search/sort/group columns resolve through closed allowlists); every VALUE is a
 * bound `$n` parameter via the `add` closure — never interpolated.
 */
import type { CmdExplorerRow } from './cmdExplorer.js';

// --- filters + search allowlist ---------------------------------------------

/**
 * Closed allowlist for the smart search — the UI search-column key → raw SQL column literal.
 * ONLY the 11 NON-PHI columns are here; the 3 PHI columns (patient_name / member_id /
 * group_number) are encrypted bytea and cannot be substring-searched, so they are absent BY
 * DESIGN. The client only ever picks KEYS, never raw column names, so no identifier ever reaches
 * SQL from user input (injection-safe).
 */
export const CMD_EXPLORER_SEARCH_COLUMNS = {
  charge_date: 'charge_date',
  payment_received: 'payment_received',
  cpt_code: 'cpt_code',
  revenue_code: 'revenue_code',
  facility: 'facility',
  charge_amount: 'charge_amount',
  allowed_amount: 'allowed_amount',
  insurance_payments: 'insurance_payments',
  adjustments: 'adjustments',
  patient_balance_due: 'patient_balance_due',
  primary_payer: 'primary_payer',
} as const;
export type CmdExplorerSearchColumn = keyof typeof CMD_EXPLORER_SEARCH_COLUMNS;

/**
 * Server-side filters for the explorer grid (non-PHI). `facility` is a MULTI-select set membership
 * (`facility = any(...)`) — the facility multi-select dropdown AND a single-facility drill-down chip
 * both feed it (the chip as a one-element array); its vocabulary comes from buildCmdFacilityOptionsQuery,
 * NOT the canonical facility dimension. An EMPTY array means "no facility restriction" (all facilities),
 * NOT "match nothing" — the condition is omitted entirely. `cpt_code` / `primary_payer` are EXACT
 * matches (drill-down chips). `from`/`to` window payment_received ([from, to)). `q` + `searchColumns`
 * are the free-text substring search: `q` is matched as a literal substring (ILIKE) against EACH
 * allowlisted column in `searchColumns`, OR'd together. All values are bound parameters; nulls/empties
 * are no-ops.
 */
export interface CmdExplorerFilter {
  facility?: string[] | null;
  cpt_code?: string | null;
  primary_payer?: string | null;
  from?: string | null; // 'YYYY-MM-DD' inclusive (payment_received >= from)
  to?: string | null; // 'YYYY-MM-DD' exclusive (payment_received < to)
  q?: string | null; // substring term (matched literally; LIKE metachars escaped)
  searchColumns?: CmdExplorerSearchColumn[]; // which NON-PHI columns `q` searches
  /**
   * Searchable-PHI blind-index tokens (migration 0036) — ALREADY keyed-HMAC'd by the caller
   * (see blindIndex.ts). The RAW PHI never reaches this pure module: only the one-way token
   * does, and it's matched by equality. Each present token ANDs an equality predicate (an
   * identifier lookup narrows the result set). The action layer gates this to PHI-entitled
   * users + audits it; here it's just opaque tokens.
   */
  phiIndex?: {
    memberIdBidx?: string | null;
    memberIdPrefixBidx?: string | null;
    groupNumberBidx?: string | null;
  };
}

/** A `$n` parameter emitter: pushes a bound value and returns its placeholder. */
export type ParamAdder = (v: unknown) => string;

/** Escape LIKE metacharacters so `q` matches as a LITERAL substring, then wrap in %…%. */
export function likeContains(term: string): string {
  const escaped = term.replace(/([\\%_])/g, '\\$1');
  return `%${escaped}%`;
}

/**
 * The shared WHERE conditions for BOTH the explorer page query and the search-summary
 * aggregates: mandatory tenant scope first, then the optional exact/window/substring filters.
 * `add` pushes a bound parameter and returns its `$n` placeholder — every VALUE is bound, and
 * every column name is a fixed literal (search columns resolve through the closed allowlist).
 */
export function cmdExplorerBaseConds(
  filter: CmdExplorerFilter,
  entityIds: string[],
  add: ParamAdder,
): string[] {
  const conds: string[] = [];
  // Tenant scope FIRST — server-derived entitled entity ids, applied to every read.
  conds.push(`business_entity_id = any(${add(entityIds)}::uuid[])`);
  // Facility set-membership. A NON-EMPTY array narrows to those facilities; an EMPTY array (or
  // null/undefined) is NO restriction — the condition is omitted so the result set is ALL
  // facilities, never zero rows. (Emitting `= any(ARRAY[]::text[])` on empty would match nothing.)
  if (Array.isArray(filter.facility) && filter.facility.length > 0) {
    conds.push(`facility = any(${add(filter.facility)}::text[])`);
  }
  if (filter.cpt_code) conds.push(`cpt_code = ${add(filter.cpt_code)}`);
  if (filter.primary_payer) conds.push(`primary_payer = ${add(filter.primary_payer)}`);
  if (filter.from) conds.push(`payment_received >= ${add(filter.from)}::date`);
  if (filter.to) conds.push(`payment_received < ${add(filter.to)}::date`);
  const term = typeof filter.q === 'string' ? filter.q.trim() : '';
  const cols = (filter.searchColumns ?? []).filter(
    (c): c is CmdExplorerSearchColumn => Object.prototype.hasOwnProperty.call(CMD_EXPLORER_SEARCH_COLUMNS, c),
  );
  if (term !== '' && cols.length > 0) {
    const p = add(likeContains(term)); // one bound pattern, reused across the OR
    const ors = cols.map((c) => `${CMD_EXPLORER_SEARCH_COLUMNS[c]}::text ilike ${p}`);
    conds.push(`(${ors.join(' or ')})`);
  }
  // Searchable-PHI blind-index equality (opaque keyed-HMAC tokens; raw PHI never gets here).
  const phi = filter.phiIndex;
  if (phi?.memberIdBidx) conds.push(`member_id_bidx = ${add(phi.memberIdBidx)}`);
  if (phi?.memberIdPrefixBidx) conds.push(`member_id_prefix_bidx = ${add(phi.memberIdPrefixBidx)}`);
  if (phi?.groupNumberBidx) conds.push(`group_number_bidx = ${add(phi.groupNumberBidx)}`);
  return conds;
}

// --- facility options (multi-select dropdown) -------------------------------

/**
 * One facility choice for the multi-select dropdown. `facility` is the EXACT filterable value
 * (what the grid/summary match on — the CMD report's own facility text). `facility_name` is the
 * friendlier dimension name when it resolves, else null (falls back to `facility` in the UI).
 * `care_setting` powers the "select all IP/OP" group affordance; null = Unclassified/Other (the
 * facility isn't in collections.facilities, or its CMD text doesn't match the dimension name —
 * this is expected for a chunk of BXR facilities whose export text carries a trailing " LLC").
 */
export interface CmdFacilityOption {
  facility: string;
  facility_name: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

/**
 * Build the tenant-scoped facility-options query for the dropdown. The DISTINCT facility list is
 * taken STRICTLY from cmd_explorer_rows scoped to the caller's entitled entityIds (a BXR user never
 * sees an Indigo-only facility string), then LEFT JOINed to the non-PHI facility dimension purely
 * to enrich name + care_setting. The dimension has no business_entity_id, so it is NOT (and cannot
 * be) tenant-filtered — but since we only ever surface facility STRINGS that already passed the
 * tenant scope, no other tenant's facility leaks into the list; the join only attaches IP/OP labels.
 * `max()` collapses the rare case of two dimension rows sharing an upper(facility_name). Non-PHI;
 * every value bound ($1 = entityIds), every identifier a fixed literal.
 */
export function buildCmdFacilityOptionsQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds];
  const sql =
    'select r.facility, max(f.facility_name) as facility_name, max(f.care_setting) as care_setting ' +
    'from (select distinct facility from collections.cmd_explorer_rows ' +
    "where business_entity_id = any($1::uuid[]) and facility is not null and btrim(facility) <> '') r " +
    'left join collections.facilities f on upper(f.facility_name) = upper(r.facility) ' +
    'group by r.facility order by r.facility';
  return { sql, params };
}

// --- sort + cursor ----------------------------------------------------------

/**
 * Columns the explorer grid may sort by — a CLOSED allowlist of fixed SQL literals (the two
 * dates + the five money columns + the two payer-gap ratio columns). Anything else falls back to
 * the default sort. These are the raw cmd_explorer_rows columns (dates sort chronologically, money
 * + ratios numerically), which is why ORDER BY uses them directly rather than the to_char text
 * aliases in the SELECT. pct_allowed / pct_paid are GENERATED STORED numerics (migration 0038), so
 * they sort and keyset-cursor exactly like charge_amount — no pagination-strategy change.
 */
export const CMD_EXPLORER_SORTABLE_COLUMNS = [
  'payment_received',
  'charge_date',
  'charge_amount',
  'allowed_amount',
  'insurance_payments',
  'adjustments',
  'patient_balance_due',
  'pct_allowed',
  'pct_paid',
] as const;
export type CmdExplorerSortColumn = (typeof CMD_EXPLORER_SORTABLE_COLUMNS)[number];
const CMD_EXPLORER_SORTABLE = new Set<string>(CMD_EXPLORER_SORTABLE_COLUMNS);

export interface CmdExplorerSort {
  column: CmdExplorerSortColumn;
  direction: 'asc' | 'desc';
}

/** Default grid order: most-recent Payment Received first. */
export const CMD_EXPLORER_DEFAULT_SORT: CmdExplorerSort = {
  column: 'payment_received',
  direction: 'desc',
};

/**
 * Forward keyset cursor for the grid: the sort-column value + id of the LAST row of the page
 * just shown (both non-PHI). `value` is a JSON-safe scalar (dates are 'YYYY-MM-DD' text, money a
 * decimal string); null means that row sat in the trailing NULLS-LAST block.
 */
export interface CmdExplorerCursor {
  id: number;
  value: string | number | null;
}

/** Clamp a sort to the allowlist; fall back to the Payment-Received-DESC default otherwise. */
export function resolveCmdExplorerSort(sort: CmdExplorerSort | undefined): CmdExplorerSort {
  if (
    sort !== undefined &&
    CMD_EXPLORER_SORTABLE.has(sort.column) &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    return { column: sort.column, direction: sort.direction };
  }
  return { ...CMD_EXPLORER_DEFAULT_SORT };
}

/** Accept a cursor only if shaped safely; otherwise treat it as the first page. */
export function resolveCmdExplorerCursor(
  cursor: CmdExplorerCursor | null | undefined,
): CmdExplorerCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!Number.isSafeInteger(cursor.id) || cursor.id < 1) return null;
  const v = cursor.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number') return null;
  return { id: cursor.id, value: v ?? null };
}

// --- page query -------------------------------------------------------------

export const CMD_EXPLORER_PAGE_SIZE = 50;

/** One keyset page of the explorer grid + the cursor to fetch the next page (null at end). */
export interface CmdExplorerPage {
  rows: CmdExplorerRow[];
  nextCursor: CmdExplorerCursor | null;
}

// Explicit non-PHI column list — the bytea PHI columns are NEVER selected here. Dates and
// ingested_at are cast to text so the row shape is stable strings (not pg Date objects);
// numeric money stays a fixed-2-decimal string. pct_allowed / pct_paid are the GENERATED STORED
// payer-gap ratios (migration 0038) — non-PHI numerics that arrive as decimal strings (or null),
// formatted as percentages client-side. id (bigserial) is the keyset + reveal key.
export const CMD_EXPLORER_SELECT =
  "select id, to_char(charge_date, 'YYYY-MM-DD') as charge_date, " +
  "to_char(payment_received, 'YYYY-MM-DD') as payment_received, cpt_code, revenue_code, " +
  'facility, charge_amount, allowed_amount, insurance_payments, adjustments, ' +
  'patient_balance_due, primary_payer, pct_allowed, pct_paid, ' +
  `to_char(ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at ` +
  'from collections.cmd_explorer_rows';

/**
 * Build the keyset page query with optional filters + an allowlisted sort. Column/table names
 * are fixed literals; every VALUE (entity ids, facility, dates, cursor value/id, limit) is a bound
 * $n parameter — no interpolation, no SELECT *. The order is `<sortcol> <dir> NULLS LAST, id <dir>`,
 * and the cursor boundary continues STRICTLY after the previous page's last row in that ordering
 * (the NULLS-LAST block is handled explicitly for both directions), so paging walks the FILTERED,
 * SORTED set consistently.
 *
 * `entityIds` is the TENANT SCOPE — the business_entity_id(s) the caller may see, derived
 * SERVER-SIDE from the RBAC-clamped view (never client input). It is applied as a mandatory WHERE
 * so a page never crosses tenants.
 */
export function buildCmdExplorerQuery(
  cursor: CmdExplorerCursor | null,
  filter: CmdExplorerFilter,
  sort: CmdExplorerSort,
  limit: number,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  // Tenant scope + the exact/window/substring filters (shared with the search summary).
  const conds = cmdExplorerBaseConds(filter, entityIds, add);

  const col = sort.column; // allowlisted fixed literal (see CMD_EXPLORER_SORTABLE_COLUMNS)
  const cmp = sort.direction === 'asc' ? '>' : '<';
  if (cursor !== null) {
    if (cursor.value === null) {
      // Cursor row sat in the trailing NULL block: only later NULL rows remain.
      conds.push(`(${col} is null and id ${cmp} ${add(cursor.id)})`);
    } else {
      // Rows past the cursor on the sort key, ties broken by id, plus the whole NULL block
      // (which sorts after any non-null value under NULLS LAST).
      const valueParam = add(cursor.value);
      const idParam = add(cursor.id);
      conds.push(
        `(${col} ${cmp} ${valueParam} or (${col} = ${valueParam} and id ${cmp} ${idParam}) or ${col} is null)`,
      );
    }
  }

  const where = conds.length > 0 ? ` where ${conds.join(' and ')}` : '';
  const dir = sort.direction === 'asc' ? 'asc' : 'desc';
  const orderClause = ` order by ${col} ${dir} nulls last, id ${dir}`;
  const limitClause = ` limit ${add(limit)}`;
  return { sql: `${CMD_EXPLORER_SELECT}${where}${orderClause}${limitClause}`, params };
}

/** A row's sort-column value as a JSON-safe cursor scalar (all sortable columns are text/null). */
export function cmdExplorerSortValue(row: CmdExplorerRow, column: CmdExplorerSortColumn): string | null {
  return row[column] ?? null;
}

// --- smart search summary ---------------------------------------------------
// The "search engine" result: instead of paging through noisy rows, the search first returns an
// AGGREGATE summary of everything matching (count + money totals) plus the top facilities /
// payers / CPT codes, each of which the UI turns into a clickable drill-down chip. All non-PHI;
// same tenant scope + filters as the grid, so the summary and the rows it drills into agree.

/** How many entries each top-N grouping returns. */
export const CMD_SEARCH_TOP_N = 8;

/** One grouped bucket (facility / payer / cpt): its label + match count + charged total. */
export interface CmdSearchGroup {
  label: string | null;
  count: number;
  charge: number;
}

export interface CmdSearchSummary {
  total_count: number;
  total_charge: number;
  total_paid: number;
  total_balance: number;
  by_facility: CmdSearchGroup[];
  by_payer: CmdSearchGroup[];
  by_cpt: CmdSearchGroup[];
}

/** Group-by columns the summary rolls up — fixed literals, never user input. */
const CMD_SEARCH_GROUP_COLUMNS = {
  facility: 'facility',
  primary_payer: 'primary_payer',
  cpt_code: 'cpt_code',
} as const;
export type CmdSearchGroupColumn = keyof typeof CMD_SEARCH_GROUP_COLUMNS;

/**
 * Build the four aggregate queries backing the search summary — a totals query plus one top-N
 * grouping per dimension — all sharing the SAME tenant-scoped WHERE. Column names are fixed
 * literals; every value is a bound parameter. Exposed so a fixture can assert the exact SQL.
 */
export function buildCmdSearchSummaryQueries(
  filter: CmdExplorerFilter,
  entityIds: string[],
  topN: number = CMD_SEARCH_TOP_N,
): {
  totals: { sql: string; params: unknown[] };
  groups: Record<CmdSearchGroupColumn, { sql: string; params: unknown[] }>;
} {
  const build = (select: string, tail: (add: ParamAdder) => string) => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conds = cmdExplorerBaseConds(filter, entityIds, add);
    const where = ` where ${conds.join(' and ')}`;
    return { sql: `${select} from collections.cmd_explorer_rows${where}${tail(add)}`, params };
  };

  const totals = build(
    'select count(*)::int as total_count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as total_charge, ' +
      'coalesce(sum(insurance_payments), 0)::float8 as total_paid, ' +
      'coalesce(sum(patient_balance_due), 0)::float8 as total_balance',
    () => '',
  );

  const groups = {} as Record<CmdSearchGroupColumn, { sql: string; params: unknown[] }>;
  for (const key of Object.keys(CMD_SEARCH_GROUP_COLUMNS) as CmdSearchGroupColumn[]) {
    const col = CMD_SEARCH_GROUP_COLUMNS[key];
    groups[key] = build(
      `select ${col} as label, count(*)::int as count, coalesce(sum(charge_amount), 0)::float8 as charge`,
      (add) => ` group by ${col} order by charge desc nulls last, count desc limit ${add(topN)}`,
    );
  }
  return { totals, groups };
}
