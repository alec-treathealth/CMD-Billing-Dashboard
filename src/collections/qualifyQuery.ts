/**
 * Qualify — PURE SQL builders (no I/O; hermetically testable). The read layer behind the Qualify
 * contract (getQualifySnapshot / getQualifyMovers). Mirrors the discipline of cmdExplorerQuery.ts:
 * every value is a bound $n param, every identifier a fixed literal, all aggregate reads go through
 * the 0050 charge-grain rollup (NEVER raw cmd_explorer_rows — that grain double-counts ~2.14×), and
 * the ranking's dollar-weighted ratio rates on the 0059 `allowed_reliable` evidence
 * (RANKING_RELIABLE_SELECT below) — deliberately NOT the shared PCT_RATIO_SELECT, which still sums
 * the netted `allowed_amount` for its own consumers (combo/cohort; their repoint is a separate diff).
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
 * member_id_prefix_bidx); raw PHI never reaches this module. Those blind indexes are matched in a WHERE
 * (movers still group by member_id_bidx for distinct-patient counts) but are NEVER projected to the caller
 * (opaque token stays server-side); a claim row carries the rollup `id` (the real cmd_explorer_rows id) so
 * the audited reveal can join back. Dollar columns are returned raw — the amounts-capability gate strips
 * them in the action layer (single choke point), never here.
 */
import { assertEntityScope } from './entityScope.js';
import { CMD_EXPLORER_CHARGE_ROLLUP, type ParamAdder } from './cmdExplorerQuery.js';

/** A member-id EXACT match vs a 3-letter alpha-PREFIX match — sniffed server-side, never client-declared. */
export type QualifyMatchKind = 'member_id' | 'prefix';

/** Safety CAP for the facility recent-claims drill (claim grain). The drill is (facility, payer, window)-
 *  bounded — a bounded set, not an unbounded scan — so it returns the WHOLE window, not a keyset page. This
 *  is only a backstop: a facility with more than QUALIFY_CASES_MAX in-window claims is truncated to the most
 *  recent (by payment date) and the UI shows an honest "narrow the window" nudge (the `capped` flag). No
 *  cohort floor — mask + per-patient audited reveal is the PHI control. */
export const QUALIFY_CASES_MAX = 500;

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
  care_setting: 'IP' | 'OP' | 'BOTH' | null; // resolved dimension level-of-care; null when unresolved
  line_count: number; // ALL in-window logical charge lines (volume context: floor + "limited data") — NOT tier-filtered
  confirmed_claims: number; // count of tiers a/cd/e1 (SQL mirror of confidence.ts — parity-tested)
  estimate_claims: number; // count of tier e2
  unknown_claims: number; // count of tiers b/none — the three sum to line_count
  billed: number | null; // sum(charge_amount), ALL lines — stripped in the action for admissions_seat
  allowed: number | null; // sum(allowed_reliable) EXCLUDING tier e2 (0059 evidence sum; null when zero reliable evidence) — stripped for admissions_seat
  pct_allowed: number | null; // dollar-weighted reliable-allowed/billed, 0-100 (guarded); null → neutral rating
}
export interface QualifyClaimRow {
  id: number; // rollup id of THIS charge — drives the audited reveal join
  /** Opaque keyed-HMAC member token — SERVER-SIDE ONLY: the core collapses it to a per-response
   *  ordinal patientKey and NEVER forwards it to the client (wire-tested in qualifyCore.test.ts). */
  member_id_bidx: string | null;
  facility: string;
  facility_name: string | null;
  primary_payer: string | null; // THIS claim's primary_payer (non-PHI); the payer chip/label
  program: 'IP' | 'OP' | 'BOTH' | null; // := resolved care_setting; null when facility text unresolved (Q-D)
  dos: string | null; // THIS claim's charge_date (service date) — display only (per-claim, not a max)
  payment_date: string | null; // THIS claim's payment_received — the SORT axis + a displayed column (day-grain 'YYYY-MM-DD')
  pct_allowed: number | null; // per-claim reliable-allowed/billed (materialized 0059 pct_allowed; NULL = unknown, never 0%)
  billed: number | null;
  allowed: number | null; // per-claim 0059 allowed_reliable (tiered; e2's latest-positive KEPT on this display surface)
  allowed_tier: string | null; // raw 0059 tier — the core collapses it via confidenceOf (never sent to the client raw)
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
 * The RANKING's reliable-evidence ratio (0059 repoint, ruling Q2a 2026-07-22) — the rating fix.
 *
 * `allowed` = sum of the materialized `allowed_reliable` EXCLUDING tier 'e2' — the tier filter, NOT
 * a bare non-null check: e2 (restated, nothing reconciles) carries a non-null latest-positive value
 * whose pct can exceed 100%, and the value-first rating's clamp0to100 (rating.ts) would silently
 * turn that into a false "Strong" green in the exact surface admissions acts on. The grid keeps
 * showing e2 unclamped (X's deliberate tell) — the exclusion is rating-evidence-only.
 *
 * e2 thereby behaves like the existing unknown tiers (b/none): its charge_amount stays in the billed
 * denominator, it contributes no allowed — an e2-heavy (reversal-chaos) facility rates LOW, not
 * falsely green (the conservative failure direction for an admissions decision). A facility with
 * ZERO reliable evidence gets a NULL numerator → NULL pct → NEUTRAL badge, never 0% → danger.
 * Displayed allowed ÷ displayed billed == displayed pct (internally consistent card).
 *
 * Deliberately NOT PCT_RATIO_SELECT: that shared select still sums the netted `allowed_amount` and
 * carries the pct_paid 2%/$100 floor — both stay with the combo/cohort consumers until their own
 * repoint diff (the floor re-ruling is DEFERRED until real allowed_reliable numbers exist). The
 * ranking never consumed pct_paid, so none is computed here.
 */
const RANKING_RELIABLE_SELECT =
  "(sum(allowed_reliable) filter (where allowed_tier <> 'e2'))::float8 as allowed, " +
  'case when sum(charge_amount) > 0 then ' +
  "round((sum(allowed_reliable) filter (where allowed_tier <> 'e2')) / sum(charge_amount) * 100, 2)::float8 " +
  'end as pct_allowed';

/**
 * Per-facility dollar-weighted RELIABLE allowed/billed for the resolved payer, windowed on
 * payment_received, cross-tenant. Facilities from BOTH tenants interleave in ONE result set — never
 * grouped/split by entity. Returns line_count (ALL in-window lines — volume context, not
 * tier-filtered), billed (all lines), allowed + pct_allowed (RANKING_RELIABLE_SELECT above — the
 * 0059 `allowed_reliable` evidence, tier e2 excluded), and the resolved facility_name/facility_code
 * (facility_code is the join key to the in-code city/state lookup). ORDER BY is a DETERMINISTIC
 * base (pct desc, facility) only — the FINAL rank is by `rating` (app/lib/qualify/rating.ts),
 * applied in the data loader (ruling Q-G). [from, to) is half-open.
 *
 * DISPLAY DELTA (by design, ruled): e1 charges (netted-sum-reconciles) contribute the netted sum —
 * a DIFFERENT number than BUILD X's latest-positive — so facility allowed/pct values shift for the
 * 5,412 e1 charges' facilities vs the pre-0059 panel. That is the fix, not a regression.
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
  // Coverage triple (0059 trust signal): the three FILTER sets are the SQL MIRROR of
  // confidence.ts's buckets (confirmed = a/cd/e1 · estimate = e2 · unknown = b/none) — SQL cannot
  // import TS, so test/qualifyConfidence.test.ts asserts the two stay in lockstep. They sum to
  // line_count (the tier taxonomy is exhaustive). Counts only — no ratio/rating math changes here.
  const inner =
    'select facility, count(*)::int as line_count, ' +
    "count(*) filter (where allowed_tier in ('a','cd','e1'))::int as confirmed_claims, " +
    "count(*) filter (where allowed_tier = 'e2')::int as estimate_claims, " +
    "count(*) filter (where allowed_tier in ('b','none'))::int as unknown_claims, " +
    'sum(charge_amount)::float8 as billed, ' +
    RANKING_RELIABLE_SELECT + ' ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and primary_payer = ${p} ` +
    `and payment_received >= ${f}::date and payment_received < ${t}::date ` +
    "and facility is not null and btrim(facility) <> '' " +
    'group by facility';
  const sql =
    'select agg.facility, agg.line_count, agg.confirmed_claims, agg.estimate_claims, agg.unknown_claims, ' +
    'agg.billed, agg.allowed, agg.pct_allowed, ' +
    'max(f.facility_name) as facility_name, ' +
    'max(f.care_setting) as care_setting, ' +
    'max(coalesce(fe.facility_code, a.facility_code)) as facility_code ' +
    `from (${inner}) agg ` +
    FACILITY_DIM_JOINS +
    'group by agg.facility, agg.line_count, agg.confirmed_claims, agg.estimate_claims, agg.unknown_claims, ' +
    'agg.billed, agg.allowed, agg.pct_allowed ' +
    'order by agg.pct_allowed desc nulls last, agg.facility';
  return { sql, params };
}

/**
 * Fix A landing lookup: the RAW facility text of the searched identifier's MOST-RECENT in-window claim under
 * the resolved payer, cross-tenant. Returns 0 or 1 row. Scoped by `primary_payer = $payer` so the returned
 * facility is guaranteed non-empty under the single-payer desktop drill. The blind-index column matches the
 * sniffed kind (exact → member_id_bidx; prefix → member_id_prefix_bidx) — the SAME columns the drill/resolve
 * use; no new mint. NO floor here — the CORE drops the candidate if it isn't a ranked (floor-clearing) facility
 * (approach ii), so this stays a single indexed lookup and the floor logic lives in ONE place (assembleFacilities).
 *
 * ORDER BY IS BYTE-IDENTICAL to buildFacilityCasesQuery's claim ordering (`agg.payment_date =
 * to_char(payment_received) desc nulls last, agg.id desc`): here `payment_received desc nulls last, id desc`.
 * payment_received is a DATE (0019 — day-grain), so the 'YYYY-MM-DD' text the drill orders on is lexical ==
 * chronological == the raw column order here — the two select the EXACT same "most recent" claim, and the
 * landed facility can never disagree with the drill's top claim. This axis change (charge_date → payment_received)
 * is the point: the window is already payment_received, so BOTH surfaces now rank on the same axis. LOCKSTEP —
 * the parity test (qualifyQuery.test.ts) asserts both order on payment_received; keep them moving together.
 */
export function buildIdentifierLandingFacilityQuery(
  token: string,
  kind: QualifyMatchKind,
  payer: string,
  from: string,
  to: string,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildIdentifierLandingFacilityQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const p = add(payer);
  const f = add(from);
  const t = add(to);
  const col = kind === 'member_id' ? 'member_id_bidx' : 'member_id_prefix_bidx';
  const tok = add(token);
  const sql =
    'select facility ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and primary_payer = ${p} ` +
    `and payment_received >= ${f}::date and payment_received < ${t}::date ` +
    `and ${col} = ${tok} ` +
    "and facility is not null and btrim(facility) <> '' " +
    'order by payment_received desc nulls last, id desc ' +
    'limit 1';
  return { sql, params };
}

/**
 * FACILITY-SCOPED recent CLAIMS for the resolved payer AT ONE FACILITY, in-window, cross-tenant. CLAIM
 * GRAIN (Direction B, ruling 1): ONE row per charge from the 0050 rollup — NO member_id_bidx dedup — so a
 * patient with several claims shows each one; per-claim DOS = that charge's own charge_date (not a max);
 * per-claim allowed = the 0059 `allowed_reliable` and pct_allowed = the materialized 0059 ratio (repoint ②
 * — restated charges now show the adjudicated/reconciling value, not the netted sum: the 133.88% fixture
 * reads 33.88%; e1 claims show the reconciling netted sum; e2 stays visible unfiltered). `facility` is the RAW
 * rollup facility text (the same value buildFacilityRankingQuery groups by, and carried to the client as
 * QualifyFacility.facilityKey), NOT the resolved facility_code — a single code can alias multiple raw texts
 * that rank as SEPARATE cards, so scoping by raw text keeps each card's claim list grain-consistent with its
 * rank. NO cohort floor (masked-by-default + audited reveal is the control).
 *
 * IDENTIFIER NARROW (Direction B): the searched identifier (or the manual prefix input) narrows the rows to
 * that member exactly — `member_id_bidx = $tok` (exact member-id search) or `member_id_prefix_bidx = $tok`
 * (≤3 alpha prefix). Mutually exclusive; `memberToken` (exact) wins if both are somehow set. The token is
 * opaque (HMAC'd upstream); a term mapping to a different payer simply yields 0 rows (NEVER re-resolves). A
 * charge-grain rollup index rides these columns, so the equality lives in the WHERE (no GROUP BY now).
 */
export function buildFacilityCasesQuery(
  payer: string,
  facility: string,
  from: string,
  to: string,
  entityIds: string[],
  opts: {
    /** Opaque member_id_prefix_bidx token (already HMAC'd upstream) — adds a STARTS-WITH prefix narrow. */
    prefixToken?: string | null;
    /** Opaque member_id_bidx token (already HMAC'd upstream) — adds an EXACT member-id narrow (wins over prefix). */
    memberToken?: string | null;
    /** Opaque group_number_bidx token (already HMAC'd upstream) — EXACT group-number narrow (the employer
     *  proxy; Phase 2). Composable: ANDs with the member narrows rather than competing with them. */
    groupToken?: string | null;
    /** Safety cap (default QUALIFY_CASES_MAX). The query OVER-FETCHES by one (binds limit+1) so the caller
     *  detects truncation (`capped`) from the extra row, never a count. NO keyset cursor — the drill returns
     *  the whole (facility, payer, window) set in one shot (bounded), ordered payment_date desc. */
    limit?: number;
    /** ALL-PAYERS view (mobile detail sheet): drop the `primary_payer = $payer` filter so EVERY payer's
     *  claims at the facility come back (each row tagged with its own primary_payer). `payer` is then
     *  UNUSED here (not bound). Blank payers are excluded so every row groups under a real payer chip. */
    allPayers?: boolean;
  } = {},
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildFacilityCasesQuery');
  const { params, add } = paramList();
  const e = add(ent);
  // Single-payer drill (desktop) binds + filters on the resolved payer; the all-payers drill (mobile)
  // filters it out entirely and only excludes blank payers. `payer` is bound ONLY on the single-payer path
  // so an unused bind never reaches Postgres.
  const payerCond = opts.allPayers
    ? " and primary_payer is not null and btrim(primary_payer) <> ''"
    : ` and primary_payer = ${add(payer)}`;
  const fac = add(facility);
  const f = add(from);
  const t = add(to);
  // Identifier narrow (inner WHERE): exact member wins over prefix (mutually exclusive in practice). Both
  // ride a charge-grain rollup index; the token is opaque (HMAC'd upstream), never the raw term.
  const idCond = opts.memberToken
    ? ` and member_id_bidx = ${add(opts.memberToken)}`
    : opts.prefixToken
      ? ` and member_id_prefix_bidx = ${add(opts.prefixToken)}`
      : '';
  // Group-number narrow (EXACT; the employer proxy) — independent of the member narrow, so both can apply.
  const grpCond = opts.groupToken ? ` and group_number_bidx = ${add(opts.groupToken)}` : '';
  // CLAIM GRAIN: one row per charge (the 0050 rollup is already charge-grain, so no aggregation) — the outer
  // GROUP BY agg.id only collapses FACILITY_DIM_JOINS fan-out (facility_name is not unique-constrained).
  const inner =
    // member_id_bidx rides to the SERVER CORE only (per-response patientKey aliasing) — the token is
    // dropped in assembleClaims and never reaches the client (wire-tested).
    'select id, member_id_bidx, facility, primary_payer, ' +
    // BOTH dates are DISPLAYED: dos = charge_date (service date); payment_date = payment_received (the
    // SORT axis — the window is already payment_received, so ordering by it makes the axis visible + the
    // list order consistent with the window). Both 'YYYY-MM-DD' text; payment_received is a DATE (0019).
    "to_char(charge_date, 'YYYY-MM-DD') as dos, " +
    "to_char(payment_received, 'YYYY-MM-DD') as payment_date, " +
    // 0059 repoint ②: per-claim allowed = the materialized tiered `allowed_reliable` (a value CMD
    // actually adjudicated — never the restatement-summed netted total this read before), and pct =
    // the materialized `pct_allowed` (0059 computes the IDENTICAL round(allowed/charge*100,2) with the
    // same >0 + non-null guards — NULL when allowed is unknown, never 0%). NO allowed_tier filter here:
    // this is a DISPLAY surface, so e2's latest-positive stays visible (X's tell; the e2 exclusion is
    // rating-evidence-only, ruling Q2a — see RANKING_RELIABLE_SELECT above).
    'charge_amount::float8 as billed, allowed_reliable::float8 as allowed, ' +
    // allowed_tier rides along RAW for the core's confidenceOf collapse (contract carries only the
    // derived confidence — the six-value tier vocabulary never reaches the client).
    'pct_allowed::float8 as pct_allowed, allowed_tier ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[])${payerCond} and facility = ${fac} ` +
    `and payment_received >= ${f}::date and payment_received < ${t}::date` +
    idCond +
    grpCond;
  // NO keyset cursor: the drill returns the WHOLE (facility, payer, window) set in one shot (bounded). We
  // OVER-FETCH by one (limit+1) purely so the caller detects truncation at the QUALIFY_CASES_MAX safety cap
  // (the `capped` flag) from the extra row — never a count.
  const lim = add((opts.limit ?? QUALIFY_CASES_MAX) + 1);
  // `agg` alias so FACILITY_DIM_JOINS (which references agg.facility) applies unchanged. ORDER BY the
  // PAYMENT date (payment_date = payment_received, the window axis) so the list reads most-recently-paid
  // first; the safety cap therefore keeps the MOST RECENT when a facility exceeds it. dos (service date)
  // rides along as a displayed column.
  const sql =
    'select agg.id, agg.member_id_bidx, agg.facility, agg.primary_payer, ' +
    'coalesce(max(f.facility_name), agg.facility) as facility_name, ' +
    'max(f.care_setting) as program, ' +
    'agg.dos, agg.payment_date, agg.pct_allowed, agg.billed, agg.allowed, agg.allowed_tier ' +
    `from (${inner}) agg ` +
    FACILITY_DIM_JOINS +
    'group by agg.id, agg.member_id_bidx, agg.facility, agg.primary_payer, agg.dos, agg.payment_date, agg.pct_allowed, agg.billed, agg.allowed, agg.allowed_tier ' +
    `order by agg.payment_date desc nulls last, agg.id desc limit ${lim}`;
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
