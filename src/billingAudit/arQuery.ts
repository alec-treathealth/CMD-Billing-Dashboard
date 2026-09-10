/**
 * AR Management — the reader-side query builders for the AR queue (claims.ar_claim + friends).
 * PURE: return `{ sql, params }`; the composition root (app/lib/ar/server.ts) executes them as
 * claims_reader and decrypts PHI. Mirrors src/billingAudit/auditQuery.ts:
 *   - every value is a bound `$n`; table / column names are fixed literals; no SELECT *;
 *   - keyset paging on `(sort expr, id)` with a `{id, value}` cursor, over-fetch limit+1;
 *   - the TENANT predicate `c.business_entity_id = any($n::uuid[])` is mandatory on every read and
 *     comes from the RBAC-clamped view, never from the client.
 *
 * PHI: the queue projection selects NO encrypted column and NO blind-index token — the row's only
 * patient handle is cmd_patient_id (opaque CMD key). Names come back through the separate, gated,
 * audited reveal (buildArPatientRevealQuery → decrypt at the composition root). Patient-search
 * filters arrive as opaque HMAC tokens and are matched against ar_patient's index columns.
 *
 * AGE is computed at read time from dos_from against the caller's business-day `asOf`, so the
 * tiles drift live; a band filter compiles to dos_from DATE BOUNDS so the (entity, dos_from) index
 * can serve it.
 */
import { AR_BANDS, arBandCaseSql, arBandDayRanges, isArBandKey, type ArBandKey, AR_MIN_AGE_DAYS } from './arBuckets.js';

export const AR_PAGE_SIZE = 50;

export type ArSortColumn =
  | 'balance' | 'total_charges' | 'dos_from' | 'age' | 'facility_code' | 'current_payer_name'
  | 'status_category' | 'last_note_at' | 'work_status' | 'cmd_followup_date';
export interface ArSort { column: ArSortColumn; direction: 'asc' | 'desc'; }
export interface ArCursor { id: number; value: string | number | null; }

export const AR_WORK_STATUSES = ['open', 'in_progress', 'waiting_payer', 'appeal', 'resolved', 'dismissed'] as const;
export type ArWorkStatus = (typeof AR_WORK_STATUSES)[number];

const STATUS_CATEGORIES = new Set(['PAID', 'BALANCE_DUE_PATIENT', 'AT_PAYER', 'APPROVED_HIGHER', 'NEEDS_RENEGOTIATING', 'ON_HOLD', 'OTHER']);
const SORT_COLUMNS = new Set<ArSortColumn>(['balance', 'total_charges', 'dos_from', 'age', 'facility_code', 'current_payer_name', 'status_category', 'last_note_at', 'work_status', 'cmd_followup_date']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CMD_ID_RE = /^[0-9]{1,20}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ArFilter {
  bands?: ArBandKey[];
  facilityCodes?: string[];
  payerNames?: string[];
  statusCategories?: string[];
  workStatuses?: ArWorkStatus[];
  assigneeUserIds?: string[];
  hasDenial?: boolean;
  /** Show paid / zero-balance claims too (default: open balance only). */
  includePaid?: boolean;
  /** Only claims whose CMD follow-up date has passed. */
  followupOverdue?: boolean;
  minBalance?: number;
  // Opaque keyed-HMAC tokens from the gated search action — never plaintext.
  patientNameBidx?: string[];
  patientNamePrefixBidx?: string[];
  memberIdBidx?: string[];
  /** Exact CMD claim id (a biller pasting an id from CMD). */
  claimId?: string;
}

export interface ArDenialSummaryItem { g: string | null; c: string; amt: string; n: number; }

/** The non-PHI queue projection (JSON-safe: strings / numbers / booleans / null). */
export interface ArQueueRow {
  id: number;
  cmd_claim_id: string;
  cmd_patient_id: string;
  facility_code: string;
  facility_name: string | null;
  claim_type: string | null;
  type_of_bill: string | null;
  dos_from: string | null;
  dos_to: string | null;
  age_days: number | null;
  band: ArBandKey | null;
  cpt_codes: string[];
  rev_codes: string[];
  total_charges: string;
  ins_paid: string;
  pat_paid: string;
  adjustments: string;
  balance: string;
  primary_payer_name: string | null;
  current_payer_name: string | null;
  status_raw: string;
  status_category: string;
  status_payer: string | null;
  cmd_status_text: string | null;
  has_denial: boolean;
  denial_summary: ArDenialSummaryItem[];
  last_error_code: string | null;
  last_835_status: string | null;
  cmd_followup_date: string | null;
  cmd_note_count: number;
  last_cmd_note_at: string | null;
  last_user_note_at: string | null;
  work_status: ArWorkStatus;
  assignee_user_id: string | null;
  assignee_email: string | null;
  due_on: string | null;
  resolution_code: string | null;
  last_seen_at: string | null;
  in_latest_snapshot: boolean;
}

export type ParamAdder = (v: unknown) => string;

// --- input hygiene -----------------------------------------------------------------------------

function cleanList(input: unknown, cap: number, maxLen: number): string[] | undefined {
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

/** Coerce untrusted filter input to the validated, bounded shape. */
export function resolveArFilter(input: unknown): ArFilter {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  const bands = Array.isArray(o.bands) ? (o.bands.filter(isArBandKey) as ArBandKey[]).slice(0, AR_BANDS.length) : [];
  const statuses = cleanList(o.statusCategories, 8, 40)?.filter((s) => STATUS_CATEGORIES.has(s));
  const work = cleanList(o.workStatuses, 8, 20)?.filter((s): s is ArWorkStatus => (AR_WORK_STATUSES as readonly string[]).includes(s));
  const assignees = cleanList(o.assigneeUserIds, 50, 36)?.filter((s) => UUID_RE.test(s));
  const minBalance = typeof o.minBalance === 'number' && Number.isFinite(o.minBalance) && o.minBalance > 0 ? Math.min(o.minBalance, 1e9) : undefined;
  const claimId = typeof o.claimId === 'string' && CMD_ID_RE.test(o.claimId.trim()) ? o.claimId.trim() : undefined;
  return {
    bands: bands.length > 0 ? [...new Set(bands)] : undefined,
    facilityCodes: cleanList(o.facilityCodes, 60, 60),
    payerNames: cleanList(o.payerNames, 100, 160),
    statusCategories: statuses && statuses.length > 0 ? statuses : undefined,
    workStatuses: work && work.length > 0 ? work : undefined,
    assigneeUserIds: assignees && assignees.length > 0 ? assignees : undefined,
    hasDenial: o.hasDenial === true ? true : undefined,
    includePaid: o.includePaid === true ? true : undefined,
    followupOverdue: o.followupOverdue === true ? true : undefined,
    minBalance,
    patientNameBidx: cleanList(o.patientNameBidx, 20, 128),
    patientNamePrefixBidx: cleanList(o.patientNamePrefixBidx, 20, 128),
    memberIdBidx: cleanList(o.memberIdBidx, 20, 128),
    claimId,
  };
}

export const AR_DEFAULT_SORT: ArSort = { column: 'balance', direction: 'desc' };

export function resolveArSort(input: unknown): ArSort {
  if (!input || typeof input !== 'object') return AR_DEFAULT_SORT;
  const o = input as Record<string, unknown>;
  const column = typeof o.column === 'string' && SORT_COLUMNS.has(o.column as ArSortColumn) ? (o.column as ArSortColumn) : AR_DEFAULT_SORT.column;
  const direction = o.direction === 'asc' ? 'asc' : 'desc';
  return { column, direction };
}

export function resolveArCursor(input: unknown): ArCursor | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.id !== 'number' || !Number.isSafeInteger(o.id) || o.id <= 0) return null;
  const v = o.value;
  if (v === null || v === undefined) return { id: o.id, value: null };
  if (typeof v === 'number' && Number.isFinite(v)) return { id: o.id, value: v };
  if (typeof v === 'string' && v.length <= 200) return { id: o.id, value: v };
  return null;
}

// --- predicates ----------------------------------------------------------------------------------

function entityIdsOrThrow(entityIds: readonly string[]): string[] {
  if (entityIds.length === 0) throw new Error('arQuery: entity scope must not be empty (fail closed)');
  return [...entityIds];
}

function asOfOrThrow(asOf: string): string {
  if (!ISO_DATE.test(asOf)) throw new Error('arQuery: asOf must be an ISO date');
  return asOf;
}

/** Whether a filter needs the ar_patient join (blind-index search). */
function needsPatientJoin(f: ArFilter): boolean {
  return Boolean(f.patientNameBidx || f.patientNamePrefixBidx || f.memberIdBidx);
}

/**
 * The shared WHERE for the queue and its summaries. `asOfParam` is the already-bound `$n` of the
 * business-day date. `includeBands=false` lets the tile summary describe the un-banded population.
 */
export function arBaseConds(
  filter: ArFilter,
  entityIds: string[],
  asOfParam: string,
  add: ParamAdder,
  includeBands = true,
  includeAgeFloor = true,
): string[] {
  const conds: string[] = [`c.business_entity_id = any(${add(entityIds)}::uuid[])`, 'c.in_latest_snapshot'];
  // AGED AR ONLY — the 0–30 day set is excluded from every read on this plane (queue, tiles and
  // KPI alike, since they share this predicate list). Ruled 2026-09-10; see AR_MIN_AGE_DAYS.
  //
  // ⚠ A NULL dos_from is KEPT, not dropped. `dos_from <= asOf - 31` is NULL for an undated claim,
  // so a bare comparison would silently remove money we cannot prove is new — the opposite of what
  // an AR queue is for. An undated claim stays visible and is the reason arBandCaseSql takes a date
  // expression as well as an age.
  //
  // `includeAgeFloor=false` is for a SINGLE-CLAIM read, never for a list. The notifications bell can
  // legitimately surface a claim younger than 31 days (someone noted or assigned it), and the drawer
  // resolves that claim through this same predicate list — so inheriting the floor made the bell
  // advertise a claim and then refuse to open it. A one-claim read is not the queue.
  if (includeAgeFloor) {
    conds.push(`(c.dos_from is null or c.dos_from <= (${asOfParam}::date - ${add(AR_MIN_AGE_DAYS)}::int))`);
  }
  if (!filter.includePaid) conds.push('c.balance > 0');
  if (filter.facilityCodes) conds.push(`c.facility_code = any(${add(filter.facilityCodes)}::text[])`);
  if (filter.payerNames) conds.push(`c.current_payer_name = any(${add(filter.payerNames)}::text[])`);
  if (filter.statusCategories) conds.push(`c.status_category = any(${add(filter.statusCategories)}::text[])`);
  if (filter.workStatuses) conds.push(`coalesce(w.work_status, 'open') = any(${add(filter.workStatuses)}::text[])`);
  if (filter.assigneeUserIds) conds.push(`w.assignee_user_id = any(${add(filter.assigneeUserIds)}::uuid[])`);
  if (filter.hasDenial) conds.push('c.has_denial');
  // The queue shows the WORK due date when one is set, else CMD's follow-up date — the overdue
  // predicate must read the same effective date or a red date would vanish under its own filter.
  if (filter.followupOverdue) conds.push(`coalesce(w.due_on, c.cmd_followup_date) < ${asOfParam}::date`);
  if (filter.minBalance !== undefined) conds.push(`c.balance >= ${add(filter.minBalance)}::numeric`);
  if (filter.claimId) conds.push(`c.cmd_claim_id = ${add(filter.claimId)}`);
  // PATIENT SEARCH IS ONE **OR** GROUP, NOT THREE AND-ED CLAUSES.
  // The box is labelled "patient name or member id", and searchArPatientsAction emits a NAME token
  // AND a MEMBER-ID token for any term containing a digit (app/lib/ar/actions.ts) — it cannot know
  // which kind the operator typed. Pushed separately these become
  //   patient_name_bidx = hmac(term) AND member_id_bidx = hmac(term)
  // which asks for a patient whose NAME is their member id: zero rows, for every member-id search
  // ever run. And because this same predicate set feeds the summary and the KPI, the hero read
  // "Open AR · 0 claims / $0" for a patient who has open AR — a wrong number, not just a bad search.
  const patientOrs: string[] = [];
  if (filter.patientNameBidx) patientOrs.push(`p.patient_name_bidx = any(${add(filter.patientNameBidx)}::text[])`);
  if (filter.patientNamePrefixBidx) patientOrs.push(`p.patient_name_pfx3_bidx = any(${add(filter.patientNamePrefixBidx)}::text[])`);
  if (filter.memberIdBidx) patientOrs.push(`p.member_id_bidx = any(${add(filter.memberIdBidx)}::text[])`);
  if (patientOrs.length > 0) conds.push(`(${patientOrs.join(' or ')})`);
  if (includeBands && filter.bands) {
    // Compile the band set to DOS bounds: age <= max ⇔ dos_from >= asOf - max; age >= min ⇔ dos_from <= asOf - min.
    const ors = arBandDayRanges(filter.bands).map((r) => {
      const upper = `c.dos_from <= (${asOfParam}::date - ${add(r.minDays)}::int)`;
      return r.maxDays === null ? `(${upper})` : `(${upper} and c.dos_from >= (${asOfParam}::date - ${add(r.maxDays)}::int))`;
    });
    conds.push(`(${ors.join(' or ')})`);
  }
  return conds;
}

const ISO_TS = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
const tsOut = (expr: string): string => `to_char(${expr} at time zone 'UTC', ${ISO_TS})`;
const dateOut = (expr: string): string => `to_char(${expr}, 'YYYY-MM-DD')`;

const BASE_JOINS =
  `from claims.ar_claim c ` +
  `left join claims.ar_claim_work w on w.business_entity_id = c.business_entity_id and w.cmd_claim_id = c.cmd_claim_id ` +
  `left join lateral (select max(n.noted_at) as last_user_note_at from claims.ar_claim_note n ` +
  `where n.business_entity_id = c.business_entity_id and n.cmd_claim_id = c.cmd_claim_id and n.source = 'user') un on true`;
const PATIENT_JOIN = ` left join claims.ar_patient p on p.business_entity_id = c.business_entity_id and p.cmd_patient_id = c.cmd_patient_id`;

/** The ORDER BY expression for a sort column (and whether `age` flips the direction). */
function sortExpr(column: ArSortColumn): { expr: string; flip: boolean; numeric: boolean } {
  switch (column) {
    case 'balance': return { expr: 'c.balance', flip: false, numeric: true };
    case 'total_charges': return { expr: 'c.total_charges', flip: false, numeric: true };
    case 'dos_from': return { expr: 'c.dos_from', flip: false, numeric: false };
    case 'age': return { expr: 'c.dos_from', flip: true, numeric: false }; // older = earlier DOS
    case 'facility_code': return { expr: 'c.facility_code', flip: false, numeric: false };
    case 'current_payer_name': return { expr: 'c.current_payer_name', flip: false, numeric: false };
    case 'status_category': return { expr: 'c.status_category', flip: false, numeric: false };
    case 'last_note_at': return { expr: 'greatest(c.last_cmd_note_at, un.last_user_note_at)', flip: false, numeric: false };
    case 'work_status': return { expr: `coalesce(w.work_status, 'open')`, flip: false, numeric: false };
    case 'cmd_followup_date': return { expr: 'c.cmd_followup_date', flip: false, numeric: false };
  }
}

/** The cursor value a row yields for a sort column — must match sortExpr's output shape. */
export function arSortValue(row: ArQueueRow, column: ArSortColumn): string | number | null {
  switch (column) {
    case 'balance': return Number(row.balance);
    case 'total_charges': return Number(row.total_charges);
    case 'dos_from':
    case 'age': return row.dos_from;
    case 'facility_code': return row.facility_code;
    case 'current_payer_name': return row.current_payer_name;
    case 'status_category': return row.status_category;
    case 'last_note_at': {
      const a = row.last_cmd_note_at ?? '';
      const b = row.last_user_note_at ?? '';
      const m = a > b ? a : b;
      return m === '' ? null : m;
    }
    case 'work_status': return row.work_status;
    case 'cmd_followup_date': return row.cmd_followup_date;
  }
}

/** One keyset page of the queue. `limit` should be AR_PAGE_SIZE + 1 (over-fetch to detect a next page). */
export function buildArQueueQuery(
  cursor: ArCursor | null,
  filter: ArFilter,
  sort: ArSort,
  limit: number,
  entityIds: readonly string[],
  asOf: string,
  /** Internal only — NOT derived from client input. See arBaseConds' includeAgeFloor. */
  opts: { includeAgeFloor?: boolean } = {},
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => { params.push(v); return `$${params.length}`; };
  const asOfParam = add(asOfOrThrow(asOf));
  const conds = arBaseConds(filter, entityIdsOrThrow(entityIds), asOfParam, add, true, opts.includeAgeFloor !== false);

  const { expr, flip, numeric } = sortExpr(sort.column);
  const dir = (flip ? (sort.direction === 'asc' ? 'desc' : 'asc') : sort.direction).toUpperCase();
  if (cursor !== null) {
    const cmp = dir === 'DESC' ? '<' : '>';
    const idParam = add(cursor.id);
    if (cursor.value === null) {
      // The cursor row sat in the NULLS LAST tail: continue within the tail by id only.
      conds.push(`(${expr} is null and c.id ${cmp} ${idParam})`);
    } else {
      const vParam = add(cursor.value);
      const cast = numeric ? '::numeric' : sort.column === 'dos_from' || sort.column === 'age' || sort.column === 'cmd_followup_date' ? '::date' : sort.column === 'last_note_at' ? '::timestamptz' : '::text';
      conds.push(`(${expr} ${cmp} ${vParam}${cast} or (${expr} = ${vParam}${cast} and c.id ${cmp} ${idParam}) or ${expr} is null)`);
    }
  }
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), AR_PAGE_SIZE * 4 + 1));
  const limitParam = add(safeLimit);
  const ageExpr = `(${asOfParam}::date - c.dos_from)`;

  const sql =
    `select c.id, c.cmd_claim_id, c.cmd_patient_id, c.facility_code, c.facility_name, c.claim_type, c.type_of_bill, ` +
    `${dateOut('c.dos_from')} as dos_from, ${dateOut('c.dos_to')} as dos_to, ` +
    `${ageExpr} as age_days, ${arBandCaseSql(ageExpr, 'c.dos_from')} as band, ` +
    `c.cpt_codes, c.rev_codes, c.total_charges::text as total_charges, c.ins_paid::text as ins_paid, c.pat_paid::text as pat_paid, ` +
    `c.adjustments::text as adjustments, c.balance::text as balance, ` +
    `c.primary_payer_name, c.current_payer_name, c.status_raw, c.status_category, c.status_payer, c.cmd_status_text, ` +
    `c.has_denial, c.denial_summary, c.last_error_code, c.last_835_status, ${dateOut('c.cmd_followup_date')} as cmd_followup_date, ` +
    `c.cmd_note_count, ${tsOut('c.last_cmd_note_at')} as last_cmd_note_at, ${tsOut('un.last_user_note_at')} as last_user_note_at, ` +
    `coalesce(w.work_status, 'open') as work_status, w.assignee_user_id::text as assignee_user_id, w.assignee_email, ` +
    `${dateOut('w.due_on')} as due_on, w.resolution_code, ${tsOut('c.last_seen_at')} as last_seen_at, c.in_latest_snapshot ` +
    BASE_JOINS + (needsPatientJoin(filter) ? PATIENT_JOIN : '') +
    ` where ${conds.join(' and ')} ` +
    `order by ${expr} ${dir} nulls last, c.id ${dir} ` +
    `limit ${limitParam}`;
  return { sql, params };
}

export interface ArBandSummaryRow { band: ArBandKey | null; claims: number; balance: string; }

/** Claims + open dollars per age band for the CURRENT filters (minus the band filter itself). */
export function buildArSummaryQuery(filter: ArFilter, entityIds: readonly string[], asOf: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => { params.push(v); return `$${params.length}`; };
  const asOfParam = add(asOfOrThrow(asOf));
  const conds = arBaseConds(filter, entityIdsOrThrow(entityIds), asOfParam, add, false);
  const ageExpr = `(${asOfParam}::date - c.dos_from)`;
  const sql =
    `select ${arBandCaseSql(ageExpr, 'c.dos_from')} as band, count(*)::int as claims, coalesce(sum(c.balance), 0)::text as balance ` +
    BASE_JOINS + (needsPatientJoin(filter) ? PATIENT_JOIN : '') +
    ` where ${conds.join(' and ')} group by 1`;
  return { sql, params };
}

export interface ArKpiRow {
  claims: number; balance: string; denied: number; denied_balance: string; worked: number;
  followup_overdue: number; never_noted: number; aged_31_plus: number; aged_31_plus_balance: string;
}

/** Headline KPIs for the current filters (bands included). */
export function buildArKpiQuery(filter: ArFilter, entityIds: readonly string[], asOf: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => { params.push(v); return `$${params.length}`; };
  const asOfParam = add(asOfOrThrow(asOf));
  const conds = arBaseConds(filter, entityIdsOrThrow(entityIds), asOfParam, add);
  const sql =
    `select count(*)::int as claims, coalesce(sum(c.balance), 0)::text as balance, ` +
    `count(*) filter (where c.has_denial)::int as denied, coalesce(sum(c.balance) filter (where c.has_denial), 0)::text as denied_balance, ` +
    `count(*) filter (where coalesce(w.work_status, 'open') <> 'open')::int as worked, ` +
    `count(*) filter (where coalesce(w.due_on, c.cmd_followup_date) < ${asOfParam}::date)::int as followup_overdue, ` +
    `count(*) filter (where c.cmd_note_count = 0 and un.last_user_note_at is null)::int as never_noted, ` +
    `count(*) filter (where (${asOfParam}::date - c.dos_from) > 30)::int as aged_31_plus, ` +
    `coalesce(sum(c.balance) filter (where (${asOfParam}::date - c.dos_from) > 30), 0)::text as aged_31_plus_balance ` +
    BASE_JOINS + (needsPatientJoin(filter) ? PATIENT_JOIN : '') +
    ` where ${conds.join(' and ')}`;
  return { sql, params };
}

export interface ArFacilityOption { facility_code: string; facility_name: string | null; n: number; balance: string; }
export interface ArPayerOption { payer_name: string; n: number; balance: string; }
export interface ArAssigneeOption { user_id: string; email: string; role: string; }

/**
 * THE PICKER AGGREGATES MUST DESCRIBE THE SAME POPULATION AS THE QUEUE.
 *
 * Both option builders carry the aged-only floor for the same reason arBaseConds does: without it a
 * facility or payer whose only claims are 0–30 days old was offered as a selectable option with a
 * real-looking count and balance, and choosing it filtered an aged-only queue to nothing. The count
 * beside the option is read as "this much money is here", so a mismatch is a wrong number and not
 * just a dead filter. `asOf` is therefore required, not optional — a picker without a business day
 * cannot honestly aggregate an age-bounded population.
 */
export function buildArFacilityOptionsQuery(entityIds: readonly string[], asOf: string): { sql: string; params: unknown[] } {
  return {
    sql:
      `select c.facility_code, max(c.facility_name) as facility_name, count(*)::int as n, coalesce(sum(c.balance), 0)::text as balance ` +
      `from claims.ar_claim c where c.business_entity_id = any($1::uuid[]) and c.in_latest_snapshot and c.balance > 0 ` +
      `and (c.dos_from is null or c.dos_from <= ($2::date - $3::int)) ` +
      `group by c.facility_code order by c.facility_code`,
    params: [entityIdsOrThrow(entityIds), asOfOrThrow(asOf), AR_MIN_AGE_DAYS],
  };
}

export function buildArPayerOptionsQuery(entityIds: readonly string[], asOf: string): { sql: string; params: unknown[] } {
  return {
    sql:
      `select c.current_payer_name as payer_name, count(*)::int as n, coalesce(sum(c.balance), 0)::text as balance ` +
      `from claims.ar_claim c where c.business_entity_id = any($1::uuid[]) and c.in_latest_snapshot and c.balance > 0 ` +
      `and (c.dos_from is null or c.dos_from <= ($2::date - $3::int)) ` +
      `and c.current_payer_name is not null group by c.current_payer_name order by balance desc, payer_name limit 400`,
    params: [entityIdsOrThrow(entityIds), asOfOrThrow(asOf), AR_MIN_AGE_DAYS],
  };
}

const ENTITY_SLUGS = new Set(['bxr', 'indigo']);
function entitySlugOrThrow(slug: string): string {
  if (!ENTITY_SLUGS.has(slug)) throw new Error('arQuery: entity slug must be bxr or indigo');
  return slug;
}

/**
 * Staff who can be assigned work IN THIS TENANT: every super_admin (cross-tenant by role) plus the
 * admins whose `claims.app_user.entity` is this tenant. Entity-scoped so a tenant's staff list never
 * carries another tenant's administrators; plain `user` cannot be assigned (it cannot see PHI).
 */
export function buildArAssigneeOptionsQuery(entitySlug: string): { sql: string; params: unknown[] } {
  return {
    sql:
      `select user_id::text as user_id, email, role from claims.app_user ` +
      `where role = 'super_admin' or (role = 'admin' and entity = $1) order by email`,
    params: [entitySlugOrThrow(entitySlug)],
  };
}

/** Resolve ONE assignee server-side (the mutation never trusts a client-supplied uuid/email pair). */
export function buildArAssigneeLookupQuery(userId: string): { sql: string; params: unknown[] } {
  return {
    sql: `select user_id::text as user_id, email, role, entity from claims.app_user where user_id = $1::uuid`,
    params: [userIdOrThrow(userId)],
  };
}

/** The patient a claim belongs to — the notes read derives it here rather than trusting the caller. */
export function buildArClaimPatientQuery(cmdClaimId: string, entityIds: readonly string[]): { sql: string; params: unknown[] } {
  return {
    sql: `select cmd_patient_id from claims.ar_claim where business_entity_id = any($1::uuid[]) and cmd_claim_id = $2 limit 1`,
    params: [entityIdsOrThrow(entityIds), claimIdOrThrow(cmdClaimId)],
  };
}

/** Freshness: the latest successful run per customer for the tenant, plus the oldest as-of among them. */
/**
 * The freshness chip's numbers — and, since 2026-09-10, its TRIPWIRE.
 *
 * ⚠ THE ORIGINAL VERSION COULD ONLY EVER LOOK HEALTHY, which is why this is the shape it is. It read
 * `distinct on (cmd_customer_id) … where status in ('ok','empty')` — i.e. only SUCCESSFUL runs — so a
 * cron that had been failing every night for a week still displayed the last good `snapshot_as_of`
 * and said nothing. Combined with there being no alerting in this repo at all, a permanently broken
 * ingest was invisible in the product; the only way to notice was to think to query the run log.
 *
 * So two facts are added, both from rows the old query deliberately excluded:
 *   last_attempt_at — max(started_at) over ALL runs, whatever their status. This is what goes stale
 *                     when the cron stops running, as opposed to when it stops SUCCEEDING.
 *   failed_recent   — runs in the last 36h whose status is neither 'ok' nor 'empty'. 36h and not 24h
 *                     because the schedule is daily: a 24h window straddles the boundary and flickers
 *                     depending on when the page is loaded.
 * `running` is excluded from failed_recent — a run in flight is not a failure, and the cron's own
 * guard already bounds how long one may claim to be running.
 */
export function buildArFreshnessQuery(entityIds: readonly string[]): { sql: string; params: unknown[] } {
  return {
    sql:
      `select (select count(*)::int from (select distinct on (cmd_customer_id) cmd_customer_id from claims.ar_snapshot_run ` +
      `where business_entity_id = any($1::uuid[]) and status in ('ok', 'empty') order by cmd_customer_id, finished_at desc) c) as customers, ` +
      `(select min(snapshot_as_of)::text from (select distinct on (cmd_customer_id) cmd_customer_id, snapshot_as_of from claims.ar_snapshot_run ` +
      `where business_entity_id = any($1::uuid[]) and status in ('ok', 'empty') order by cmd_customer_id, finished_at desc) o) as oldest_as_of, ` +
      `(select max(snapshot_as_of)::text from claims.ar_snapshot_run where business_entity_id = any($1::uuid[]) and status in ('ok', 'empty')) as newest_as_of, ` +
      `(select max(finished_at)::text from claims.ar_snapshot_run where business_entity_id = any($1::uuid[]) and status in ('ok', 'empty')) as last_run_finished_at, ` +
      // Deliberately NOT filtered by status: this is the one number that goes stale when the cron
      // stops running at all, which is the failure the old query could not represent.
      `(select max(started_at)::text from claims.ar_snapshot_run where business_entity_id = any($1::uuid[])) as last_attempt_at, ` +
      // count(DISTINCT cmd_customer_id), not count(*): the run log holds one row per ATTEMPT, so a
      // facility that failed twice in 36h (two daily failures, or a failure plus a manual retry) was
      // reported to the operator as TWO failing facilities. The banner says "N facilities", so the
      // number has to be facilities.
      `(select count(distinct cmd_customer_id)::int from claims.ar_snapshot_run where business_entity_id = any($1::uuid[]) ` +
      `and status not in ('ok', 'empty', 'running') and started_at > now() - interval '36 hours') as failed_recent, ` +
      // Staleness decided by the DATABASE clock, not the browser's. The alternative — shipping the
      // timestamp and diffing it client-side — needs a post-mount clock to stay hydration-safe, and
      // then an operator in a skewed timezone can see a different alarm state than the server would.
      // A boolean from now() has one answer for everyone.
      `(select coalesce(max(started_at) < now() - interval '36 hours', true) from claims.ar_snapshot_run ` +
      `where business_entity_id = any($1::uuid[])) as attempt_stale`,
    params: [entityIdsOrThrow(entityIds)],
  };
}

// --- claim detail --------------------------------------------------------------------------------

function claimIdOrThrow(cmdClaimId: string): string {
  if (!CMD_ID_RE.test(cmdClaimId)) throw new Error('arQuery: claim id must be a CMD numeric id');
  return cmdClaimId;
}

/** The queue row for ONE claim (same projection, no paging) — the drawer header. */
export function buildArClaimQuery(cmdClaimId: string, entityIds: readonly string[], asOf: string): { sql: string; params: unknown[] } {
  const filter: ArFilter = { claimId: claimIdOrThrow(cmdClaimId), includePaid: true };
  // includeAgeFloor: false — the drawer must open ANY claim by id, including one younger than the
  // queue's 31-day floor that the notifications bell surfaced. Opting out here rather than in
  // ArFilter keeps it unreachable from client input.
  const { sql, params } = buildArQueueQuery(null, filter, AR_DEFAULT_SORT, 1, entityIds, asOf, { includeAgeFloor: false });
  // The single-claim read must also see claims that dropped out of the latest snapshot.
  return { sql: sql.replace(' and c.in_latest_snapshot', ''), params };
}

export interface ArChargeLineRow {
  id: number; cmd_charge_id: string; dos_from: string | null; dos_to: string | null; cpt_code: string | null; modifiers: string | null;
  rev_code: string | null; units: string | null; charge_amount: string; allowed: string | null; ins_paid: string; pat_paid: string;
  adjustments: string; balance: string; status_raw: string; status_category: string; first_bill_date: string | null;
  last_bill_date: string | null; ins_last_payment_date: string | null; in_latest_snapshot: boolean;
}

export function buildArChargeLinesQuery(cmdClaimId: string, entityIds: readonly string[]): { sql: string; params: unknown[] } {
  return {
    sql:
      `select id, cmd_charge_id, ${dateOut('dos_from')} as dos_from, ${dateOut('dos_to')} as dos_to, cpt_code, modifiers, rev_code, ` +
      `units::text as units, charge_amount::text as charge_amount, allowed::text as allowed, ins_paid::text as ins_paid, pat_paid::text as pat_paid, ` +
      `adjustments::text as adjustments, balance::text as balance, status_raw, status_category, ${dateOut('first_bill_date')} as first_bill_date, ` +
      `${dateOut('last_bill_date')} as last_bill_date, ${dateOut('ins_last_payment_date')} as ins_last_payment_date, in_latest_snapshot ` +
      `from claims.ar_charge where business_entity_id = any($1::uuid[]) and cmd_claim_id = $2 order by dos_from nulls last, id limit 500`,
    params: [entityIdsOrThrow(entityIds), claimIdOrThrow(cmdClaimId)],
  };
}

export interface ArRemitRow {
  id: number; cmd_charge_id: string; kind: 'A' | 'R'; group_code: string | null; code: string; amount: string | null;
  is_denial: boolean; payer_name: string | null; payer_level: number | null; received_date: string | null;
}

export function buildArRemitsQuery(cmdClaimId: string, entityIds: readonly string[]): { sql: string; params: unknown[] } {
  return {
    sql:
      `select id, cmd_charge_id, kind, group_code, code, amount::text as amount, is_denial, payer_name, payer_level, ${dateOut('received_date')} as received_date ` +
      `from claims.ar_remit where business_entity_id = any($1::uuid[]) and cmd_claim_id = $2 order by received_date desc nulls last, id desc limit 500`,
    params: [entityIdsOrThrow(entityIds), claimIdOrThrow(cmdClaimId)],
  };
}

export interface ArStatusEventRow {
  id: number; status_type: string; status_date: string | null; status_code: string | null; status_message: string | null;
  action_code: string | null; action_message: string | null; receiver_name: string | null; err_fixed: string | null;
}

export function buildArStatusEventsQuery(cmdClaimId: string, entityIds: readonly string[], limit = 40): { sql: string; params: unknown[] } {
  return {
    sql:
      `select id, status_type, ${tsOut('status_date')} as status_date, status_code, status_message, action_code, action_message, receiver_name, err_fixed ` +
      `from claims.ar_claim_status_event where business_entity_id = any($1::uuid[]) and cmd_claim_id = $2 order by status_date desc nulls last, id desc limit $3`,
    params: [entityIdsOrThrow(entityIds), claimIdOrThrow(cmdClaimId), Math.max(1, Math.min(200, Math.floor(limit)))],
  };
}

/** Note rows with the CIPHERTEXT — decrypt at the composition root, gated. Claim-level plus patient-level (null claim) notes. */
export interface ArNoteEncRow { id: number; source: 'cmd' | 'user'; author_label: string; author_user_id: string | null; note_enc: Buffer; note_type: string | null; noted_at: string; cmd_claim_id: string | null; }

export function buildArNotesQuery(cmdClaimId: string, cmdPatientId: string, entityIds: readonly string[], limit = 200): { sql: string; params: unknown[] } {
  if (!CMD_ID_RE.test(cmdPatientId)) throw new Error('arQuery: patient id must be a CMD numeric id');
  return {
    sql:
      `select id, source, author_label, author_user_id::text as author_user_id, note_enc, note_type, ${tsOut('noted_at')} as noted_at, cmd_claim_id ` +
      `from claims.ar_claim_note where business_entity_id = any($1::uuid[]) ` +
      `and (cmd_claim_id = $2 or (cmd_claim_id is null and cmd_patient_id = $3)) order by noted_at desc, id desc limit $4`,
    params: [entityIdsOrThrow(entityIds), claimIdOrThrow(cmdClaimId), cmdPatientId, Math.max(1, Math.min(500, Math.floor(limit)))],
  };
}

/** The latest follow-up note for each claim on a page, keyed back by claim id. Ciphertext. */
export interface ArLatestNoteEncRow { cmd_claim_id: string; note_enc: Buffer; noted_at: string; source: string; author_label: string | null; claim_level: boolean }

/**
 * ONE query for the latest follow-up note of every claim on a page — claim-level or patient-level.
 *
 * Why it takes PAIRS: migration 0110 made CMD-sourced notes patient-level (`cmd_claim_id` is NULL on
 * most of them — 1,535 of CAMH's 1,567), so "this claim's latest note" cannot be answered from the
 * claim id alone. The caller passes (claim, patient) pairs it has already read inside the tenant
 * scope, and the lateral resolves each independently; a claim id can therefore only ever reach the
 * notes of its own patient, the same property loadArNotes relies on.
 *
 * One indexed lateral per row rather than N round trips. Returns CIPHERTEXT — decryption is the
 * caller's job, and deliberately not cacheable (see loadArLatestNotes).
 */
export function buildArLatestNotesQuery(
  pairs: readonly { cmdClaimId: string; cmdPatientId: string }[],
  entityIds: readonly string[],
): { sql: string; params: unknown[] } {
  const claims: string[] = [];
  const patients: string[] = [];
  for (const p of pairs) {
    claims.push(claimIdOrThrow(p.cmdClaimId));
    if (!CMD_ID_RE.test(p.cmdPatientId)) throw new Error('arQuery: patient id must be a CMD numeric id');
    patients.push(p.cmdPatientId);
  }
  return {
    sql:
      `select k.cmd_claim_id, n.note_enc, ${tsOut('n.noted_at')} as noted_at, n.source, n.author_label, ` +
      `(n.cmd_claim_id is not null) as claim_level ` +
      `from unnest($2::text[], $3::text[]) as k(cmd_claim_id, cmd_patient_id) ` +
      `cross join lateral (` +
      `select note_enc, noted_at, source, author_label, cmd_claim_id from claims.ar_claim_note ` +
      `where business_entity_id = any($1::uuid[]) ` +
      `and (cmd_claim_id = k.cmd_claim_id or (cmd_claim_id is null and cmd_patient_id = k.cmd_patient_id)) ` +
      `order by noted_at desc, id desc limit 1) n`,
    params: [entityIdsOrThrow(entityIds), claims, patients],
  };
}

export interface ArEventRow { id: number; event_type: string; actor_email: string; from_value: string | null; to_value: string | null; detail: Record<string, unknown>; created_at: string; }

export function buildArEventsQuery(cmdClaimId: string, entityIds: readonly string[], limit = 100): { sql: string; params: unknown[] } {
  return {
    sql:
      `select id, event_type, actor_email, from_value, to_value, detail, ${tsOut('created_at')} as created_at ` +
      `from claims.ar_claim_event where business_entity_id = any($1::uuid[]) and cmd_claim_id = $2 order by created_at desc, id desc limit $3`,
    params: [entityIdsOrThrow(entityIds), claimIdOrThrow(cmdClaimId), Math.max(1, Math.min(500, Math.floor(limit)))],
  };
}

/** The encrypted identifiers for ONE patient — decrypted only after the gate + audit row. */
export function buildArPatientRevealQuery(cmdPatientId: string, entityIds: readonly string[]): { sql: string; params: unknown[] } {
  if (!CMD_ID_RE.test(cmdPatientId)) throw new Error('arQuery: patient id must be a CMD numeric id');
  return {
    sql: `select patient_name_enc, patient_dob_enc, member_id_enc from claims.ar_patient where business_entity_id = any($1::uuid[]) and cmd_patient_id = $2 limit 1`,
    params: [entityIdsOrThrow(entityIds), cmdPatientId],
  };
}

/** Bulk reveal for a page — ids bounded by the caller (≤200). */
export function buildArPatientsRevealQuery(cmdPatientIds: readonly string[], entityIds: readonly string[]): { sql: string; params: unknown[] } {
  const ids = cmdPatientIds.filter((id) => CMD_ID_RE.test(id)).slice(0, 200);
  return {
    sql: `select cmd_patient_id, patient_name_enc, member_id_enc from claims.ar_patient where business_entity_id = any($1::uuid[]) and cmd_patient_id = any($2::text[])`,
    params: [entityIdsOrThrow(entityIds), ids],
  };
}

// --- notifications -------------------------------------------------------------------------------

export interface ArNotificationRow {
  id: number; event_type: string; actor_email: string; from_value: string | null; to_value: string | null;
  created_at: string; cmd_claim_id: string; facility_code: string | null; business_entity_id: string; unread: boolean;
}

function userIdOrThrow(userId: string): string {
  if (!UUID_RE.test(userId)) throw new Error('arQuery: user id must be a uuid');
  return userId;
}

/** Recent events by OTHER actors, flagged unread against the caller's cursor. */
export function buildArNotificationsQuery(userId: string, entityIds: readonly string[], limit = 25): { sql: string; params: unknown[] } {
  return {
    sql:
      `select e.id, e.event_type, e.actor_email, e.from_value, e.to_value, ${tsOut('e.created_at')} as created_at, e.cmd_claim_id, c.facility_code, e.business_entity_id::text as business_entity_id, ` +
      `(e.created_at > coalesce((select s.last_seen_at from claims.ar_notification_seen s where s.app_user_id = $2::uuid), 'epoch'::timestamptz)) as unread ` +
      `from claims.ar_claim_event e ` +
      `left join claims.ar_claim c on c.business_entity_id = e.business_entity_id and c.cmd_claim_id = e.cmd_claim_id ` +
      `where e.business_entity_id = any($1::uuid[]) and e.actor_user_id <> $2::uuid order by e.created_at desc, e.id desc limit $3`,
    params: [entityIdsOrThrow(entityIds), userIdOrThrow(userId), Math.max(1, Math.min(100, Math.floor(limit)))],
  };
}

export function buildArNotificationCountQuery(userId: string, entityIds: readonly string[]): { sql: string; params: unknown[] } {
  return {
    sql:
      `select count(*)::int as unread from claims.ar_claim_event e where e.business_entity_id = any($1::uuid[]) and e.actor_user_id <> $2::uuid ` +
      `and e.created_at > coalesce((select s.last_seen_at from claims.ar_notification_seen s where s.app_user_id = $2::uuid), 'epoch'::timestamptz)`,
    params: [entityIdsOrThrow(entityIds), userIdOrThrow(userId)],
  };
}
