/**
 * Facility Resolution — pure query builders + the deterministic search grammar.
 *
 * Reads collections.cmd_facility_resolution (migration 0086), the charge-grain attribution
 * matview over every 'No Facility' charge. Same contract as cmdExplorerQuery.ts: NO Next.js, NO
 * pg, NO I/O — string building over closed allowlists only, so the whole module is unit-testable
 * under plain node:test. Every table/column name is a fixed literal; every value is a bound $n.
 * Never SELECT * — the projection is the explicit allowlist below.
 *
 * TENANCY: the matview cannot carry RLS (sql-migrations.md), so EVERY builder here takes
 * entityIds and runs it through assertEntityScope (fail-closed) into a
 * `business_entity_id = any($n::uuid[])` condition. Callers derive entityIds server-side via
 * viewEntityScope — never from client input.
 *
 * PHI: member_id_bidx is the keyed-HMAC blind index — a non-reversible token, never a raw
 * identifier. The UI derives a short display token from it (memberDisplayToken). Search input
 * may contain a display token; it is matched by PREFIX against the bidx column and is never
 * logged. No plaintext identifiers exist anywhere on this surface.
 *
 * SEARCH GRAMMAR (parseResolutionSearch) — deterministic, one chip per token, no guessing:
 *   "quoted phrase"        → facility term (contains, LIKE-escaped)
 *   >N >=N <N <=N =N       → amount comparator (matches charged OR paid)
 *   N-M (both numeric)     → amount range, inclusive
 *   $N or N.NN             → amount exact
 *   bare integer ≥3 digits → amount exact — UNLESS it is a 4-digit 1900..2100, which is a year
 *   YYYY-MM                → calendar month (charge_date)
 *   jan..december [YYYY]   → month name (≥3-char prefix); an immediately following 4-digit year
 *                            binds to it ("jul 2024" is ONE chip); alone = that month, any year
 *   method names           → method chip, unique-prefix tolerant at ≥3 chars over the closed set
 *                            (manual, named, member_inference, vob, tie_break, unresolved)
 *   seed | cron            → source-era chip
 *   M-<hex> or bare hex≥10 → member-token chip (bidx prefix match)
 *   any other word         → facility term (contains) — applies only to resolved rows, whose
 *                            facility columns are non-null
 *   anything unparseable   → an UNMATCHED chip: surfaced to the user, never applied, never guessed.
 */
import { assertEntityScope } from './entityScope.js';
import { likeContains } from './cmdExplorerQuery.js';

// --- vocabulary ----------------------------------------------------------------

export const RESOLUTION_METHODS = [
  'manual',
  'named',
  'member_inference',
  'vob',
  'tie_break',
  'unresolved',
] as const;
export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

/**
 * EVIDENCE CLASS of a resolution method — the exact/inferred split, defined HERE and nowhere else.
 *
 * WHY IT LIVES IN THIS MODULE. Until 2026-08-30 the split existed only as page copy, one sentence
 * on app/app/billing-audit/facility-resolution/page.tsx ("attributed by exact-evidence methods or
 * worked by hand"), and that sentence does not even draw this line — it groups `manual` AGAINST
 * "exact-evidence methods" where the ruling puts them together. Prose in one component cannot be
 * imported, so the Collections grid would have had to restate the method list to render a badge,
 * and a seventh method added to 0086 would then have to be remembered in two places. It is stated
 * once, keyed off RESOLUTION_METHODS, and imported.
 *
 *   EXACT EVIDENCE  'manual' — a human ruling with an audit trail (0085 facility_assignments)
 *                   'named'  — 0084 pull provenance: the account the line was actually pulled from
 *   INFERRED        'member_inference' | 'vob' | 'tie_break' — derived from OTHER rows about the
 *                   same member. Defensible, deterministic, and still a conclusion we drew rather
 *                   than a fact CMD or an operator gave us.
 *   (neither)       'unresolved' — facility_alias is NULL iff this; the raw CMD value stands.
 *
 * ⚠ AN INFERRED FACILITY MUST NEVER RENDER IDENTICALLY TO ONE CMD NAMED (ruling 2026-08-30).
 *
 * BOTH SURFACES NOW HONOUR THAT, as of #294 (2026-08-31). The Collections grid honoured it first
 * (app/components/dashboard/facility-cell.tsx); the workbench STATUS cell
 * (facility-resolution-leaves.tsx) gave EVERY resolved method the same teal pill and was
 * deliberately left alone by the original ruling, which named porting the split as a follow-up
 * rather than a drive-by because it is that page's whole visual language. #294 is that follow-up,
 * and the treatment was ported VERBATIM — same three channels, same classes — so the two surfaces
 * now agree by construction rather than by two people remembering the same intent.
 */
export const EXACT_EVIDENCE_METHODS = ['manual', 'named'] as const;
export const INFERRED_METHODS = ['member_inference', 'vob', 'tie_break'] as const;

export type ResolutionClass = 'exact' | 'inferred' | 'unresolved';

// Typed as the FULL method union rather than as its own literal set, so adding a seventh method to
// RESOLUTION_METHODS without classifying it is a TYPECHECK FAILURE here — not a silent default to
// 'unresolved' at runtime, which would quietly hide a new resolution from the grid.
const RESOLUTION_CLASS_BY_METHOD: Record<ResolutionMethod, ResolutionClass> = {
  manual: 'exact',
  named: 'exact',
  member_inference: 'inferred',
  vob: 'inferred',
  tie_break: 'inferred',
  unresolved: 'unresolved',
};

/**
 * Evidence class for a method string. Accepts `string | null | undefined` because callers read it
 * off a LEFT JOIN that legitimately misses (a charge with no resolution row at all), and an
 * unrecognised value fails CLOSED to 'unresolved' — an unknown method must never be presented as
 * evidence. The Record above is what makes a KNOWN-but-unclassified method impossible.
 */
export function resolutionClassOf(method: string | null | undefined): ResolutionClass {
  if (method === null || method === undefined) return 'unresolved';
  return RESOLUTION_CLASS_BY_METHOD[method as ResolutionMethod] ?? 'unresolved';
}

/**
 * Narrow a method string that came off the wire. The DB column is plain text, so every consumer
 * reads it as `string | null` — and indexing a Record<ResolutionMethod, …> with that is an implicit
 * `any` under the root tsconfig's strictness. This is the one place that cast is made, guarded.
 */
export function isResolutionMethod(method: string | null | undefined): method is ResolutionMethod {
  return method !== null && method !== undefined && method in RESOLUTION_CLASS_BY_METHOD;
}

export const RESOLUTION_ERAS = ['seed', 'cron'] as const;
export type ResolutionEra = (typeof RESOLUTION_ERAS)[number];

export const RESOLUTION_PAGE_SIZE = 50;

/** How many chars of the bidx the UI shows / accepts as a member display token. */
export const MEMBER_TOKEN_LENGTH = 10;

/** Non-reversible short display token for a member (bidx is itself an HMAC, never a raw id). */
export function memberDisplayToken(memberIdBidx: string): string {
  return `M-${memberIdBidx.slice(0, MEMBER_TOKEN_LENGTH)}`;
}

// --- row shapes ------------------------------------------------------------------

/** One queue row — the explicit non-PHI projection of the 0086 matview. */
export interface ResolutionRow {
  id: number;
  business_entity_id: string;
  member_id_bidx: string;
  charge_date: string;
  payment_received: string | null;
  cpt_code: string | null;
  revenue_code: string | null;
  cpt_key: string;
  revenue_key: string;
  charge_amount: string;
  insurance_payments: string | null;
  primary_payer: string | null;
  source_era: ResolutionEra;
  method: ResolutionMethod;
  facility_code: string | null;
  facility_label: string | null;
  facility_alias: string | null;
  unresolved_reason: string | null;
  assignment_id: number | null;
}

/** One overview line: per-method rollup (charge grain — never summed line grain). */
export interface ResolutionOverviewRow {
  method: ResolutionMethod;
  charges: number;
  members: number;
  charge_dollars: string;
  paid_dollars: string;
  facilities: number;
}

/** The durable identity of one charge (the 0059 rollup group key) for the assignment write. */
export interface ResolutionChargeKey {
  business_entity_id: string;
  member_id_bidx: string;
  charge_date: string;
  cpt_key: string;
  revenue_key: string;
  charge_amount: string;
}

// --- search parsing ---------------------------------------------------------------

export type ResolutionChip =
  | { kind: 'amount'; op: '>' | '>=' | '<' | '<=' | '='; value: string; label: string }
  | { kind: 'amount_range'; lo: string; hi: string; label: string }
  | { kind: 'month'; year: number | null; month: number; label: string }
  | { kind: 'year'; year: number; label: string }
  | { kind: 'method'; method: ResolutionMethod; label: string }
  | { kind: 'era'; era: ResolutionEra; label: string }
  | { kind: 'member'; prefix: string; label: string }
  | { kind: 'facility'; term: string; label: string }
  | { kind: 'unmatched'; raw: string; label: string };

export interface ParsedResolutionSearch {
  chips: ResolutionChip[];
  /** chips minus the unmatched ones — what the query builder actually applies. */
  applied: ResolutionChip[];
}

const MONTHS: readonly string[] = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function matchMonthName(token: string): number | null {
  if (token.length < 3) return null;
  const t = token.toLowerCase();
  const hits = MONTHS.map((m, i) => (m.startsWith(t) ? i + 1 : null)).filter((v) => v !== null);
  return hits.length === 1 ? hits[0]! : null; // ambiguous prefixes never match
}

function matchMethodPrefix(token: string): ResolutionMethod | null {
  if (token.length < 3) return null;
  const t = token.toLowerCase();
  const hits = RESOLUTION_METHODS.filter((m) => m.startsWith(t));
  return hits.length === 1 ? hits[0]! : null;
}

const NUM = /^\$?\d{1,9}(\.\d{1,2})?$/;
const isNum = (s: string): boolean => NUM.test(s);
const numVal = (s: string): string => s.replace(/^\$/, '');

/** Split on whitespace, keeping double-quoted phrases as one token (quotes preserved so the
 *  parser can tell a phrase from a word; stripped again at chip creation). */
function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|(\S+)/g)) {
    const phrase = m[1];
    const word = m[2];
    if (phrase !== undefined && phrase.trim() !== '') out.push(`"${phrase.trim()}"`);
    else if (word !== undefined && word.trim() !== '') out.push(word.trim());
  }
  return out;
}

const SEARCH_MAX_LENGTH = 200;
const SEARCH_MAX_CHIPS = 12;

/** Deterministic search-input → chips. Never throws; never guesses (see grammar above). */
export function parseResolutionSearch(input: string): ParsedResolutionSearch {
  const chips: ResolutionChip[] = [];
  const tokens = tokenize(input.slice(0, SEARCH_MAX_LENGTH));
  for (let i = 0; i < tokens.length && chips.length < SEARCH_MAX_CHIPS; i += 1) {
    const raw = tokens[i]!;

    // quoted phrase → facility term, verbatim
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 2) {
      const term = raw.slice(1, -1);
      chips.push({ kind: 'facility', term, label: `facility ~ "${term}"` });
      continue;
    }

    // comparators
    const cmp = raw.match(/^(>=|<=|>|<|=)(\$?\d{1,9}(?:\.\d{1,2})?)$/);
    if (cmp !== null) {
      const op = cmp[1] as '>' | '>=' | '<' | '<=' | '=';
      const value = numVal(cmp[2]!);
      chips.push({ kind: 'amount', op, value, label: `amount ${op} ${value}` });
      continue;
    }

    // Calendar month YYYY-MM. MUST be tried BEFORE the range rule: '2024-03' also satisfies the
    // N-M range pattern, and reading it as the range 2024..3 would silently invert into an
    // unmatched chip. A YYYY-MM-shaped token whose numbers are NOT a valid year+month falls
    // THROUGH to the range rule rather than dead-ending (e.g. '2000-50' is a range, not a month).
    const ym = raw.match(/^(\d{4})-(\d{2})$/);
    if (ym !== null) {
      const year = Number(ym[1]);
      const month = Number(ym[2]);
      if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
        chips.push({ kind: 'month', year, month, label: `${ym[1]}-${ym[2]}` });
        continue;
      }
    }

    // range N-M
    const range = raw.match(/^(\$?\d{1,9}(?:\.\d{1,2})?)-(\$?\d{1,9}(?:\.\d{1,2})?)$/);
    if (range !== null) {
      const lo = numVal(range[1]!);
      const hi = numVal(range[2]!);
      if (Number(lo) <= Number(hi)) {
        chips.push({ kind: 'amount_range', lo, hi, label: `amount ${lo}–${hi}` });
        continue;
      }
      chips.push({ kind: 'unmatched', raw, label: raw });
      continue;
    }

    // month name [+ year]
    const monthNum = matchMonthName(raw);
    if (monthNum !== null) {
      const next = tokens[i + 1];
      if (next !== undefined && /^\d{4}$/.test(next) && Number(next) >= 1900 && Number(next) <= 2100) {
        chips.push({ kind: 'month', year: Number(next), month: monthNum, label: `${MONTHS[monthNum - 1]} ${next}` });
        i += 1; // consumed the year token
      } else {
        chips.push({ kind: 'month', year: null, month: monthNum, label: `${MONTHS[monthNum - 1]} (any year)` });
      }
      continue;
    }

    // numbers: year vs exact amount
    if (isNum(raw)) {
      const v = numVal(raw);
      if (/^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= 2100 && !raw.startsWith('$')) {
        chips.push({ kind: 'year', year: Number(v), label: `year ${v}` });
        continue;
      }
      if (raw.startsWith('$') || v.includes('.') || v.length >= 3) {
        chips.push({ kind: 'amount', op: '=', value: v, label: `amount = ${v}` });
        continue;
      }
      chips.push({ kind: 'unmatched', raw, label: raw });
      continue;
    }

    // eras (exact)
    const lower = raw.toLowerCase();
    if (lower === 'seed' || lower === 'cron') {
      chips.push({ kind: 'era', era: lower, label: `era: ${lower}` });
      continue;
    }

    // methods (unique prefix ≥3 over the closed set)
    const method = matchMethodPrefix(raw);
    if (method !== null) {
      chips.push({ kind: 'method', method, label: `method: ${method}` });
      continue;
    }

    // member display token
    const memberTok = raw.match(/^m-([0-9a-f]{4,64})$/i);
    if (memberTok !== null) {
      const prefix = memberTok[1]!.toLowerCase();
      chips.push({ kind: 'member', prefix, label: `member M-${prefix.slice(0, MEMBER_TOKEN_LENGTH)}` });
      continue;
    }
    if (/^[0-9a-f]{10,64}$/i.test(raw)) {
      const prefix = raw.toLowerCase();
      chips.push({ kind: 'member', prefix, label: `member M-${prefix.slice(0, MEMBER_TOKEN_LENGTH)}` });
      continue;
    }

    // facility word (must contain at least two letters — 1-char noise is unmatched)
    if (/[a-z].*[a-z]/i.test(raw)) {
      chips.push({ kind: 'facility', term: raw, label: `facility ~ ${raw}` });
      continue;
    }

    chips.push({ kind: 'unmatched', raw, label: raw });
  }
  return { chips, applied: chips.filter((c) => c.kind !== 'unmatched') };
}

// --- sort + cursor ------------------------------------------------------------------

const RESOLUTION_SORTABLE = new Set(['charge_date', 'payment_received', 'charge_amount', 'insurance_payments']);
export type ResolutionSortColumn = 'charge_date' | 'payment_received' | 'charge_amount' | 'insurance_payments';
export interface ResolutionSort {
  column: ResolutionSortColumn;
  direction: 'asc' | 'desc';
}
export const RESOLUTION_DEFAULT_SORT: ResolutionSort = { column: 'charge_date', direction: 'desc' };

export interface ResolutionCursor {
  id: number;
  value: string | number | null;
}

/** Clamp to the allowlist; the default (charge_date DESC) otherwise. */
export function resolveResolutionSort(sort: ResolutionSort | undefined): ResolutionSort {
  if (
    sort !== undefined &&
    RESOLUTION_SORTABLE.has(sort.column) &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    return { column: sort.column, direction: sort.direction };
  }
  return { ...RESOLUTION_DEFAULT_SORT };
}

/** Accept a cursor only if shaped safely; otherwise first page. */
export function resolveResolutionCursor(cursor: ResolutionCursor | null | undefined): ResolutionCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!Number.isSafeInteger(cursor.id) || cursor.id < 1) return null;
  const v = cursor.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number') return null;
  return { id: cursor.id, value: v ?? null };
}

// --- builders -------------------------------------------------------------------------

const MATVIEW = 'collections.cmd_facility_resolution';

/** The explicit queue projection (matches ResolutionRow). Dates/money cast to stable text. */
const RESOLUTION_SELECT =
  'select id, business_entity_id::text as business_entity_id, member_id_bidx, ' +
  'charge_date::text as charge_date, payment_received::text as payment_received, ' +
  'cpt_code, revenue_code, cpt_key, revenue_key, ' +
  'charge_amount::text as charge_amount, insurance_payments::text as insurance_payments, ' +
  'primary_payer, source_era, method, facility_code, facility_label, facility_alias, ' +
  'unresolved_reason, assignment_id ';

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

/** Per-method overview (charge grain). One row per method present in scope. */
export function buildResolutionOverviewQuery(entityIds: readonly string[]): SqlQuery {
  const ids = assertEntityScope(entityIds, 'buildResolutionOverviewQuery');
  return {
    sql:
      'select method, count(*)::int as charges, count(distinct member_id_bidx)::int as members, ' +
      'sum(charge_amount)::text as charge_dollars, sum(coalesce(insurance_payments,0))::text as paid_dollars, ' +
      'count(distinct facility_alias)::int as facilities ' +
      `from ${MATVIEW} where business_entity_id = any($1::uuid[]) ` +
      'group by method',
    params: [ids],
  };
}

/** Chips → the queue page query (keyset-paginated, allowlisted sort). */
export function buildResolutionQueueQuery(
  applied: readonly ResolutionChip[],
  sort: ResolutionSort | undefined,
  cursor: ResolutionCursor | null | undefined,
  entityIds: readonly string[],
): SqlQuery {
  const ids = assertEntityScope(entityIds, 'buildResolutionQueueQuery');
  const s = resolveResolutionSort(sort);
  const c = resolveResolutionCursor(cursor);

  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const conds: string[] = [`business_entity_id = any(${add(ids)}::uuid[])`];

  // OR within a kind, AND across kinds.
  const methods = applied.filter((ch) => ch.kind === 'method').map((ch) => ch.method);
  if (methods.length > 0) conds.push(`method = any(${add(methods)}::text[])`);

  const eras = applied.filter((ch) => ch.kind === 'era').map((ch) => ch.era);
  if (eras.length > 0) conds.push(`source_era = any(${add(eras)}::text[])`);

  const dateConds: string[] = [];
  for (const ch of applied) {
    if (ch.kind === 'month' && ch.year !== null) {
      const start = `${ch.year}-${String(ch.month).padStart(2, '0')}-01`;
      dateConds.push(
        `(charge_date >= ${add(start)}::date and charge_date < (${add(start)}::date + interval '1 month'))`,
      );
    } else if (ch.kind === 'month') {
      dateConds.push(`extract(month from charge_date) = ${add(ch.month)}::int`);
    } else if (ch.kind === 'year') {
      const start = `${ch.year}-01-01`;
      dateConds.push(
        `(charge_date >= ${add(start)}::date and charge_date < (${add(start)}::date + interval '1 year'))`,
      );
    }
  }
  if (dateConds.length > 0) conds.push(`(${dateConds.join(' or ')})`);

  for (const ch of applied) {
    if (ch.kind === 'amount') {
      const p = add(ch.value);
      conds.push(`(charge_amount ${ch.op} ${p}::numeric or insurance_payments ${ch.op} ${p}::numeric)`);
    } else if (ch.kind === 'amount_range') {
      const lo = add(ch.lo);
      const hi = add(ch.hi);
      conds.push(
        `((charge_amount between ${lo}::numeric and ${hi}::numeric) ` +
          `or (insurance_payments between ${lo}::numeric and ${hi}::numeric))`,
      );
    }
  }

  const memberConds = applied
    .filter((ch) => ch.kind === 'member')
    .map((ch) => `member_id_bidx like ${add(`${ch.prefix.replace(/([\\%_])/g, '\\$1')}%`)}`);
  if (memberConds.length > 0) conds.push(`(${memberConds.join(' or ')})`);

  for (const ch of applied) {
    if (ch.kind === 'facility') {
      const p = add(likeContains(ch.term));
      conds.push(
        `(facility_alias ilike ${p} or facility_label ilike ${p} or facility_code ilike ${p})`,
      );
    }
  }

  // keyset pagination: (sort col dir NULLS LAST, id desc). The cursor is the last row shown.
  const col = s.column; // allowlisted by resolveResolutionSort — a fixed literal by construction
  if (c !== null) {
    const idP = add(c.id);
    if (c.value === null) {
      // the cursor row sat in the trailing NULLS-LAST block — continue inside it by id
      conds.push(`(${col} is null and id < ${idP})`);
    } else {
      const vP = add(c.value);
      const cmp = s.direction === 'asc' ? '>' : '<';
      conds.push(
        `((${col} ${cmp} ${vP}) or (${col} = ${vP} and id < ${idP}) or (${col} is null))`,
      );
    }
  }

  const sql =
    RESOLUTION_SELECT +
    `from ${MATVIEW} where ` +
    conds.join(' and ') +
    ` order by ${col} ${s.direction} nulls last, id desc ` +
    `limit ${RESOLUTION_PAGE_SIZE + 1}`; // over-fetch one row to detect hasMore

  return { sql, params };
}

/** Expand selected members → ALL their unresolved charge keys (the bulk-by-member path).
 *  Bounded: LIMIT is one over the save function's 500-key cap so the caller can fail loud
 *  rather than silently truncate a member's charges. */
export function buildMemberUnresolvedKeysQuery(
  entityIds: readonly string[],
  memberBidxes: readonly string[],
): SqlQuery {
  const ids = assertEntityScope(entityIds, 'buildMemberUnresolvedKeysQuery');
  if (memberBidxes.length === 0 || memberBidxes.length > 50) {
    throw new Error('buildMemberUnresolvedKeysQuery: 1..50 members per expansion');
  }
  return {
    sql:
      'select business_entity_id::text as business_entity_id, member_id_bidx, ' +
      'charge_date::text as charge_date, cpt_key, revenue_key, charge_amount::text as charge_amount ' +
      `from ${MATVIEW} ` +
      "where business_entity_id = any($1::uuid[]) and member_id_bidx = any($2::text[]) and method = 'unresolved' " +
      'order by member_id_bidx, charge_date, id ' +
      'limit 501',
    params: [ids, [...memberBidxes]],
  };
}

/** The assignment picker's canonical facility options (roster codes → display names). */
export function buildResolutionFacilityOptionsQuery(facilityCodes: readonly string[]): SqlQuery {
  if (facilityCodes.length === 0 || facilityCodes.length > 100) {
    throw new Error('buildResolutionFacilityOptionsQuery: 1..100 roster codes');
  }
  return {
    sql:
      'select facility_code, facility_name from collections.facilities ' +
      'where facility_code = any($1::text[]) order by facility_name',
    params: [[...facilityCodes]],
  };
}
