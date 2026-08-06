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
import {
  CMD_EXPLORER_CHARGE_ROLLUP,
  buildVobMarketSemiJoin,
  cmdExplorerBaseConds,
  type CmdExplorerFilter,
  type ParamAdder,
  type VobMarketFilter,
} from './cmdExplorerQuery.js';

/** A member-id EXACT match vs a 3-letter alpha-PREFIX match — sniffed server-side, never client-declared. */
export type QualifyMatchKind = 'member_id' | 'prefix';

/** Every PHI blind-index a RESOLUTION can equality-match on: the two member kinds + the exact
 *  client-name token (Change C, migration 0066/0067). The raw term is HMAC'd upstream — only the
 *  opaque token and this kind label reach the builders. */
export type QualifyTokenKind = QualifyMatchKind | 'client_name';

/** kind → the rollup blind-index COLUMN it matches (fixed literals — never caller-supplied). */
const TOKEN_COLUMN: Record<QualifyTokenKind, string> = {
  member_id: 'member_id_bidx',
  prefix: 'member_id_prefix_bidx',
  client_name: 'patient_name_bidx',
};

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
  distinct_patients: number; // count(distinct member_id_bidx) in-window — the sample-gate unit (rating suppression, hotfix 2026-07-27); the token is COUNTED, never projected
  confirmed_claims: number; // count of tiers a/cd/e1 (SQL mirror of confidence.ts — parity-tested)
  estimate_claims: number; // count of tier e2
  unknown_claims: number; // count of tiers b/none — the three sum to line_count
  billed: number | null; // sum(charge_amount), ALL lines — stripped in the action for admissions_seat
  allowed: number | null; // sum(allowed_reliable) EXCLUDING tier e2 (0059 evidence sum; null when zero reliable evidence) — stripped for admissions_seat
  pct_allowed: number | null; // dollar-weighted reliable-allowed/billed, 0-100 (guarded); null → neutral rating
  /** The other two KPI-tile metrics, per facility — the worst/best FLANKS the tiles bracket their
   *  headline with (2026-08-04). Computed by the SAME expressions buildBookKpisQuery uses, so a flank
   *  and the headline above it are the same measurement. PERCENTAGES ONLY (never the payment sum), so
   *  they survive the amounts strip and blind/sighted roles derive identical flanks. OPTIONAL so
   *  pre-existing fixtures/loaders stay valid; consumers coalesce to null. */
  pct_paid_of_allowed?: number | null;
  pct_paid_of_billed?: number | null;
  /** v2 TTP factor input: median (payment_received − charge_date) in days over the in-window rows.
   *  NON-DOLLAR (a day count). Paid-lines-only by construction — the window is payment-dated, so
   *  unresolved claims are structurally absent from this axis (the factor detail discloses it).
   *  OPTIONAL so pre-v2 fixtures/loaders remain valid; consumers coalesce to null. */
  median_days_to_payment?: number | null;
  entity_ids: string[]; // distinct tenant uuid(s) backing this facility — core maps to a BXR/Indigo/Mixed label
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

/** The `totals` row shape of Collections' `buildCmdSearchSummaryQueries` (the compose-bar live match
 *  count). Qualify consumes ONLY this row (not the grouped aggregates); the CORE derives the two
 *  percentages then strips the raw dollar sums for non-amounts viewers (the one choke point). */
export interface QualifyMatchSummaryRow {
  total_count: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  total_balance: number;
}

/** The distinct-CLIENT evidence count for the composed match (readout gauge). ONE row. */
export interface QualifyMatchClientCountRow {
  distinct_patients: number;
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
  kind: QualifyTokenKind,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildResolvePayerQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const tok = add(token);
  const col = TOKEN_COLUMN[kind];
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

/** One payer behind a token, with the evidence supporting it. Plaintext primary_payer is non-PHI
 *  (same class as QualifyMover.label), so unlike the VOB employer spread this IS wire-safe. */
export interface QualifyPayerSpreadRow {
  primary_payer: string;
  lines: number;
  patients: number;
  last_payment: string | null; // ISO date of the most recent payment_received, or null
}

/** Hard cap on payers returned. MEASURED 2026-08-06: the busiest prefix bills under 17 distinct
 *  payers, so 25 clears the live maximum with headroom and still bounds a pathological future row. */
export const QUALIFY_PAYER_SPREAD_LIMIT = 25;

/**
 * EVERY payer behind a token, ranked — the widened form of buildResolvePayerQuery.
 *
 * WHY: buildResolvePayerQuery computes exactly this ranking and then throws all but the top row away
 * with `limit 1`. MEASURED live 2026-08-06 over the whole rollup (2,665 prefixes carrying claims,
 * 491,905 lines): 44.9% of those prefixes bill under MORE THAN ONE payer, and weighted by member —
 * how a real card-in-hand search samples — that is **80.6% of searches**, against 82.1% of all
 * charge lines. Max 17 payers on a single prefix. So for four searches in five, `limit 1` silently
 * discards real billing history the user came to find, and the surface reports a single payer as
 * though it were the answer.
 *
 * Identical semantics to buildResolvePayerQuery otherwise — same UNWINDOWED posture (identity is
 * recognized if the token appears at ANY time), same tenancy scope, same dominance ordering — so row
 * [0] of this result is byte-identical to what that builder returns. It is a widening, not a
 * redefinition, and the two must not drift: test/qualifyPolicyQuery.test.ts pins that agreement.
 *
 * `last_payment` rides along so a disambiguation UI can rank recency against volume without a second
 * query; it is a date, never an amount, so it is identical for an admissions_seat session.
 */
export function buildResolvePayerSpreadQuery(
  token: string,
  kind: QualifyTokenKind,
  entityIds: string[],
  limit: number = QUALIFY_PAYER_SPREAD_LIMIT,
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildResolvePayerSpreadQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const tok = add(token);
  const col = TOKEN_COLUMN[kind];
  // Integer-clamped and interpolated, never a bound param — see QUALIFY_SPREAD_LIMIT's note.
  const lim = Math.max(1, Math.min(200, Math.trunc(limit)));
  const sql =
    'select primary_payer, count(*)::int as lines, ' +
    'count(distinct member_id_bidx)::int as patients, ' +
    "to_char(max(payment_received), 'YYYY-MM-DD') as last_payment " +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and ${col} = ${tok} ` +
    "and primary_payer is not null and btrim(primary_payer) <> '' " +
    'group by primary_payer ' +
    // The SAME ordering as buildResolvePayerQuery, so row [0] agrees with the narrow resolve exactly.
    'order by count(*) desc, max(payment_received) desc nulls last, primary_payer ' +
    `limit ${lim}`;
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
 * repoint diff (the floor re-ruling is DEFERRED until real allowed_reliable numbers exist).
 *
 * PAID RATIOS (2026-08-04, Alec's ask: the KPI tiles show worst/best FACILITY flanks on all three
 * metrics, so each facility must carry all three). The two `pct_paid_*` expressions are BYTE-FOR-BYTE
 * the ones `buildBookKpisQuery` computes — same numerator (`sum(insurance_payments)`), same reliable
 * denominator, same guard, same rounding. That is the point: a flank must be the same measurement as
 * the headline it brackets, or the tile's parts contradict its whole. A parity test asserts the two
 * builders keep emitting identical expressions.
 *
 * NON-DOLLAR: only the PERCENTAGES are projected, never `sum(insurance_payments)` itself — so these
 * survive the amounts strip and an admissions_seat derives identical flanks to a super_admin. Cost is
 * one more aggregate over rows the query already scans (no new join, no new predicate).
 */
const RANKING_RELIABLE_SELECT =
  "(sum(allowed_reliable) filter (where allowed_tier <> 'e2'))::float8 as allowed, " +
  'case when sum(charge_amount) > 0 then ' +
  "round((sum(allowed_reliable) filter (where allowed_tier <> 'e2')) / sum(charge_amount) * 100, 2)::float8 " +
  'end as pct_allowed, ' +
  "case when (sum(allowed_reliable) filter (where allowed_tier <> 'e2')) > 0 then " +
  "round(sum(insurance_payments) / (sum(allowed_reliable) filter (where allowed_tier <> 'e2')) * 100, 2)::float8 " +
  'end as pct_paid_of_allowed, ' +
  'case when sum(charge_amount) > 0 then ' +
  'round(sum(insurance_payments) / sum(charge_amount) * 100, 2)::float8 ' +
  'end as pct_paid_of_billed';

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
  /** The resolved payer, OR NULL for the v2 COMPARABLE-COHORT ranking (Phase B): a no-claims policy
   *  ranks facilities over its employer/funding cohort (the `market` semi-join) across ALL payers —
   *  the cohort IS the policy's behavioral peer group, so no payer clause is emitted. Callers must
   *  pass a market narrow whenever payer is null (an unscoped null would rank the whole book); the
   *  cores enforce that. */
  payer: string | null,
  from: string,
  to: string,
  entityIds: string[],
  market: VobMarketFilter = {},
  token: string | null = null,
  kind: QualifyTokenKind | null = null,
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildFacilityRankingQuery');
  // Fail-closed at the CHOKEPOINT (the assertEntityScope pattern): a null payer with no market
  // narrow would silently rank the whole book through the comparable path (review finding #5).
  if (payer === null && !(market.employers?.length || market.funding?.length)) {
    throw new Error('buildFacilityRankingQuery: payer=null (cohort mode) requires a non-empty market narrow');
  }
  const { params, add } = paramList();
  const e = add(ent);
  const payerCond = payer !== null ? `and primary_payer = ${add(payer)} ` : '';
  const f = add(from);
  const t = add(to);
  // Optional IDENTIFIER narrow: a prefix/member/client-name search scopes the ranking to that
  // identifier's FOOTPRINT — only facilities that billed it in-window rank, and each facility's
  // line_count / billed / allowed / pct are computed over ONLY the matched rows (applied inside the
  // per-facility aggregate below, so the returned facility SET and every count follow). The blind-index
  // column is a fixed literal from TOKEN_COLUMN (never caller text); the token is a bound param. Both
  // null (the by-payer resolve path) = the payer-wide ranking, byte-for-byte unchanged. Hits the rollup's
  // member_id_bidx / member_id_prefix_bidx index (0059) — additive to the existing payer+window filter,
  // so it only narrows the scan (never a regression).
  const idNarrow = token && kind ? `and ${TOKEN_COLUMN[kind]} = ${add(token)} ` : '';
  // VOB employer/funding market narrow (semi-join; no-VOB excluded when active). Same helper the
  // collections grid uses, so the two surfaces filter the market identically.
  const mj = buildVobMarketSemiJoin(market, add);
  // Coverage triple (0059 trust signal): the three FILTER sets are the SQL MIRROR of
  // confidence.ts's buckets (confirmed = a/cd/e1 · estimate = e2 · unknown = b/none) — SQL cannot
  // import TS, so test/qualifyConfidence.test.ts asserts the two stay in lockstep. They sum to
  // line_count (the tier taxonomy is exhaustive). Counts only — no ratio/rating math changes here.
  const inner =
    'select facility, count(*)::int as line_count, ' +
    // distinct patients backing this facility slice — the rating sample gate's unit (hotfix
    // 2026-07-27). member_id_bidx is an opaque keyed-HMAC token: COUNTED here, NEVER projected (no
    // PHI leaves), exactly like the movers query's distinct-patient floor.
    'count(distinct member_id_bidx)::int as distinct_patients, ' +
    "count(*) filter (where allowed_tier in ('a','cd','e1'))::int as confirmed_claims, " +
    "count(*) filter (where allowed_tier = 'e2')::int as estimate_claims, " +
    "count(*) filter (where allowed_tier in ('b','none'))::int as unknown_claims, " +
    'sum(charge_amount)::float8 as billed, ' +
    // v2 TTP factor: median service→payment days over the in-window (paid) rows. A day count, not a
    // dollar — survives the amounts strip. charge_date can be null on degenerate rows → FILTERed out.
    'percentile_cont(0.5) within group (order by (payment_received - charge_date)::float8) ' +
    'filter (where charge_date is not null and payment_received is not null)::float8 as median_days_to_payment, ' +
    // entity_ids: the distinct tenant(s) whose rows back this facility card. The core maps it to a
    // small non-PHI 'BXR' / 'Indigo' / 'Mixed' LABEL — never used to GROUP or SPLIT (cross-tenant
    // interleave stays; grouping-by-entity is banned). A facility text under both tenants → 'Mixed'.
    'array_agg(distinct business_entity_id::text) as entity_ids, ' +
    RANKING_RELIABLE_SELECT + ' ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) ` +
    payerCond +
    `and payment_received >= ${f}::date and payment_received < ${t}::date ` +
    "and facility is not null and btrim(facility) <> '' " +
    idNarrow +
    (mj ? `and ${mj} ` : '') +
    'group by facility';
  const sql =
    'select agg.facility, agg.line_count, agg.distinct_patients, agg.confirmed_claims, agg.estimate_claims, agg.unknown_claims, ' +
    'agg.billed, agg.allowed, agg.pct_allowed, agg.pct_paid_of_allowed, agg.pct_paid_of_billed, ' +
    'agg.median_days_to_payment, agg.entity_ids, ' +
    'max(f.facility_name) as facility_name, ' +
    'max(f.care_setting) as care_setting, ' +
    'max(coalesce(fe.facility_code, a.facility_code)) as facility_code ' +
    `from (${inner}) agg ` +
    FACILITY_DIM_JOINS +
    'group by agg.facility, agg.line_count, agg.distinct_patients, agg.confirmed_claims, agg.estimate_claims, agg.unknown_claims, ' +
    'agg.billed, agg.allowed, agg.pct_allowed, agg.pct_paid_of_allowed, agg.pct_paid_of_billed, ' +
    'agg.median_days_to_payment, agg.entity_ids ' +
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
  kind: QualifyTokenKind,
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
  const col = TOKEN_COLUMN[kind];
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
 * COMPOSED recent CLAIMS for a filter SET (the compose-bar model), in-window, cross-tenant. CLAIM GRAIN
 * (Direction B, ruling 1): ONE row per charge from the 0050 rollup — NO member_id_bidx dedup — so a
 * patient with several claims shows each one; per-claim DOS = that charge's own charge_date (not a max);
 * per-claim allowed = the 0059 `allowed_reliable`, pct_allowed = the materialized 0059 ratio (e2 stays
 * visible unfiltered — display surface). `facility` is the RAW rollup facility text (the join key the
 * ranking groups by / QualifyFacility.facilityKey), never the facility_code.
 *
 * FILTER PREDICATE: adopts Collections' shared `cmdExplorerBaseConds` (facility[] / primary_payers[] /
 * employer+funding VOB semi-join / [from,to) window / member+prefix+group blind-index equality) — the
 * SAME predicate the Collections grid + summary use, so the two surfaces filter identically. Qualify
 * CONSUMES it (never forks it) and passes its cross-tenant [BXR, Indigo] entity array exactly where
 * Collections passes one tenant. The single-facility / single-payer drill (desktop rows, mobile detail)
 * is just a one-element `facility` / `primary_payers` array. The SELECT, masking columns, and
 * payment-date ordering below are Qualify's own — only the WHERE is shared.
 */
export function buildFacilityCasesQuery(
  filter: CmdExplorerFilter,
  entityIds: string[],
  opts: {
    /** Opaque patient_name_bidx token (Change C) — the EXACT client-name narrow. CmdExplorerFilter.phiIndex
     *  carries no patientNameBidx (Collections has no name search), so this is Qualify's OWN extra AND rather
     *  than a fork of the shared builder — the PERMANENT shape of Qualify's admissions-first name divergence.
     *  Dormant until QUALIFY_CLIENT_NAME_ENABLED flips. */
    nameToken?: string | null;
    /** ALL-PAYERS view (mobile detail sheet): the filter carries NO primary_payers, so drop the payer
     *  restriction but still exclude blank payers so every row groups under a real payer chip. */
    allPayers?: boolean;
    /** Safety cap (default QUALIFY_CASES_MAX). OVER-FETCHES by one (binds limit+1) so the caller detects
     *  truncation (`capped`) from the extra row, never a count. NO keyset cursor — the whole set in one shot. */
    limit?: number;
  } = {},
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildFacilityCasesQuery');
  const { params, add } = paramList();
  // Adopt Collections' shared filter-predicate builder for the WHERE — Qualify CONSUMES it, never forks
  // it. cmdExplorerBaseConds emits the tenant scope FIRST as any($ent::uuid[]); Qualify passes its
  // cross-tenant array exactly where Collections passes one tenant.
  const conds = cmdExplorerBaseConds(filter, ent, add);
  // Qualify-owned EXTRA ANDs cmdExplorerBaseConds does not express (permanent, by design):
  //  - patient_name_bidx: Qualify's admissions-first client-name narrow (Change C). No patientNameBidx in
  //    CmdExplorerFilter.phiIndex (Collections has no name search) → ANDed here, not a builder fork.
  if (opts.nameToken) conds.push(`patient_name_bidx = ${add(opts.nameToken)}`);
  //  - all-payers view: the filter omits primary_payers, so exclude only blank payers.
  if (opts.allPayers) conds.push("primary_payer is not null and btrim(primary_payer) <> ''");
  const where = conds.join(' and ');
  // NO keyset cursor: the whole composed set in one shot (bounded). OVER-FETCH by one (limit+1) so the
  // caller detects truncation at the QUALIFY_CASES_MAX safety cap (`capped`) from the extra row.
  const lim = add((opts.limit ?? QUALIFY_CASES_MAX) + 1);
  // CLAIM GRAIN: one row per charge (the 0050 rollup is already charge-grain). The outer GROUP BY agg.id
  // only collapses FACILITY_DIM_JOINS fan-out (facility_name is not unique-constrained). member_id_bidx
  // rides to the SERVER CORE only (per-response patientKey aliasing) — dropped in assembleClaims, never
  // sent to the client (wire-tested). allowed_tier rides raw for the core's confidenceOf collapse.
  const inner =
    'select id, member_id_bidx, facility, primary_payer, ' +
    "to_char(charge_date, 'YYYY-MM-DD') as dos, " +
    "to_char(payment_received, 'YYYY-MM-DD') as payment_date, " +
    'charge_amount::float8 as billed, allowed_reliable::float8 as allowed, ' +
    'pct_allowed::float8 as pct_allowed, allowed_tier ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where ${where}`;
  // `agg` alias so FACILITY_DIM_JOINS (which references agg.facility) applies unchanged. ORDER BY the
  // PAYMENT date (the window axis) so the list reads most-recently-paid first; the safety cap keeps the
  // MOST RECENT when the set exceeds it. dos (service date) rides along as a displayed column.
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
 * COMPOSED distinct-CLIENT count — the readout EVIDENCE gauge's number, over the SAME filter set as the
 * live "N charge lines match" count, so the gauge and the count describe the identical population.
 *
 * Qualify-OWNED, deliberately SEPARATE from Collections' `buildCmdSearchSummaryQueries`: that shared
 * `totals` builder is patient-count-blind and Collections consumes it, so it MUST NOT be edited to add a
 * count. Instead this ANDs the SAME shared `cmdExplorerBaseConds` predicate (CONSUMED, never forked —
 * exactly the buildFacilityCasesQuery pattern) and counts distinct clients. `member_id_bidx` is an opaque
 * keyed-HMAC token: COUNTED here, NEVER projected (no PHI leaves). Charge-grain 0050 rollup only.
 *
 * NAME-BLIND, same as the match count: `cmdExplorerBaseConds` cannot express `patient_name_bidx`, so
 * when QUALIFY_CLIENT_NAME_ENABLED flips (Part 2) BOTH this and the summary count will need the name AND
 * added in lockstep — else the gauge and count would over-count a name-narrowed search. Harmless today.
 */
export function buildQualifyMatchClientCountQuery(
  filter: CmdExplorerFilter,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildQualifyMatchClientCountQuery');
  const { params, add } = paramList();
  const conds = cmdExplorerBaseConds(filter, ent, add);
  const sql =
    'select count(distinct member_id_bidx)::int as distinct_patients ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where ${conds.join(' and ')}`;
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
  opts: { minPatients?: number; minCharges?: number; topN?: number; market?: VobMarketFilter } = {},
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
  // VOB employer/funding market narrow — scopes the whole two-window population before the payer
  // rollup (semi-join; no-VOB members excluded when active).
  const mj = buildVobMarketSemiJoin(opts.market ?? {}, add);
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
    (mj ? `and ${mj} ` : '') +
    'group by primary_payer' +
    ') ' +
    'select primary_payer, this_patients, prior_patients, (this_patients - prior_patients) as delta_patients ' +
    'from w ' +
    `where this_patients >= ${minp} and this_charges >= ${minc} ` +
    `order by delta_patients desc, this_patients desc, primary_payer limit ${lim}`;
  return { sql, params };
}

// ── Redesign overview aggregates (book KPIs + per-facility rating trend) ──────────────────────────
// Both read the SAME 0059 charge rollup the ranking does (grain-safe, cross-tenant); both return
// ONLY percentages / ratings — dollars are summed inside SQL and never projected, so an
// admissions_seat consumes them unchanged. The reliable-allowed evidence excludes tier 'e2' exactly
// like RANKING_RELIABLE_SELECT (ruling Q2a) so the rating scale is identical everywhere.

/** Book-wide KPI row (percentages only — the underlying dollar sums never leave SQL). */
export interface QualifyBookKpisRow {
  pct_allowed_of_billed: number | null; // reliable allowed (ex-e2) ÷ billed — the contract rate
  pct_paid_of_allowed: number | null; // insurance_payments ÷ reliable allowed — collection yield on allowed
  pct_paid_of_billed: number | null; // insurance_payments ÷ billed — net realization
  distinct_patients: number; // count(distinct member_id_bidx) in the slice — the tile sample-gate unit (Phase 2); COUNTED, never projected
}

/**
 * DESIGN B ORIENTATION SCOPE (Phase 2, ruling 2026-07-27) — the ONLY shape the KPI-tile aggregate
 * accepts. It is a `Pick` of `CmdExplorerFilter` restricted to **payer + facility + window** and
 * STRUCTURALLY cannot carry `employers`/`funding` (or cpt/phi/q). That is the whole enforcement of the
 * Design B asymmetry: employer + funding narrow the match count + cases list (per-row facts, truthful
 * at any n), but they must NEVER scope the tiles/ratings — employer shreds a slice to ~1 distinct
 * patient (measured), and a rating on 1 patient is noise. Widening this to a full `CmdExplorerFilter`
 * is a loud, deliberate type change AND trips the employer-absent regression test in qualifyQuery.test.ts.
 */
export type QualifyOrientationScope = Pick<CmdExplorerFilter, 'facility' | 'primary_payers' | 'from' | 'to'>;

/**
 * KPI percentages for the composed orientation slice (payer + facility + window), cross-tenant. Derived
 * IN-PLANE from the charge rollup (insurance_payments = the per-charge max payer payment; allowed_reliable
 * ex-e2; charge_amount) — NO external collections join. Each ratio is guarded (>0 denominator) and rounds
 * to 2 dp; a collapsed denominator yields NULL (never a coerced 0%). One row out.
 *
 * SCOPE is a `QualifyOrientationScope` (payer + facility + window only) fed through the SHARED
 * `cmdExplorerBaseConds` — the same predicate the grid/summary/cases use, so it emits the cross-tenant
 * `business_entity_id = any($ent::uuid[])` FIRST and handles facility[]/primary_payers[]/window
 * identically. Because the scope TYPE has no employer/funding fields, `cmdExplorerBaseConds` never emits
 * a VOB market semi-join here — Design B asymmetry enforced by construction, not by call-site discipline.
 * Returns the three ratios PLUS `distinct_patients` (the tile sample gate); dollars are summed inside
 * SQL and NEVER projected, so an admissions_seat consumes this unchanged.
 */
export function buildBookKpisQuery(
  scope: QualifyOrientationScope,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildBookKpisQuery');
  const { params, add } = paramList();
  // Shared predicate (cross-tenant array first). `scope` cannot express employer/funding, so no market
  // semi-join is emitted — the Design B asymmetry is structural. Do NOT swap this for a full filter.
  const where = cmdExplorerBaseConds(scope, ent, add).join(' and ');
  const reliable = "sum(allowed_reliable) filter (where allowed_tier <> 'e2')";
  const sql =
    'select ' +
    `case when sum(charge_amount) > 0 then round((${reliable}) / sum(charge_amount) * 100, 2)::float8 end as pct_allowed_of_billed, ` +
    `case when (${reliable}) > 0 then round(sum(insurance_payments) / (${reliable}) * 100, 2)::float8 end as pct_paid_of_allowed, ` +
    'case when sum(charge_amount) > 0 then round(sum(insurance_payments) / sum(charge_amount) * 100, 2)::float8 end as pct_paid_of_billed, ' +
    // Tile sample gate (Phase 2): distinct patients in the slice. member_id_bidx is COUNTED, never
    // projected (no PHI leaves) — mirrors the ranking + movers discipline.
    'count(distinct member_id_bidx)::int as distinct_patients ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where ${where}`;
  return { sql, params };
}

/** Number of evenly-spaced sub-window buckets in a facility sparkline (fixed so density is consistent
 *  across 30/60/90 and calendar windows — weekly buckets would give only ~4 points at 30d). */
export const QUALIFY_TREND_BUCKETS = 8;
/** Default "Facilities Heating Up" size (top-N by rating delta). 15 — the ticker is a continuous
 *  marquee, so more cards just make a longer, richer loop (was 8). */
export const QUALIFY_TREND_TOP_N = 15;
/** Trend floor — a facility needs at least this many CURRENT-window lines to rank (kills 1–2-line
 *  flukes). Mirrors rating.ts QUALIFY_MIN_LINES; kept as a local literal so this src/ module never
 *  imports from app/ (the dependency points the wrong way). Keep the two values in lockstep. */
export const QUALIFY_TREND_MIN_LINES = 3;
/** DELTA gate (Phase 2, ruling 2026-07-27): a card needs at least this many DISTINCT PATIENTS in BOTH
 *  the current AND the prior sub-window to rank — else its "biggest improver" delta is computed on
 *  noise (measured: under a single payer only ~13% of slices clear >=5 both sides). Mirrors the movers
 *  patient discipline (5). Cards failing it are DROPPED rather than ranked on a noisy delta — including
 *  NEW facilities (no prior window), which cannot show a trustworthy improvement. Book-wide, rich
 *  facilities clear it easily; it bites only the thin (payer-scoped) slices it is meant to protect. */
export const QUALIFY_TREND_MIN_PATIENTS = 5;

/** Per-facility trend row (ratings only — no dollars projected). */
export interface QualifyFacilityTrendRow {
  facility: string; // raw rollup facility text (the join key / QualifyFacility.facilityKey)
  facility_name: string | null;
  facility_code: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
  dominant_payer: string | null; // top payer by reliable ALLOWED $ in-window — the Heating-Up hybrid resolve target
  entity_ids: string[]; // distinct business_entity_id(s) of the current-window rows → BXR/Indigo/Mixed label
  line_count: number; // ALL current-window charge lines backing the rating (the UI's defined "n")
  cur_rating: number | null; // current-window reliable allowed% (ex-e2), 0-100
  prior_rating: number | null; // prior equal-window rating (null → no prior evidence, a NEW facility)
  points: number[]; // per-bucket ratings, oldest→newest; thin buckets dropped (never fabricated)
}

/**
 * Per-facility rating TREND + prior-window delta, cross-tenant — powers the "Facilities Heating Up"
 * cards + their sparklines. ONE scan over [priorFrom, to): the prior window is exactly the rows with
 * payment_received < from (priorTo == from, adjacent windows). Per facility it returns the
 * current-window rating, the prior-window rating (for the delta the caller computes), the dominant
 * payer (the payer bringing the most reliable ALLOWED dollars at this facility in-window — the hybrid
 * click target; ties fall back to line count then name), a small entity-id set (→ BXR/Indigo/Mixed
 * label), the current-window line_count
 * (the "n"), and `points` — the current window sliced into QUALIFY_TREND_BUCKETS even sub-windows,
 * each a reliable allowed% (thin buckets dropped so no point is fabricated). Floor: only facilities
 * with >= QUALIFY_MIN_LINES current-window lines AND >= QUALIFY_TREND_MIN_PATIENTS distinct patients in
 * BOTH windows rank (kills 1–2-line flukes AND noisy-delta thin slices; see the constant). ORDER BY the
 * rating delta desc (biggest improvers first). Optional single-payer scope (`payer`): fed only when
 * exactly one payer is selected (Design B — the ticker is book-wide-within-payer); omitted = book-wide.
 * DESIGN B: NO market (employer/funding) scope — the type carries none, so the ticker can never be
 * employer/funding-narrowed (that shreds the delta before it shreds the rating).
 */
export function buildFacilityTrendQuery(
  from: string,
  to: string,
  priorFrom: string,
  entityIds: string[],
  opts: { payer?: string | null; buckets?: number; minLines?: number; minPatients?: number; topN?: number } = {},
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildFacilityTrendQuery');
  const buckets = Math.max(1, Math.min(24, Math.trunc(opts.buckets ?? QUALIFY_TREND_BUCKETS)));
  const minLines = Math.max(QUALIFY_TREND_MIN_LINES, Math.trunc(opts.minLines ?? QUALIFY_TREND_MIN_LINES));
  const minPatients = Math.max(QUALIFY_TREND_MIN_PATIENTS, Math.trunc(opts.minPatients ?? QUALIFY_TREND_MIN_PATIENTS));
  const topN = Math.max(1, Math.trunc(opts.topN ?? QUALIFY_TREND_TOP_N));
  const { params, add } = paramList();
  const e = add(ent);
  const pf = add(priorFrom);
  const f = add(from);
  const t = add(to);
  const payerCond = opts.payer ? ` and primary_payer = ${add(opts.payer)}` : '';
  const nb = add(buckets);
  const ml = add(minLines);
  const mp = add(minPatients);
  const lim = add(topN);
  const reliable = (pfx: string) => `sum(allowed_reliable) filter (where ${pfx}allowed_tier <> 'e2')`;
  // span: one scan over [priorFrom, to). is_cur splits the current window ([from, to)) from the prior
  // ([priorFrom, from) == the adjacent prior window). Facility text is filtered non-blank here.
  // member_id_bidx rides along ONLY to be COUNTED (the delta gate) — never projected to the caller.
  const span =
    'select facility, primary_payer, business_entity_id, member_id_bidx, charge_amount, allowed_reliable, allowed_tier, ' +
    `(payment_received >= ${f}::date) as is_cur, ` +
    // bucket index over the CURRENT window only (0..nb-1); null for prior rows.
    `case when payment_received >= ${f}::date then ` +
    `least(${nb} - 1, greatest(0, floor(${nb}::float8 * (payment_received - ${f}::date) / nullif(${t}::date - ${f}::date, 0))::int)) end as bkt ` +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) ` +
    `and payment_received >= ${pf}::date and payment_received < ${t}::date ` +
    "and facility is not null and btrim(facility) <> ''" +
    payerCond;
  // fac: per-facility current + prior aggregates + entity set + BOTH-window distinct-patient counts
  // (the delta gate). member_id_bidx is COUNTED here, never projected.
  const fac =
    'select facility, ' +
    'count(*) filter (where is_cur)::int as line_count, ' +
    'count(distinct member_id_bidx) filter (where is_cur)::int as cur_patients, ' +
    'count(distinct member_id_bidx) filter (where not is_cur)::int as prior_patients, ' +
    'array_agg(distinct business_entity_id::text) filter (where is_cur) as entity_ids, ' +
    `case when sum(charge_amount) filter (where is_cur) > 0 then round((${reliable('is_cur and ')}) / sum(charge_amount) filter (where is_cur) * 100, 2)::float8 end as cur_rating, ` +
    `case when sum(charge_amount) filter (where not is_cur) > 0 then round((${reliable('not is_cur and ')}) / sum(charge_amount) filter (where not is_cur) * 100, 2)::float8 end as prior_rating ` +
    'from span group by facility';
  // pay/dom: DOMINANT PAYER = the payer bringing the most reliable ALLOWED dollars (ex-e2) at the
  // facility in the CURRENT window — the Heating-Up hybrid resolve target. `distinct on (facility)` +
  // `allowed_sum desc nulls last` picks that payer; ties (or an all-e2 facility with no reliable
  // allowed → null sums) fall back to line count, then payer name, so the choice is deterministic and
  // a facility that serves several payers still resolves to a real one.
  const pay =
    'select facility, primary_payer, ' +
    `sum(allowed_reliable) filter (where allowed_tier <> 'e2') as allowed_sum, ` +
    'count(*)::int as pay_lines ' +
    "from span where is_cur and primary_payer is not null and btrim(primary_payer) <> '' " +
    'group by facility, primary_payer';
  const dom =
    'select distinct on (facility) facility, primary_payer as dominant_payer ' +
    'from pay order by facility, allowed_sum desc nulls last, pay_lines desc, primary_payer';
  // bkt_agg: per-facility current-window sparkline — per-bucket rating, thin buckets dropped, oldest→newest.
  const bktAgg =
    'select facility, ' +
    'array_remove(array_agg(bkt_rating order by bkt), null) as points ' +
    'from (select facility, bkt, ' +
    "case when sum(charge_amount) > 0 and sum(allowed_reliable) filter (where allowed_tier <> 'e2') is not null " +
    "then round((sum(allowed_reliable) filter (where allowed_tier <> 'e2')) / sum(charge_amount) * 100, 2)::float8 end as bkt_rating " +
    'from span where is_cur group by facility, bkt) b group by facility';
  const sql =
    `with span as (${span}), fac as (${fac}), pay as (${pay}), dom as (${dom}), bkt_agg as (${bktAgg}) ` +
    'select agg.facility, agg.line_count, agg.dominant_payer, agg.entity_ids, agg.cur_rating, agg.prior_rating, ' +
    "coalesce(agg.points, array[]::float8[]) as points, " +
    'max(f.facility_name) as facility_name, ' +
    'max(f.care_setting) as care_setting, ' +
    'max(coalesce(fe.facility_code, a.facility_code)) as facility_code ' +
    'from (select fac.*, dom.dominant_payer, bkt_agg.points from fac left join dom using (facility) left join bkt_agg using (facility)) agg ' +
    FACILITY_DIM_JOINS +
    // line floor (fluke-killer) AND the both-window distinct-patient delta gate (Phase 2): both
    // sub-windows must carry >= mp patients or the "improver" delta is noise. cur/prior_patients are
    // used ONLY here (pre-GROUP BY), never projected — so no GROUP BY entry is needed for them.
    `where agg.line_count >= ${ml} and agg.cur_patients >= ${mp} and agg.prior_patients >= ${mp} ` +
    'group by agg.facility, agg.line_count, agg.dominant_payer, agg.entity_ids, agg.cur_rating, agg.prior_rating, agg.points ' +
    'order by (agg.cur_rating - agg.prior_rating) desc nulls last, agg.cur_rating desc nulls last, agg.facility ' +
    `limit ${lim}`;
  return { sql, params };
}
