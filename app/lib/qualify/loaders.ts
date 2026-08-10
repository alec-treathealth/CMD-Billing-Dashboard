/**
 * Qualify v2 DATA LOADERS — the server-side read layer for the v2 additions (policy resolution,
 * VOB freshness, the auto-window rungs, the coding registry, census aggregates). SERVER-ONLY: this
 * module builds a pg pool; importing it from a Client Component fails the build loudly.
 *
 * Deliberately NOT in app/lib/server.ts: that composition root is under active concurrent
 * development, and the second-pool pattern is already established there (verisReaderPool — "a slow
 * read can't pin the shared app pool"). This pool is the same shape: claims_reader, max 4,
 * verify-full TLS via the ONE ssl.ts path, unnamed parameterized queries only (Supavisor 6543).
 */
import { PgExecutor, makeReaderPool, readerConnectionStringFromEnv } from '../../../src/queries/executor';
import {
  buildQualifyPolicyQuery,
  buildQualifyPolicySpreadQuery,
  buildQualifyVobFreshnessQuery,
  buildQualifyWindowRungsQuery,
  type QualifyPolicyRow,
  type QualifyPolicySpreadRow,
  type QualifyWindowRungsRow,
} from '../../../src/collections/qualifyPolicyQuery';
import {
  buildCurrentCodingDecisionsQuery,
  buildCodingDecisionHistoryQuery,
  type CodingDecisionRow,
} from '../../../src/collections/codingRegistryQuery';
import { buildQualifyCensusReadQuery, buildQualifyOutcomesReadQuery } from '../../../src/collections/qualifyCensus';
import { buildRollupRefreshFreshnessQuery } from '../../../src/collections/rollupFreshnessQuery';
import type { QualifyTokenKind } from '../../../src/collections/qualifyQuery';
import {
  buildPolicyTapeQuery,
  buildPolicyTapeContextQuery,
  QUALIFY_RATING_HISTORY_WINDOW_DAYS,
  addDaysIso,
  type QualifyPolicyTapeRow,
  type QualifyPolicyTapeContextRow,
} from '../../../src/collections/qualifyRatingHistory';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../../../src/tenants';
import { facilityLocation } from './facilityLocations';
import type { QualifyPolicyTapeContext } from './board';
import {
  buildRecentSearchListQuery,
  buildWatcherListQuery,
  buildWatcherSeriesQuery,
  type QualifyRecentSearchRow,
  type QualifyWatcherRow,
  type QualifyWatcherSeriesRow,
} from '../../../src/collections/qualifyWatchers';

let executor: PgExecutor | null = null;
/** Module-cached executor on a SEPARATE small claims_reader pool (the verisReaderPool precedent). */
function qualifyV2Reader(): PgExecutor {
  if (!executor) executor = new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return executor;
}

/** Policy on file behind a member/prefix token (Phase B). One aggregate row always. */
export async function loadQualifyPolicy(
  token: string,
  kind: Exclude<QualifyTokenKind, 'client_name'>,
): Promise<QualifyPolicyRow> {
  const q = buildQualifyPolicyQuery(token, kind);
  const res = await qualifyV2Reader().query<QualifyPolicyRow>(q.sql, q.params);
  return (
    res.rows[0] ?? {
      member_count: 0,
      carrier: null,
      employer_name: null,
      employer_norm: null,
      employer_count: 0,
      carrier_count: 0,
      funding: null,
      policy_type: null,
      plan_type: null,
      group_on_file: false,
      vob_fresh_as_of: null,
      deductible: null,
      deductible_met: null,
      oop_max: null,
      oop_met: null,
    }
  );
}

/** The employer + carrier spread behind a token, ranked and capped (QUALIFY_SPREAD_LIMIT).
 *
 *  ⚠ The returned employer rows carry employer_norm and are SERVER-SIDE ONLY — getQualifySnapshotCore
 *  splits them off at its PHI forwarding boundary and never puts them on the wire. Returning them
 *  from this loader is intentional: the comparable-cohort join key needs them. */
export async function loadQualifyPolicySpread(
  token: string,
  kind: Exclude<QualifyTokenKind, 'client_name'>,
): Promise<QualifyPolicySpreadRow[]> {
  const q = buildQualifyPolicySpreadQuery(token, kind);
  const res = await qualifyV2Reader().query<QualifyPolicySpreadRow>(q.sql, q.params);
  return res.rows;
}

/** Global VOB feed high-water mark as a FULL UTC ISO timestamp (exact staleness math in core).
 *  Null on an empty matview. */
export async function loadQualifyVobFreshness(): Promise<string | null> {
  const q = buildQualifyVobFreshnessQuery();
  const res = await qualifyV2Reader().query<{ fresh_as_of: string | null }>(q.sql, q.params);
  return res.rows[0]?.fresh_as_of ?? null;
}

/**
 * WHEN THE RANKING INDEX WAS LAST REBUILT — `collections.rollup_refresh_run.finished_at` for the
 * newest ok run, as a full UTC ISO timestamp. Null when the log is empty, when no run has ever
 * completed ok, or when the read fails (see the caller's fail-soft).
 *
 * ⚠ THIS IS THE FIRST APP-PATH READER OF THAT TABLE (S5, 2026-08-08). Until now only writers existed
 * — the hourly `/api/cron/refresh-charge-rollup` route as `cmd_rollup_writer`. `claims_reader` holds
 * BOTH gates already (0054:68 grant, 0054:89-90 SELECT policy, RLS on), verified live as the
 * reader's own privileges rather than read off the migration text: the 0089 incident is exactly the
 * case where a GRANT existed, a POLICY did not, and the silent empty result became permanently wrong
 * data behind a fail-soft catch. No migration, no new grant.
 *
 * ⚠ THE COLUMN CHOICE IS THE WHOLE DECISION, and `buildRollupRefreshFreshnessQuery` carries the
 * argument: `max(ingested_at)` is first-seen (42h stale on a healthy weekend) and
 * `rollup_max_payment_date` reads five days into the FUTURE. Both are pinned out at the SQL.
 *
 * Non-PHI: one operational timestamp, no tenant, no identifier, no user input.
 */
export async function loadRollupRefreshFreshness(): Promise<string | null> {
  const q = buildRollupRefreshFreshnessQuery();
  const res = await qualifyV2Reader().query<{ rebuilt_at: string | null }>(q.sql, q.params);
  return res.rows[0]?.rebuilt_at ?? null;
}

/** The five-rung distinct-patient counts in ONE scan (Phase E). */
export async function loadQualifyWindowRungs(
  token: string,
  kind: Exclude<QualifyTokenKind, 'client_name'>,
  entityIds: string[],
  froms: { d30: string; d60: string; d90: string; d180: string; d365: string },
  to: string,
): Promise<QualifyWindowRungsRow> {
  const q = buildQualifyWindowRungsQuery(token, kind, entityIds, froms, to);
  const res = await qualifyV2Reader().query<QualifyWindowRungsRow>(q.sql, q.params);
  return res.rows[0] ?? { p30: 0, p60: 0, p90: 0, p180: 0, p365: 0 };
}

/** Postgres error codes that mean "the registry isn't there yet", not "the database is down".
 *  0077 creates schema + tables + grants in ONE apply, so there is no legitimate partially-granted
 *  steady state — 42501 (insufficient_privilege) is deliberately NOT here: after apply, a
 *  permission error is a real outage and must surface, never masquerade as "unseeded"
 *  (review finding #3 — the confidently-wrong axis). */
const REGISTRY_ABSENT_CODES = new Set(['42P01' /* undefined_table */, '3F000' /* invalid_schema_name */]);

function registryAbsent(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
  const absent = REGISTRY_ABSENT_CODES.has(code);
  // SQLSTATE is non-PHI; the swallow must stay discoverable in server logs.
  if (absent) console.error(`coding registry unavailable (sqlstate ${code}) — treating as unseeded`);
  return absent;
}

/**
 * All CURRENT coding decisions (Phase A) — FAIL-SOFT on the known "migration 0077 not applied yet"
 * error class (the PR-migrations-not-auto-applied incident pattern): the factor then reads
 * `seeded:false` and rating v2 renormalizes the coding weight away instead of 500ing the page.
 * Any OTHER error rethrows — a real outage must never masquerade as "registry unseeded".
 */
export async function loadCurrentCodingDecisions(): Promise<{ seeded: boolean; rows: CodingDecisionRow[] }> {
  const q = buildCurrentCodingDecisionsQuery();
  try {
    const res = await qualifyV2Reader().query<CodingDecisionRow>(q.sql, q.params);
    return { seeded: res.rows.length > 0, rows: res.rows };
  } catch (err) {
    if (registryAbsent(err)) return { seeded: false, rows: [] };
    throw err;
  }
}

/** Registry history for the CRUD surface (current + superseded), bounded. Same fail-soft class. */
export async function loadCodingDecisionHistory(limit = 500): Promise<{ available: boolean; rows: CodingDecisionRow[] }> {
  const q = buildCodingDecisionHistoryQuery(limit);
  try {
    const res = await qualifyV2Reader().query<CodingDecisionRow>(q.sql, q.params);
    return { available: true, rows: res.rows };
  } catch (err) {
    if (registryAbsent(err)) return { available: false, rows: [] };
    throw err;
  }
}


/** Per-facility monday-census aggregates (Phase G) — FAIL-SOFT while 0078 is unapplied: the
 *  auth-fit factor reads unavailable and the UR/beds chips stay absent, never a 500. Aggregate
 *  facility-grain rows only (no PHI exists on this path). */
export async function loadQualifyCensusAuth(): Promise<
  Array<{ facility_code: string; board_family: string | null; avg_auth_days: number | null; avg_los_days: number | null; auth_sample: number | null; los_sample: number | null; next_ur_date: string | null; open_beds: number | null; bed_capacity: number | null }>
> {
  const q = buildQualifyCensusReadQuery();
  try {
    const res = await qualifyV2Reader().query<{
      facility_code: string;
      board_family: string | null;
      avg_auth_days: number | null;
      avg_los_days: number | null;
      auth_sample: number | null;
      los_sample: number | null;
      next_ur_date: string | null;
      open_beds: number | null;
      bed_capacity: number | null;
    }>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
    if (code === '42P01') {
      console.error('qualify census table absent (0078 unapplied) — auth-fit factor unavailable');
      return [];
    }
    throw err;
  }
}

/** Completed-stay LOS/auth per facility (0091) — FAIL-SOFT on 42P01 while the table is unapplied,
 *  exactly like the census reader above: the auth-fit factor then falls back to the in-progress
 *  census snapshot rather than 500ing. Any OTHER error rethrows — a real outage must not read as
 *  "no outcomes on file". Aggregate facility-grain rows; no PHI on this path. */
export async function loadQualifyFacilityOutcomes(): Promise<
  Array<{ facility_code: string; stays_sample: number; auth_sample: number; avg_los_days: number | null; avg_auth_days: number | null; window_days: number }>
> {
  const q = buildQualifyOutcomesReadQuery();
  try {
    const res = await qualifyV2Reader().query<{
      facility_code: string;
      stays_sample: number;
      auth_sample: number;
      avg_los_days: number | null;
      avg_auth_days: number | null;
      window_days: number;
    }>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
    if (code === '42P01') {
      console.error('qualify facility outcomes table absent (0091 unapplied) — auth-fit falls back to the census snapshot');
      return [];
    }
    throw err;
  }
}

/** The smoke-shell policy tape (mig 0093) — FAIL-SOFT to null on the absent-relation class
 *  (42P01/3F000) while 0093 is unapplied, the exact loaders.ts discipline: the board renders the
 *  tape lane honestly empty instead of 500ing (PR-migrations-not-auto-applied incident pattern).
 *  Any OTHER error rethrows — 42501 or an outage must never masquerade as "no snapshots yet".
 *  Its OWN absent-check rather than registryAbsent(): that helper's log line names the CODING
 *  REGISTRY, which would misdirect an operator diagnosing an unapplied 0093 (review 2026-08-08). */
export async function loadQualifyPolicyTape(): Promise<QualifyPolicyTapeRow[] | null> {
  const q = buildPolicyTapeQuery();
  try {
    const res = await qualifyV2Reader().query<QualifyPolicyTapeRow>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
    if (code === '42P01' || code === '3F000') {
      // SQLSTATE is non-PHI; the swallow must stay discoverable in server logs.
      console.error(`qualify rating history unavailable (sqlstate ${code}) — mig 0093 unapplied? tape reads as absent`);
      return null;
    }
    throw err;
  }
}

/**
 * The tape's DIMENSION context (2026-08-09) — care setting + area + facility spread per (token,
 * payer), for the ≤20 tokens the strip is about to render. See `buildPolicyTapeContextQuery` for why
 * this is a second read rather than columns on the nightly snapshot, and for the measured cost.
 *
 * The window is the SAME 90 days the snapshot rated over (`QUALIFY_RATING_HISTORY_WINDOW_DAYS`), so
 * the facility this names is the facility the rating was computed from. Anchored on TODAY rather than
 * on the snapshot's as_of, which is deliberate and worth stating: the caption answers "where does
 * this policy get treated", a present-tense operational question, while the rating answers "how did
 * it pay over the rated window". Anchoring the caption a day back to match the snapshot would buy
 * exact agreement on a question nobody is asking.
 *
 * NO try/catch HERE. The CORE owns the fail-soft (getQualifyPolicyTapeCore wraps this call), so a
 * failure degrades the captions and keeps the rows. Catching here as well would hide the cause from
 * the one place that logs it.
 */
export async function loadQualifyPolicyTapeContext(
  tokens: readonly string[],
): Promise<QualifyPolicyTapeContext[]> {
  if (tokens.length === 0) return [];
  const today = new Date().toISOString().slice(0, 10);
  const q = buildPolicyTapeContextQuery(
    [BXR_ENTITY_ID, INDIGO_ENTITY_ID],
    tokens,
    addDaysIso(today, -(QUALIFY_RATING_HISTORY_WINDOW_DAYS - 1)),
    addDaysIso(today, 1),
  );
  const res = await qualifyV2Reader().query<QualifyPolicyTapeContextRow>(q.sql, q.params);
  return res.rows.map((r) => {
    // facilityLocations.ts is the ONLY source of geography in this system — collections.facilities
    // carries no city/state. Unmapped codes return null and the UI drops the clause.
    const loc = facilityLocation(r.facility_code);
    return {
      token: r.token,
      payer: r.payer,
      careSetting: r.care_setting,
      area: loc && loc.state ? `${loc.city}, ${loc.state}` : null,
      facilityCount: r.facility_count,
    };
  });
}

// ── Watchers + recent searches (mig 0097) ─────────────────────────────────────────────────────────
//
// SAME FAIL-SOFT CLASS AS THE TAPE ABOVE, plus 42883 (undefined_function): the WRITE path calls
// SECURITY DEFINER functions, and an unapplied 0097 surfaces there as undefined_function rather
// than undefined_table. All three degrade to "relations absent" (null / persisted:false) so the
// board runs session-only instead of 500ing; any OTHER error rethrows — a 42501 must never
// masquerade as "not provisioned yet" (the 0089 lesson).

function relationAbsent(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
  return code === '42P01' || code === '3F000' || code === '42883';
}

export async function loadQualifyWatcherRows(userId: string): Promise<QualifyWatcherRow[] | null> {
  const q = buildWatcherListQuery(userId);
  try {
    const res = await qualifyV2Reader().query<QualifyWatcherRow>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    if (relationAbsent(err)) {
      console.error('qualify watchers unavailable (mig 0097 unapplied?) — board runs session-only');
      return null;
    }
    throw err;
  }
}

export async function loadQualifyRecentSearchRows(userId: string): Promise<QualifyRecentSearchRow[] | null> {
  const q = buildRecentSearchListQuery(userId);
  try {
    const res = await qualifyV2Reader().query<QualifyRecentSearchRow>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    if (relationAbsent(err)) return null; // the watcher loader above already logged the class
    throw err;
  }
}

/** Sparkline series off the 0093 daily table. NOT fail-soft here — the CORE owns that (enrichment
 *  degrades to no sparkline), same division of labor as loadQualifyPolicyTapeContext above. */
export async function loadQualifyWatcherSeries(
  subjects: readonly { token: string | null; payer: string }[],
): Promise<QualifyWatcherSeriesRow[]> {
  if (subjects.length === 0) return [];
  const q = buildWatcherSeriesQuery(subjects);
  const res = await qualifyV2Reader().query<QualifyWatcherSeriesRow>(q.sql, q.params);
  return res.rows;
}

/** One definer call each. persisted:false = 0097 unapplied (session-only mode); errors rethrow. */
export async function saveQualifyWatcherRow(args: {
  userId: string;
  kind: 'trend' | 'patient';
  payer: string | null;
  token: string | null;
  echo: string | null;
  thresholdPts: number | null;
}): Promise<{ persisted: boolean }> {
  try {
    await qualifyV2Reader().query('select claims.save_qualify_watcher($1::uuid, $2, $3, $4, $5, $6::int)', [
      args.userId,
      args.kind,
      args.payer,
      args.token,
      args.echo,
      args.thresholdPts,
    ]);
    return { persisted: true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false };
    throw err;
  }
}

export async function deleteQualifyWatcherRow(userId: string, id: string): Promise<{ persisted: boolean }> {
  try {
    await qualifyV2Reader().query('select claims.delete_qualify_watcher($1::uuid, $2::bigint)', [userId, id]);
    return { persisted: true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false };
    throw err;
  }
}

export async function recordQualifyRecentSearchRow(args: {
  userId: string;
  payer: string | null;
  echo: string | null;
  planClass: string | null;
}): Promise<{ persisted: boolean }> {
  try {
    await qualifyV2Reader().query('select claims.record_qualify_recent_search($1::uuid, $2, $3, $4)', [
      args.userId,
      args.payer,
      args.echo,
      args.planClass,
    ]);
    return { persisted: true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false };
    throw err;
  }
}

export async function clearQualifyRecentSearchRows(userId: string): Promise<{ persisted: boolean }> {
  try {
    await qualifyV2Reader().query('select claims.clear_qualify_recent_searches($1::uuid)', [userId]);
    return { persisted: true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false };
    throw err;
  }
}
