/**
 * Qualify v2 — POLICY RESOLUTION + AUTO-WINDOW SQL builders (pure; no I/O; hermetically testable).
 * Phase B/E of qualify-v2-build-plan: the alpha prefix IS the policy — resolve what is already on
 * file behind it (vob.member_benefits_latest) and decide the evidence window with ONE bucketed
 * query instead of five sequential probes.
 *
 * PHI DISCIPLINE (same as qualifyQuery.ts): identity enters ONLY as an opaque keyed-HMAC blind-index
 * token. vob.member_benefits_latest carries NO readable prefix column — member_id_prefix_bidx is the
 * match key (verified live 2026-08-03; any code naming `alpha_prefix` fails at runtime). Tokens are
 * matched in WHERE clauses and NEVER projected. The policy aggregate returns plan-level facts
 * (carrier / employer / funding / plan type), a presence flag for the group number (the raw group
 * exists only as a blind index and is unrecoverable by design), and dates — no member-level row.
 *
 * The VOB set is Indigo-sourced and carries no business_entity_id — the collections market semi-join
 * (buildVobMarketSemiJoin) already reads it unscoped from both-tenant sessions; these builders follow
 * that established posture. The claims-side rungs query IS tenant-scoped like every rollup read.
 */
import { assertEntityScope } from './entityScope.js';
import { CMD_EXPLORER_CHARGE_ROLLUP } from './cmdExplorerQuery.js';
import type { QualifyTokenKind } from './qualifyQuery.js';

export const VOB_MEMBER_BENEFITS_LATEST = 'vob.member_benefits_latest';

/** kind → blind-index column on the VOB matview (fixed literals; prefix + exact member only —
 *  the matview has no name index, so 'client_name' is deliberately unsupported here). */
const VOB_TOKEN_COLUMN: Record<Exclude<QualifyTokenKind, 'client_name'>, string> = {
  member_id: 'member_id_bidx',
  prefix: 'member_id_prefix_bidx',
};

function paramList(): { params: unknown[]; add: (v: unknown) => string } {
  const params: unknown[] = [];
  return {
    params,
    add: (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    },
  };
}

/** The one-row policy aggregate behind a prefix/member token. Modal (most frequent) values across the
 *  matched members; `employer_norm` rides along SERVER-SIDE ONLY as the comparables join key — the
 *  core never forwards it on the wire (employer_name is the display value). */
export interface QualifyPolicyRow {
  member_count: number;
  carrier: string | null; // mode() insurance_co
  employer_name: string | null;
  employer_norm: string | null; // SERVER-SIDE comparables key — never shipped to the client
  /** How many DISTINCT employers / carriers sit behind this token. The honesty denominators: the
   *  modal chip is "1 of employer_count", and >1 means the single displayed value is a slice. These
   *  are the TRUE counts, deliberately not derived from buildQualifyPolicySpreadQuery — that list is
   *  capped at QUALIFY_SPREAD_LIMIT, so a 300-employer prefix would otherwise report "1 of 25". */
  employer_count: number;
  carrier_count: number;
  funding: string | null;
  policy_type: string | null;
  plan_type: string | null;
  group_on_file: boolean;
  vob_fresh_as_of: string | null; // max(vob_created_at) behind this token, ISO date
  // Display-only benefit strings (raw VOB text, dollar-bearing — stripped for admissions_seat in core).
  deductible: string | null;
  deductible_met: string | null;
  oop_max: string | null;
  oop_met: string | null;
}

/**
 * Resolve the policy on file behind a member/prefix blind-index token. One row always (aggregate);
 * member_count = 0 ⇒ nothing on file (found:false upstream). mode() ignores NULLs, so a sparsely
 * extracted field falls back to the most frequent REAL value rather than null-dominance; an all-null
 * column yields null. Benefit strings take the value from the MOST RECENT VOB row (max-by
 * vob_created_at via the (val, created) pair trick would need a lateral — modal is the honest simple
 * read for v1 and the strings are display-only).
 */
export function buildQualifyPolicyQuery(
  token: string,
  kind: Exclude<QualifyTokenKind, 'client_name'>,
): { sql: string; params: unknown[] } {
  const { params, add } = paramList();
  const tok = add(token);
  const col = VOB_TOKEN_COLUMN[kind];
  const sql =
    'select ' +
    'count(distinct member_id_bidx)::int as member_count, ' +
    'mode() within group (order by insurance_co) as carrier, ' +
    'mode() within group (order by employer_name) as employer_name, ' +
    'mode() within group (order by employer_norm) as employer_norm, ' +
    // The honesty denominators for the modal chips above. Same scan, same WHERE — no extra cost.
    //
    // nullif(btrim(…), '') is NOT decoration: count(distinct) treats '' and '   ' as real distinct
    // values, while buildQualifyPolicySpreadQuery filters them out with `btrim(col) <> ''` and the UI
    // treats a blank as missing. Without this the three disagree, and the disagreement points the
    // wrong way — a prefix with one real employer plus one blank row would report employer_count = 2
    // and render "1 of 2", manufacturing ambiguity out of dirty data on the exact chip that exists to
    // stop the surface overclaiming. MEASURED 2026-08-06: zero blank rows live in either column
    // across all 23,067, so this is latent rather than active — but the VOB parser is upstream ETL
    // (three generations so far), and "no blanks today" is not a property this query can rely on.
    "count(distinct nullif(btrim(employer_norm), ''))::int as employer_count, " +
    "count(distinct nullif(btrim(insurance_co), ''))::int as carrier_count, " +
    'mode() within group (order by funding) as funding, ' +
    'mode() within group (order by policy_type) as policy_type, ' +
    'mode() within group (order by plan_type) as plan_type, ' +
    'coalesce(bool_or(group_number_bidx is not null), false) as group_on_file, ' +
    "to_char(max(vob_created_at), 'YYYY-MM-DD') as vob_fresh_as_of, " +
    'mode() within group (order by ind_deductible) as deductible, ' +
    'mode() within group (order by ind_deductible_met) as deductible_met, ' +
    'mode() within group (order by ind_oop_max) as oop_max, ' +
    'mode() within group (order by ind_oop_met) as oop_met ' +
    `from ${VOB_MEMBER_BENEFITS_LATEST} ` +
    `where ${col} = ${tok}`;
  return { sql, params };
}

/** One value in the spread behind a token: a distinct employer or carrier and how many members
 *  carry it. `value` for dim='employer' is employer_norm — the NORMALIZED key, never the display
 *  name. See the PHI note on buildQualifyPolicySpreadQuery. */
export interface QualifyPolicySpreadRow {
  dim: 'employer' | 'carrier';
  value: string;
  members: number;
}

/** Hard cap on spread rows per dimension. MEASURED 2026-08-06: one prefix carries 300 distinct
 *  employers and another 50 carriers, so this query is unbounded without it. 25 is far past what any
 *  disambiguation UI shows (top ~5 + a count) while still letting the caller say "and 275 more"
 *  honestly from member_count/employer_count on the policy row rather than from this list's length. */
export const QUALIFY_SPREAD_LIMIT = 25;

/**
 * The SPREAD behind a token — every distinct employer and carrier with its member count, ranked.
 *
 * WHY THIS EXISTS: buildQualifyPolicyQuery collapses each column with an INDEPENDENT `mode()`, which
 * has two failure modes measured live 2026-08-06 against the whole VOB set (4,075 prefixes / 23,067
 * members):
 *
 *   1. It asserts a specificity the data does not support. Weighted by MEMBER — which is how a real
 *      search samples, since a rep types the prefix off the card of the patient in front of them —
 *      80.5% of searches land on a multi-employer prefix, 86.8% on a multi-carrier one, and in 57%
 *      of searches the single displayed employer is a MINORITY of that prefix's members. Mean
 *      member-weighted dominance of the displayed employer is 49.1%: the chip is wrong more often
 *      than it is right. Uniform-over-prefixes averages (78.6% dominance) hide this completely,
 *      because the big prefixes where the mode is worst are exactly the ones searches hit.
 *   2. Because each column modes independently, the card can display a COMBINATION no single member
 *      holds — carrier from one sub-population, employer from another.
 *
 * The rank is already computed inside `mode()`; returning it costs the same scan.
 *
 * ⚠ PHI: `value` for dim='employer' is **employer_norm**, deliberately NOT employer_name.
 * `employer_name` is a PHI column (app/lib/phi.ts PHI_BASE_COLUMNS) and the AI payload has never
 * carried it (src/collections/qualifyAi.ts). The core consumes employer rows SERVER-SIDE ONLY — as
 * the comparable-cohort join key and as a count — and forwards only carrier rows plus employer
 * COUNTS on the wire. Shipping this list of employer values to a browser would multiply an existing
 * single-value exposure by up to 300 and is the one thing this builder must not be used for.
 */
export function buildQualifyPolicySpreadQuery(
  token: string,
  kind: Exclude<QualifyTokenKind, 'client_name'>,
  limit: number = QUALIFY_SPREAD_LIMIT,
): { sql: string; params: unknown[] } {
  const { params, add } = paramList();
  const tok = add(token);
  const col = VOB_TOKEN_COLUMN[kind];
  // The LIMIT is a VALUE, so it is BOUND, not interpolated — the repo rule is that only table/column
  // names are fixed literals. An earlier revision interpolated it on the belief that a $n could not
  // be reused across both UNION ALL branches; that was simply wrong (verified against the live
  // database 2026-08-06: one placeholder referenced in both branches, including as LIMIT, binds
  // once and applies to both). The clamp stays, but as a RESOURCE bound, not a safety mechanism:
  // binding makes the query injection-proof by construction, while the clamp is what stops a caller
  // bug asking for 10^9 rows. Two different jobs; neither substitutes for the other.
  const lim = add(Math.max(1, Math.min(200, Math.trunc(limit))));
  const branch = (dim: 'employer' | 'carrier', valueCol: string) =>
    `(select '${dim}'::text as dim, ${valueCol} as value, ` +
    'count(distinct member_id_bidx)::int as members ' +
    `from ${VOB_MEMBER_BENEFITS_LATEST} ` +
    `where ${col} = ${tok} and ${valueCol} is not null and btrim(${valueCol}) <> '' ` +
    `group by ${valueCol} ` +
    // Deterministic tiebreak on value so equal-count rows never reorder between runs.
    `order by count(distinct member_id_bidx) desc, ${valueCol} ` +
    `limit ${lim})`;
  const sql = `${branch('employer', 'employer_norm')} union all ${branch('carrier', 'insurance_co')}`;
  return { sql, params };
}

/** Global VOB feed freshness — max(vob_created_at) across the whole matview. This is the Phase 0
 *  staleness signal (a silent sync stall makes Qualify confidently wrong): the POLICY's own date can
 *  be legitimately old, but the FEED's high-water mark going stale is an ops alarm surfaced on-card. */
export function buildQualifyVobFreshnessQuery(): { sql: string; params: unknown[] } {
  return {
    // Full UTC ISO timestamp, not day-grain (PR #73 review): the staleness compare in core.ts
    // applies QUALIFY_VOB_STALE_HOURS exactly, so truncating here would smuggle up to 24h of slack.
    sql: `select to_char(max(vob_created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as fresh_as_of from ${VOB_MEMBER_BENEFITS_LATEST}`,
    params: [],
  };
}

/** One rung-count row: distinct patients per trailing window, computed in ONE scan. */
export interface QualifyWindowRungsRow {
  p30: number;
  p60: number;
  p90: number;
  p180: number;
  p365: number;
}

/**
 * The auto-window sufficiency ladder (Phase E) as ONE bucketed query: distinct patients behind the
 * token per trailing window, all five FILTER counts over a single [from365, to) scan. The scan is
 * token-scoped FIRST (the rollup's member_id_prefix_bidx / member_id_bidx btrees — a prefix's slice
 * is small), so this never touches the covering-index-critical book-wide path. Never five sequential
 * count(distinct …) round-trips — that was the plan's explicit implementation constraint.
 *
 * `froms` are the five inclusive lower bounds (30/60/90/180/365d), `to` the exclusive upper — all
 * computed by the caller via qualifyWindowBounds so business-timezone anchoring stays in ONE place.
 */
export function buildQualifyWindowRungsQuery(
  token: string,
  kind: Exclude<QualifyTokenKind, 'client_name'>,
  entityIds: string[],
  froms: { d30: string; d60: string; d90: string; d180: string; d365: string },
  to: string,
): { sql: string; params: unknown[] } {
  const ent = assertEntityScope(entityIds, 'buildQualifyWindowRungsQuery');
  const { params, add } = paramList();
  const e = add(ent);
  const tok = add(token);
  const col = VOB_TOKEN_COLUMN[kind] === 'member_id_bidx' ? 'member_id_bidx' : 'member_id_prefix_bidx';
  const f30 = add(froms.d30);
  const f60 = add(froms.d60);
  const f90 = add(froms.d90);
  const f180 = add(froms.d180);
  const f365 = add(froms.d365);
  const t = add(to);
  const rung = (f: string, name: string) =>
    `count(distinct member_id_bidx) filter (where payment_received >= ${f}::date)::int as ${name}`;
  const sql =
    'select ' +
    [rung(f30, 'p30'), rung(f60, 'p60'), rung(f90, 'p90'), rung(f180, 'p180'), rung(f365, 'p365')].join(', ') +
    ` from ${CMD_EXPLORER_CHARGE_ROLLUP} ` +
    `where business_entity_id = any(${e}::uuid[]) and ${col} = ${tok} ` +
    `and payment_received >= ${f365}::date and payment_received < ${t}::date`;
  return { sql, params };
}
