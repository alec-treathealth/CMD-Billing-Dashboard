/**
 * PAYER INTEL — pure SQL builders for the /payer-intel tab (2026-08-17 build), which merges the
 * Collections search engine with Qualify's ticker/rating surfaces on one page.
 *
 * ⚠ NAMING: "payer-intel" ALREADY means the monthly intel.* research cron in this repo
 * (app/api/cron/payer-intel + app/lib/payerIntelTrigger.ts). This module is the PAGE's query
 * layer and shares nothing with that pipeline — be explicit in PRs about which one is meant.
 *
 * Standing rules, all honored here: parameterized queries only (every identifier a fixed literal,
 * every value a $n bound param); aggregates read CMD_EXPLORER_CHARGE_ROLLUP, never the raw
 * snapshot table (~2.14 rows/charge — summing it reproduces the >100%-ratio bug); tenant scope is
 * always the first predicate via `assertEntityScope`; no PHI column is ever projected.
 *
 * DOLLAR POSTURE, per builder (R-AMOUNTS is enforced in the app core, but projection is the first
 * gate): the gainers rail projects NO dollar column (same posture as buildPolicyTapeQuery). The
 * decliners rail and placement table DO project dollar sums — they are stripped for
 * admissions_seat sessions at the core's single choke point, mirroring Qualify's
 * stripSnapshotAmounts pattern (module-private, applied LAST).
 */

import { assertEntityScope } from './entityScope.js';
import { QUALIFY_NO_FACILITY_SQL } from './qualifyFacilityPlaceholder.js';
import {
  CMD_EXPLORER_CHARGE_ROLLUP,
  PCT_RATIO_SELECT,
  cmdExplorerBaseConds,
  type CmdExplorerFilter,
  type ParamAdder,
} from './cmdExplorerQuery.js';
import { QUALIFY_TAPE_DELTA_DAYS, QUALIFY_TAPE_TOP_N } from './qualifyRatingHistory.js';

// ── Tunables ─────────────────────────────────────────────────────────────────────────────────────

/** Decliners rail: minimum drop in % collected (points over the window pair) before a facility is
 *  "losing ground". Spec-fixed at ≥5 pts / 90d; a smaller drop is noise at these line counts. */
export const PAYER_INTEL_DECLINE_THRESHOLD_PTS = 5;
/** Decliners rail window (days). Current window = trailing N; prior = the N before it. */
export const PAYER_INTEL_DECLINE_WINDOW_DAYS = 90;
/** Line floor, applied to BOTH windows: a facility thin in either one can manufacture a 40-point
 *  "decline" out of two claims. */
export const PAYER_INTEL_DECLINE_MIN_LINES = 3;

/**
 * The CLIENT floor a window must clear before this tab will put a score on it — SCALED BY THE
 * WINDOW, ruled by Alec 2026-08-17: "only 1 client in the time window if it's 7d, 2 if it's 14,
 * then 3 if it's 30d or beyond."
 *
 * The reasoning it encodes: a fixed floor asks a 7-day window to produce as many distinct clients
 * as a quarter, which at this book's scale means the short windows are structurally silent — the
 * measured shape is that a prefix is usually ONE PERSON, and the flat 5 this rail shipped with
 * suppressed most real movement rather than most noise. Scaling ties the confidence bar to how
 * much time the window actually had to accumulate people.
 *
 * Applies to BOTH rails (the decliners' two windows and the gainers' rating horizon), so the two
 * halves of the board agree on what "enough to score" means.
 *
 * ⚠ NOT the same knob as `COHORT_MIN_PATIENTS` (5, cmdExplorerQuery.ts) and it must not be
 * conflated with it: that one is a live SUPPRESSION floor on the Collections cohort curve — a
 * k-anonymity bound on a shipped production surface, not a display threshold. Lowering it shrinks
 * the smallest publishable bucket for every reader of that panel and needs its own ruling.
 */
export function payerIntelMinClientsFor(windowDays: number): number {
  if (!Number.isFinite(windowDays) || windowDays <= 7) return 1;
  if (windowDays <= 14) return 2;
  return 3;
}
/** Rail length bound. */
export const PAYER_INTEL_DECLINE_TOP_N = 12;

/** Placement table row bound — the roster is ~30 facilities; this is a defensive cap, not paging. */
export const PAYER_INTEL_PLACEMENT_MAX_ROWS = 50;

/** Charge-lines (CPT × revenue) table depth on the RESULT screen. */
export const PAYER_INTEL_COMBO_TOP_N = 12;

// ── 1. Policies gaining ground (IDLE rail #1) ────────────────────────────────────────────────────

/**
 * STRICTLY-GAINERS fork of `buildPolicyTapeQuery` (qualifyRatingHistory.ts).
 *
 * The shipped tape picks top-N by ABSOLUTE delta (Alec-ruled — "Policies on the Move" mixes both
 * directions) and must not change. This rail's contract is different: gainers only, biggest gain
 * first, so the fork (a) adds `cur.rating > prev.rating` and (b) orders the LIMIT by the SIGNED
 * delta. Filtering the shipped query's output would under-fill the rail in a decliner-heavy
 * period because its LIMIT runs before any sign filter.
 *
 * NON-DOLLAR projection by construction (the buildPolicyTapeQuery posture): the daily table
 * carries billed/allowed/paid and this select never touches them, so an admissions_seat session
 * receives identical bytes.
 */
export function buildPayerIntelGainersQuery(opts?: {
  deltaDays?: number;
  minMembers?: number;
  limit?: number;
}): { sql: string; params: unknown[] } {
  const deltaDays = Math.min(Math.max(Math.trunc(opts?.deltaDays ?? QUALIFY_TAPE_DELTA_DAYS), 1), 3650);
  // The window-scaled client floor (1 / 2 / 3 by horizon) — the SAME rule the decliners rail
  // applies, so the two halves of the board agree on what "enough to score" means. The shipped
  // Qualify tape keeps its flat QUALIFY_TAPE_MIN_MEMBERS; this is a fork, not an edit.
  const minMembers = Math.min(
    Math.max(Math.trunc(opts?.minMembers ?? payerIntelMinClientsFor(deltaDays)), 0),
    1000,
  );
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? QUALIFY_TAPE_TOP_N), 1), 100);
  // Same inner/outer split as the tape: the INNER order picks WHICH pairs ride (biggest gain
  // first); the OUTER re-sorts for reading (rating desc — scannable, the delta rides each card).
  const inner =
    'with latest as (select max(as_of_date) as d from collections.qualify_policy_rating_daily) ' +
    'select cur.member_id_prefix_bidx, ' +
    'right(cur.member_id_prefix_bidx, 6) as token_tail, ' +
    'e.echo, ' +
    'cur.primary_payer, ' +
    'cur.rating::int as rating_now, cur.band as band_now, ' +
    'prev.rating::int as rating_then, ' +
    '(cur.rating - prev.rating)::int as delta_pts, ' +
    'cur.distinct_members, cur.line_count, cur.window_days, ' +
    "to_char(l.d, 'YYYY-MM-DD') as as_of " +
    'from latest l ' +
    'join collections.qualify_policy_rating_daily cur on cur.as_of_date = l.d ' +
    'join collections.qualify_policy_rating_daily prev ' +
    'on prev.as_of_date = l.d - $1::int ' +
    'and prev.member_id_prefix_bidx = cur.member_id_prefix_bidx ' +
    'and prev.primary_payer = cur.primary_payer ' +
    'left join collections.qualify_prefix_echo e ' +
    'on e.member_id_prefix_bidx = cur.member_id_prefix_bidx ' +
    'where cur.rating is not null and prev.rating is not null ' +
    'and cur.rating > prev.rating ' +
    'and cur.distinct_members >= $2::int ' +
    'order by (cur.rating - prev.rating) desc, cur.rating desc, cur.primary_payer asc, cur.member_id_prefix_bidx asc ' +
    'limit $3::int';
  const sql =
    `select * from (${inner}) gainers ` +
    'order by gainers.rating_now desc, gainers.delta_pts desc, gainers.primary_payer asc, ' +
    'gainers.member_id_prefix_bidx asc';
  return { sql, params: [deltaDays, minMembers, limit] };
}

// ── 2. Facilities losing ground (IDLE rail #2) ───────────────────────────────────────────────────

/** One decliner row. `billed_current` is a DOLLAR SUM — core strips it for amounts-blind sessions.
 *  `decline_reason` does not exist here: NO server-side attribution logic exists in this repo
 *  (verified 2026-08-17), so per the build spec the tick renders WITHOUT a why-tag.
 *  TODO(payer-intel): decline_reason attribution (payer-mix shift / zero-paid concentration /
 *  thin volume) is a net-new analysis service — design it server-side; never fabricate client-side. */
export interface PayerIntelDeclinerRow {
  facility: string;
  facility_code: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
  /** % collected of billed (paid ÷ billed × 100, 2dp), per window. Payment-date windows — both
   *  endpoints aggregate PAYMENTS RECEIVED in the window, the house idiom (buildFacilityTrendQuery,
   *  buildBookKpisQuery), which sidesteps the claim-maturity distortion a service-date window has. */
  pct_current: number | null;
  pct_prior: number | null;
  /** cur − prior; ≤ −threshold by construction. */
  delta_pts: number;
  line_count: number;
  distinct_members: number;
  /** sum(charge_amount) in the CURRENT window — dollars; stripped for admissions_seat. */
  billed_current: number;
}

/**
 * Per-facility % collected of billed, trailing window vs the window before it, DECLINERS ONLY.
 *
 * Two window CTEs (one scan each — the buildBookKpisQuery "split the scans" lesson: a combined
 * count(distinct)+sums aggregate over the whole book spilled to disk at 1.8s) joined on facility,
 * then thresholded. Floors apply to BOTH windows so a facility thin in either cannot fake a cliff.
 * The 'No Facility' placeholder is excluded — a rail naming a place nobody was treated is noise
 * (same ruling as the tape context query, 2026-08-12).
 *
 * The facilities/aliases crosswalk (the FACILITY_DIM_JOINS shape, restated — this module does not
 * import qualifyQuery.ts, same boundary qualifyRatingHistory.ts keeps) resolves care_setting for
 * the tick's IP/OP tag; unmapped facilities ride with null rather than being dropped.
 */
export function buildFacilityDeclinersQuery(
  entityIds: string[],
  opts?: { windowDays?: number; thresholdPts?: number; limit?: number },
): { sql: string; params: unknown[] } {
  assertEntityScope(entityIds, 'payerIntelSearch.buildFacilityDeclinersQuery');
  const windowDays = Math.min(Math.max(Math.trunc(opts?.windowDays ?? PAYER_INTEL_DECLINE_WINDOW_DAYS), 7), 365);
  const thresholdPts = Math.min(Math.max(opts?.thresholdPts ?? PAYER_INTEL_DECLINE_THRESHOLD_PTS, 0), 100);
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? PAYER_INTEL_DECLINE_TOP_N), 1), 50);
  const windowAgg = (alias: string, fromExpr: string, toExpr: string) =>
    `${alias} as (` +
    'select facility, ' +
    'sum(charge_amount)::float8 as billed, ' +
    'sum(insurance_payments)::float8 as paid, ' +
    'count(*)::int as lines, ' +
    'count(distinct member_id_bidx)::int as members ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    'where business_entity_id = any($1::uuid[]) ' +
    `and payment_received >= ${fromExpr} and payment_received < ${toExpr} ` +
    "and facility is not null and btrim(facility) <> '' " +
    'and facility <> $3 ' +
    'group by facility)';
  const sql =
    'with ' +
    windowAgg('cur', "current_date - $2::int", 'current_date') +
    ', ' +
    windowAgg('prior', "current_date - ($2::int * 2)", 'current_date - $2::int') +
    ', paired as (' +
    'select cur.facility, cur.billed, cur.lines, cur.members, ' +
    'case when cur.billed > 0 then round((cur.paid / cur.billed * 100)::numeric, 2)::float8 end as pct_current, ' +
    'case when prior.billed > 0 then round((prior.paid / prior.billed * 100)::numeric, 2)::float8 end as pct_prior ' +
    'from cur join prior on prior.facility = cur.facility ' +
    'where cur.lines >= $4::int and prior.lines >= $4::int ' +
    'and cur.members >= $5::int and prior.members >= $5::int' +
    ') ' +
    'select p.facility, ' +
    'coalesce(fe.facility_code, a.facility_code) as facility_code, ' +
    'f.care_setting, ' +
    'p.pct_current, p.pct_prior, ' +
    'round((p.pct_current - p.pct_prior)::numeric, 1)::float8 as delta_pts, ' +
    'p.lines as line_count, p.members as distinct_members, ' +
    'p.billed as billed_current ' +
    'from paired p ' +
    'left join collections.facilities fe on upper(fe.facility_name) = upper(p.facility) ' +
    'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(p.facility) ' +
    'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, a.facility_code) ' +
    'where p.pct_current is not null and p.pct_prior is not null ' +
    'and (p.pct_prior - p.pct_current) >= $6 ' +
    'order by (p.pct_current - p.pct_prior) asc, p.billed desc ' +
    'limit $7::int';
  return {
    sql,
    params: [
      entityIds,
      windowDays,
      QUALIFY_NO_FACILITY_SQL,
      PAYER_INTEL_DECLINE_MIN_LINES,
      // Window-SCALED, not a constant: 1 client at 7d, 2 at 14d, 3 at 30d and beyond (the
      // 2026-08-17 ruling on payerIntelMinClientsFor). Both windows must clear it.
      payerIntelMinClientsFor(windowDays),
      thresholdPts,
      limit,
    ],
  };
}

// ── 3. Placement table (RESULT: "Where this policy places") ─────────────────────────────────────

/** One placement row: this SEARCH's cohort at one facility. Dollar fields (`paid_per_patient`,
 *  `billed`) are stripped for amounts-blind sessions at the core choke point. */
export interface PayerIntelPlacementRow {
  facility: string;
  facility_code: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
  line_count: number;
  distinct_members: number;
  /** % collected of billed for THIS cohort at THIS facility (paid ÷ billed × 100, 2dp). */
  pct_collected: number | null;
  /** sum(insurance_payments) ÷ distinct members — dollars/patient, trailing window. */
  paid_per_patient: number | null;
  billed: number;
}

/**
 * Per-facility aggregates for the ACTIVE SEARCH — composes the Collections engine's shared WHERE
 * (`cmdExplorerBaseConds`) so every facet (payer / employer_names / funding / prefix / group-#
 * token / dates / row_ids) means exactly what it means on the grid, then groups by facility.
 *
 * ⚠ row_ids EMPTY-ARRAY CONTRACT (the gap found 2026-08-17): the SHARED builder deliberately
 * treats `row_ids: []` as absent, so THIS builder re-implements the action-layer half locally —
 * a PRESENT-but-empty array emits a literal `false` predicate. A name-search that matched nothing
 * must aggregate nothing, never widen to the whole book. Callers that pre-check emptiness get the
 * same rows either way; callers that forget are safe by construction here.
 */
export function buildPayerIntelPlacementQuery(
  filter: CmdExplorerFilter,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  assertEntityScope(entityIds, 'payerIntelSearch.buildPayerIntelPlacementQuery');
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = cmdExplorerBaseConds(filter, entityIds, add);
  if (Array.isArray(filter.row_ids) && filter.row_ids.length === 0) conds.push('false');
  conds.push("facility is not null and btrim(facility) <> ''");
  conds.push(`facility <> ${add(QUALIFY_NO_FACILITY_SQL)}`);
  const sql =
    'with agg as (' +
    'select facility, ' +
    'count(*)::int as line_count, ' +
    'count(distinct member_id_bidx)::int as distinct_members, ' +
    'sum(charge_amount)::float8 as billed, ' +
    'sum(insurance_payments)::float8 as paid ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where ${conds.join(' and ')} ` +
    'group by facility' +
    ') ' +
    'select agg.facility, ' +
    'coalesce(fe.facility_code, al.facility_code) as facility_code, ' +
    'f.care_setting, ' +
    'agg.line_count, agg.distinct_members, ' +
    'case when agg.billed > 0 then round((agg.paid / agg.billed * 100)::numeric, 2)::float8 end as pct_collected, ' +
    'case when agg.distinct_members > 0 then round((agg.paid / agg.distinct_members)::numeric, 2)::float8 end as paid_per_patient, ' +
    'agg.billed ' +
    'from agg ' +
    'left join collections.facilities fe on upper(fe.facility_name) = upper(agg.facility) ' +
    'left join collections.cmd_facility_aliases al on upper(al.facility_text) = upper(agg.facility) ' +
    'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, al.facility_code) ' +
    'order by pct_collected desc nulls last, agg.billed desc ' +
    `limit ${add(PAYER_INTEL_PLACEMENT_MAX_ROWS)}`;
  return { sql, params };
}

/**
 * Distinct members across the WHOLE selection — its own scan, never folded into the totals
 * aggregate (the buildBookKpisQuery lesson: count(distinct)+sums in one aggregate spilled to disk,
 * 1.8s vs 152ms). Same shared WHERE + same present-but-empty row_ids hardening as the placement
 * builder.
 */
export function buildPayerIntelDistinctMembersQuery(
  filter: CmdExplorerFilter,
  entityIds: string[],
): { sql: string; params: unknown[] } {
  assertEntityScope(entityIds, 'payerIntelSearch.buildPayerIntelDistinctMembersQuery');
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = cmdExplorerBaseConds(filter, entityIds, add);
  if (Array.isArray(filter.row_ids) && filter.row_ids.length === 0) conds.push('false');
  return {
    sql:
      'select count(distinct member_id_bidx)::int as members ' +
      `from ${CMD_EXPLORER_CHARGE_ROLLUP} where ${conds.join(' and ')}`,
    params,
  };
}

// ── 4. Charge lines (RESULT: CPT × revenue rollup, with zero-paid) ──────────────────────────────

/** CmdComboGroup plus the zero-paid share the mockup's table carries and the AI payload needs. */
export interface PayerIntelComboRow {
  cpt: string | null;
  revenue: string | null;
  count: number;
  charge: number;
  pct_allowed: number | null;
  pct_paid: number | null;
  pct_zero_paid: number;
}

/**
 * The search's CPT×revenue rollup — `buildCmdSearchSummaryQueries`' combo query plus a zero-paid
 * share per bucket (count of lines with no positive insurance payment ÷ lines). Same
 * PCT_RATIO_SELECT ratios (dollar-weighted, guarded denominators — the pct_paid floor is a ruled
 * product decision, untouched). Same row_ids empty-array hardening as the placement builder.
 */
export function buildPayerIntelComboQuery(
  filter: CmdExplorerFilter,
  entityIds: string[],
  topN: number = PAYER_INTEL_COMBO_TOP_N,
): { sql: string; params: unknown[] } {
  assertEntityScope(entityIds, 'payerIntelSearch.buildPayerIntelComboQuery');
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = cmdExplorerBaseConds(filter, entityIds, add);
  if (Array.isArray(filter.row_ids) && filter.row_ids.length === 0) conds.push('false');
  const sql =
    'select cpt_code as cpt, revenue_code as revenue, count(*)::int as count, ' +
    'coalesce(sum(charge_amount), 0)::float8 as charge, ' +
    PCT_RATIO_SELECT +
    ', ' +
    'round(count(*) filter (where coalesce(insurance_payments, 0) <= 0)::numeric / count(*) * 100, 2)::float8 as pct_zero_paid ' +
    `from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where ${conds.join(' and ')} ` +
    `group by cpt_code, revenue_code order by charge desc nulls last, count desc limit ${add(Math.min(Math.max(Math.trunc(topN), 1), 50))}`;
  return { sql, params };
}

// ── 5. Policy rating for the RESULT hero ─────────────────────────────────────────────────────────

export interface PayerIntelRatingRow {
  rating: number | null;
  as_of: string;
  /** The D-deltaDays rating when that exact snapshot row exists — the hero's "prior run" context. */
  rating_then: number | null;
}

/**
 * The hero's policy rating, read from the SAME nightly table the tape reads (mig 0093) — never
 * recomputed interactively, so the hero and the rails can't disagree about a pair.
 *
 * Two subject shapes, the buildWatcherSeriesQuery precedent:
 *   · token + payer → the pair's own latest rating, verbatim;
 *   · payer only    → the LINE-WEIGHTED mean across that payer's rated pairs on the latest date
 *     (weighted, not flat — a 3-member pair and a 300-line pair are not the same evidence).
 * Ratings only; the dollar columns beside them are never projected.
 */
export function buildPayerIntelRatingQuery(
  token: string | null,
  payer: string,
  deltaDays: number = QUALIFY_TAPE_DELTA_DAYS,
): { sql: string; params: unknown[] } {
  const clamped = Math.min(Math.max(Math.trunc(deltaDays), 1), 3650);
  if (token !== null) {
    return {
      sql:
        'with latest as (select max(as_of_date) as d from collections.qualify_policy_rating_daily) ' +
        'select cur.rating::int as rating, ' +
        "to_char(l.d, 'YYYY-MM-DD') as as_of, " +
        'prev.rating::int as rating_then ' +
        'from latest l ' +
        'join collections.qualify_policy_rating_daily cur ' +
        'on cur.as_of_date = l.d and cur.member_id_prefix_bidx = $1 and cur.primary_payer = $2 ' +
        'left join collections.qualify_policy_rating_daily prev ' +
        'on prev.as_of_date = l.d - $3::int ' +
        'and prev.member_id_prefix_bidx = cur.member_id_prefix_bidx ' +
        'and prev.primary_payer = cur.primary_payer',
      params: [token, payer, clamped],
    };
  }
  return {
    sql:
      'with latest as (select max(as_of_date) as d from collections.qualify_policy_rating_daily) ' +
      'select ' +
      '(sum(cur.rating * cur.line_count)::numeric / nullif(sum(cur.line_count), 0))::int as rating, ' +
      "to_char(max(l.d), 'YYYY-MM-DD') as as_of, " +
      'null::int as rating_then ' +
      'from latest l ' +
      'join collections.qualify_policy_rating_daily cur ' +
      'on cur.as_of_date = l.d and cur.primary_payer = $1 ' +
      'where cur.rating is not null',
    params: [payer],
  };
}

// ── 6. Saved / recent searches (0104 columns) ────────────────────────────────────────────────────

export interface PayerIntelSavedSearchRow {
  id: string | number; // bigint arrives as a STRING from node-pg (pg-bigint-reads-as-string)
  payer_label: string | null;
  prefix_echo: string | null;
  plan_class: string | null;
  entity_type: string | null;
  resolved: boolean | null;
  starred: boolean;
  searched_at: string;
}

/** The 0104 starred-search caps, mirrored as constants so tests can assert them against the
 *  definer's literals instead of letting the two drift (the QUALIFY_WATCHER_MAX pattern). */
export const PAYER_INTEL_STARRED_MAX = 12;
export const PAYER_INTEL_RECENT_MAX = 20;

/**
 * A user's saved searches: EVERY starred row plus the newest unstarred, one round trip. The UI
 * splits on `starred`. App-layer user scoping (0046 model: the WHERE is the scope; the Server
 * Action passes its own authenticated uid, never client input).
 */
export function buildPayerIntelSavedSearchesQuery(userId: string): { sql: string; params: unknown[] } {
  return {
    sql:
      'select id, payer_label, prefix_echo, plan_class, entity_type, resolved, starred, ' +
      "to_char(searched_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as searched_at " +
      'from claims.qualify_recent_search where app_user_id = $1::uuid ' +
      'order by starred desc, searched_at desc, id desc limit $2::int',
    params: [userId, PAYER_INTEL_STARRED_MAX + PAYER_INTEL_RECENT_MAX],
  };
}

// ── 7. Census strip read ─────────────────────────────────────────────────────────────────────────

export interface PayerIntelCensusRowRaw {
  facility_code: string;
  board_family: string | null;
  admitted_count: number | null;
  open_beds: number | null;
  bed_capacity: number | null;
  synced_at: string | null;
}

/**
 * The census strip's read — distinct from `buildQualifyCensusReadQuery` (qualifyCensus.ts), which
 * serves the RATING factor and therefore projects auth/LOS and not `admitted_count`/`synced_at`.
 * This strip needs occupancy (admitted ÷ capacity) and an as-of stamp, and nothing else.
 *
 * Semantics the UI must honor (0078/0088 census contract): outpatient rows carry
 * `bed_capacity = NULL` and `open_beds = 0` meaning "beds do not apply" — never "full".
 * PENDING ADMITS ARE NOT STORED ANYWHERE (only 'Admitted' and 'Open Bed*' statuses survive
 * `aggregateCensusItems`) — the app-side census provider returns `pendingAdmits: null` and the
 * UI renders an honest em dash. Wiring it means a Monday aggregation change + a column migration,
 * NOT a client-side guess.
 */
export function buildPayerIntelCensusQuery(): { sql: string; params: unknown[] } {
  return {
    sql:
      'select facility_code, board_family, admitted_count, open_beds, bed_capacity, ' +
      "to_char(synced_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as synced_at " +
      'from collections.qualify_facility_census',
    params: [],
  };
}

// ── 8. Facility roster names (census strip + placement display) ─────────────────────────────────

export interface PayerIntelFacilityNameRow {
  facility_code: string;
  facility_name: string;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

/** facility_code → display name + care setting, whole roster (small table, whole read). */
export function buildPayerIntelFacilityNamesQuery(): { sql: string; params: unknown[] } {
  return {
    sql: 'select facility_code, facility_name, care_setting from collections.facilities',
    params: [],
  };
}
