/**
 * Code Performance — SQL builders for /code-performance (procedure-code × revenue-code pairings over
 * collections.cmd_explorer_charge_rollup) plus the PURE shaping helpers the app layer applies to
 * their rows. No pg, no I/O, no clock read: every builder returns `{ sql, params }` and the app runs
 * it as claims_reader through PgExecutor. Hermetic coverage: test/codePerformanceQuery.test.ts.
 *
 * ── GRAIN ─────────────────────────────────────────────────────────────────────────────────────────
 * One rollup row = one logical charge (0050/0059: charge_amount counted once, insurance_payments =
 * max() over snapshots, adjustments / patient_balance_due = latest snapshot, payment_received =
 * max() = the LAST posting). The pairing grain here is (hcpcs, loc_suffix, revcode) AFTER the
 * normalisation below, so `charges` on a pairing row is a count of logical charges, not postings.
 *
 * ── NORMALISATION ON READ — live data defects, applied in EVERY builder ─────────────────────────
 *   hcpcs      := regexp_replace(nullif(btrim(cpt_code),''), '(IOP|PHP|RTC|UHC)$', '')
 *   loc_suffix := substring(nullif(btrim(cpt_code),'') from '(IOP|PHP|RTC|UHC)$')   ← KEPT, own column
 *   revcode    := lpad(nullif(btrim(revenue_code),''), 4, '0')
 * Indigo emits both '913' and '0913' for one code and welds level-of-care onto the CPT (H2013IOP,
 * H2020PHP, H2018RTC); H2020UHC encodes the PAYER. Measured 2026-09-08 over the trailing 180 days:
 * Indigo 128 raw (cpt, rev) pairs → 64 after both normalisations → 78 with loc_suffix kept as its
 * own dimension; BXR 44 → 44 → 44 (no suffixes, no 3-digit codes).
 * ⚠ DEFINITIONAL, NOT A DISCREPANCY. The build thread also carried "132 → 82". Those figures padded
 * the revenue code but LEFT THE SUFFIX ON the CPT; ours strip it (64) and keep it as a separate
 * dimension (78). The gap between 82 and 64 is the 11 suffixed codes collapsing onto their bases.
 * Do not reconcile the two as a bug. Two other thread figures were plain miscounts, not data
 * changes: "24" revenue values were 22 non-null + NULL, and "34" static-only procedure codes were 32.
 *
 * ── METRICS — sum-over-sum, NEVER avg() of a per-charge ratio ────────────────────────────────────
 * The rollup's pct_allowed / pct_paid are per-charge and UNWEIGHTED (verified from pg_get_viewdef,
 * 2026-09-08); no builder here reads them. The reliable-allowed gate is allowed_tier ∈ ('a','cd','e1')
 * (0059 ruling Q2a: 'e2' is an unreconciled latest-positive and is excluded; 'b' is the CMD phantom
 * $0; 'none' has no allowed at all).
 *   allowed_rate         sum(allowed_reliable) / sum(charge_amount), both gated
 *   allowed_coverage     share of charges inside the gate — MUST render beside allowed_rate; under
 *                        60% the rate is noise about a minority of the pairing
 *   paid_of_allowed      sum(insurance_payments) / sum(allowed_reliable), gated + allowed_reliable > 0.
 *                        NOT CLAMPED at 100 — overpayment / clawback exposure is the signal
 *   underpaid_dollars    sum(greatest(allowed_reliable − insurance_payments, 0)) over POSTED gated charges
 *   days_p50 / days_p90  percentile_cont over (payment_received − charge_date). payment_received is
 *                        max() per charge, so this is charge → LAST posting, not first dollar. Indigo
 *                        carries future EFT effective dates (114 charges, 2026-09-08), which inflate it.
 *   pct_zero_paid        charges with coalesce(insurance_payments,0) = 0. NOT a denial rate — it mixes
 *                        true denials, patient-responsibility-only, timely filing and in-flight claims.
 *                        The real denial numerator needs 835 data and is out of scope. A SIGNAL.
 *   write_off_rate       sum(adjustments) / sum(charge_amount) — INDIGO ONLY, see SUPPRESSION
 *   patient_balance_rate sum(patient_balance_due) / sum(charge_amount) — BXR ONLY, see SUPPRESSION.
 *                        An AR-AGING concept, not a rate: it is the balance OUTSTANDING AS OF TODAY
 *                        after patient payments, so it decays as patients pay and a 6mo window reads
 *                        lower than 30d on the same charges. Label it that way; never place it beside
 *                        allowed_rate as though comparable.
 *   payer_concentration  top payer's billed / total billed for the pairing (raw, unaliased payer strings)
 *   facility_spread      max(allowed_rate) − min(allowed_rate) across facilities within the pairing,
 *                        facilities with >= CODE_PERF_FACILITY_MIN_CHARGES charges only
 *
 * ── WINDOWS + MATURITY GUARD ─────────────────────────────────────────────────────────────────────
 * 30d / 60d / 90d / 6mo (=180d), half-open, anchored on the BUSINESS day in America/Los_Angeles —
 * computed IN SQL as (now() at time zone 'America/Los_Angeles')::date so the app never reads a clock:
 *   s := business_today − N,  e := business_today,  charge_date >= s AND charge_date < e + 1.
 * Median days-to-money runs 27–44 days and Indigo's charge feed lags ~15 days, so a short window is
 * mostly charges that have not been paid yet and yield reads LOW for purely mechanical reasons.
 * Every aggregate therefore carries matured_share = share of charges with charge_date <= e − 45.
 * Under CODE_PERF_MATURED_SHARE_FLOOR (0.60) the window measures velocity and volume, not yield, and
 * the UI must de-emphasise the yield columns — returned per pairing row AND per window.
 * ⚠ The spec's draft wrote `filter (where charge_date <= max(e) - 45)`. An aggregate inside FILTER is
 * a syntax error (42803); `e` is constant per row from the `win` CTE, so the builders filter on the
 * column directly. Same figure, valid SQL.
 *
 * ── SUPPRESSION IS A STATE, NOT AN ABSENCE (rulings 2026-09-08) ──────────────────────────────────
 * Two metrics are wrong for one tenant each, for reasons measured by the accounting identity
 * charge = paid + adjustments + patient_balance (96.6% BXR / 98.5% Indigo before 2026-08-15):
 *   · BXR write_off_rate is DROPPED, not gated. Report 10094775 (re-pinned 2026-08-15) aliases
 *     'Insurance Adjustment Amount' as the total adjustment; it is a PER-PAYMENT-ROW value, and the
 *     rollup's latest-snapshot pick lands on a zero row on ~28% of charges (identity 62% → 90% with
 *     max()). Directional bias of unknown magnitude — a caveat does not travel with a screenshot.
 *   · Indigo patient_balance_rate is SUPPRESSED. Indigo's report stopped carrying 'Charge Balance
 *     Due Pat' on 2026-08-15 (the day the employer column was added); every Indigo charge
 *     re-snapshotted since reads NULL (12,481 of 12,481), and the latest-snapshot pick overwrites
 *     the real balance. Any recent-window figure would be an artifact.
 * Both are FILED follow-ups (ingest side). Here they are representable ONLY as an explicit
 * `{ state: 'suppressed', reason }` — never null, never absent — so a column that is missing for one
 * tenant renders as "suppressed because …" and not as "this tenant has no write-offs".
 * The SQL computes both for every tenant; `shapeTenantGatedMetrics` is the ONE place that decides,
 * and a numeric never leaves this module for a suppressed (tenant, metric).
 *
 * ── DESCRIPTIONS: PRECEDENCE + NO-CODE PRESENTATION (038 header, B and D) ───────────────────────
 * ref.code_description may hold a GLOBAL row (business_entity_id NULL) and a TENANT row for one
 * code; the tenant row WINS, global is the fallback — `buildCodeDescriptionQuery` is the reference
 * implementation (distinct on … order by business_entity_id nulls last) and its test locks the
 * ORDER BY. "No code reported" arrives in two shapes — the literal em dash in the procedure slot
 * and a NULL revenue code — and is presented through ONE helper (`describeCodeSlot`) yielding one
 * label family and one `noCode` flag, so no component ever renders a bare blank for the NULL.
 *
 * ── SORT / FILTER SURFACE ────────────────────────────────────────────────────────────────────────
 * Nothing user-controlled reaches SQL as an identifier. Every ORDER BY is a fixed literal; the
 * pairing result (≤ ~80 rows) is sorted client-side. The only user values that reach SQL are bound
 * params: the entity UUID (validated by assertEntityScope), the window day count (from a fixed map),
 * facility NAMES (sanitised text[]), and the pair key (three nullable text values).
 */
import { assertEntityScope } from './entityScope.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../tenants.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Window presets → day counts. `6mo` is 180 days by definition here (documented, not calendar). */
export const CODE_PERF_WINDOWS = { '30d': 30, '60d': 60, '90d': 90, '6mo': 180 } as const;
export type CodePerfWindow = keyof typeof CODE_PERF_WINDOWS;
export const CODE_PERF_WINDOW_KEYS = Object.keys(CODE_PERF_WINDOWS) as CodePerfWindow[];
export const CODE_PERF_DEFAULT_WINDOW: CodePerfWindow = '6mo';

/** A charge is "matured" when it is at least this many days old at the window's end. */
export const CODE_PERF_MATURITY_DAYS = 45;
/** Below this matured share the window measures velocity/volume, not yield (0–1 scale). */
export const CODE_PERF_MATURED_SHARE_FLOOR = 0.6;
/** A facility needs at least this many charges in the pairing to enter facility_spread. */
export const CODE_PERF_FACILITY_MIN_CHARGES = 30;
/** The freshness read is bounded to this many days of charge_date so it never scans the full book. */
export const CODE_PERF_FRESHNESS_LOOKBACK_DAYS = 365;
/** Upper bound on facility names accepted into one filter — BXR has 17, Indigo 28. */
export const CODE_PERF_MAX_FACILITIES = 100;

/** 0059's reliable-allowed tiers. 'e2' (unreconciled latest-positive) and 'b' (phantom $0) excluded. */
export const CODE_PERF_RELIABLE_TIERS = ['a', 'cd', 'e1'] as const;

/** Row-flag thresholds (percent scale unless noted). */
export const CODE_PERF_FLAG_THRESHOLDS = {
  allowedCoverageUnreliableBelowPct: 60,
  dormantIdleDays: 90,
  highZeroPaidPct: 20,
  wideFacilitySpreadPts: 25,
  paidOverAllowedPct: 100,
} as const;

// SQL fragments — FIXED LITERALS. `r` is the rollup alias in every builder's base CTE.
const BUSINESS_TODAY_SQL = "(now() at time zone 'America/Los_Angeles')::date";
export const HCPCS_NORM_SQL = "regexp_replace(nullif(btrim(r.cpt_code), ''), '(IOP|PHP|RTC|UHC)$', '')";
export const LOC_SUFFIX_SQL = "substring(nullif(btrim(r.cpt_code), '') from '(IOP|PHP|RTC|UHC)$')";
export const REVCODE_NORM_SQL = "lpad(nullif(btrim(r.revenue_code), ''), 4, '0')";
const RELIABLE_TIER_SQL = "allowed_tier in ('a', 'cd', 'e1')";

// ---------------------------------------------------------------------------------------------
// Input clamps — everything user-controlled passes through one of these before it becomes a param
// ---------------------------------------------------------------------------------------------

/** Clamp any input to a known window key; anything unrecognised falls back to the default (6mo). */
export function resolveCodePerfWindow(input: unknown): CodePerfWindow {
  return typeof input === 'string' && (CODE_PERF_WINDOW_KEYS as string[]).includes(input)
    ? (input as CodePerfWindow)
    : CODE_PERF_DEFAULT_WINDOW;
}

/**
 * Facility filter → `text[] | null`. `null` means ALL facilities (the SQL predicate is
 * `$3::text[] is null or facility = any($3::text[])`). Non-string / blank entries are dropped, names
 * are trimmed and de-duplicated, and an empty result is `null` — never `[]`, because `= any('{}')`
 * would silently match nothing and read as "no charges". Facility names are CMD display text (the
 * vocabulary `buildCodePerfFacilityOptionsQuery` emits), compared by plain equality.
 */
export function sanitizeCodePerfFacilities(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length === 0 || t.length > 200) continue;
    seen.add(t);
    if (seen.size >= CODE_PERF_MAX_FACILITIES) break;
  }
  return seen.size === 0 ? null : [...seen];
}

/** The identity of one pairing row. Any part may be NULL (no code reported / no suffix). */
export interface CodePerfPairKey {
  hcpcs: string | null;
  locSuffix: string | null;
  revcode: string | null;
}

/** Coerce an untrusted pair key: trims, upper-cases, blank → null, length-bounded. */
export function sanitizeCodePerfPairKey(input: unknown): CodePerfPairKey {
  const pick = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim().toUpperCase();
    return t.length === 0 || t.length > 12 ? null : t;
  };
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return { hcpcs: pick(o.hcpcs), locSuffix: pick(o.locSuffix), revcode: pick(o.revcode) };
}

export interface CodePerfScope {
  /** ONE tenant. Pairings are never mixed across tenants — code conventions differ per tenant. */
  entityId: string;
  windowDays: number;
  facilities: string[] | null;
}

function scopeParams(scope: CodePerfScope): unknown[] {
  const [entityId] = assertEntityScope([scope.entityId], 'codePerformanceQuery');
  const days = Number.isSafeInteger(scope.windowDays) && scope.windowDays > 0 && scope.windowDays <= 366
    ? scope.windowDays
    : CODE_PERF_WINDOWS[CODE_PERF_DEFAULT_WINDOW];
  return [entityId, days, scope.facilities];
}

// ---------------------------------------------------------------------------------------------
// The shared base CTE — window + normalisation + tenant + facility filter. $1 entity, $2 days, $3 facilities.
// ---------------------------------------------------------------------------------------------

const BASE_CTE = `with win as (
  select ${BUSINESS_TODAY_SQL} - $2::int as s,
         ${BUSINESS_TODAY_SQL}           as e
), base as (
  select
    ${HCPCS_NORM_SQL}                          as hcpcs,
    ${LOC_SUFFIX_SQL}                          as loc_suffix,
    ${REVCODE_NORM_SQL}                        as revcode,
    nullif(btrim(r.primary_payer), '')         as payer_raw,
    r.facility, r.charge_date, r.payment_received, r.charge_amount,
    r.insurance_payments, r.allowed_reliable, r.allowed_tier,
    r.adjustments, r.patient_balance_due, w.s, w.e
  from collections.cmd_explorer_charge_rollup r
  cross join win w
  where r.business_entity_id = $1::uuid
    and r.charge_date >= w.s and r.charge_date < w.e + 1
    and ($3::text[] is null or r.facility = any($3::text[]))
)`;

/** Every column `base` projects — re-projected by name in the drill-down CTEs (never `select *`). */
const BASE_COLUMNS_SQL =
  'hcpcs, loc_suffix, revcode, payer_raw, facility, charge_date, payment_received, charge_amount, ' +
  'insurance_payments, allowed_reliable, allowed_tier, adjustments, patient_balance_due, s, e';

/** The pair-key predicate for drill-downs. NULL-safe: `is not distinct from`. $4 hcpcs, $5 loc, $6 rev. */
const PAIR_PREDICATE_SQL = `hcpcs is not distinct from $4::text
    and loc_suffix is not distinct from $5::text
    and revcode is not distinct from $6::text`;

/** The metric block shared by every grouped aggregate. Sum-over-sum; no pct_allowed / pct_paid. */
const METRICS_SQL = `count(*)::int                                                    as charges,
    sum(charge_amount)                                               as billed,
    sum(insurance_payments)                                          as collected,
    round(100.0 * count(*) filter (where ${RELIABLE_TIER_SQL}) / nullif(count(*), 0), 1)
                                                                     as allowed_coverage,
    round(100.0 * sum(allowed_reliable) filter (where ${RELIABLE_TIER_SQL})
          / nullif(sum(charge_amount) filter (where ${RELIABLE_TIER_SQL}), 0), 2)
                                                                     as allowed_rate,
    round(100.0 * sum(insurance_payments) filter (where ${RELIABLE_TIER_SQL} and allowed_reliable > 0)
          / nullif(sum(allowed_reliable) filter (where ${RELIABLE_TIER_SQL} and allowed_reliable > 0), 0), 2)
                                                                     as paid_of_allowed,
    sum(greatest(allowed_reliable - coalesce(insurance_payments, 0), 0))
        filter (where ${RELIABLE_TIER_SQL} and payment_received is not null)
                                                                     as underpaid_dollars,
    percentile_cont(0.5) within group (
      order by case when payment_received >= charge_date then payment_received - charge_date end)
                                                                     as days_p50,
    percentile_cont(0.9) within group (
      order by case when payment_received >= charge_date then payment_received - charge_date end)
                                                                     as days_p90,
    round(100.0 * count(*) filter (where coalesce(insurance_payments, 0) = 0) / nullif(count(*), 0), 1)
                                                                     as pct_zero_paid,
    round(100.0 * sum(adjustments) / nullif(sum(charge_amount), 0), 2)
                                                                     as write_off_rate,
    round(100.0 * sum(patient_balance_due) / nullif(sum(charge_amount), 0), 2)
                                                                     as patient_balance_rate,
    round(100.0 * count(*) filter (where charge_date <= e - ${CODE_PERF_MATURITY_DAYS}) / nullif(count(*), 0), 1)
                                                                     as matured_share`;

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

/**
 * Pairing level: one row per (hcpcs, loc_suffix, revcode), billed desc. Adds payer_concentration and
 * facility_spread via two more grouped passes over the same base CTE (the spread only counts
 * facilities with >= CODE_PERF_FACILITY_MIN_CHARGES charges in the pairing). Joins are NULL-safe
 * (`is not distinct from`) because a pairing key may be NULL on any part.
 */
export function buildCodePerfPairingQuery(scope: CodePerfScope): SqlQuery {
  const sql = `${BASE_CTE}, pair as (
  select hcpcs, loc_suffix, revcode,
    count(distinct payer_raw)::int                                   as payers,
    count(distinct facility)::int                                    as facilities,
    ${METRICS_SQL},
    min(charge_date)                                                 as first_seen,
    max(charge_date)                                                 as last_seen,
    (max(e) - max(charge_date))::int                                 as days_idle
  from base
  group by hcpcs, loc_suffix, revcode
), payer_billed as (
  select hcpcs, loc_suffix, revcode, payer_raw, sum(charge_amount) as billed
  from base
  group by hcpcs, loc_suffix, revcode, payer_raw
), payer_conc as (
  select hcpcs, loc_suffix, revcode,
    round(100.0 * max(billed) / nullif(sum(billed), 0), 1)           as payer_concentration
  from payer_billed
  group by hcpcs, loc_suffix, revcode
), fac as (
  select hcpcs, loc_suffix, revcode, facility,
    100.0 * sum(allowed_reliable) filter (where ${RELIABLE_TIER_SQL})
          / nullif(sum(charge_amount) filter (where ${RELIABLE_TIER_SQL}), 0) as allowed_rate
  from base
  group by hcpcs, loc_suffix, revcode, facility
  having count(*) >= ${CODE_PERF_FACILITY_MIN_CHARGES}
), fac_spread as (
  select hcpcs, loc_suffix, revcode,
    count(*)::int                                                    as facilities_rated,
    round(max(allowed_rate) - min(allowed_rate), 2)                  as facility_spread
  from fac
  where allowed_rate is not null
  group by hcpcs, loc_suffix, revcode
)
select
  p.hcpcs, p.loc_suffix, p.revcode, p.payers, p.facilities,
  p.charges, p.billed, p.collected, p.allowed_coverage, p.allowed_rate, p.paid_of_allowed,
  p.underpaid_dollars, p.days_p50, p.days_p90, p.pct_zero_paid, p.write_off_rate,
  p.patient_balance_rate, p.matured_share, p.first_seen, p.last_seen, p.days_idle,
  pc.payer_concentration, fs.facilities_rated, fs.facility_spread
from pair p
left join payer_conc pc
  on pc.hcpcs is not distinct from p.hcpcs
 and pc.loc_suffix is not distinct from p.loc_suffix
 and pc.revcode is not distinct from p.revcode
left join fac_spread fs
  on fs.hcpcs is not distinct from p.hcpcs
 and fs.loc_suffix is not distinct from p.loc_suffix
 and fs.revcode is not distinct from p.revcode
order by p.billed desc, p.hcpcs nulls last, p.loc_suffix nulls last, p.revcode nulls last`;
  return { sql, params: scopeParams(scope) };
}

/** Window-level totals — the KPI tiles and the WINDOW-level maturity guard. One row. */
export function buildCodePerfWindowSummaryQuery(scope: CodePerfScope): SqlQuery {
  const sql = `${BASE_CTE}
select
  max(s)                                                             as window_start,
  max(e)                                                             as window_end,
  count(distinct (hcpcs, loc_suffix, revcode))::int                  as pairings,
  count(distinct facility)::int                                      as facilities,
  count(distinct payer_raw)::int                                     as payers,
  count(*) filter (where hcpcs is null or hcpcs = '—')::int          as no_procedure_code_charges,
  count(*) filter (where revcode is null)::int                       as no_revenue_code_charges,
  ${METRICS_SQL}
from base`;
  return { sql, params: scopeParams(scope) };
}

/**
 * Payer level for ONE pairing (lazy-loaded drill-down). payer_raw is the raw, unaliased CMD string —
 * one carrier appears on several rows; alias resolution is out of scope and the UI must say so.
 */
export function buildCodePerfPayerQuery(scope: CodePerfScope, pair: CodePerfPairKey): SqlQuery {
  const sql = `${BASE_CTE}, scoped as (
  select ${BASE_COLUMNS_SQL} from base
  where ${PAIR_PREDICATE_SQL}
), total as (
  select sum(charge_amount) as billed from scoped
)
select
  s.payer_raw,
  ${METRICS_SQL},
  round(100.0 * sum(s.charge_amount) / nullif(max(t.billed), 0), 1)  as share_of_billed
from scoped s
cross join total t
group by s.payer_raw
order by billed desc, s.payer_raw nulls last`;
  return { sql, params: [...scopeParams(scope), pair.hcpcs, pair.locSuffix, pair.revcode] };
}

/**
 * Facility level for ONE pairing — the outlier view behind facility_spread. Only facilities with
 * >= CODE_PERF_FACILITY_MIN_CHARGES charges in the pairing; ordered by allowed_rate so the spread's
 * two ends are the first and last rows. `below_floor` reports how many facilities were excluded.
 */
export function buildCodePerfFacilityQuery(scope: CodePerfScope, pair: CodePerfPairKey): SqlQuery {
  const sql = `${BASE_CTE}, scoped as (
  select ${BASE_COLUMNS_SQL} from base
  where ${PAIR_PREDICATE_SQL}
), per_facility as (
  select facility,
    ${METRICS_SQL}
  from scoped
  group by facility
)
select
  facility, charges, billed, collected, allowed_coverage, allowed_rate, paid_of_allowed,
  underpaid_dollars, days_p50, days_p90, pct_zero_paid, write_off_rate, patient_balance_rate,
  matured_share,
  (charges >= ${CODE_PERF_FACILITY_MIN_CHARGES})                     as rated,
  (select count(*)::int from per_facility where charges < ${CODE_PERF_FACILITY_MIN_CHARGES})
                                                                     as below_floor
from per_facility
where charges >= ${CODE_PERF_FACILITY_MIN_CHARGES}
order by allowed_rate desc nulls last, billed desc, facility nulls last`;
  return { sql, params: [...scopeParams(scope), pair.hcpcs, pair.locSuffix, pair.revcode] };
}

/**
 * Monthly series — [month, charges, billed, allowed_rate, matured_share] — for one pairing when a
 * pair is given, otherwise for the whole window. Month = date_trunc('month', charge_date). The
 * INCOMPLETE-month decision is not made here: the app shades months at/after each tenant's
 * max(charge_date) month from the freshness query, because BXR and Indigo lag differently.
 */
export function buildCodePerfMonthlyQuery(scope: CodePerfScope, pair?: CodePerfPairKey): SqlQuery {
  const where = pair ? `where ${PAIR_PREDICATE_SQL}` : '';
  const sql = `${BASE_CTE}
select
  date_trunc('month', charge_date)::date                             as month,
  count(*)::int                                                      as charges,
  sum(charge_amount)                                                 as billed,
  sum(insurance_payments)                                            as collected,
  round(100.0 * sum(allowed_reliable) filter (where ${RELIABLE_TIER_SQL})
        / nullif(sum(charge_amount) filter (where ${RELIABLE_TIER_SQL}), 0), 2)
                                                                     as allowed_rate,
  round(100.0 * count(*) filter (where ${RELIABLE_TIER_SQL}) / nullif(count(*), 0), 1)
                                                                     as allowed_coverage,
  round(100.0 * count(*) filter (where charge_date <= e - ${CODE_PERF_MATURITY_DAYS}) / nullif(count(*), 0), 1)
                                                                     as matured_share
from base
${where}
group by 1
order by 1`;
  const params = pair ? [...scopeParams(scope), pair.hcpcs, pair.locSuffix, pair.revcode] : scopeParams(scope);
  return { sql, params };
}

/**
 * Facility vocabulary for the multi-select: every office name the reports returned for this tenant
 * inside the window, with charge counts. NOT a hardcoded roster — "No Facility" (BXR's manual
 * resolution queue) is a real value and surfaces like any other. Ignores any facility filter.
 */
export function buildCodePerfFacilityOptionsQuery(scope: CodePerfScope): SqlQuery {
  const [entityId, days] = scopeParams(scope);
  const sql = `select r.facility, count(*)::int as charges, sum(r.charge_amount) as billed
from collections.cmd_explorer_charge_rollup r
where r.business_entity_id = $1::uuid
  and r.charge_date >= ${BUSINESS_TODAY_SQL} - $2::int
  and r.charge_date <  ${BUSINESS_TODAY_SQL} + 1
group by r.facility
order by r.facility nulls last`;
  return { sql, params: [entityId, days] };
}

/**
 * Freshness, per tenant: max(ingested_at), max(charge_date), max(payment_received), and the count of
 * charges whose payment_received is in the future (Indigo EFT effective dates — 114 / BXR 0 on
 * 2026-09-08). Drives the per-tenant incomplete-month shading and the Indigo days-to-money notice.
 * Bounded to CODE_PERF_FRESHNESS_LOOKBACK_DAYS of charge_date so it never scans the full book; the
 * maxima are unaffected because a tenant with no charge in the last year has no freshness to show.
 */
export function buildCodePerfFreshnessQuery(entityIds: readonly string[]): SqlQuery {
  const ids = assertEntityScope(entityIds, 'buildCodePerfFreshnessQuery');
  const sql = `select
  r.business_entity_id,
  ${BUSINESS_TODAY_SQL}                                              as business_today,
  max(r.ingested_at)                                                 as max_ingested_at,
  max(r.charge_date)                                                 as max_charge_date,
  max(r.payment_received)                                            as max_payment_received,
  count(*) filter (where r.payment_received > ${BUSINESS_TODAY_SQL})::int
                                                                     as future_payment_charges,
  count(*)::int                                                      as charges_in_lookback
from collections.cmd_explorer_charge_rollup r
where r.business_entity_id = any($1::uuid[])
  and r.charge_date >= ${BUSINESS_TODAY_SQL} - ${CODE_PERF_FRESHNESS_LOOKBACK_DAYS}
group by r.business_entity_id
order by r.business_entity_id`;
  return { sql, params: [ids] };
}

/**
 * Descriptions with the 038 PRECEDENCE contract: tenant row wins, global is the fallback, never
 * another tenant's row. `distinct on (code_type, code)` + `order by … business_entity_id nulls last`
 * IS the contract — the test locks this ORDER BY. Returns every code type; the app maps procedure
 * lookups across ('CPT','HCPCS','OTHER') and revenue lookups to 'REV' (038 CODE_TYPE RULE).
 */
export function buildCodeDescriptionQuery(entityId: string): SqlQuery {
  const [id] = assertEntityScope([entityId], 'buildCodeDescriptionQuery');
  const sql = `select distinct on (code_type, code)
  code_type, code, short_label, long_description, prior_description, source_citation, provenance,
  needs_review, description_conflict,
  (business_entity_id is not null)                                   as tenant_override
from ref.code_description
where business_entity_id is null or business_entity_id = $1::uuid
order by code_type, code, business_entity_id nulls last`;
  return { sql, params: [id] };
}

// ---------------------------------------------------------------------------------------------
// Row shaping — pure, tested at root, applied by the app layer to pg rows
// ---------------------------------------------------------------------------------------------

/** node-pg returns numeric / bigint / sums as STRINGS (memory: pg-bigint-reads-as-string). Coerce once. */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export type GatedMetric = { state: 'available'; value: number | null } | { state: 'suppressed'; reason: string };

export const CODE_PERF_SUPPRESSION_REASONS = {
  bxrWriteOff:
    'Dropped for BXR. Since the 2026-08-15 report re-pin, BXR’s adjustments column is a per-payment-row ' +
    'value and the rollup zeroes it on roughly 28% of charges. Directional bias of unknown magnitude — ' +
    'no figure is shown rather than a wrong one.',
  indigoPatientBalance:
    'Suppressed for Indigo. The Indigo report stopped carrying the patient balance column on ' +
    '2026-08-15; every charge re-snapshotted since reads NULL, so any recent-window figure would be an ' +
    'artifact, not a balance.',
  unknownTenant: 'Suppressed: metric availability is ruled per tenant and this tenant has no ruling.',
} as const;

export interface TenantGatedMetrics {
  write_off_rate: GatedMetric;
  patient_balance_rate: GatedMetric;
}

/**
 * THE one place the per-tenant metric ruling is applied. Indigo → write_off_rate available,
 * patient_balance_rate suppressed. BXR → the reverse. Anything else → both suppressed (fail closed).
 * A suppressed metric NEVER carries the SQL value — the number is discarded here, not hidden later.
 */
export function shapeTenantGatedMetrics(
  entityId: string,
  raw: { write_off_rate: unknown; patient_balance_rate: unknown },
): TenantGatedMetrics {
  if (entityId === INDIGO_ENTITY_ID) {
    return {
      write_off_rate: { state: 'available', value: toNum(raw.write_off_rate) },
      patient_balance_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.indigoPatientBalance },
    };
  }
  if (entityId === BXR_ENTITY_ID) {
    return {
      write_off_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.bxrWriteOff },
      patient_balance_rate: { state: 'available', value: toNum(raw.patient_balance_rate) },
    };
  }
  return {
    write_off_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.unknownTenant },
    patient_balance_rate: { state: 'suppressed', reason: CODE_PERF_SUPPRESSION_REASONS.unknownTenant },
  };
}

/** Labels the UI must use for a missing code — the ONE place either representation is interpreted (038 D). */
export const NO_PROCEDURE_CODE_LABEL = 'No procedure code reported';
export const NO_REVENUE_CODE_LABEL = 'No revenue code reported';
/** CMD's literal marker in the procedure slot. Seeded in 038 as code_type OTHER with NO_PROCEDURE_CODE_LABEL. */
export const NO_PROCEDURE_CODE_MARKER = '—';

export interface CodeSlotPresentation {
  /** What to print in the code cell: the code itself, or the no-code label. */
  label: string;
  /** TRUE for both the em dash and a NULL — the same visual state for both. */
  noCode: boolean;
  /** The key to look the description up with (null when there is nothing to look up). */
  lookupCode: string | null;
}

export function describeCodeSlot(kind: 'procedure' | 'revenue', code: string | null): CodeSlotPresentation {
  if (kind === 'procedure') {
    if (code === null || code === NO_PROCEDURE_CODE_MARKER) {
      // The em dash HAS a table row (so it appears in the review queue); the label still comes from here.
      return { label: NO_PROCEDURE_CODE_LABEL, noCode: true, lookupCode: code === null ? null : NO_PROCEDURE_CODE_MARKER };
    }
    return { label: code, noCode: false, lookupCode: code };
  }
  if (code === null) return { label: NO_REVENUE_CODE_LABEL, noCode: true, lookupCode: null };
  return { label: code, noCode: false, lookupCode: code };
}

export type CodePerfFlag =
  | 'no_procedure_code'
  | 'no_revenue_code'
  | 'allowed_unreliable'
  | 'immature_window'
  | 'dormant'
  | 'paid_over_allowed'
  | 'high_zero_paid'
  | 'wide_facility_spread'
  | 'not_clinical';

/** The non-clinical procedure-slot markers (interest postings) — never yield, always flagged. */
export const NON_CLINICAL_PROCEDURE_CODES: ReadonlySet<string> = new Set(['INT', 'INTRST']);

export interface CodePerfFlagInputs {
  hcpcs: string | null;
  revcode: string | null;
  allowed_coverage: number | null;
  matured_share: number | null;
  days_idle: number | null;
  paid_of_allowed: number | null;
  pct_zero_paid: number | null;
  facility_spread: number | null;
}

/** Row flags, thresholds from CODE_PERF_FLAG_THRESHOLDS. Percent-scale inputs (0–100) except days. */
export function deriveCodePerfFlags(row: CodePerfFlagInputs): CodePerfFlag[] {
  const t = CODE_PERF_FLAG_THRESHOLDS;
  const flags: CodePerfFlag[] = [];
  if (describeCodeSlot('procedure', row.hcpcs).noCode) flags.push('no_procedure_code');
  if (row.revcode === null) flags.push('no_revenue_code');
  if (row.hcpcs !== null && NON_CLINICAL_PROCEDURE_CODES.has(row.hcpcs)) flags.push('not_clinical');
  if (row.allowed_coverage !== null && row.allowed_coverage < t.allowedCoverageUnreliableBelowPct) {
    flags.push('allowed_unreliable');
  }
  if (row.matured_share !== null && row.matured_share < CODE_PERF_MATURED_SHARE_FLOOR * 100) {
    flags.push('immature_window');
  }
  if (row.days_idle !== null && row.days_idle >= t.dormantIdleDays) flags.push('dormant');
  if (row.paid_of_allowed !== null && row.paid_of_allowed > t.paidOverAllowedPct) flags.push('paid_over_allowed');
  if (row.pct_zero_paid !== null && row.pct_zero_paid >= t.highZeroPaidPct) flags.push('high_zero_paid');
  if (row.facility_spread !== null && row.facility_spread >= t.wideFacilitySpreadPts) {
    flags.push('wide_facility_spread');
  }
  return flags;
}

/** Window-level maturity verdict for the UI banner. `matured_share` on the 0–100 scale as SQL returns it. */
export function isImmatureWindow(maturedSharePct: number | null): boolean {
  return maturedSharePct === null || maturedSharePct < CODE_PERF_MATURED_SHARE_FLOOR * 100;
}

/** The typed pairing row the app layer emits — dollars stay numbers; gated metrics are states. */
export interface CodePerfPairingRow {
  hcpcs: string | null;
  loc_suffix: string | null;
  revcode: string | null;
  payers: number;
  facilities: number;
  charges: number;
  billed: number;
  collected: number;
  allowed_coverage: number | null;
  allowed_rate: number | null;
  paid_of_allowed: number | null;
  underpaid_dollars: number | null;
  days_p50: number | null;
  days_p90: number | null;
  pct_zero_paid: number | null;
  matured_share: number | null;
  first_seen: string | null;
  last_seen: string | null;
  days_idle: number | null;
  payer_concentration: number | null;
  facilities_rated: number | null;
  facility_spread: number | null;
  write_off_rate: GatedMetric;
  patient_balance_rate: GatedMetric;
  flags: CodePerfFlag[];
}

function isoDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

/** pg row → typed pairing row. Applies the tenant ruling and derives flags. Pure. */
export function shapeCodePerfPairingRow(raw: Record<string, unknown>, entityId: string): CodePerfPairingRow {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const gated = shapeTenantGatedMetrics(entityId, {
    write_off_rate: raw.write_off_rate,
    patient_balance_rate: raw.patient_balance_rate,
  });
  const base = {
    hcpcs: str(raw.hcpcs),
    loc_suffix: str(raw.loc_suffix),
    revcode: str(raw.revcode),
    payers: toNum(raw.payers) ?? 0,
    facilities: toNum(raw.facilities) ?? 0,
    charges: toNum(raw.charges) ?? 0,
    billed: toNum(raw.billed) ?? 0,
    collected: toNum(raw.collected) ?? 0,
    allowed_coverage: toNum(raw.allowed_coverage),
    allowed_rate: toNum(raw.allowed_rate),
    paid_of_allowed: toNum(raw.paid_of_allowed),
    underpaid_dollars: toNum(raw.underpaid_dollars),
    days_p50: toNum(raw.days_p50),
    days_p90: toNum(raw.days_p90),
    pct_zero_paid: toNum(raw.pct_zero_paid),
    matured_share: toNum(raw.matured_share),
    first_seen: isoDate(raw.first_seen),
    last_seen: isoDate(raw.last_seen),
    days_idle: toNum(raw.days_idle),
    payer_concentration: toNum(raw.payer_concentration),
    facilities_rated: toNum(raw.facilities_rated),
    facility_spread: toNum(raw.facility_spread),
  };
  return {
    ...base,
    ...gated,
    flags: deriveCodePerfFlags(base),
  };
}
