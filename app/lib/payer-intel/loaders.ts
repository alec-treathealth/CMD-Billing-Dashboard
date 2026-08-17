/**
 * Payer Intel DATA LOADERS — the server-side read/write layer for /payer-intel. SERVER-ONLY: this
 * module builds a pg pool; importing it from a Client Component fails the build loudly.
 *
 * Same second-pool shape as app/lib/qualify/loaders.ts (the verisReaderPool precedent):
 * claims_reader, small pool, verify-full TLS via the ONE ssl.ts path, unnamed parameterized
 * queries only (Supavisor 6543 forbids named prepared statements). Reads that are byte-identical
 * to Qualify's (tape context enrichment) are IMPORTED from qualify's loaders rather than
 * duplicated, so the two tabs cannot drift on shared semantics.
 *
 * FAIL-SOFT DISCIPLINE (the loaders.ts house rule): ONLY the absent-relation class
 * (42P01/3F000) degrades, and only on surfaces that must render without their table (rails,
 * saved searches). Everything else RETHROWS — a 42501 must never masquerade as "no data yet"
 * (the 0089 lesson), and 42883 on a definer means a signature drift, which must be loud.
 */
import { PgExecutor, makeReaderPool, readerConnectionStringFromEnv } from '../../../src/queries/executor';
import {
  buildFacilityDeclinersQuery,
  buildPayerIntelCensusQuery,
  buildPayerIntelComboQuery,
  buildPayerIntelDistinctMembersQuery,
  buildPayerIntelFacilityNamesQuery,
  buildPayerIntelGainersQuery,
  buildPayerIntelPlacementQuery,
  buildPayerIntelRatingQuery,
  buildPayerIntelSavedSearchesQuery,
  type PayerIntelCensusRowRaw,
  type PayerIntelComboRow,
  type PayerIntelDeclinerRow,
  type PayerIntelFacilityNameRow,
  type PayerIntelPlacementRow,
  type PayerIntelRatingRow,
  type PayerIntelSavedSearchRow,
} from '../../../src/collections/payerIntelSearch';
import {
  buildCmdCollectionsEmployerOptionsQuery,
  buildCmdPayerOptionsQuery,
  buildCmdSearchSummaryQueries,
  buildCohortCurveQueries,
  type CmdExplorerFilter,
  type CohortCurvePoint,
} from '../../../src/collections/cmdExplorerQuery';
import type { QualifyPolicyTapeRow } from '../../../src/collections/qualifyRatingHistory';

let executor: PgExecutor | null = null;
function payerIntelReader(): PgExecutor {
  if (!executor) executor = new PgExecutor(makeReaderPool(readerConnectionStringFromEnv()));
  return executor;
}

function sqlstateOf(err: unknown): string {
  return typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : '';
}

function relationAbsent(err: unknown): boolean {
  const code = sqlstateOf(err);
  return code === '42P01' || code === '3F000';
}

// ── IDLE rails ───────────────────────────────────────────────────────────────────────────────────

/** Gainers rail rows (same row type as the tape — the fork only changes selection). Null ⟺ the
 *  0093 relation is absent, mirroring loadQualifyPolicyTape's fail-soft exactly. */
export async function loadPayerIntelGainers(): Promise<QualifyPolicyTapeRow[] | null> {
  const q = buildPayerIntelGainersQuery();
  try {
    const res = await payerIntelReader().query<QualifyPolicyTapeRow>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    const code = sqlstateOf(err);
    if (code === '42P01' || code === '3F000') {
      console.error(`payer intel gainers unavailable (sqlstate ${code}) — mig 0093 unapplied? rail reads as absent`);
      return null;
    }
    throw err;
  }
}

/** Decliners rail. Reads the always-present charge rollup — NO fail-soft; errors rethrow. */
export async function loadPayerIntelDecliners(entityIds: string[]): Promise<PayerIntelDeclinerRow[]> {
  const q = buildFacilityDeclinersQuery(entityIds);
  const res = await payerIntelReader().query<PayerIntelDeclinerRow>(q.sql, q.params);
  return res.rows;
}

// ── Census strip ─────────────────────────────────────────────────────────────────────────────────

export async function loadPayerIntelCensus(): Promise<PayerIntelCensusRowRaw[]> {
  const q = buildPayerIntelCensusQuery();
  try {
    const res = await payerIntelReader().query<PayerIntelCensusRowRaw>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    if (relationAbsent(err)) {
      console.error('payer intel census read: qualify_facility_census absent — strip renders empty');
      return [];
    }
    throw err;
  }
}

export async function loadPayerIntelFacilityNames(): Promise<PayerIntelFacilityNameRow[]> {
  const q = buildPayerIntelFacilityNamesQuery();
  const res = await payerIntelReader().query<PayerIntelFacilityNameRow>(q.sql, q.params);
  return res.rows;
}

// ── Saved searches (0104) ────────────────────────────────────────────────────────────────────────

export async function loadPayerIntelSavedSearches(userId: string): Promise<PayerIntelSavedSearchRow[] | null> {
  const q = buildPayerIntelSavedSearchesQuery(userId);
  try {
    const res = await payerIntelReader().query<PayerIntelSavedSearchRow>(q.sql, q.params);
    return res.rows;
  } catch (err) {
    if (relationAbsent(err)) {
      console.error('payer intel saved searches: 0097/0104 relations absent — section degrades to session-only');
      return null;
    }
    throw err;
  }
}

/** Star toggle via the 0104 definer. The 12-star cap surfaces as SQLSTATE 23514 whose message
 *  names the limit — the ACTION maps that to a typed reason; here it rethrows like every
 *  non-absent error (a swallowed cap would render a star that silently did not stick). */
export async function setPayerIntelSearchStarredRow(
  userId: string,
  id: string,
  starred: boolean,
): Promise<{ persisted: boolean; found: boolean }> {
  try {
    const res = await payerIntelReader().query<{ set_qualify_search_starred: boolean }>(
      'select claims.set_qualify_search_starred($1::uuid, $2::bigint, $3::boolean)',
      [userId, id, starred],
    );
    return { persisted: true, found: res.rows[0]?.set_qualify_search_starred === true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false, found: false };
    throw err;
  }
}

/** Record one search's non-PHI facets via the 0104 six-param definer overload. */
export async function recordPayerIntelSearchRow(args: {
  userId: string;
  payer: string | null;
  echo: string | null;
  planClass: string | null;
  entityType: string | null;
  resolved: boolean | null;
}): Promise<{ persisted: boolean }> {
  try {
    await payerIntelReader().query(
      'select claims.record_qualify_recent_search($1::uuid, $2, $3, $4, $5, $6::boolean)',
      [args.userId, args.payer, args.echo, args.planClass, args.entityType, args.resolved],
    );
    return { persisted: true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false };
    throw err;
  }
}

export async function clearPayerIntelSearchesRow(userId: string): Promise<{ persisted: boolean }> {
  try {
    await payerIntelReader().query('select claims.clear_qualify_recent_searches($1::uuid)', [userId]);
    return { persisted: true };
  } catch (err) {
    if (relationAbsent(err)) return { persisted: false };
    throw err;
  }
}

// ── Search execution (RESULT state) ──────────────────────────────────────────────────────────────

export interface PayerIntelTotalsRow {
  total_count: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  total_balance: number;
}

/** The RESULT screen's four aggregate reads, one Promise.all fan-out. Distinct members runs as its
 *  own scan, never folded into the totals aggregate (the buildBookKpisQuery split-the-scans lesson:
 *  count(distinct)+sums in one aggregate spilled to disk at 1.8s). ⚠ totals comes from the SHARED
 *  summary builder, which treats row_ids:[] as absent — the CORE must short-circuit a matched-
 *  nothing search to a zero result before calling this (the payer-intel builders harden themselves;
 *  the shared totals query cannot without touching Collections). */
export async function loadPayerIntelSearchAggregates(
  filter: CmdExplorerFilter,
  entityIds: string[],
): Promise<{
  totals: PayerIntelTotalsRow;
  distinctMembers: number;
  placement: PayerIntelPlacementRow[];
  combos: PayerIntelComboRow[];
}> {
  const summary = buildCmdSearchSummaryQueries(filter, entityIds);
  const placementQ = buildPayerIntelPlacementQuery(filter, entityIds);
  const comboQ = buildPayerIntelComboQuery(filter, entityIds);
  const membersQ = buildPayerIntelDistinctMembersQuery(filter, entityIds);
  const [totalsRes, placementRes, comboRes, membersRes] = await Promise.all([
    payerIntelReader().query<PayerIntelTotalsRow>(summary.totals.sql, summary.totals.params),
    payerIntelReader().query<PayerIntelPlacementRow>(placementQ.sql, placementQ.params),
    payerIntelReader().query<PayerIntelComboRow>(comboQ.sql, comboQ.params),
    payerIntelReader().query<{ members: number }>(membersQ.sql, membersQ.params),
  ]);
  const totals = totalsRes.rows[0] ?? {
    total_count: 0,
    total_charge: 0,
    total_allowed: 0,
    total_paid: 0,
    total_balance: 0,
  };
  return {
    totals,
    distinctMembers: membersRes.rows[0]?.members ?? 0,
    placement: placementRes.rows,
    combos: comboRes.rows,
  };
}

/** The search's by-payer grouping — the prefix→payer resolution read (top label = dominant
 *  payer by charge, the shared summary builder's own ordering). */
export async function loadPayerIntelPayerGroups(
  filter: CmdExplorerFilter,
  entityIds: string[],
): Promise<{ label: string | null; count: number }[]> {
  const q = buildCmdSearchSummaryQueries(filter, entityIds).groups.primary_payer;
  const res = await payerIntelReader().query<{ label: string | null; count: number }>(q.sql, q.params);
  return res.rows;
}

/** Employer type-ahead over the collections-native employer_name (mig 0101, trigram-served) —
 *  the SAME builder Collections uses, behind THIS tab's gate. Term floor enforced here (a 1-2
 *  char ILIKE is the most expensive query on the surface). */
export async function loadPayerIntelEmployerOptions(term: string, entityIds: string[]): Promise<string[]> {
  if (term.trim().length < 3) return [];
  const q = buildCmdCollectionsEmployerOptionsQuery(entityIds, term.trim(), 25);
  const res = await payerIntelReader().query<{ employer_name: string }>(q.sql, q.params);
  return res.rows.map((r) => r.employer_name);
}

/** The hero rating off the 0093 nightly table. Null result ⟺ relation absent or no rated row. */
export async function loadPayerIntelRating(
  token: string | null,
  payer: string,
): Promise<PayerIntelRatingRow | null> {
  const q = buildPayerIntelRatingQuery(token, payer);
  try {
    const res = await payerIntelReader().query<PayerIntelRatingRow>(q.sql, q.params);
    return res.rows[0] ?? null;
  } catch (err) {
    if (relationAbsent(err)) return null;
    throw err;
  }
}

/** Payer vocabulary for free-text classification (matview-backed; ~260 names). */
export async function loadPayerIntelPayerVocabulary(entityIds: string[]): Promise<string[]> {
  const q = buildCmdPayerOptionsQuery(entityIds);
  const res = await payerIntelReader().query<{ primary_payer: string }>(q.sql, q.params);
  return res.rows.map((r) => r.primary_payer);
}

// ── AI payload reads ─────────────────────────────────────────────────────────────────────────────

export interface PayerIntelCohortCurveRows {
  byPosition: CohortCurvePoint[];
  byDays: CohortCurvePoint[];
}

/** The cohort curve for a prefix token — the SAME suppressed builders the Collections cohort panel
 *  uses (min-patient floor enforced in SQL via HAVING), so the AI payload can never carry a bucket
 *  the UI itself would suppress. */
export async function loadPayerIntelCohortCurve(
  prefixToken: string,
  entityIds: string[],
): Promise<PayerIntelCohortCurveRows> {
  const q = buildCohortCurveQueries(prefixToken, entityIds);
  const [pos, days] = await Promise.all([
    payerIntelReader().query<CohortCurvePoint>(q.byPosition.sql, q.byPosition.params),
    payerIntelReader().query<CohortCurvePoint>(q.byDays.sql, q.byDays.params),
  ]);
  return { byPosition: pos.rows, byDays: days.rows };
}
