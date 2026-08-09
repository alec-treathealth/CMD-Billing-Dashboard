/**
 * Qualify POLICY-RATING HISTORY — the nightly snapshot behind the smoke-shell tape's 90d delta.
 *
 * WHY: nothing persists a (prefix-token × payer) policy rating over time — the live number is
 * computed per request and discarded (src/collections/qualifyQuery.ts ranking → app core
 * assembleFacilities → derivePolicyRating). A "trending policies" tape needs rating-at-D vs
 * rating-at-D-90, so this module writes one row per ACTIVE (member_id_prefix_bidx, primary_payer)
 * pair per day into collections.qualify_policy_rating_daily (mig 0093), with the claims aggregates
 * that fed the number stored beside it so a score's movement is CHECKABLE, not just asserted.
 *
 * CATCH-UP MODEL (self-healing, backfill included): each run computes every as_of date in the
 * trailing horizon that has no ok=true run-log row, oldest first, capped per run. The FIRST run
 * therefore backfills the whole horizon (~180 dates) in one pass — the aggregates are
 * date-predicated (payment_received window ending at as_of), so history is reconstructible from
 * the rollup. A missed night, a platform kill, or a failed date just leaves dates missing; the
 * next run picks them up. Re-running a date upserts in place (idempotent).
 *
 * ⚠ BACKFILL IS A DISCLOSED RECONSTRUCTION, NOT OBSERVED HISTORY: the claims-side factors
 * (allowed%, sample, time-to-payment) are as-of reconstructions from the current rollup, but the
 * coding-registry and census/outcomes context is CURRENT-state only (those tables are overwritten
 * in place), so backfilled ratings use today's coding/census context against the historical claim
 * window. The per-date `now` injected into the rate callback IS the as_of date, so coding-age
 * decay is at least measured from the right day. Two residual caveats apply to EVERY snapshot,
 * steady-state included: (a) report lag — a payment dated inside the window but ingested after
 * the snapshot ran is visible to a later interactive read and to any re-backfill, but not to the
 * frozen row; (b) the newest computable date is YESTERDAY (see the anchor note in the run
 * function) — an as_of=today row would rate a mostly-empty final day and freeze wrong.
 *
 * RATING PARITY BY INJECTION: the five-factor math lives in app/lib/qualify (ratingV2 +
 * policyRating — pure, client-safe) and src MUST NOT import app. The composition root
 * (app/lib/server.ts) injects `rate`, wired to the SAME computeRatingV2 + derivePolicyRating the
 * interactive surface ships, so the stored number is the number a user would see — never a
 * parallel formula. This module only supplies the per-facility aggregates (the exact
 * buildFacilityRankingQuery inner-aggregate shape) and stores what the callback returns.
 *
 * WINDOW: fixed trailing 90d ([as_of-89, as_of+1), half-open, payment_received axis — mirrors
 * trailingWindowFor). The interactive path may ladder to other windows per identifier; the tape's
 * claim is explicitly "rating over trailing 90d" and stores window_days so the read side can say
 * so. 90d was Alec's call (2026-08-08) so tape scores line up with a 90d-window search.
 *
 * PHI DISCIPLINE: prefix identity exists here ONLY as the keyed-HMAC token (member_id_prefix_bidx
 * — declared not-PHI, blindIndex.ts); member_id_bidx is COUNTED (distinct) and never projected.
 * payer/facility labels are the same non-PHI text every Qualify aggregate ships. No name, no raw
 * identifier, no ciphertext, and the run-log stores counts/dates/messages only.
 *
 * ROLES: aggregates + dimension joins read as claims_reader (readDb — every table here is already
 * reader-granted for the interactive path); run-log + upserts write as cmd_rollup_writer (writeDb
 * — granted select/insert/update on the two 0093 tables, nothing else new). Never claims_admin.
 * Supavisor 6543: every statement is its own autocommit pool.query — no transactions, no named
 * prepared statements. The run-log start row is INSERTed first (refreshChargeRollup's durability
 * model): a platform kill leaves ok/finished_at NULL as the "started but unfinished" signal.
 */
import { assertEntityScope } from './entityScope.js';

/** The minimal query surface this module needs — STRUCTURAL on purpose, so a pg.Pool (the writer),
 *  a PgExecutor (the app's reader pools), and a plain test fake all satisfy it without casts. Every
 *  call is one autocommit statement (Supavisor 6543 discipline). */
export interface QualifyRatingQueryDb {
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

// ── Tunables (exported so tests and the read side assert the same numbers) ──────────────────────

/** Trailing window each daily snapshot rates over. Alec's 90d ruling (2026-08-08). */
export const QUALIFY_RATING_HISTORY_WINDOW_DAYS = 90;
/** How far back the catch-up looks for missing as_of dates. 180 = the 90d delta's "then" endpoint
 *  plus 90 more days of runway for a future then-vs-then comparison. */
export const QUALIFY_RATING_HISTORY_HORIZON_DAYS = 180;
/** Per-run cap on dates computed (backfill bound; ~0.3-0.6s/date measured class of scan). 200 lets
 *  the first run clear the whole 180-day horizon inside maxDuration=300 with headroom. */
export const QUALIFY_RATING_HISTORY_MAX_DATES = 200;

/** Tape read tunables (mig 0093 read side). Delta compares as_of D vs D-90. */
export const QUALIFY_TAPE_DELTA_DAYS = 90;
/** Pair-level distinct-member floor for tape visibility — mirrors the rating sample floor
 *  (sampleGate.ts QUALIFY_RATING_MIN_PATIENTS = 3): a prefix is usually ONE PERSON (measured
 *  58.8%), and a one-member pair's "trend" is that person's claims aging, not market movement. */
export const QUALIFY_TAPE_MIN_MEMBERS = 3;
export const QUALIFY_TAPE_TOP_N = 20;

// ── Row shapes ───────────────────────────────────────────────────────────────────────────────────

/** One (prefix, payer, facility) aggregate row — the rate callback's per-facility input. The
 *  pair-grain GROUPING SETS row (facility null) carries the pair-level dedup/median instead. */
export interface QualifyRatingHistoryAggRow {
  member_id_prefix_bidx: string;
  primary_payer: string;
  facility: string | null; // null ⟺ the pair-grain row (GROUPING SETS)
  line_count: number;
  distinct_patients: number;
  confirmed_claims: number;
  billed: number | null;
  allowed: number | null;
  pct_allowed: number | null;
  paid: number | null;
  median_days_to_payment: number | null;
  facility_name: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
  facility_code: string | null;
}

/** The per-facility slice handed to the injected rate callback (pair-grain row excluded). */
export interface QualifyRatingHistoryFacilityAgg {
  facility: string;
  facilityCode: string | null;
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
  lineCount: number;
  distinctPatients: number;
  confirmedClaims: number;
  pctAllowed: number | null;
  medianDaysToPayment: number | null;
}

/** Injected rating fold: app wires computeRatingV2 + derivePolicyRating here (see module header).
 *  `asOf` is 'YYYY-MM-DD'; implementations must treat it as the clock for age-decay factors. */
export type QualifyRatePairFn = (input: {
  payer: string;
  facilities: QualifyRatingHistoryFacilityAgg[];
  asOf: string;
  windowDays: number;
}) => { rating: number | null; band: string | null; ratedFacilities: number };

export interface QualifyRatingHistoryDeps {
  /** claims_reader connection — aggregate scan + dimension joins (all pre-granted for Qualify reads). */
  readDb: QualifyRatingQueryDb;
  /** cmd_rollup_writer connection — run-log rows + daily upserts (0093 grants), each autocommit. */
  writeDb: QualifyRatingQueryDb;
  /** The rating fold, injected from app (parity with the interactive surface — never reimplement). */
  rate: QualifyRatePairFn;
  /** Pinned cross-tenant pair [BXR, Indigo] — the same array every Qualify read scopes on. */
  entityIds: string[];
  /** Anchor date 'YYYY-MM-DD' (UTC). Injectable for tests; default = today UTC. The newest
   *  COMPUTED as_of is always `today - 1` — the newest closed date (see the anchor note below). */
  today?: string;
  horizonDays?: number;
  maxDatesPerRun?: number;
  windowDays?: number;
  triggeredBy?: 'cron' | 'manual';
  /** Monotonic clock (ms) for durations; injectable for tests. */
  now?: () => number;
}

/** Non-PHI run summary — safe to log and return to the (authed) cron caller. */
export interface QualifyRatingHistoryStats {
  ok: boolean;
  dates_computed: number;
  pairs_written: number;
  /** as_of dates still missing in the horizon AFTER this run (0 in steady state). */
  dates_pending: number;
  duration_ms: number;
  /** First/last as_of computed this run (ISO dates), null when nothing was pending. */
  from_date: string | null;
  to_date: string | null;
}

// ── Pure SQL builders (hermetically testable; values are $n params, identifiers fixed literals) ──

/** Dates in the trailing horizon with no ok=true run yet, oldest first, capped. Reads the run-log
 *  only — a date that computed ZERO pairs still closes its run row, so it never re-runs forever. */
export function buildMissingAsOfDatesQuery(
  today: string,
  horizonDays: number,
  cap: number,
): { sql: string; params: unknown[] } {
  return {
    sql:
      'select to_char(d.d::date, \'YYYY-MM-DD\') as as_of ' +
      "from generate_series($1::date - ($2::int - 1), $1::date, interval '1 day') as d(d) " +
      'where not exists (select 1 from collections.qualify_rating_run r ' +
      'where r.as_of_date = d.d::date and r.ok = true) ' +
      'order by d.d asc limit $3::int',
    params: [today, horizonDays, cap],
  };
}

/**
 * The one scan per as_of date: (prefix, payer, facility) aggregates for the rate callback PLUS the
 * (prefix, payer) pair-grain row via GROUPING SETS — pair-level distinct_patients cannot be summed
 * from facility slices (one member at two facilities would double-count), so it must come from its
 * own grouping. Aggregate shapes MIRROR buildFacilityRankingQuery's inner select + the
 * FACILITY_DIM_JOINS crosswalk (src/collections/qualifyQuery.ts) — the reliable-allowed ruling
 * (tier e2 excluded, 0059) and the [from, to) half-open payment_received window included. Kept as a
 * restated mirror rather than an export from qualifyQuery.ts so this module never forces edits in
 * the file the search rewrite owns; test/qualifyRatingHistory.test.ts pins the shape.
 */
export function buildRatingHistoryAggQuery(
  entityIds: string[],
  from: string,
  to: string,
): { sql: string; params: unknown[] } {
  assertEntityScope(entityIds, 'qualifyRatingHistory.buildRatingHistoryAggQuery');
  const sql =
    'select agg.member_id_prefix_bidx, agg.primary_payer, agg.facility, ' +
    'agg.line_count, agg.distinct_patients, agg.confirmed_claims, ' +
    'agg.billed, agg.allowed, agg.pct_allowed, agg.paid, agg.median_days_to_payment, ' +
    'max(f.facility_name) as facility_name, ' +
    'max(f.care_setting) as care_setting, ' +
    'max(coalesce(fe.facility_code, a.facility_code)) as facility_code ' +
    'from (' +
    'select member_id_prefix_bidx, primary_payer, facility, ' +
    'count(*)::int as line_count, ' +
    // opaque keyed-HMAC token: COUNTED for the sample gate, NEVER projected (qualifyQuery discipline)
    'count(distinct member_id_bidx)::int as distinct_patients, ' +
    "count(*) filter (where allowed_tier in ('a','cd','e1'))::int as confirmed_claims, " +
    'sum(charge_amount)::float8 as billed, ' +
    // reliable allowed, tier e2 excluded — RANKING_RELIABLE_SELECT's ruling (0059), restated
    "(sum(allowed_reliable) filter (where allowed_tier <> 'e2'))::float8 as allowed, " +
    'case when sum(charge_amount) > 0 then ' +
    "round((sum(allowed_reliable) filter (where allowed_tier <> 'e2')) / sum(charge_amount) * 100, 2)::float8 " +
    'end as pct_allowed, ' +
    'sum(insurance_payments)::float8 as paid, ' +
    'percentile_cont(0.5) within group (order by (payment_received - charge_date)::float8) ' +
    'filter (where charge_date is not null and payment_received is not null)::float8 as median_days_to_payment ' +
    'from collections.cmd_explorer_charge_rollup ' +
    // Deliberate cross-tenant exception: this aggregate is requested for the validated entity scope.
    'where business_entity_id = any($1::uuid[]) ' +
    'and payment_received >= $2::date and payment_received < $3::date ',
    'and member_id_prefix_bidx is not null ' +
    "and primary_payer is not null and btrim(primary_payer) <> '' " +
    "and facility is not null and btrim(facility) <> '' " +
    'group by grouping sets ' +
    '((member_id_prefix_bidx, primary_payer, facility), (member_id_prefix_bidx, primary_payer))' +
    ') agg ' +
    // mirror of FACILITY_DIM_JOINS (qualifyQuery.ts): exact-name match, else the alias crosswalk
    'left join collections.facilities fe on upper(fe.facility_name) = upper(agg.facility) ' +
    'left join collections.cmd_facility_aliases a on upper(a.facility_text) = upper(agg.facility) ' +
    'left join collections.facilities f on f.facility_code = coalesce(fe.facility_code, a.facility_code) ' +
    'group by agg.member_id_prefix_bidx, agg.primary_payer, agg.facility, ' +
    'agg.line_count, agg.distinct_patients, agg.confirmed_claims, ' +
    'agg.billed, agg.allowed, agg.pct_allowed, agg.paid, agg.median_days_to_payment ' +
    'order by agg.member_id_prefix_bidx, agg.primary_payer, agg.facility nulls first';
  return { sql, params: [entityIds, from, to] };
}

/** One rated pair, ready for the daily upsert. */
export interface QualifyRatingDailyRow {
  token: string;
  payer: string;
  rating: number | null;
  band: string | null;
  lineCount: number;
  distinctMembers: number;
  confirmedClaims: number;
  pctAllowed: number | null;
  medianDaysToPayment: number | null;
  facilityCount: number;
  ratedFacilities: number;
  billed: number | null;
  allowed: number | null;
  paid: number | null;
}

/** Multi-row idempotent upsert via aligned unnest arrays — ONE autocommit statement per as_of
 *  date. ON CONFLICT (the 0093 PK) makes a re-run of the same date overwrite in place. */
export function buildRatingDailyUpsert(
  asOf: string,
  windowDays: number,
  rows: QualifyRatingDailyRow[],
): { sql: string; params: unknown[] } {
  const sql =
    'insert into collections.qualify_policy_rating_daily ' +
    '(as_of_date, member_id_prefix_bidx, primary_payer, window_days, rating, band, ' +
    'line_count, distinct_members, confirmed_claims, pct_allowed, median_days_to_payment, ' +
    'facility_count, rated_facilities, billed_amount, allowed_amount, paid_amount) ' +
    'select $1::date, t.token, t.payer, $2::int, t.rating, t.band, ' +
    't.line_count, t.members, t.confirmed, t.pct_allowed, t.median_dtp, ' +
    't.fac_count, t.rated_facs, t.billed, t.allowed, t.paid ' +
    'from unnest($3::text[], $4::text[], $5::int[], $6::text[], $7::int[], $8::int[], $9::int[], ' +
    '$10::float8[], $11::float8[], $12::int[], $13::int[], $14::float8[], $15::float8[], $16::float8[]) ' +
    'as t(token, payer, rating, band, line_count, members, confirmed, pct_allowed, median_dtp, ' +
    'fac_count, rated_facs, billed, allowed, paid) ' +
    'on conflict (as_of_date, member_id_prefix_bidx, primary_payer) do update set ' +
    'window_days = excluded.window_days, rating = excluded.rating, band = excluded.band, ' +
    'line_count = excluded.line_count, distinct_members = excluded.distinct_members, ' +
    'confirmed_claims = excluded.confirmed_claims, pct_allowed = excluded.pct_allowed, ' +
    'median_days_to_payment = excluded.median_days_to_payment, ' +
    'facility_count = excluded.facility_count, rated_facilities = excluded.rated_facilities, ' +
    'billed_amount = excluded.billed_amount, allowed_amount = excluded.allowed_amount, ' +
    'paid_amount = excluded.paid_amount, computed_at = now()';
  return {
    sql,
    params: [
      asOf,
      windowDays,
      rows.map((r) => r.token),
      rows.map((r) => r.payer),
      rows.map((r) => r.rating),
      rows.map((r) => r.band),
      rows.map((r) => r.lineCount),
      rows.map((r) => r.distinctMembers),
      rows.map((r) => r.confirmedClaims),
      rows.map((r) => r.pctAllowed),
      rows.map((r) => r.medianDaysToPayment),
      rows.map((r) => r.facilityCount),
      rows.map((r) => r.ratedFacilities),
      rows.map((r) => r.billed),
      rows.map((r) => r.allowed),
      rows.map((r) => r.paid),
    ],
  };
}

/** The tape read: latest snapshot vs exactly deltaDays earlier, both endpoints rated, member floor
 *  applied, top-N by absolute movement. NON-DOLLAR projection by construction (admissions_seat-safe
 *  — the buildBookKpisQuery precedent: dollar columns exist in the table and are never projected).
 *  The token IS projected here — it is the pair's identity for the UI (doctrine: the keyed-HMAC
 *  token is not PHI; blindIndex.ts) — alongside the ≤3-char echo when one is on file (0093 seam). */
export function buildPolicyTapeQuery(opts?: {
  deltaDays?: number;
  minMembers?: number;
  limit?: number;
}): { sql: string; params: unknown[] } {
  // Bounds-clamp (defense-in-depth; callers pass constants).
  const deltaDays = Math.min(Math.max(Math.trunc(opts?.deltaDays ?? QUALIFY_TAPE_DELTA_DAYS), 1), 3650);
  const minMembers = Math.min(Math.max(Math.trunc(opts?.minMembers ?? QUALIFY_TAPE_MIN_MEMBERS), 0), 1000);
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? QUALIFY_TAPE_TOP_N), 1), 100);
  const sql =
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
    'and cur.distinct_members >= $2::int ' +
    'order by abs(cur.rating - prev.rating) desc, cur.rating desc, cur.primary_payer asc, cur.member_id_prefix_bidx asc ' +
    'limit $3::int';
  return { sql, params: [deltaDays, minMembers, limit] };
}

/** Raw tape row (loader-side type; the app contract mirrors it in camelCase). */
export interface QualifyPolicyTapeRow {
  member_id_prefix_bidx: string;
  token_tail: string;
  echo: string | null;
  primary_payer: string;
  rating_now: number;
  band_now: string | null;
  rating_then: number;
  delta_pts: number;
  distinct_members: number;
  line_count: number;
  window_days: number;
  as_of: string;
}

// ── Date helpers (UTC, pure) ─────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' + n days, UTC-safe (no DST drift — date math on epoch days). */
export function addDaysIso(iso: string, days: number): string {
  if (!ISO_DATE.test(iso)) throw new Error(`Invalid ISO date: ${iso.slice(0, 16)}`);
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── The work module ──────────────────────────────────────────────────────────────────────────────

const PAIR_SEP = ''; // literal control-char separator (the facilityKey precedent)

/**
 * Compute + persist every missing daily snapshot in the horizon. Returns non-PHI stats. On a
 * per-date failure: the failure is recorded on that date's run row (best-effort) and the error
 * RETHROWN — later dates stay missing and the next run self-heals them. Never swallows.
 */
export async function runQualifyRatingHistory(deps: QualifyRatingHistoryDeps): Promise<QualifyRatingHistoryStats> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const today = deps.today ?? todayUtcIso();
  if (!ISO_DATE.test(today)) throw new Error('Invalid anchor date.');
  const horizonDays = deps.horizonDays ?? QUALIFY_RATING_HISTORY_HORIZON_DAYS;
  const maxDates = deps.maxDatesPerRun ?? QUALIFY_RATING_HISTORY_MAX_DATES;
  const windowDays = deps.windowDays ?? QUALIFY_RATING_HISTORY_WINDOW_DAYS;
  const triggeredBy = deps.triggeredBy ?? 'cron';
  assertEntityScope(deps.entityIds, 'qualifyRatingHistory.runQualifyRatingHistory');

  // 1. Which as_of dates still need computing (oldest first)? Run-log is the ledger. The horizon
  //    bounds the result at ~180 tiny rows, so fetch ALL missing dates and cap locally — that makes
  //    dates_pending an exact count, not a guess.
  //
  //    ⚠ ANCHORED AT YESTERDAY, NOT TODAY (review 2026-08-08, CONFIRMED finding): at the 05:10 UTC
  //    run time, payment_received = today rows have barely begun ingesting, so an as_of=today
  //    snapshot would rate a ~89-day effective window, close ok=true, and FREEZE — permanently
  //    diverging from the interactive number computed later the same day, and skewing the tape's
  //    "now" endpoint against fully-ingested backfill endpoints. Yesterday is the newest CLOSED
  //    date: by 05:10 UTC its business day's hourly ingests have long finished. The tape therefore
  //    reads "as of yesterday's close" — the stock-tape semantic the UI already implies.
  const latestClosedDate = addDaysIso(today, -1);
  const missingQ = buildMissingAsOfDatesQuery(latestClosedDate, horizonDays, horizonDays);
  const missingRes = await deps.writeDb.query<{ as_of: string }>(missingQ.sql, missingQ.params);
  const missingAll = missingRes.rows.map((r) => r.as_of);
  const missing = missingAll.slice(0, maxDates);
  const pending = missingAll.length - missing.length;
  /** Per-date failures collected so ONE poison date cannot starve every newer date (review
   *  2026-08-08, CONFIRMED finding) — the loop records + continues, then throws at the end. */
  const failures: Array<{ asOf: string; message: string }> = [];

  let pairsWritten = 0;
  let datesComputed = 0;

  for (const asOf of missing) {
    // 2. Durable start row FIRST (own autocommit statement — survives a platform kill as the
    //    ok/finished_at NULL "started but unfinished" signal; refreshChargeRollup's model).
    const startRes = await deps.writeDb.query<{ id: string }>(
      'insert into collections.qualify_rating_run (as_of_date, triggered_by) values ($1, $2) returning id',
      [asOf, triggeredBy],
    );
    const runId = Number(startRes.rows[0]!.id);
    const dateStartMs = now();

    try {
      // 3. One aggregate scan for this date's trailing window (half-open [from, to)).
      const from = addDaysIso(asOf, -(windowDays - 1));
      const to = addDaysIso(asOf, 1);
      const aggQ = buildRatingHistoryAggQuery(deps.entityIds, from, to);
      const aggRes = await deps.readDb.query<QualifyRatingHistoryAggRow>(aggQ.sql, aggQ.params);

      // 4. Group by pair; facility rows feed the rate callback, the pair-grain row (facility null)
      //    carries the deduped member count + pair-level median for storage.
      const byPair = new Map<string, { pairRow: QualifyRatingHistoryAggRow | null; facs: QualifyRatingHistoryAggRow[] }>();
      for (const row of aggRes.rows) {
        const key = `${row.member_id_prefix_bidx}${PAIR_SEP}${row.primary_payer}`;
        let entry = byPair.get(key);
        if (!entry) {
          entry = { pairRow: null, facs: [] };
          byPair.set(key, entry);
        }
        if (row.facility === null) entry.pairRow = row;
        else entry.facs.push(row);
      }

      const dailyRows: QualifyRatingDailyRow[] = [];
      for (const [, entry] of byPair) {
        // A pair-grain row always exists for a pair with any facility rows (GROUPING SETS emits
        // both grains from the same groups); tolerate its absence anyway rather than crash a run.
        const anchor = entry.pairRow ?? entry.facs[0];
        if (!anchor) continue;
        const rated = deps.rate({
          payer: anchor.primary_payer,
          facilities: entry.facs.map((f) => ({
            facility: f.facility as string,
            facilityCode: f.facility_code,
            careSetting: f.care_setting,
            lineCount: f.line_count,
            distinctPatients: f.distinct_patients,
            confirmedClaims: f.confirmed_claims,
            pctAllowed: f.pct_allowed,
            medianDaysToPayment: f.median_days_to_payment,
          })),
          asOf,
          windowDays,
        });
        dailyRows.push({
          token: anchor.member_id_prefix_bidx,
          payer: anchor.primary_payer,
          rating: rated.rating,
          band: rated.band,
          lineCount: anchor.line_count,
          distinctMembers: anchor.distinct_patients,
          confirmedClaims: anchor.confirmed_claims,
          pctAllowed: anchor.pct_allowed,
          medianDaysToPayment: anchor.median_days_to_payment,
          facilityCount: entry.facs.length,
          ratedFacilities: rated.ratedFacilities,
          billed: anchor.billed,
          allowed: anchor.allowed,
          paid: anchor.paid,
        });
      }

      // 5. One idempotent upsert statement for the date (skip when the window is truly empty).
      if (dailyRows.length > 0) {
        const up = buildRatingDailyUpsert(asOf, windowDays, dailyRows);
        await deps.writeDb.query(up.sql, up.params);
      }

      // 6. Close the run row ok=true — this is what marks the date done for the catch-up query.
      await deps.writeDb.query(
        'update collections.qualify_rating_run set finished_at = now(), duration_ms = $1, ok = true, pairs_written = $2 where id = $3',
        [now() - dateStartMs, dailyRows.length, runId],
      );
      pairsWritten += dailyRows.length;
      datesComputed += 1;
    } catch (err) {
      // Record the failure on the SAME row (best-effort — never mask the original error), then
      // CONTINUE to the remaining dates: a date whose failure is deterministic must not starve
      // every newer snapshot behind it (review 2026-08-08). The run still FAILS at the end —
      // failures are collected, never swallowed (the refreshChargeRollup discipline).
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ asOf, message });
      try {
        await deps.writeDb.query(
          'update collections.qualify_rating_run set finished_at = now(), duration_ms = $1, ok = false, error = $2 where id = $3',
          [now() - dateStartMs, message, runId],
        );
      } catch (recordErr) {
        console.error(
          'qualify-rating-history: failed to record the failure row (original error preserved):',
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        );
      }
    }
  }

  if (failures.length > 0) {
    // The route surfaces this as a generic 500; per-date detail is durable in the run-log rows.
    throw new Error(
      `qualify-rating-history: ${failures.length} of ${missing.length} as_of date(s) failed — first (${failures[0]!.asOf}): ${failures[0]!.message}`,
    );
  }

  return {
    ok: true,
    dates_computed: datesComputed,
    pairs_written: pairsWritten,
    dates_pending: pending,
    duration_ms: now() - startedMs,
    from_date: missing[0] ?? null,
    to_date: missing[missing.length - 1] ?? null,
  };
}
