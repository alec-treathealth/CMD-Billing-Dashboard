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
    'mode() within group (order by funding) as funding, ' +
    'mode() within group (order by policy_type) as policy_type, ' +
    'mode() within group (order by plan_type) as plan_type, ' +
    'bool_or(group_number_bidx is not null) as group_on_file, ' +
    "to_char(max(vob_created_at), 'YYYY-MM-DD') as vob_fresh_as_of, " +
    'mode() within group (order by ind_deductible) as deductible, ' +
    'mode() within group (order by ind_deductible_met) as deductible_met, ' +
    'mode() within group (order by ind_oop_max) as oop_max, ' +
    'mode() within group (order by ind_oop_met) as oop_met ' +
    `from ${VOB_MEMBER_BENEFITS_LATEST} ` +
    `where ${col} = ${tok}`;
  return { sql, params };
}

/** Global VOB feed freshness — max(vob_created_at) across the whole matview. This is the Phase 0
 *  staleness signal (a silent sync stall makes Qualify confidently wrong): the POLICY's own date can
 *  be legitimately old, but the FEED's high-water mark going stale is an ops alarm surfaced on-card. */
export function buildQualifyVobFreshnessQuery(): { sql: string; params: unknown[] } {
  return {
    sql: `select to_char(max(vob_created_at), 'YYYY-MM-DD') as fresh_as_of from ${VOB_MEMBER_BENEFITS_LATEST}`,
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
