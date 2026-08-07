/**
 * COMPLETED-STAY OUTCOMES SYNC — keeps collections.qualify_facility_outcomes (0091) fresh from the
 * executive dashboard's census history, so the Qualify auth-fit factor scores FINISHED admissions
 * rather than stays still in progress.
 *
 * WHY THIS EXISTS: the monday census boards this repo already reads are a snapshot of clients
 * CURRENTLY ADMITTED, so their "length of stay" is today-minus-admit — a stay that has not ended.
 * Measured 2026-08-06, that read put all twelve residential facilities BELOW their authorization
 * (0.69-0.96), so the overrun penalty could never fire for anyone; on completed stays four are at or
 * over it. The source here carries a real discharge date on 93.4% of rows and 47-165 authorized-day
 * values per facility, against the snapshot's 4-15.
 *
 * ┌─ PHI: AGGREGATE-ONLY, AND THIS IS THE LOAD-BEARING PROPERTY ─────────────────────────────────┐
 * │ The GROUP BY runs IN THE SOURCE DATABASE. What crosses the wire is one row per facility —     │
 * │ counts and day-averages. No patient row is ever selected, transferred, or held in memory here. │
 * │                                                                                                │
 * │ That is deliberate and must not be "optimized" into a row-level copy for flexibility. The      │
 * │ source table is patient-grain: it carries no name, but facility + admit date + discharge date  │
 * │ is a limited data set, and copying it would multiply PHI surface across a project boundary for │
 * │ nothing this factor needs. If per-stay detail is ever genuinely required, that is a separate   │
 * │ decision with its own review — not a widening of this query.                                   │
 * └────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * TWO DATABASES, TWO ROLES: reads come from the source project over EXEC_CENSUS_DATABASE_URL; writes
 * go to THIS project's collections plane as cmd_rollup_writer, the same least-privilege writer every
 * other collections cron uses. The source credential is read-only in intent and this module only
 * ever issues a SELECT — there is no write path back to it.
 */
import type pg from 'pg';

/** Trailing window, in days, measured BY DISCHARGE DATE. 365 keeps per-facility samples in the
 *  47-165 range measured 2026-08-06; a shorter window thins the auth side back toward the snapshot's
 *  4-15, which is the problem this sync exists to solve. Stored on the row so the number stays
 *  self-describing when it is retuned. */
export const OUTCOMES_WINDOW_DAYS = 365;

/** Row shape returned by the source aggregate — facility-grain, no patient data. */
export interface FacilityOutcomeRow {
  facility: string;
  stays_sample: number;
  avg_los_days: number | null;
  auth_sample: number;
  avg_auth_days: number | null;
}

/**
 * Source `facility` label -> this repo's `collections.facilities.facility_code`.
 *
 * EXPLICIT, NOT FUZZY. Every pair below was verified 2026-08-06 by reading facility_name out of the
 * live roster ('Opus' -> 10021573 OPUS HEALTH, 'SVR' -> 10025950 SILICON VALLEY RECOVERY, and so
 * on). A name-similarity match would be one rename away from silently writing another facility's
 * length of stay onto a card, and qualify_facility_outcomes has a FK to the roster, so a wrong code
 * would either error or — worse, if it happened to resolve — attribute real numbers to the wrong
 * building. An unmapped source facility is REPORTED, never guessed at (see unmapped below).
 *
 * The roster mixes two keying conventions: BXR facilities are mnemonics, Indigo facilities are
 * 8-digit CMD customer ids. Both appear here, verbatim from collections.facilities.
 */
export const OUTCOME_FACILITY_CODES: Readonly<Record<string, string>> = {
  Opus: '10021573',
  SVR: '10025950',
  Hillside: '10026624',
  Revival: '10028595',
  CAMH: 'CAMH',
  Nashville: 'NASH',
  Lonestar: 'LSMH',
  Tennessee: 'TBH',
  Dallas: 'DMH',
  Kentucky: 'KWC',
  LAMH: 'LAMH',
  Pacific: 'PCMH',
};

/**
 * Source facilities deliberately NOT mapped, each with the reason. Listed rather than omitted so a
 * future reader can tell "we decided against this" from "nobody noticed it".
 */
export const OUTCOME_EXCLUDED: Readonly<Record<string, string>> = {
  MHC: 'care_setting BOTH (10024431) — runs residential AND outpatient, so one blended LOS mixes two quantities. Same reason its census board is deferred.',
  AMH: 'no facility_code in collections.facilities, and zero authorized-day values on file',
  'Wellness Recovery': 'still unseeded in the roster (named in the 0006 header); one completed stay',
};

/**
 * The source aggregate. Completed stays only — a real discharge date, and a non-negative length.
 *
 * `dc_date >= adm_date` is not defensive noise: a reversed pair would contribute a NEGATIVE length
 * of stay to an average that feeds a rating factor, and silently pull a facility's number down.
 * Windowed BY DISCHARGE DATE, because a stay belongs to the period it FINISHED in — windowing on
 * admission would let a long stay that started 18 months ago vanish from every window.
 */
export const OUTCOMES_SOURCE_SQL =
  'select facility, ' +
  'count(*)::int as stays_sample, ' +
  'round(avg(dc_date - adm_date)::numeric, 2)::float8 as avg_los_days, ' +
  'count(total_auth_days)::int as auth_sample, ' +
  'round(avg(total_auth_days)::numeric, 2)::float8 as avg_auth_days ' +
  'from public.census_records ' +
  'where dc_date is not null and adm_date is not null and dc_date >= adm_date ' +
  '  and dc_date >= current_date - $1::int ' +
  'group by facility';

/** UPSERT one facility's outcome row. Values bound; identifiers fixed literals. */
export const OUTCOMES_UPSERT_SQL =
  'insert into collections.qualify_facility_outcomes ' +
  '(facility_code, stays_sample, avg_los_days, auth_sample, avg_auth_days, window_days, source, synced_at) ' +
  'values ($1, $2, $3, $4, $5, $6, $7, now()) ' +
  'on conflict (facility_code) do update set ' +
  'stays_sample = excluded.stays_sample, avg_los_days = excluded.avg_los_days, ' +
  'auth_sample = excluded.auth_sample, avg_auth_days = excluded.avg_auth_days, ' +
  'window_days = excluded.window_days, source = excluded.source, synced_at = now()';

export const OUTCOMES_SOURCE_LABEL = 'exec-dashboard/census_records';

export interface OutcomesSyncStats {
  facilities_source: number;
  facilities_written: number;
  /** Source facilities with no mapping AND no recorded exclusion — the actionable list. A facility
   *  that appears upstream and is silently dropped is how a card goes stale without anyone noticing. */
  unmapped: string[];
  /** Mapped facilities skipped because the window held too little to be worth storing. */
  skipped_thin: string[];
}

/**
 * Minimum completed stays before a facility's averages are worth storing. Mirrors
 * QUALIFY_AUTH_FIT_MIN_SAMPLE (3): below it the rating layer suppresses the factor anyway, so
 * writing the row would only replace a good previous value with a worse one on a quiet window.
 */
export const OUTCOMES_MIN_STAYS = 3;

/**
 * Run one sync. `source` reads the exec-dashboard project; `writer` is this project's
 * cmd_rollup_writer connection. Kept as two injected clients so the whole thing is testable without
 * either database.
 */
export async function runFacilityOutcomesSync(
  source: Pick<pg.PoolClient, 'query'>,
  writer: Pick<pg.PoolClient, 'query'>,
  opts: { windowDays?: number } = {},
): Promise<OutcomesSyncStats> {
  const windowDays = opts.windowDays ?? OUTCOMES_WINDOW_DAYS;
  const { rows } = await source.query<FacilityOutcomeRow>(OUTCOMES_SOURCE_SQL, [windowDays]);

  const stats: OutcomesSyncStats = {
    facilities_source: rows.length,
    facilities_written: 0,
    unmapped: [],
    skipped_thin: [],
  };

  for (const r of rows) {
    const code = OUTCOME_FACILITY_CODES[r.facility];
    if (code === undefined) {
      // A KNOWN exclusion is silent; anything else is reported, because an unrecognised upstream
      // facility means either a rename or a genuinely new one, and both need a human.
      if (OUTCOME_EXCLUDED[r.facility] === undefined) stats.unmapped.push(r.facility);
      continue;
    }
    if (r.stays_sample < OUTCOMES_MIN_STAYS || r.avg_los_days === null) {
      stats.skipped_thin.push(r.facility);
      continue;
    }
    await writer.query(OUTCOMES_UPSERT_SQL, [
      code,
      r.stays_sample,
      r.avg_los_days,
      r.auth_sample,
      // avg over zero non-null values is NULL, which is the honest value — the rating layer reads
      // auth_sample alongside it and suppresses rather than dividing by a fabricated number.
      r.avg_auth_days,
      windowDays,
      OUTCOMES_SOURCE_LABEL,
    ]);
    stats.facilities_written++;
  }

  if (stats.unmapped.length > 0) {
    // Facility labels are non-PHI (they are buildings, not people), so this is safe to log and is
    // the only channel that surfaces a rename before the numbers quietly go stale.
    console.error(`facility-outcomes: ${stats.unmapped.length} unmapped source facilit(ies): ${stats.unmapped.join(', ')}`);
  }
  return stats;
}
