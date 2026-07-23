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
 * ONLY the 4 TEXT columns admissions actually search by are here (facility / primary_payer /
 * cpt_code / revenue_code). The numeric + date columns (charge_amount, allowed_amount,
 * insurance_payments, adjustments, patient_balance_due, charge_date, payment_received) were REMOVED
 * from the substring bar: a leading-wildcard `::text ILIKE '%q%'` on them can't use any index and
 * roughly DOUBLED the per-keystroke aggregate cost for almost no real use (nobody free-text-searches
 * a dollar amount — the date window, the sort headers, and the drill chips are the right tools for
 * money/date). The 3 PHI columns (patient_name / member_id / group_number) are encrypted bytea and
 * cannot be substring-searched, so they are absent BY DESIGN (the gated blind-index lookup handles
 * those). The client only ever picks KEYS, never raw column names, so no identifier ever reaches SQL
 * from user input (injection-safe).
 */
export const CMD_EXPLORER_SEARCH_COLUMNS = {
  facility: 'facility',
  primary_payer: 'primary_payer',
  cpt_code: 'cpt_code',
  revenue_code: 'revenue_code',
} as const;
export type CmdExplorerSearchColumn = keyof typeof CMD_EXPLORER_SEARCH_COLUMNS;

/**
 * Minimum free-text term length before the substring search runs. A 1–2 char prefix (`%90%`) matches
 * a huge fraction of the tenant slice and is a THROWAWAY mid-typing query — also the single most
 * expensive to run — so a shorter term emits NO substring clause at all (the query degrades to a
 * plain browse of the current window). The client mirrors this floor (MIN_SEARCH_LEN in
 * cmd-explorer.tsx) to avoid firing the request; this is the authoritative, unit-tested server-side
 * floor that the summary + grid builders both honor.
 */
export const CMD_SEARCH_TERM_MIN = 3;

/**
 * Server-side filters for the explorer grid (non-PHI). `facility` is a MULTI-select set membership
 * (`facility = any(...)`) — the facility multi-select dropdown AND a single-facility drill-down chip
 * both feed it (the chip as a one-element array); its vocabulary comes from buildCmdFacilityOptionsQuery,
 * NOT the canonical facility dimension. An EMPTY array means "no facility restriction" (all facilities),
 * NOT "match nothing" — the condition is omitted entirely. `cpt_code` / `revenue_code` / `primary_payer`
 * are EXACT matches (drill-down chips); a (CPT, Revenue-code) combo chip sets `cpt_code` AND
 * `revenue_code` together. `from`/`to` window payment_received ([from, to)). `q` + `searchColumns`
 * are the free-text substring search: `q` is matched as a literal substring (ILIKE) against EACH
 * allowlisted column in `searchColumns`, OR'd together. All values are bound parameters; nulls/empties
 * are no-ops.
 */
export interface CmdExplorerFilter {
  facility?: string[] | null;
  cpt_code?: string | null;
  revenue_code?: string | null;
  primary_payer?: string | null;
  /**
   * Multi-select payer tags (the guided payer search). Set membership like `facility`: a NON-EMPTY
   * array ANDs `primary_payer = any(...)`; empty/absent = no payer restriction (not match-nothing).
   * Distinct from the single `primary_payer` (legacy single-drill field) — both are supported; the
   * explorer UI now feeds this array.
   */
  primary_payers?: string[] | null;
  /**
   * VOB MARKET filters — the member's verified employer / funding, matched through the
   * vob.member_benefits_current view on member_id_bidx (member-level; the bidx is tenant-agnostic).
   * Set membership like `facility`/`primary_payers`: a NON-EMPTY array narrows, empty/absent is no
   * restriction. `employers` matches employer_norm (the normalized, indexed employer key the
   * type-ahead picker supplies); `funding` matches the market tag ('Self-Funded' / 'Fully Insured').
   * SEMANTICS: the match is a SEMI-JOIN into the VOB set, so a charge whose member has NO VOB (or
   * whose VOB doesn't match) is EXCLUDED whenever either filter is active — "no-VOB excluded" is
   * intrinsic to the predicate, not a separate flag.
   */
  employers?: string[] | null;
  funding?: string[] | null;
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

/** The employer / funding market filter (the member's verified VOB employer + funding). */
export interface VobMarketFilter {
  employers?: string[] | null; // selected employer_norm values (type-ahead picker vocabulary)
  funding?: string[] | null; // market tags: 'Self-Funded' / 'Fully Insured'
}

/**
 * The VOB employer/funding market predicate, as a SEMI-JOIN on member_id_bidx:
 *   `member_id_bidx in (select member_id_bidx from vob.member_benefits_current where <conds>)`
 * Returns null when neither filter is active (a no-op). Shared by the collections grid/summary AND
 * the qualify builders so the predicate and its column names (funding / employer_norm) live in ONE
 * place. A SEMI-JOIN, not a JOIN: vob.member_benefits_current also has member_id_bidx, so joining it
 * would make the callers' UNQUALIFIED member_id_bidx conditions ambiguous and force a FROM change.
 * Both sub-conditions target the SAME (latest) VOB row per member. "No-VOB excluded" is intrinsic —
 * a member absent from the subquery cannot satisfy the IN. Every value is bound via `add`.
 */
export function buildVobMarketSemiJoin(filter: VobMarketFilter, add: ParamAdder): string | null {
  const vobConds: string[] = [];
  if (Array.isArray(filter.funding) && filter.funding.length > 0) {
    vobConds.push(`funding = any(${add(filter.funding)}::text[])`);
  }
  if (Array.isArray(filter.employers) && filter.employers.length > 0) {
    vobConds.push(`employer_norm = any(${add(filter.employers)}::text[])`);
  }
  if (vobConds.length === 0) return null;
  // vob.member_benefits_latest is the MATERIALIZED latest-per-member set (migration 0063), refreshed on
  // each VOB load. It supersedes the plain vob.member_benefits_current view here: that view recomputed
  // latest-per-member (~0.7–1.1s sort+DISTINCT over the whole table) on EVERY market-filtered query.
  return `member_id_bidx in (select member_id_bidx from vob.member_benefits_latest where ${vobConds.join(' and ')})`;
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
  if (filter.revenue_code) conds.push(`revenue_code = ${add(filter.revenue_code)}`);
  if (filter.primary_payer) conds.push(`primary_payer = ${add(filter.primary_payer)}`);
  // Payer set-membership (multi-select tags), same discipline as facility: non-empty array narrows,
  // empty/absent is no restriction (omitted, never `= any(ARRAY[]::text[])` which matches nothing).
  if (Array.isArray(filter.primary_payers) && filter.primary_payers.length > 0) {
    conds.push(`primary_payer = any(${add(filter.primary_payers)}::text[])`);
  }
  // VOB employer / funding market filters — shared semi-join helper (member_id_bidx IN (…); see
  // buildVobMarketSemiJoin for why it's a semi-join, not a JOIN). Applies identically to the grid and
  // every summary aggregate; "no-VOB excluded" is intrinsic when either filter is active.
  const vobMarket = buildVobMarketSemiJoin(filter, add);
  if (vobMarket) conds.push(vobMarket);
  if (filter.from) conds.push(`payment_received >= ${add(filter.from)}::date`);
  if (filter.to) conds.push(`payment_received < ${add(filter.to)}::date`);
  const term = typeof filter.q === 'string' ? filter.q.trim() : '';
  const cols = (filter.searchColumns ?? []).filter(
    (c): c is CmdExplorerSearchColumn => Object.prototype.hasOwnProperty.call(CMD_EXPLORER_SEARCH_COLUMNS, c),
  );
  // A sub-minimum term emits NO substring clause (see CMD_SEARCH_TERM_MIN) — the short-prefix
  // scans were the bulk of the wasted work, and this is the authoritative floor both builders share.
  if (term.length >= CMD_SEARCH_TERM_MIN && cols.length > 0) {
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
 * sees an Indigo-only facility string), then resolved to the non-PHI facility dimension purely to
 * enrich name + care_setting. Resolution is two-path: an EXACT name match, else the explicit
 * cmd_facility_aliases crosswalk (migration 0039) — which reconciles the CMD export text with the
 * curated dimension name (trailing " LLC", abbreviations, multi-text facilities, a confirmed typo).
 * care_setting is always read from the resolved dimension row (single source of truth), never the
 * crosswalk. The dimension has no business_entity_id, so it is NOT tenant-filtered — but since we
 * only ever surface facility STRINGS that already passed the tenant scope, no other tenant's
 * facility leaks into the list; the joins only attach the IP/OP label. A text that resolves to
 * neither (e.g. the "No Facility" placeholder) yields a null care_setting → "Other" in the UI.
 * `max()` collapses any join multiplicity. Non-PHI; every value bound ($1 = entityIds), every
 * identifier a fixed literal.
 */
export function buildCmdFacilityOptionsQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds];
  const sql =
    'select r.facility, max(f.facility_name) as facility_name, max(f.care_setting) as care_setting ' +
    'from (select distinct facility from collections.cmd_explorer_rows ' +
    "where business_entity_id = any($1::uuid[]) and facility is not null and btrim(facility) <> '') r " +
    'left join collections.facilities fe on upper(fe.facility_name) = upper(r.facility) ' +
    'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(r.facility) ' +
    'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, a.facility_code) ' +
    'group by r.facility order by r.facility';
  return { sql, params };
}

/**
 * Distinct payer names for the guided PAYER search's type-ahead, tenant-scoped to the caller's
 * entitled entityIds. Non-PHI (`primary_payer` is a payer name, not an identifier). Blank/null
 * payers are excluded; results are ordered for a stable client list. Every value is bound
 * ($1 = entityIds); every identifier is a fixed literal. ~260 distinct payers per tenant, so the
 * client loads the full list ONCE and filters it as the user types — no per-keystroke round-trip
 * and no server-side pagination needed at this cardinality.
 */
export function buildCmdPayerOptionsQuery(entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds];
  const sql =
    'select distinct primary_payer from collections.cmd_explorer_rows ' +
    "where business_entity_id = any($1::uuid[]) and primary_payer is not null and btrim(primary_payer) <> '' " +
    'order by primary_payer';
  return { sql, params };
}

/** The funding-market vocabulary — the exact stored values the `funding` filter matches. Static (a
 *  two-value enum), so the UI renders a fixed toggle/tag set with no query. */
export const CMD_FUNDING_MARKETS = ['Self-Funded', 'Fully Insured'] as const;

/**
 * One employer choice for the guided employer type-ahead. `employer_norm` is the EXACT filter value
 * (what the grid/qualify `employers` filter matches — the normalized, indexed key); `employer_name`
 * is a representative raw display name (several raw spellings can collapse to one norm), or null.
 */
export interface CmdEmployerOption {
  employer_norm: string;
  employer_name: string | null;
}

/**
 * Distinct EMPLOYER options for the guided employer type-ahead. UNLIKE facility/payer (loaded once at
 * ~260 each), there are ~11.6k distinct employers, so this is a SERVER-SIDE, per-keystroke search:
 * the caller passes the typed `term` (gate a sub-CMD_SEARCH_TERM_MIN term client-side) and a `limit`.
 * Tenant-scoped to employers that actually appear for the caller's own members (via the VOB↔collections
 * member_id_bidx link) so a picked option always has rows. Returns the FILTER value (`employer_norm` —
 * what the grid/qualify `employers` filter matches) plus a representative display `employer_name`
 * (multiple raw names can share one norm). `term` is a LITERAL substring (LIKE metachars escaped);
 * every value is bound ($1 entityIds, $2 pattern, $3 limit), every identifier a fixed literal.
 */
export function buildCmdEmployerOptionsQuery(
  entityIds: string[],
  term: string,
  limit: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [entityIds, likeContains(term), limit];
  const sql =
    'select employer_norm, max(employer_name) as employer_name ' +
    // Materialized latest-per-member set (0063): the employer_norm trigram GIN index serves the
    // leading-wildcard ILIKE, and the set is deduped once per load — not recomputed per keystroke.
    'from vob.member_benefits_latest ' +
    'where employer_norm is not null and employer_norm ilike $2 ' +
    'and member_id_bidx in (select member_id_bidx from collections.cmd_explorer_rows ' +
    'where business_entity_id = any($1::uuid[])) ' +
    'group by employer_norm order by employer_norm limit $3';
  return { sql, params };
}

// --- saved grid views (per-user column layout) ------------------------------

/**
 * The explorer grid's DISPLAY columns — the CLOSED allowlist of column KEYS a saved view may
 * reference. The ORDER of a saved view's array is the display order; MEMBERSHIP is visibility (a
 * column absent from the array is hidden). This includes the 3 PHI *display* keys (patient_name /
 * member_id_raw / group_number): the KEY is non-PHI (the VALUE renders masked until an audited
 * reveal), so a layout may legitimately include or omit them. Kept here (not just in the client's
 * COLUMNS) so the server can validate a client-supplied saved-view column list against a fixed set —
 * no unknown/garbage key is ever persisted. Order mirrors the client's DEFAULT_ORDER.
 */
export const CMD_EXPLORER_COLUMN_KEYS = [
  'charge_date',
  'payment_received',
  'cpt_code',
  'revenue_code',
  'primary_payer',
  'patient_name',
  'member_id_raw',
  'group_number',
  'facility',
  'charge_amount',
  'allowed_amount',
  'pct_allowed',
  'insurance_payments',
  'pct_paid',
  'adjustments',
  'patient_balance_due',
] as const;
export type CmdExplorerColumnKey = (typeof CMD_EXPLORER_COLUMN_KEYS)[number];
const CMD_EXPLORER_COLUMN_KEY_SET = new Set<string>(CMD_EXPLORER_COLUMN_KEYS);

/**
 * Sanitize a client-supplied saved-view column list before it is persisted: keep only allowlisted
 * keys, in the supplied order, de-duplicated; silently drop anything unknown/non-string; the result
 * can never exceed the allowlist size. Returns [] when nothing valid remains — the caller treats an
 * empty result as an invalid save (a view must show at least one column). This is the injection/DoS
 * boundary for the untrusted `columns` array (which is otherwise stored verbatim as jsonb).
 */
export function sanitizeGridColumns(input: unknown): CmdExplorerColumnKey[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: CmdExplorerColumnKey[] = [];
  for (const v of input) {
    if (typeof v !== 'string' || !CMD_EXPLORER_COLUMN_KEY_SET.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v as CmdExplorerColumnKey);
  }
  return out;
}

// --- sort + cursor ----------------------------------------------------------

/**
 * Columns the explorer grid may sort by — a CLOSED allowlist of fixed SQL literals (the two dates +
 * the four rollup-MATERIALIZED money columns). Anything else falls back to the default sort. These
 * are all values the 0050 charge-grain rollup carries per charge, so keyset paging drives off the
 * rollup's indexes (see buildCmdExplorerQuery).
 *
 * allowed_amount / pct_allowed / pct_paid are SORTABLE AGAIN (0059 repoint ③): the rollup now
 * materializes allowed_reliable + both pcts, so there is a real column to keyset on — BUILD X's
 * per-page selection (which forced dropping these three) is deleted. The grid's displayed
 * "allowed_amount" is the matview's allowed_reliable (aliased), so the allowed_amount sort targets
 * the PHYSICAL allowed_reliable column via CMD_EXPLORER_SORT_SQL below — never the raw netted
 * allowed_amount column, which the grid no longer displays.
 */
export const CMD_EXPLORER_SORTABLE_COLUMNS = [
  'payment_received',
  'charge_date',
  'charge_amount',
  'allowed_amount',
  'pct_allowed',
  'pct_paid',
  'insurance_payments',
  'adjustments',
  'patient_balance_due',
] as const;
export type CmdExplorerSortColumn = (typeof CMD_EXPLORER_SORTABLE_COLUMNS)[number];
const CMD_EXPLORER_SORTABLE = new Set<string>(CMD_EXPLORER_SORTABLE_COLUMNS);

/**
 * Physical rollup column behind each sortable key — ALL fixed literals. `allowed_amount` is the ONE
 * remap: the grid DISPLAYS `allowed_reliable AS allowed_amount` (0059), so its ORDER BY and keyset
 * conditions must bind allowed_reliable — `order by t.allowed_amount` would silently sort by the
 * raw NETTED column, a number the grid does not display (rows would appear misordered vs the cell
 * values, and the keyset cursor — built from the DISPLAYED value — would walk the wrong ordering).
 */
const CMD_EXPLORER_SORT_SQL: Record<CmdExplorerSortColumn, string> = {
  payment_received: 'payment_received',
  charge_date: 'charge_date',
  charge_amount: 'charge_amount',
  allowed_amount: 'allowed_reliable',
  pct_allowed: 'pct_allowed',
  pct_paid: 'pct_paid',
  insurance_payments: 'insurance_payments',
  adjustments: 'adjustments',
  patient_balance_due: 'patient_balance_due',
};

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
  // Aliased `t` SO THE ORDER BY CAN TARGET THE RAW COLUMN: the two date columns are projected as
  // `to_char(<date>, 'YYYY-MM-DD') AS <date>` (output name == column name), and an UNQUALIFIED
  // `order by payment_received` resolves to that TEXT output alias (Postgres: output name wins in
  // ORDER BY), which no index can serve — forcing a full seq scan + top-N sort of the tenant slice.
  // `order by t.<col>` (see buildCmdExplorerQuery) binds to the underlying date/numeric column so
  // idx_cmd_explorer_payment_received (and the money/ratio orderings) drive the sort + LIMIT.
  'from collections.cmd_explorer_rows t';

/**
 * Build the CHARGE-GRAIN keyset page for the "All Collections" grid.
 *
 * ONE indexed select over the 0059 matview — BUILD X's per-page base-table override
 * (page→snaps→sel→picked) is DELETED (0059 repoint ③). History, compressed: cmd_explorer_rows is
 * POSTING-snapshot grain (BXR ~2.14 rows/charge), so X collapsed the grid to charge grain by
 * paginating the 0050 rollup and OVERRIDING allowed/pct per page from the base snapshots — the
 * rollup's summed allowed over-stated restated charges (133.88% on the reference fixture) and
 * nothing was materialized to sort on. Migration 0059 materialized that tiered rule INTO the
 * matview (allowed_reliable / allowed_tier / pct_allowed / pct_paid, scratch-verified 100%
 * tier-parity with X's selector), so the grid now reads the materialized columns directly:
 *
 *  - DISPLAYED allowed_amount = the matview's `allowed_reliable` (aliased) — the tiered per-charge
 *    value (single real value / reconciling snapshot / e1 reconciling netted sum / e2
 *    latest-positive / NULL unknown). pct_allowed / pct_paid come straight off the matview (same
 *    0038 formula, NULL-safe: NULL allowed → NULL pct, never 0%).
 *  - E1 DISPLAY DELTA (by design, ruled): X's inline tier-e always showed latest-positive; 0059's
 *    e1 shows the reconciling NETTED sum instead — the 5,412 e1 charges render a different (proven)
 *    dollar than the X-era grid did. e2 stays latest-positive with pct_paid UNCLAMPED >100%
 *    (X's reversal tell, deliberately preserved — do not clamp).
 *  - The three sorts are RESTORED (CMD_EXPLORER_SORTABLE_COLUMNS). Sort/keyset bind the PHYSICAL
 *    column via CMD_EXPLORER_SORT_SQL — allowed_amount remaps to allowed_reliable (see that map's
 *    comment); everything the grid sorts by is now a real matview column.
 *
 * Column/table names are fixed literals; every VALUE (entity ids, facility, dates, cursor value/id,
 * limit) is a bound $n — no interpolation, no SELECT *. The cursor boundary continues STRICTLY
 * after the previous page's last row in the `<sortcol> <dir> NULLS LAST, id <dir>` order (cursor
 * values are built from the DISPLAYED row fields, which match the physical sort columns —
 * row.allowed_amount IS allowed_reliable). `entityIds` is the server-derived RBAC tenant scope,
 * applied as a mandatory WHERE so a page never crosses tenants.
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
  // Tenant scope + the exact/window/substring filters (shared with the search summary). Every column
  // referenced here exists on the rollup, so the same conds apply unchanged.
  const conds = cmdExplorerBaseConds(filter, entityIds, add);

  // Physical sort column (fixed literal from the map — allowed_amount → allowed_reliable).
  const col = CMD_EXPLORER_SORT_SQL[sort.column];
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

  // The CmdExplorerRow shape (same output names/casts the grid has always returned). Dates and
  // ingested_at to_char'd to stable strings. `t.<col>` / `t.id` bind the RAW columns so the sort is
  // column-driven, never the to_char text alias (see CMD_EXPLORER_SELECT's alias note).
  const sql =
    `select id, to_char(charge_date, 'YYYY-MM-DD') as charge_date, ` +
    `to_char(payment_received, 'YYYY-MM-DD') as payment_received, cpt_code, revenue_code, ` +
    `facility, charge_amount, allowed_reliable as allowed_amount, insurance_payments, adjustments, ` +
    `patient_balance_due, primary_payer, pct_allowed, pct_paid, ` +
    `to_char(ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at ` +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} t${where} ` +
    `order by t.${col} ${dir} nulls last, t.id ${dir} limit ${add(limit)}`;
  return { sql, params };
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

/**
 * The CHARGE-GRAIN aggregate source (migration 0050): one row per logical charge with
 * grain-correct netting — charge_amount counted once; insurance_payments = the charge-cumulative
 * running total's max (NEVER summed); allowed_amount = the posting-netted sum (± reversal rows
 * cancel); point-in-time fields = latest snapshot. EVERY aggregate builder in this module reads
 * this view: summing raw cmd_explorer_rows (snapshot grain, BXR ~2.14 rows per charge) was the
 * confirmed root cause of the >100% ratios and ~2× inflated totals (2026-07-13 grain audit).
 * The row-browsing grid and the drilldown patient TABLE intentionally stay on cmd_explorer_rows —
 * row grain is what they display — and the view's `id` is the latest snapshot's real row id, so
 * joins back to the base table (and the audited PHI reveal) still hold.
 */
export const CMD_EXPLORER_CHARGE_ROLLUP = 'collections.cmd_explorer_charge_rollup';

/**
 * Shared dollar-weighted %-allowed / %-paid select — ratio of the group's SUMS, never an average
 * of per-row ratios (see CmdComboGroup). %-allowed guards a zero/negative/null denominator to SQL
 * NULL. %-paid guards HARDER: the netted allowed must be a MEANINGFUL denominator — at least 2% of
 * the group's billed dollars and at least $100 — because reversal-heavy groups net allowed toward
 * zero and turn the ratio into a 500–1900% artifact (the pre-0050 readings the footnote used to
 * rationalize as out-of-network). Below the floor the ratio is NULL ("—"), never a huge number.
 */
// 0059 repoint ④: the allowed aggregate is sum(allowed_reliable) — the materialized tiered value —
// not the netted posting sum (which over-states restatements and nets reversal-heavy groups toward
// zero). The pct_paid FLOOR (>= greatest(2% of billed, $100)) is DELIBERATELY UNCHANGED: its
// original netted-toward-zero rationale weakens under allowed_reliable, but re-ruling it is a
// product decision DEFERRED until real allowed_reliable numbers have been observed (Alec,
// 2026-07-22) — do not loosen/drop it inside a repoint diff.
export const PCT_RATIO_SELECT =
  'case when sum(charge_amount) > 0 then round(sum(allowed_reliable) / sum(charge_amount) * 100, 2)::float8 end as pct_allowed, ' +
  'case when sum(allowed_reliable) >= greatest(sum(charge_amount) * 0.02, 100) then round(sum(insurance_payments) / sum(allowed_reliable) * 100, 2)::float8 end as pct_paid';

/** One grouped bucket (facility / payer / cpt): its label + match count + charged total. */
export interface CmdSearchGroup {
  label: string | null;
  count: number;
  charge: number;
}

/**
 * One (CPT code, Revenue code) COMBINATION bucket. A DISTINCT shape from CmdSearchGroup — it
 * carries TWO label fields (`cpt` + `revenue`) plus two ratios — because a combo entry answers
 * "how does this payer treat this exact CPT×revenue-code pairing", which one label can't express.
 *
 * `pct_allowed` / `pct_paid` are DOLLAR-WEIGHTED ratios of the bucket's SUMS —
 * sum(allowed_reliable)/sum(charge_amount) and sum(insurance_payments)/sum(allowed_reliable), each ×100
 * rounded to 2 dp — NEVER an average of each row's individual ratio (avg-of-ratios over-weights
 * small claims and misstates the actual dollar recovery rate, which is the number admissions must
 * trust). NULL when the denominator is 0 / negative / null (guarded in SQL, never an error). `count`
 * + `charge` mirror CmdSearchGroup.
 */
export interface CmdComboGroup {
  cpt: string | null;
  revenue: string | null;
  count: number;
  charge: number;
  pct_allowed: number | null;
  pct_paid: number | null;
}

export interface CmdSearchSummary {
  /** Matching LOGICAL CHARGES (0050 rollup grain) — the grid below pages snapshot rows, so its
   *  page count can exceed this; the UI labels the two grains differently on purpose. */
  total_count: number;
  total_charge: number;
  /** sum(allowed_reliable) over the filtered set — the SAME reliable tiered value the cohort totals
   *  and the combo ratios use, so the selection-mode green cards reconcile with cohort mode and the
   *  CPT×Rev %s. Added so SELECTION-MODE %-allowed / %-paid derive from this one aggregate (no new
   *  query) — see `yield_pct`. */
  total_allowed: number;
  total_paid: number;
  total_balance: number;
  /** SELECTION-MODE payer-behavior percentages, derived server-side from the totals above via the
   *  shared {@link deriveYield} helper — the SAME formula/rounding/guards the cohort whole-cohort
   *  cards use, so the two modes can never drift. %Collected = total_paid/total_charge reconciles
   *  exactly with the Insurance Paid ÷ Charged tiles. */
  yield_pct: CohortTotals;
  by_facility: CmdSearchGroup[];
  by_payer: CmdSearchGroup[];
  by_cpt: CmdSearchGroup[];
  by_combo: CmdComboGroup[];
}

/** Group-by columns the summary rolls up — fixed literals, never user input. */
const CMD_SEARCH_GROUP_COLUMNS = {
  facility: 'facility',
  primary_payer: 'primary_payer',
  cpt_code: 'cpt_code',
} as const;
export type CmdSearchGroupColumn = keyof typeof CMD_SEARCH_GROUP_COLUMNS;

/**
 * Build the five aggregate queries backing the search summary — a totals query, one top-N grouping
 * per single dimension (facility / payer / cpt), and one top-N (CPT, Revenue-code) COMBINATION
 * grouping — all sharing the SAME tenant-scoped WHERE. Column names are fixed literals; every value
 * is a bound parameter. Exposed so a fixture can assert the exact SQL.
 */
export function buildCmdSearchSummaryQueries(
  filter: CmdExplorerFilter,
  entityIds: string[],
  topN: number = CMD_SEARCH_TOP_N,
): {
  totals: { sql: string; params: unknown[] };
  groups: Record<CmdSearchGroupColumn, { sql: string; params: unknown[] }>;
  combo: { sql: string; params: unknown[] };
} {
  const build = (select: string, tail: (add: ParamAdder) => string) => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conds = cmdExplorerBaseConds(filter, entityIds, add);
    const where = ` where ${conds.join(' and ')}`;
    // CHARGE grain (0050 rollup), so counts are logical charges and sums are netted — the grid
    // below the summary still pages snapshot ROWS, which is why its copy says "posting rows".
    return { sql: `${select} from ${CMD_EXPLORER_CHARGE_ROLLUP}${where}${tail(add)}`, params };
  };

  const totals = build(
    'select count(*)::int as total_count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as total_charge, ' +
      // Reliable tiered allowed (0059) — the SAME column the combo ratios + cohort totals sum, so
      // SELECTION-MODE %-allowed / %-paid derive from the tile aggregate with NO new query.
      'coalesce(sum(allowed_reliable), 0)::float8 as total_allowed, ' +
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

  // The (CPT, Revenue-code) combination grouping. Ratios come from the shared PCT_RATIO_SELECT
  // (dollar-weighted ratio-of-sums with the guarded denominators — see its doc). cpt_code and
  // revenue_code are fixed-literal group columns; ::float8 makes the rounded numerics arrive as JS
  // numbers (like `charge`).
  const combo = build(
    'select cpt_code as cpt, revenue_code as revenue, count(*)::int as count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as charge, ' +
      PCT_RATIO_SELECT,
    (add) => ` group by cpt_code, revenue_code order by charge desc nulls last, count desc limit ${add(topN)}`,
  );

  return { totals, groups, combo };
}

// --- alpha-prefix cohort payer-behavior curve (Session D) -------------------
// The merged "attrition rate" (how many claims before a payer's reimbursement degrades) + "days
// insurer paid" (how long a new patient under the same alpha prefix keeps full authorization)
// metric: allowed% / paid% plotted across a patient's claim sequence, rolled up over ALL patients
// sharing an alpha-prefix blind-index token. The OUTPUT is a cohort AGGREGATE — never a single
// patient's figures — but computing it groups by member_id_bidx internally to sequence each
// patient's visits, THEN rolls the cohort up. Two x-axes come from the SAME sequencing idea: claim/
// visit POSITION (ordinal by distinct service date) and DAYS since the patient's first claim.
//
// SMALL-COHORT SUPPRESSION is load-bearing, not cosmetic (a 2-patient "cohort" is a 2-patient
// disclosure wearing an aggregate's clothes). A `HAVING count(distinct member_id_bidx) >= threshold`
// on the FINAL grouped result drops any bucket below the floor ENTIRELY, IN-QUERY, before the data
// serializes — a client-side or action-layer hide would be inspectable in the network tab. The
// threshold is CLAMPED to COHORT_MIN_PATIENTS here so no caller can weaken it below the agreed floor.

/**
 * Floor on distinct patients per bucket. Buckets below it are SUPPRESSED in-query (absent, not
 * caveated). Signed off with Alec (Session D). Callers may raise it; they can NEVER lower it.
 */
export const COHORT_MIN_PATIENTS = 5;
/**
 * Cap on the claim-position axis. Behavioral-health patients average ~40–70 visits, so the raw
 * sequence has a long tail; the early sequence carries the degradation signal and a bounded axis
 * keeps the payload small.
 */
export const COHORT_POSITION_CAP = 24;
/** Day-axis bucket width + cap: monthly buckets across the first ~year since a patient's 1st claim. */
export const COHORT_DAY_BUCKET_DAYS = 30;
export const COHORT_DAY_CAP = 360;

/**
 * One cohort-curve bucket. `patients` is ALWAYS >= COHORT_MIN_PATIENTS (a smaller bucket was
 * suppressed and never appears). `pct_allowed` / `pct_paid` are DOLLAR-WEIGHTED (ratio of the
 * bucket's summed dollars, guarded), the same discipline as the Session C combo grouping.
 *
 * Phase 2 (dollars + zero-pay): `paid_total` is the bucket's summed insurance $ — it powers the
 * client-side avg-$/patient and cumulative-$/starting-patient reads. `pct_zero_paid` is the share
 * of charge LINES with no positive insurance payment; `pct_patient_shifted` is its subset where the
 * balance moved to the patient (deductible/coinsurance — a collections problem, NOT a denial).
 * `allowed_amount <= 0` is deliberately NOT the zero-pay signal: in this dataset ~85% of
 * allowed<=0/null lines carry real payments (CMD often omits a meaningful allowed amount).
 */
export interface CohortCurvePoint {
  bucket: number;
  patients: number;
  /** Logical CHARGE LINES in the bucket (0050 rollup grain). Field name kept for API/cache
   *  compatibility; UI copy says "charge lines", never "claims". */
  claims: number;
  pct_allowed: number | null;
  pct_paid: number | null;
  paid_total: number;
  pct_zero_paid: number;
  pct_patient_shifted: number;
}

export interface CohortCurveOptions {
  minPatients?: number;
  positionCap?: number;
  dayBucketDays?: number;
  dayCap?: number;
}

/**
 * Whole-cohort END-TO-END payer yield — dollar-weighted over the ENTIRE prefix cohort's charge lines
 * (0050 rollup), with NO position cap and NO per-bucket suppression: the honest lifetime total,
 * deliberately free of the curve's survivorship bias. Each ratio is null when its denominator is <= 0.
 * The whole object is null when the cohort is below COHORT_MIN_PATIENTS (the cards then read "not
 * enough data", never a false-precision stat).
 */
export interface CohortTotals {
  /** paid ÷ billed — net collected of billed (end-to-end yield). */
  pct_collected: number | null;
  /** allowed ÷ billed — what the payer agreed to. */
  pct_allowed: number | null;
  /** paid ÷ allowed — paid of what was allowed. */
  pct_paid: number | null;
}

/** Raw dollar sums a yield is derived from — `null`/`0` denominators guard to a `null` ratio. */
export interface YieldInput {
  billed: number | null;
  allowed: number | null;
  paid: number | null;
}

/**
 * THE single derivation of the three payer-behavior percentages from raw dollar sums — the one
 * place BOTH the whole-cohort yield cards (cohort mode) AND the filter-wide green cards (selection
 * mode) read, so the two modes can never drift. Each ratio guards a null/zero/negative denominator
 * to `null` ("—") and rounds to 2 dp — byte-identical to the inline cohort-totals ratio it replaces
 * (Math.round(x*10000)/100). Pure; no PHI; unit-tested in the hermetic suite.
 */
export function deriveYield({ billed, allowed, paid }: YieldInput): CohortTotals {
  const ratio = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? Math.round((num / den) * 10000) / 100 : null;
  return {
    pct_collected: ratio(paid, billed), // paid ÷ billed
    pct_allowed: ratio(allowed, billed), // allowed ÷ billed
    pct_paid: ratio(paid, allowed), // paid ÷ allowed
  };
}

/**
 * The cohort-curve response: both suppressed x-axes plus the cohort's distinct-patient count
 * (derived from the position-1 bucket, since every patient has a first visit). When the whole
 * cohort is below the floor, EVERY bucket is suppressed → both arrays are empty and
 * `cohort_patients` is 0 (the panel then shows "not enough data", never a partial disclosure).
 * `totals` is the whole-cohort end-to-end yield (see CohortTotals) — null below the floor.
 */
export interface CohortCurve {
  by_position: CohortCurvePoint[];
  by_days: CohortCurvePoint[];
  cohort_patients: number;
  totals: CohortTotals | null;
}

// --- cohort-point drilldown (Session G) -------------------------------------
// Clicking one cohort-curve point opens a breakdown for THAT bucket: an aggregate slice (payer mix,
// CPT/rev mix — always renders once the point clears COHORT_MIN_PATIENTS, the SAME floor the curve
// itself already enforces, since a suppressed point is never clickable) plus an OPTIONAL patient
// table gated by a SEPARATE, stricter floor. Row-level disclosure — even PHI-masked — carries more
// re-identification risk than an aggregate ratio, so it needs its own, higher bar than the curve's.

/**
 * Floor on distinct patients before the drilldown's PATIENT TABLE may render rows. Independent of
 * and stricter than COHORT_MIN_PATIENTS (which gates the aggregate breakdown + the curve itself).
 * Signed off with Alec: N=10 (real-data check: at N=5 the table would show for ~78% of points that
 * render on a typical viewable cohort; at N=10, ~25-27% — still usable at early claim positions,
 * where the disclosure risk of a small table is highest anyway).
 */
export const COHORT_DRILLDOWN_TABLE_MIN_PATIENTS = 10;

/**
 * Does a bucket's (server-recomputed) distinct-patient count clear the curve's OWN aggregate floor?
 * Pulled out as a named, pure predicate — rather than an inline `>=` in server.ts — so the exact
 * boundary is unit-testable in this hermetic module (server.ts has no test harness in this repo).
 */
export function clearsCohortFloor(patients: number): boolean {
  return patients >= COHORT_MIN_PATIENTS;
}

/** Does a bucket's patient count clear the STRICTER, separate patient-table floor (Session G)? */
export function clearsDrilldownTableFloor(patients: number): boolean {
  return patients >= COHORT_DRILLDOWN_TABLE_MIN_PATIENTS;
}

/**
 * The aggregate breakdown for ONE cohort-curve point. Pure SQL aggregate, NO row egress, non-PHI.
 * `patients` is RE-DERIVED server-side for this exact bucket (never trusted from the client's
 * click) — the authoritative gate for whether this breakdown may render at all. `by_payer` /
 * `by_cpt_revenue` reuse the EXISTING CmdSearchGroup / CmdComboGroup shapes (same fields the smart-
 * search summary already returns) rather than inventing parallel types.
 */
export interface CohortDrilldownAggregate {
  bucket: number;
  patients: number;
  claims: number;
  pct_allowed: number | null;
  pct_paid: number | null;
  paid_total: number;
  pct_zero_paid: number;
  pct_patient_shifted: number;
  by_payer: CmdSearchGroup[];
  by_cpt_revenue: CmdComboGroup[];
}

/**
 * The patient table for one point: EITHER the masked non-PHI rows (same CmdExplorerRow shape +
 * reveal path the main grid uses) OR a suppression marker — never a partial/truncated row set.
 */
export type CohortDrilldownTable =
  | { kind: 'suppressed'; floor: number }
  | { kind: 'rows'; rows: CmdExplorerRow[] };

/** The full response for one clicked cohort-curve point. */
export interface CohortDrilldownResult {
  aggregate: CohortDrilldownAggregate;
  table: CohortDrilldownTable;
}

// Phase 2 dollars + zero-pay, appended to the SAME suppressed select (the HAVING covers every field
// here — nothing derivable below the min-patient floor can serialize). Ratios come from the shared
// PCT_RATIO_SELECT (dollar-weighted, guarded denominators). Same discipline: sums and filtered
// counts only, never avg() (the fixture tests forbid the token so avg-of-ratios can't creep back
// in). A surviving group always has count(*) >= 1, so the share divisions need no zero guard;
// insurance_payments is coalesced defensively (no NULLs in the data today, but the schema allows
// them, and a NULL must read as "no positive payment", not silently drop out of the zero-pay share).
// At CHARGE grain (0050 rollup) the `claims` count and zero-pay shares are per logical charge line,
// not per snapshot row.
const COHORT_METRIC_SELECT =
  PCT_RATIO_SELECT +
  ', ' +
  'round(coalesce(sum(insurance_payments), 0), 2)::float8 as paid_total, ' +
  'round(count(*) filter (where coalesce(insurance_payments, 0) <= 0)::numeric / count(*) * 100, 2)::float8 as pct_zero_paid, ' +
  'round(count(*) filter (where coalesce(insurance_payments, 0) <= 0 and patient_balance_due > 0)::numeric / count(*) * 100, 2)::float8 as pct_patient_shifted';

/**
 * Build the TWO read-only cohort-curve queries — by claim/visit POSITION and by DAYS-since-first —
 * for one alpha-prefix blind-index token, tenant-scoped. Both enforce the min-patient floor via
 * HAVING on the final grouped result. Every value is a bound parameter; every identifier is a fixed
 * literal. `prefixBidx` is an OPAQUE keyed-HMAC token — no raw PHI reaches this module. The floor is
 * clamped so it can never drop below COHORT_MIN_PATIENTS.
 *
 * Grain: reads the CHARGE-GRAIN rollup (0050) — one row per logical charge line with netted
 * dollars, never the raw snapshot table. A "claim/visit" is a DISTINCT service date (charge_date):
 * one visit → many CPT×rev charge lines, so dense_rank() over charge_date collapses same-day lines
 * into one visit position. The cohort is scoped ONLY by tenant + prefix token (NOT the grid's
 * facility/month filters) so each patient's full lifetime sequence is intact, never truncated to a
 * window.
 */
export function buildCohortCurveQueries(
  prefixBidx: string,
  entityIds: string[],
  opts: CohortCurveOptions = {},
): { byPosition: { sql: string; params: unknown[] }; byDays: { sql: string; params: unknown[] } } {
  // Clamp the floor: a caller may make suppression STRICTER, never weaker than the agreed minimum.
  const minPatients = Math.max(COHORT_MIN_PATIENTS, opts.minPatients ?? COHORT_MIN_PATIENTS);
  const positionCap = opts.positionCap ?? COHORT_POSITION_CAP;
  const dayBucketDays = opts.dayBucketDays ?? COHORT_DAY_BUCKET_DAYS;
  const dayCap = opts.dayCap ?? COHORT_DAY_CAP;

  const byPosition = (() => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const ent = add(entityIds);
    const pref = add(prefixBidx);
    const cap = add(positionCap);
    const minp = add(minPatients);
    // dense_rank over charge_date = VISIT position (same-day charge lines share a position). The
    // HAVING is the suppression boundary — no LIMIT/pagination exists to bypass it.
    const sql =
      'with seq as (select member_id_bidx, ' +
      'dense_rank() over (partition by member_id_bidx order by charge_date) as pos, ' +
      'charge_amount, allowed_reliable, insurance_payments, patient_balance_due ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
      `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null) ` +
      'select pos::int as bucket, count(distinct member_id_bidx)::int as patients, count(*)::int as claims, ' +
      COHORT_METRIC_SELECT + ' ' +
      `from seq where pos <= ${cap} group by pos having count(distinct member_id_bidx) >= ${minp} order by pos`;
    return { sql, params };
  })();

  const byDays = (() => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const ent = add(entityIds);
    const pref = add(prefixBidx);
    const bucket = add(dayBucketDays);
    const cap = add(dayCap);
    const minp = add(minPatients);
    // Bucket by whole `dayBucketDays`-wide windows measured from each patient's OWN first claim
    // (days_since = charge_date − first_dt, an integer). Same HAVING suppression on the rollup.
    const sql =
      'with base as (select member_id_bidx, charge_date, charge_amount, allowed_reliable, insurance_payments, patient_balance_due ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null), ` +
      'firstdt as (select member_id_bidx, min(charge_date) as first_dt from base group by member_id_bidx), ' +
      'seq as (select b.member_id_bidx, (b.charge_date - f.first_dt) as days_since, b.charge_amount, b.allowed_reliable, b.insurance_payments, b.patient_balance_due ' +
      'from base b join firstdt f using (member_id_bidx)) ' +
      `select (floor(days_since::numeric / ${bucket}) * ${bucket})::int as bucket, count(distinct member_id_bidx)::int as patients, count(*)::int as claims, ` +
      COHORT_METRIC_SELECT + ' ' +
      `from seq where days_since <= ${cap} group by floor(days_since::numeric / ${bucket}) having count(distinct member_id_bidx) >= ${minp} order by bucket`;
    return { sql, params };
  })();

  return { byPosition, byDays };
}

/** Raw dollar sums returned by buildCohortTotalsQuery (the caller derives the guarded ratios). */
export interface CohortTotalsRow {
  billed: number | null;
  allowed: number | null;
  paid: number | null;
}

/**
 * Whole-cohort END-TO-END yield aggregate for one alpha-prefix cohort — the honest lifetime totals,
 * scoped IDENTICALLY to buildCohortCurveQueries (tenant + prefix token, 0050 charge grain) but with
 * NO position cap, NO day cap, and NO per-bucket suppression, so it never inherits the curve's
 * survivorship bias. Returns raw dollar sums (billed / allowed / paid); the caller derives the three
 * guarded ratios and applies the COHORT_MIN_PATIENTS gate (see loadCohortCurveData). Every value is a
 * bound parameter; every identifier a fixed literal; no raw PHI reaches this module (prefixBidx is an
 * opaque keyed-HMAC token).
 */
export function buildCohortTotalsQuery(
  prefixBidx: string,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const ent = add(entityIds);
  const pref = add(prefixBidx);
  const sql =
    // 0059 ④: end-to-end yield's allowed = the reliable tiered sum, matching the curve's ratios.
    'select sum(charge_amount)::float8 as billed, sum(allowed_reliable)::float8 as allowed, ' +
    'sum(insurance_payments)::float8 as paid ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null`;
  return { sql, params };
}

/**
 * Build the FOUR read-only queries behind ONE cohort-curve point's drilldown (Session G) — a stats
 * query (patients/claims/dollar-weighted %s + $/zero-pay, RE-DERIVED for this EXACT bucket — the
 * caller must never trust a client-supplied bucket's implied patient count), a top-N payer
 * breakdown, a top-N (CPT, Revenue-code) breakdown, and the FULL non-PHI row projection (reusing
 * CMD_EXPLORER_SELECT verbatim — the exact same column allowlist + shape the main grid returns).
 * All four share the SAME tiny `bucket_rows` CTE (just `id` + `member_id_bidx` for the matching
 * charge lines at this bucket) — every value is a bound parameter, every column/table a fixed
 * literal. The CALLER decides which to run: `stats` first (the authoritative gate), then
 * `byPayer`/`byCptRevenue` only once it clears COHORT_MIN_PATIENTS (the SAME floor the curve itself
 * enforces — a point that never rendered can't be drilled into), and `rows` only if it ADDITIONALLY
 * clears the stricter COHORT_DRILLDOWN_TABLE_MIN_PATIENTS.
 *
 * `axis` picks which of the curve's two x-axes this bucket belongs to (claim/visit POSITION vs DAYS
 * since first claim) — mirrors buildCohortCurveQueries' own by_position/by_days split exactly, so a
 * bucket number here means the same thing it means on the curve.
 */
export function buildCohortDrilldownQueries(
  prefixBidx: string,
  entityIds: string[],
  axis: 'position' | 'days',
  bucket: number,
  opts: CohortCurveOptions & { topN?: number } = {},
): {
  stats: { sql: string; params: unknown[] };
  byPayer: { sql: string; params: unknown[] };
  byCptRevenue: { sql: string; params: unknown[] };
  rows: { sql: string; params: unknown[] };
} {
  const dayBucketDays = opts.dayBucketDays ?? COHORT_DAY_BUCKET_DAYS;
  const topN = opts.topN ?? CMD_SEARCH_TOP_N;

  // The shared `bucket_rows` CTE: which (id, member_id_bidx) pairs fall in this exact bucket, tenant
  // + prefix scoped identically to buildCohortCurveQueries — and, like the curve, at CHARGE grain
  // (0050 rollup: one id per logical charge = the latest snapshot's row id). Deliberately minimal
  // (just the join key + the patient key) — every other column each query needs comes from joining
  // BACK to the rollup (aggregates: netted dollars) or the base table (the patient-table row
  // projection) below, so there is exactly one place that defines "which charges are in this bucket."
  const bucketRowsCte = (add: ParamAdder): string => {
    const ent = add(entityIds);
    const pref = add(prefixBidx);
    if (axis === 'position') {
      const buck = add(bucket);
      return (
        'with seq as (select id, member_id_bidx, ' +
        'dense_rank() over (partition by member_id_bidx order by charge_date) as pos ' +
        `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
        `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null), ` +
        `bucket_rows as (select id, member_id_bidx from seq where pos = ${buck}) `
      );
    }
    const bwidth = add(dayBucketDays);
    const buck = add(bucket);
    return (
      `with base as (select id, member_id_bidx, charge_date from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
      `where business_entity_id = any(${ent}::uuid[]) and member_id_prefix_bidx = ${pref} and charge_date is not null), ` +
      'firstdt as (select member_id_bidx, min(charge_date) as first_dt from base group by member_id_bidx), ' +
      'seq as (select b.id, b.member_id_bidx, (b.charge_date - f.first_dt) as days_since ' +
      'from base b join firstdt f using (member_id_bidx)), ' +
      `bucket_rows as (select id, member_id_bidx from seq where (floor(days_since::numeric / ${bwidth}) * ${bwidth})::int = ${buck}) `
    );
  };

  const build = (select: string, tail: (add: ParamAdder) => string = () => ''): { sql: string; params: unknown[] } => {
    const params: unknown[] = [];
    const add: ParamAdder = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    const cte = bucketRowsCte(add);
    return { sql: `${cte}${select}${tail(add)}`, params };
  };

  // The three AGGREGATE queries join back to the ROLLUP (netted dollars at charge grain — joining
  // the raw snapshot table here would resurrect the grain bug for exactly this bucket).
  // `member_id_bidx` exists on BOTH the rollup and bucket_rows, so it's qualified; every other
  // column referenced is unique to whichever side actually has it (no other ambiguity).
  const stats = build(
    'select count(distinct bucket_rows.member_id_bidx)::int as patients, count(*)::int as claims, ' +
      COHORT_METRIC_SELECT +
      ` from ${CMD_EXPLORER_CHARGE_ROLLUP} join bucket_rows using (id)`,
  );

  const byPayer = build(
    'select primary_payer as label, count(*)::int as count, coalesce(sum(charge_amount), 0)::float8 as charge ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} join bucket_rows using (id)`,
    (add) => ` group by primary_payer order by charge desc nulls last, count desc limit ${add(topN)}`,
  );

  const byCptRevenue = build(
    'select cpt_code as cpt, revenue_code as revenue, count(*)::int as count, ' +
      'coalesce(sum(charge_amount), 0)::float8 as charge, ' +
      PCT_RATIO_SELECT +
      ` from ${CMD_EXPLORER_CHARGE_ROLLUP} join bucket_rows using (id)`,
    (add) => ` group by cpt_code, revenue_code order by charge desc nulls last, count desc limit ${add(topN)}`,
  );

  // Reuse CMD_EXPLORER_SELECT verbatim (aliased `t`, over the BASE table) — the identical non-PHI
  // column allowlist + shape the main grid returns, so the drilldown's patient table is a
  // CmdExplorerRow[] the SAME masking + reveal path already handles. bucket_rows ids are the
  // rollup's latest-snapshot row ids, so this join lands on ONE real row per charge (the current
  // state) rather than every historical snapshot. `using (id)` (not `on bucket_rows.id = t.id`) — CRITICAL:
  // CMD_EXPLORER_SELECT's bare `id` column would otherwise be ambiguous once bucket_rows' OWN `id`
  // is also in scope from an explicit ON-join; USING merges the shared column into one unambiguous
  // output (caught by a live query-execution check — a plain SQL-string match test can't catch this
  // class of bug, since it never actually runs the query against a real Postgres planner).
  const rows = build(`${CMD_EXPLORER_SELECT} join bucket_rows using (id)`, () => ' order by t.charge_date');

  return { stats, byPayer, byCptRevenue, rows };
}
