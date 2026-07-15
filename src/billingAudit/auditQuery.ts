/**
 * Billing Audit — the reader-side query builder for the /billing-audit work table
 * (claims.audit_row, charge-line grain). Next-free + PHI-free: NO bytea PHI column
 * (patient_name_enc / patient_dob_enc / member_id_enc) and NO blind-index token is ever
 * selected here — the grid shows a static mask; the patient drill reveals identifiers
 * through the separate canRevealPhi-gated + audited path (Phase-4 build 5). The only
 * per-patient handle exposed is cmd_patient_id, an opaque CMD business key stored
 * plaintext (never in the encrypted set — same classification as the collections CMD ids).
 *
 * Column/table names are FIXED literals; every value (entity ids, scope, facility, payer,
 * cpt, rev, status, dates, cursor value/id, limit) is a bound $n parameter — no
 * interpolation, no SELECT *. Mirrors src/collections/cmdExplorerQuery.ts:
 *   - keyset cursor {id, value}, order `<sortcol> <dir> NULLS LAST, id <dir>`, over-fetch
 *     PAGE_SIZE+1, so paging walks the FILTERED, SORTED set consistently;
 *   - a table alias `t` so ORDER BY targets the RAW date/amount column (not a to_char text
 *     output alias), letting the (business_entity_id, audit_scope, charge_from_date) index
 *     drive the sort + LIMIT.
 *
 * TENANT + SCOPE are mandatory WHERE predicates, both derived server-side (never client
 * input): business_entity_id = any($n::uuid[]) from the RBAC-clamped view, and audit_scope
 * = $n from the active subtab. A page can never cross a tenant or mix IP/OP.
 */
import type { AuditScope } from './auditConfig.js';

/** The non-PHI projection returned to the grid (all strings/numbers/null — JSON-safe). */
export interface AuditGridRow {
  id: number;
  audit_scope: AuditScope;
  facility_code: string | null;
  office_name: string | null;
  provider_name: string | null;
  cmd_claim_id: string;
  cmd_patient_id: string;
  payer_name: string | null;
  status_category: string;
  status_payer: string | null;
  charge_status_raw: string | null;
  claim_type: string | null;
  claim_frequency: string | null;
  cpt_code: string | null;
  rev_code: string | null;
  modifier_1: string | null;
  modifier_2: string | null;
  units: string | null;
  type_of_bill: string | null;
  auth_number: string | null;
  charge_from_date: string | null;
  charge_to_date: string | null;
  stmt_from_date: string | null;
  stmt_to_date: string | null;
  admission_date: string | null;
  charge_amount_cents: string; // bigint → string from pg; formatted to $ client-side
  principal_diag: string | null;
  last_fu_note: string | null;
  ingested_at: string | null;
}

export type ParamAdder = (v: unknown) => string;

// --- filters ----------------------------------------------------------------

/** All non-PHI filters. (Patient search + has-open-flags are deliberately NOT here:
 *  patient search is a gated PHI op — build 5; flags are Phase 3.) */
export interface AuditFilter {
  facilityCodes?: string[]; // exact match on facility_code (roster codes)
  payerNames?: string[]; //    exact match on payer_name
  cptCodes?: string[];
  revCodes?: string[];
  statusCategories?: string[]; // status_category enum values
  statusPayer?: string | null; // sub-filter when a single AT_PAYER category is selected
  dateFrom?: string | null; //   charge_from_date >= (inclusive, 'YYYY-MM-DD')
  dateTo?: string | null; //     charge_from_date <= (inclusive, 'YYYY-MM-DD')
}

const STATUS_CATEGORIES = new Set([
  'PAID', 'BALANCE_DUE_PATIENT', 'AT_PAYER', 'APPROVED_HIGHER',
  'NEEDS_RENEGOTIATING', 'ON_HOLD', 'OTHER',
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Bounded string list: trims, drops blanks/overlong, caps count — never an unbounded IN. */
function cleanList(input: unknown, cap = 100, maxLen = 120): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length === 0 || s.length > maxLen) continue;
    out.push(s);
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Coerce untrusted filter input to the validated shape (allowlisted, bounded). */
export function resolveAuditFilter(input: AuditFilter | null | undefined): AuditFilter {
  if (!input || typeof input !== 'object') return {};
  const statuses = cleanList(input.statusCategories, 8, 40)?.filter((s) => STATUS_CATEGORIES.has(s));
  const statusPayer = typeof input.statusPayer === 'string' && input.statusPayer.trim().length > 0 && input.statusPayer.length <= 120
    ? input.statusPayer.trim()
    : null;
  const dateFrom = typeof input.dateFrom === 'string' && ISO_DATE.test(input.dateFrom) ? input.dateFrom : null;
  const dateTo = typeof input.dateTo === 'string' && ISO_DATE.test(input.dateTo) ? input.dateTo : null;
  return {
    facilityCodes: cleanList(input.facilityCodes, 60, 60),
    payerNames: cleanList(input.payerNames, 100, 120),
    cptCodes: cleanList(input.cptCodes, 60, 20),
    revCodes: cleanList(input.revCodes, 60, 20),
    statusCategories: statuses && statuses.length > 0 ? statuses : undefined,
    statusPayer,
    dateFrom,
    dateTo,
  };
}

/** Tenant + scope + filter predicates (shared by the grid page and any future summary). */
export function auditBaseConds(
  filter: AuditFilter,
  scope: AuditScope,
  entityIds: string[],
  add: ParamAdder,
): string[] {
  const conds: string[] = [
    `t.business_entity_id = any(${add(entityIds)}::uuid[])`,
    `t.audit_scope = ${add(scope)}`,
  ];
  if (filter.facilityCodes) conds.push(`t.facility_code = any(${add(filter.facilityCodes)}::text[])`);
  if (filter.payerNames) conds.push(`t.payer_name = any(${add(filter.payerNames)}::text[])`);
  if (filter.cptCodes) conds.push(`t.cpt_code = any(${add(filter.cptCodes)}::text[])`);
  if (filter.revCodes) conds.push(`t.rev_code = any(${add(filter.revCodes)}::text[])`);
  if (filter.statusCategories) conds.push(`t.status_category = any(${add(filter.statusCategories)}::text[])`);
  if (filter.statusPayer) conds.push(`t.status_payer = ${add(filter.statusPayer)}`);
  if (filter.dateFrom) conds.push(`t.charge_from_date >= ${add(filter.dateFrom)}::date`);
  if (filter.dateTo) conds.push(`t.charge_from_date <= ${add(filter.dateTo)}::date`);
  return conds;
}

// --- sort + cursor ----------------------------------------------------------

export const AUDIT_SORTABLE_COLUMNS = [
  'charge_from_date',
  'charge_amount_cents',
  'payer_name',
  'facility_code',
  'status_category',
] as const;
export type AuditSortColumn = (typeof AUDIT_SORTABLE_COLUMNS)[number];
const AUDIT_SORTABLE = new Set<string>(AUDIT_SORTABLE_COLUMNS);

export interface AuditSort {
  column: AuditSortColumn;
  direction: 'asc' | 'desc';
}

/** Default grid order: most-recent date of service first (charge_from_date DESC). */
export const AUDIT_DEFAULT_SORT: AuditSort = { column: 'charge_from_date', direction: 'desc' };

export function resolveAuditSort(sort: AuditSort | undefined): AuditSort {
  if (
    sort !== undefined &&
    AUDIT_SORTABLE.has(sort.column) &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    return { column: sort.column, direction: sort.direction };
  }
  return { ...AUDIT_DEFAULT_SORT };
}

/** Forward keyset cursor: the sort-column value + id of the LAST row shown (both non-PHI). */
export interface AuditCursor {
  id: number;
  value: string | number | null;
}

export function resolveAuditCursor(cursor: AuditCursor | null | undefined): AuditCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (!Number.isSafeInteger(cursor.id) || cursor.id < 1) return null;
  const v = cursor.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number') return null;
  return { id: cursor.id, value: v ?? null };
}

// --- page query -------------------------------------------------------------

export const AUDIT_PAGE_SIZE = 50;

export interface AuditPage {
  rows: AuditGridRow[];
  nextCursor: AuditCursor | null;
}

// Explicit non-PHI column list — the bytea PHI columns are NEVER selected. Dates are
// to_char'd to stable 'YYYY-MM-DD' strings; charge_amount_cents (bigint) arrives as a
// string. id (bigserial) is the keyset + drill/reveal key. cmd_patient_id is the opaque
// non-PHI patient handle the drill groups on.
export const AUDIT_SELECT =
  'select t.id, t.audit_scope, t.facility_code, t.office_name, t.provider_name, ' +
  't.cmd_claim_id, t.cmd_patient_id, t.payer_name, t.status_category, t.status_payer, ' +
  't.charge_status_raw, t.claim_type, t.claim_frequency, t.cpt_code, t.rev_code, ' +
  't.modifier_1, t.modifier_2, t.units::text as units, t.type_of_bill, t.auth_number, ' +
  "to_char(t.charge_from_date, 'YYYY-MM-DD') as charge_from_date, " +
  "to_char(t.charge_to_date, 'YYYY-MM-DD') as charge_to_date, " +
  "to_char(t.stmt_from_date, 'YYYY-MM-DD') as stmt_from_date, " +
  "to_char(t.stmt_to_date, 'YYYY-MM-DD') as stmt_to_date, " +
  "to_char(t.admission_date, 'YYYY-MM-DD') as admission_date, " +
  't.charge_amount_cents::text as charge_amount_cents, t.principal_diag, t.last_fu_note, ' +
  `to_char(t.ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ingested_at ` +
  'from claims.audit_row t';

/**
 * Build one keyset page. `limit` is the page size (callers over-fetch PAGE_SIZE+1 to detect
 * a next page). Order is `t.<sortcol> <dir> NULLS LAST, t.id <dir>`; the cursor boundary
 * continues STRICTLY after the previous page's last row (the NULLS-LAST block handled for
 * both directions).
 */
export function buildAuditRowsQuery(
  cursor: AuditCursor | null,
  filter: AuditFilter,
  sort: AuditSort,
  limit: number,
  scope: AuditScope,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = auditBaseConds(filter, scope, entityIds, add);

  const col = sort.column; // allowlisted fixed literal
  const cmp = sort.direction === 'asc' ? '>' : '<';
  if (cursor !== null) {
    if (cursor.value === null) {
      conds.push(`(t.${col} is null and t.id ${cmp} ${add(cursor.id)})`);
    } else {
      const valueParam = add(cursor.value);
      const idParam = add(cursor.id);
      conds.push(
        `(t.${col} ${cmp} ${valueParam} or (t.${col} = ${valueParam} and t.id ${cmp} ${idParam}) or t.${col} is null)`,
      );
    }
  }

  const where = ` where ${conds.join(' and ')}`;
  const dir = sort.direction === 'asc' ? 'asc' : 'desc';
  const orderClause = ` order by t.${col} ${dir} nulls last, t.id ${dir}`;
  const limitClause = ` limit ${add(limit)}`;
  return { sql: `${AUDIT_SELECT}${where}${orderClause}${limitClause}`, params };
}

/** A row's sort-column value as a JSON-safe cursor scalar. */
export function auditSortValue(row: AuditGridRow, column: AuditSortColumn): string | number | null {
  const v = row[column];
  return v ?? null;
}

// --- filter option queries (non-PHI) ----------------------------------------

export interface AuditFacilityOption {
  facility_code: string;
  label: string | null;
  n: number;
}

/** Distinct facility_codes present in the (scope, tenant) slice + their friendly label from
 *  the facilities dimension (care_setting is the IP/OP source of truth) — the exact set the
 *  Facility tag picker should offer, joined to a human label. */
export function buildAuditFacilityOptionsQuery(scope: AuditScope, entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [scope, entityIds];
  return {
    sql:
      'select a.facility_code, f.facility_name as label, count(*)::int as n ' +
      'from claims.audit_row a ' +
      'left join collections.facilities f on f.facility_code = a.facility_code ' +
      'where a.audit_scope = $1 and a.business_entity_id = any($2::uuid[]) and a.facility_code is not null ' +
      'group by a.facility_code, f.facility_name order by a.facility_code',
    params,
  };
}

export interface AuditPayerOption {
  payer_name: string;
  n: number;
}

/** Distinct payer_names present in the (scope, tenant) slice — the Payer tag picker options. */
export function buildAuditPayerOptionsQuery(scope: AuditScope, entityIds: string[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [scope, entityIds];
  return {
    sql:
      'select payer_name, count(*)::int as n from claims.audit_row ' +
      'where audit_scope = $1 and business_entity_id = any($2::uuid[]) and payer_name is not null ' +
      'group by payer_name order by count(*) desc, payer_name',
    params,
  };
}
