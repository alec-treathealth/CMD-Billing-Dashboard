/**
 * Qualify — PURE SQL builders (no I/O; hermetically testable). The read layer behind the Qualify
 * contract (getQualifySnapshot / getQualifyMovers). Mirrors the discipline of cmdExplorerQuery.ts:
 * every value is a bound $n param, every identifier a fixed literal, all aggregate reads go through
 * the 0050 charge-grain rollup (NEVER raw cmd_explorer_rows — that grain double-counts ~2.14×), and
 * the dollar-weighted ratio reuses the shared, hardened PCT_RATIO_SELECT verbatim.
 *
 * ┌─ CROSS-TENANT EXCEPTION (Prompt-1 finding 2a / ruling 1a) ────────────────────────────────────┐
 * │ Every builder here scopes `business_entity_id = any($ent::uuid[])` where $ent is the caller's   │
 * │ pinned [BXR, Indigo] array (from requireQualifyPrincipal), NOT a single resolved entity and NOT │
 * │ the RBAC-clamped view. Qualify reads BOTH tenants by design. This is the reviewed, deliberate   │
 * │ exception — do NOT "fix" it to the single-tenant `viewEntityScope` pattern every other reader   │
 * │ uses. The array still passes assertEntityScope() for fail-closed shape validation.              │
 * └────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * PHI: member/prefix identity enters ONLY as an opaque keyed-HMAC blind-index token (member_id_bidx /
 * member_id_prefix_bidx); raw PHI never reaches this module. member_id_bidx is used for grouping /
 * distinct-patient counting but is NEVER projected to the caller (opaque token stays server-side); a
 * patient row carries the rollup `id` (latest snapshot's real cmd_explorer_rows id) so the audited
 * reveal can join back. Dollar columns are returned raw — the amounts-capability gate strips them in
 * the action layer (single choke point), never here.
 */
import { assertEntityScope } from './entityScope.js';
import { CMD_EXPLORER_CHARGE_ROLLUP, PCT_RATIO_SELECT, type ParamAdder } from './cmdExplorerQuery.js';

/** A member-id EXACT match vs a 3-letter alpha-PREFIX match — sniffed server-side, never client-declared. */
export type QualifyMatchKind = 'member_id' | 'prefix';

/** 15 most-recent distinct patients on the cases panel (ruling: no separate cohort floor — mask + audited reveal is the control). */
export const QUALIFY_CASES_LIMIT = 15;

/** Movers suppression floors + cap (ruling Q-B). */
export const QUALIFY_MOVERS_MIN_PATIENTS = 5; // thisWindow distinct patients >= this to appear at all
export const QUALIFY_MOVERS_MIN_CHARGES = 10; // charge floor so a 5-6-patient cohort with thin real volume can't top the list
export const QUALIFY_MOVERS_TOP_N = 12;

// ── builder outputs (the row shapes the data loaders consume) ────────────────────────────────────
export interface QualifyResolvePayerRow {
  primary_payer: string;
}
export interface QualifyFacilityRow {
  facility: string; // raw rollup facility text (fallback display when facility_name is null)
  facility_name: string | null; // resolved dimension name (crosswalk)
  facility_code: string | null; // resolved facility_code — join key to the in-code city/state lookup
  line_count: number; // logical charge lines (rating-dampening weight; NON-dollar)
  billed: number | null; // sum(charge_amount)  — stripped in the action for admissions_seat
  allowed: number | null; // sum(allowed_amount) — stripped in the action for admissions_seat
  pct_allowed: number | null; // dollar-weighted allowed/billed, 0-100 (guarded); the displayed value
}
export interface QualifyCaseRow {
  id: number; // rollup id of the patient's MOST-RECENT charge — drives the audited reveal join
  facility: string;
  facility_name: string | null;
  program: 'IP' | 'OP' | 'BOTH' | null; // := resolved care_setting; null when facility text unresolved (Q-D)
  last_dos: string | null; // max(charge_date) — display only
  pct_allowed: number | null; // per-patient dollar-weighted allowed/billed
  billed: number | null;
  allowed: number | null;
}
export interface QualifyMoverRow {
  primary_payer: string; // plaintext, non-PHI — the mover LABEL, tappable into the primary_payers filter
  this_patients: number;
  prior_patients: number;
  delta_patients: number; // this - prior (signed; ranked desc = biggest gainers first)
}

function paramList(): { params: unknown[]; add: ParamAdder } {
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  return { params, add };
}

/**
 * Shared facility-dimension resolution: the SAME two-path crosswalk buildCmdFacilityOptionsQuery uses
 * (exact facility_name match, else the cmd_facility_aliases crosswalk → canonical facilities row). It
 * attaches facility_name / care_setting / facility_code; `max()` in the caller collapses any join
 * multiplicity (facility_name is not unique-constrained). The dimension tables are global (no
 * business_entity_id) — but every facility TEXT we join has already passed the tenant scope in the
 * inner aggregate, so no other tenant's facility leaks in; the joins only enrich the label.
 */
const FACILITY_DIM_JOINS =
  'left join collections.facilities fe on upper(fe.facility_name) = upper(agg.facility) ' +
  'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(agg.facility) ' +
  'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, a.facility_code) ';

/**
 * Resolve the dominant payer for a matched member/prefix token. UNWINDOWED on purpose: identity is
 * recognized if the token appears at ANY time, so a null result strictly means "never seen this
 * identifier" (→ resolved=null → VOB path). A KNOWN identifier with no in-window activity yields a
 * non-null payer but an empty facilities[] ("payer has no facilities in this window") — a different,
 * legitimate state the frontends must not conflate with VOB. Dominant = most charges, tiebreak
 * most-recent payment_received (tunable heuristic). Cross-tenant. Returns 0 or 1 row.
 */
export function buildResolvePayerQuery(
  token: string,
  kind: QualifyMatchKind,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildResolvePayerQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const tok = add(token);
  const col = kind === 'member_id' ? 'member_id_bidx' : 'member_id_prefix_bidx';
  const sql =
    'select primary_payer ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and ${col} = ${tok} ` +
    "and primary_payer is not null and btrim(primary_payer) <> '' " +
    'group by primary_payer ' +
    'order by count(*) desc, max(payment_received) desc nulls last, primary_payer ' +
    'limit 1';
  return { sql, params };
}

/**
 * Per-facility dollar-weighted allowed/billed for the resolved payer, windowed on payment_received,
 * cross-tenant. Facilities from BOTH tenants interleave in ONE result set — never grouped/split by
 * entity. Returns line_count (rating weight), dollar sums, pct_allowed (PCT_RATIO_SELECT), and the
 * resolved facility_name/facility_code (facility_code is the join key to the in-code city/state
 * lookup). ORDER BY is a DETERMINISTIC base (pct desc, facility) only — the FINAL rank is by `rating`
 * (app/lib/qualify/rating.ts), applied in the data loader (ruling Q-G). [from, to) is half-open.
 */
export function buildFacilityRankingQuery(
  payer: string,
  from: string,
  to: string,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildFacilityRankingQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const p = add(payer);
  const f = add(from);
  const t = add(to);
  const inner =
    'select facility, count(*)::int as line_count, ' +
    'sum(charge_amount)::float8 as billed, sum(allowed_amount)::float8 as allowed, ' +
    PCT_RATIO_SELECT + ' ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and primary_payer = ${p} ` +
    `and payment_received >= ${f}::date and payment_received < ${t}::date ` +
    "and facility is not null and btrim(facility) <> '' " +
    'group by facility';
  const sql =
    'select agg.facility, agg.line_count, agg.billed, agg.allowed, agg.pct_allowed, ' +
    'max(f.facility_name) as facility_name, ' +
    'max(coalesce(fe.facility_code, a.facility_code)) as facility_code ' +
    `from (${inner}) agg ` +
    FACILITY_DIM_JOINS +
    'group by agg.facility, agg.line_count, agg.billed, agg.allowed, agg.pct_allowed ' +
    'order by agg.pct_allowed desc nulls last, agg.facility';
  return { sql, params };
}

/**
 * The 15 most-recent DISTINCT patients (member_id_bidx) for the resolved payer, in-window,
 * cross-tenant. Per patient: the id of their MOST-RECENT charge (audited-reveal join key), that
 * charge's facility + resolved program (care_setting), last DOS (max charge_date), and per-patient
 * dollar-weighted pct_allowed + dollar sums. Recency ordering = max(payment_received) desc. NO cohort
 * floor (ruling Q-F: masked-by-default + audited reveal is the control). member_id_bidx is used only
 * for grouping — it is NEVER projected (opaque token stays server-side).
 */
export function buildCasesQuery(
  payer: string,
  from: string,
  to: string,
  entityIds: string[],
  limit: number = QUALIFY_CASES_LIMIT,
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildCasesQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const p = add(payer);
  const f = add(from);
  const t = add(to);
  const lim = add(limit);
  const inner =
    'select member_id_bidx, ' +
    '(array_agg(id order by payment_received desc nulls last, charge_date desc nulls last, id desc))[1] as id, ' +
    '(array_agg(facility order by payment_received desc nulls last, charge_date desc nulls last, id desc))[1] as facility, ' +
    "to_char(max(charge_date), 'YYYY-MM-DD') as last_dos, max(payment_received) as last_payment, " +
    'sum(charge_amount)::float8 as billed, sum(allowed_amount)::float8 as allowed, ' +
    PCT_RATIO_SELECT + ' ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and primary_payer = ${p} ` +
    `and payment_received >= ${f}::date and payment_received < ${t}::date ` +
    'group by member_id_bidx';
  // `agg` alias so FACILITY_DIM_JOINS (which references agg.facility) applies unchanged.
  const sql =
    'select agg.id, agg.facility, ' +
    'coalesce(max(f.facility_name), agg.facility) as facility_name, ' +
    'max(f.care_setting) as program, ' +
    'agg.last_dos, agg.pct_allowed, agg.billed, agg.allowed ' +
    `from (${inner}) agg ` +
    FACILITY_DIM_JOINS +
    'group by agg.id, agg.facility, agg.last_dos, agg.pct_allowed, agg.billed, agg.allowed, agg.last_payment ' +
    `order by agg.last_payment desc nulls last, agg.id desc limit ${lim}`;
  return { sql, params };
}

/**
 * FACILITY-SCOPED variant of buildCasesQuery: the 15 most-recent DISTINCT patients for the resolved
 * payer AT ONE FACILITY, in-window, cross-tenant. Identical grain, ordering, masking discipline, and
 * dimension enrichment as buildCasesQuery — the ONLY difference is the extra `and facility = $facility`
 * predicate in the inner aggregate. `facility` is the RAW rollup facility text (the same value
 * buildFacilityRankingQuery groups by, and the same value carried to the client as QualifyFacility.
 * facilityKey), NOT the resolved facility_code — a single code can alias multiple raw texts that rank
 * as SEPARATE cards, so scoping by raw text keeps each card's claim list grain-consistent with its rank.
 */
export function buildFacilityCasesQuery(
  payer: string,
  facility: string,
  from: string,
  to: string,
  entityIds: string[],
  limit: number = QUALIFY_CASES_LIMIT,
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildFacilityCasesQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const p = add(payer);
  const fac = add(facility);
  const f = add(from);
  const t = add(to);
  const lim = add(limit);
  const inner =
    'select member_id_bidx, ' +
    '(array_agg(id order by payment_received desc nulls last, charge_date desc nulls last, id desc))[1] as id, ' +
    '(array_agg(facility order by payment_received desc nulls last, charge_date desc nulls last, id desc))[1] as facility, ' +
    "to_char(max(charge_date), 'YYYY-MM-DD') as last_dos, max(payment_received) as last_payment, " +
    'sum(charge_amount)::float8 as billed, sum(allowed_amount)::float8 as allowed, ' +
    PCT_RATIO_SELECT + ' ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and primary_payer = ${p} and facility = ${fac} ` +
    `and payment_received >= ${f}::date and payment_received < ${t}::date ` +
    'group by member_id_bidx';
  // `agg` alias so FACILITY_DIM_JOINS (which references agg.facility) applies unchanged.
  const sql =
    'select agg.id, agg.facility, ' +
    'coalesce(max(f.facility_name), agg.facility) as facility_name, ' +
    'max(f.care_setting) as program, ' +
    'agg.last_dos, agg.pct_allowed, agg.billed, agg.allowed ' +
    `from (${inner}) agg ` +
    FACILITY_DIM_JOINS +
    'group by agg.id, agg.facility, agg.last_dos, agg.pct_allowed, agg.billed, agg.allowed, agg.last_payment ' +
    `order by agg.last_payment desc nulls last, agg.id desc limit ${lim}`;
  return { sql, params };
}

/**
 * Top PAYER movers by DISTINCT-PATIENT delta across two adjacent windows on payment_received,
 * cross-tenant (ruling Q-B, Option B). this=[thisFrom,thisTo), prior=[priorFrom,priorTo).
 * count(distinct member_id_bidx) dampens one-high-frequency-patient skew. Suppression:
 * this_patients >= minPatients AND this_charges >= minCharges (the charge floor so a
 * barely-above-patient-floor cohort with thin real volume can't top on a modest swing). Ranked by
 * SIGNED delta desc (biggest gainers first — "trending up"), tiebreak this_patients desc then payer.
 * Labeled by plaintext primary_payer (non-PHI); NO member-id-level data leaves. Floors are clamped so
 * a caller can only make suppression STRICTER.
 */
export function buildMoversQuery(
  thisFrom: string,
  thisTo: string,
  priorFrom: string,
  priorTo: string,
  entityIds: string[],
  opts: { minPatients?: number; minCharges?: number; topN?: number } = {},
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildMoversQuery');
  const minPatients = Math.max(QUALIFY_MOVERS_MIN_PATIENTS, opts.minPatients ?? QUALIFY_MOVERS_MIN_PATIENTS);
  const minCharges = Math.max(QUALIFY_MOVERS_MIN_CHARGES, opts.minCharges ?? QUALIFY_MOVERS_MIN_CHARGES);
  const topN = opts.topN ?? QUALIFY_MOVERS_TOP_N;
  const { params, add } = paramList();
  const e = add(ent);
  const tf = add(thisFrom);
  const tt = add(thisTo);
  const pf = add(priorFrom);
  const pt = add(priorTo);
  const minp = add(minPatients);
  const minc = add(minCharges);
  const lim = add(topN);
  // Scan ONCE across the union [priorFrom, thisTo); FILTER splits the two windows. The outer WHERE
  // uses CTE column names (aliases can't appear in HAVING, so the floor lives in the outer query).
  const sql =
    'with w as (' +
    'select primary_payer, ' +
    `count(distinct member_id_bidx) filter (where payment_received >= ${tf}::date and payment_received < ${tt}::date)::int as this_patients, ` +
    `count(distinct member_id_bidx) filter (where payment_received >= ${pf}::date and payment_received < ${pt}::date)::int as prior_patients, ` +
    `count(*) filter (where payment_received >= ${tf}::date and payment_received < ${tt}::date)::int as this_charges ` +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) ` +
    "and primary_payer is not null and btrim(primary_payer) <> '' " +
    `and payment_received >= ${pf}::date and payment_received < ${tt}::date ` +
    'group by primary_payer' +
    ') ' +
    'select primary_payer, this_patients, prior_patients, (this_patients - prior_patients) as delta_patients ' +
    'from w ' +
    `where this_patients >= ${minp} and this_charges >= ${minc} ` +
    `order by delta_patients desc, this_patients desc, primary_payer limit ${lim}`;
  return { sql, params };
}
