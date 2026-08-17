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
 * AMBIENT CACHING (2026-08-17 latency pass): the rails, census, and facet vocabularies are
 * request-independent and identical for every viewer, so they ride `unstable_cache` (tag
 * 'payer-intel-ambient', 300s) — the Collections vocabularies' pattern. Known trade-offs
 * accepted: a failed BACKGROUND revalidation serves stale silently, and unstable_cache throws
 * outside a request context — these wrappers are therefore only ever invoked from pages/actions,
 * never from tests (the hermetic suite exercises the cores with fake deps). Per-user reads
 * (saved searches) and search execution are NEVER cached.
 *
 * FAIL-SOFT DISCIPLINE (the loaders.ts house rule): ONLY the absent-relation class
 * (42P01/3F000) degrades, and only on surfaces that must render without their table (rails,
 * saved searches). Everything else RETHROWS — a 42501 must never masquerade as "no data yet"
 * (the 0089 lesson), and 42883 on a definer means a signature drift, which must be loud.
 */
import { unstable_cache } from 'next/cache';
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
  CMD_EXPLORER_DEFAULT_SORT,
  CMD_EXPLORER_PAGE_SIZE,
  buildCmdCollectionsEmployerOptionsQuery,
  buildCmdExplorerQuery,
  buildCmdFacilityOptionsQuery,
  buildCmdPayerOptionsQuery,
  buildCmdSearchSummaryQueries,
  buildCohortCurveQueries,
  cmdExplorerSortValue,
  resolveCmdExplorerCursor,
  type CmdExplorerFilter,
  type CohortCurvePoint,
} from '../../../src/collections/cmdExplorerQuery';
import type { CmdExplorerRow } from '../../../src/collections/cmdExplorer';
import type { QualifyPolicyTapeRow } from '../../../src/collections/qualifyRatingHistory';
import type { PayerIntelGridCursor } from './contract';

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

const AMBIENT_TAG = 'payer-intel-ambient';
const AMBIENT_REVALIDATE_S = 300;

// ── IDLE rails (window-parameterized — the tickers adapt to the recency toggle) ──────────────────

async function loadGainersUncached(deltaDays: number): Promise<QualifyPolicyTapeRow[] | null> {
  const q = buildPayerIntelGainersQuery({ deltaDays });
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

/** Gainers rail rows (same row type as the tape — the fork only changes selection). Null ⟺ the
 *  0093 relation is absent, mirroring loadQualifyPolicyTape's fail-soft exactly. Cached per
 *  deltaDays (the arg IS the cache key part). */
export const loadPayerIntelGainers = unstable_cache(loadGainersUncached, ['payer-intel-gainers'], {
  revalidate: AMBIENT_REVALIDATE_S,
  tags: [AMBIENT_TAG],
});

async function loadDeclinersUncached(entityIds: string[], windowDays: number): Promise<PayerIntelDeclinerRow[]> {
  const q = buildFacilityDeclinersQuery(entityIds, { windowDays });
  const res = await payerIntelReader().query<PayerIntelDeclinerRow>(q.sql, q.params);
  return res.rows;
}

/** Decliners rail. Reads the always-present charge rollup — NO fail-soft; errors rethrow. */
export const loadPayerIntelDecliners = unstable_cache(loadDeclinersUncached, ['payer-intel-decliners'], {
  revalidate: AMBIENT_REVALIDATE_S,
  tags: [AMBIENT_TAG],
});

// ── Census strip ─────────────────────────────────────────────────────────────────────────────────

async function loadCensusUncached(): Promise<PayerIntelCensusRowRaw[]> {
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

export const loadPayerIntelCensus = unstable_cache(loadCensusUncached, ['payer-intel-census'], {
  revalidate: AMBIENT_REVALIDATE_S,
  tags: [AMBIENT_TAG],
});

async function loadFacilityNamesUncached(): Promise<PayerIntelFacilityNameRow[]> {
  const q = buildPayerIntelFacilityNamesQuery();
  const res = await payerIntelReader().query<PayerIntelFacilityNameRow>(q.sql, q.params);
  return res.rows;
}

export const loadPayerIntelFacilityNames = unstable_cache(loadFacilityNamesUncached, ['payer-intel-facility-names'], {
  revalidate: AMBIENT_REVALIDATE_S,
  tags: [AMBIENT_TAG],
});

// ── Facet vocabularies (the pickers) ─────────────────────────────────────────────────────────────

/** Facility PICKER options — the matview-backed rollup TEXT values (`facility`), the vocabulary
 *  `cmdExplorerBaseConds` actually matches. ⚠ Never feed facility_code into the facility facet:
 *  the first build did, and every facility-scoped search silently matched nothing. */
export interface PayerIntelFacilityOption {
  facility: string;
  facility_name: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

async function loadFacilityOptionsUncached(entityIds: string[]): Promise<PayerIntelFacilityOption[]> {
  const q = buildCmdFacilityOptionsQuery(entityIds);
  const res = await payerIntelReader().query<PayerIntelFacilityOption>(q.sql, q.params);
  return res.rows;
}

export const loadPayerIntelFacilityOptions = unstable_cache(
  loadFacilityOptionsUncached,
  ['payer-intel-facility-options'],
  { revalidate: AMBIENT_REVALIDATE_S, tags: [AMBIENT_TAG] },
);

async function loadPayerVocabularyUncached(entityIds: string[]): Promise<string[]> {
  const q = buildCmdPayerOptionsQuery(entityIds);
  const res = await payerIntelReader().query<{ primary_payer: string }>(q.sql, q.params);
  return res.rows.map((r) => r.primary_payer);
}

/** Payer vocabulary for free-text classification + the picker (matview-backed; ~260 names). */
export const loadPayerIntelPayerVocabulary = unstable_cache(
  loadPayerVocabularyUncached,
  ['payer-intel-payer-vocab'],
  { revalidate: AMBIENT_REVALIDATE_S, tags: [AMBIENT_TAG] },
);

/** Employer type-ahead over the collections-native employer_name (mig 0101, trigram-served) —
 *  the SAME builder Collections uses, behind THIS tab's gate. NOT cached (per-keystroke terms
 *  would just pollute the cache). Term floor enforced here (a 1-2 char ILIKE is the most
 *  expensive query on the surface). */
export async function loadPayerIntelEmployerOptions(term: string, entityIds: string[]): Promise<string[]> {
  if (term.trim().length < 3) return [];
  const q = buildCmdCollectionsEmployerOptionsQuery(entityIds, term.trim(), 25);
  const res = await payerIntelReader().query<{ employer_name: string }>(q.sql, q.params);
  return res.rows.map((r) => r.employer_name);
}

// ── Saved searches (0104) — per-user, NEVER cached ───────────────────────────────────────────────

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

// ── Search execution (RESULT state) — NEVER cached ───────────────────────────────────────────────

export interface PayerIntelTotalsRow {
  total_count: number;
  total_charge: number;
  total_allowed: number;
  total_paid: number;
  total_balance: number;
}

interface GroupRow {
  label: string | null;
  count: number;
  charge: number;
}

/** The RESULT screen's aggregate reads, one Promise.all fan-out: totals · distinct members (its
 *  own scan — the buildBookKpisQuery split-the-scans lesson) · placement · combos · the by-payer
 *  and by-facility DRILL groups (the Collections summary's Top lists). ⚠ totals/groups come from
 *  the SHARED summary builder, which treats row_ids:[] as absent — the CORE short-circuits a
 *  matched-nothing search before calling this. */
export async function loadPayerIntelSearchAggregates(
  filter: CmdExplorerFilter,
  entityIds: string[],
): Promise<{
  totals: PayerIntelTotalsRow;
  distinctMembers: number;
  placement: PayerIntelPlacementRow[];
  combos: PayerIntelComboRow[];
  byPayer: GroupRow[];
  byFacility: GroupRow[];
}> {
  const summary = buildCmdSearchSummaryQueries(filter, entityIds);
  const placementQ = buildPayerIntelPlacementQuery(filter, entityIds);
  const comboQ = buildPayerIntelComboQuery(filter, entityIds);
  const membersQ = buildPayerIntelDistinctMembersQuery(filter, entityIds);
  const [totalsRes, placementRes, comboRes, membersRes, payerRes, facilityRes] = await Promise.all([
    payerIntelReader().query<PayerIntelTotalsRow>(summary.totals.sql, summary.totals.params),
    payerIntelReader().query<PayerIntelPlacementRow>(placementQ.sql, placementQ.params),
    payerIntelReader().query<PayerIntelComboRow>(comboQ.sql, comboQ.params),
    payerIntelReader().query<{ members: number }>(membersQ.sql, membersQ.params),
    payerIntelReader().query<GroupRow>(summary.groups.primary_payer.sql, summary.groups.primary_payer.params),
    payerIntelReader().query<GroupRow>(summary.groups.facility.sql, summary.groups.facility.params),
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
    byPayer: payerRes.rows,
    byFacility: facilityRes.rows,
  };
}

/** The search's by-payer grouping alone — the prefix→payer resolution read (top label = dominant
 *  payer by charge, the shared summary builder's own ordering). */
export async function loadPayerIntelPayerGroups(
  filter: CmdExplorerFilter,
  entityIds: string[],
): Promise<{ label: string | null; count: number }[]> {
  const q = buildCmdSearchSummaryQueries(filter, entityIds).groups.primary_payer;
  const res = await payerIntelReader().query<{ label: string | null; count: number }>(q.sql, q.params);
  return res.rows;
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

// ── Charge-line grid (the Collections keyset grid behind THIS tab's gate) ────────────────────────

/** One over-fetched keyset page: CMD_EXPLORER_PAGE_SIZE rows + the cursor for the next (null at
 *  end). Fixed Payment-Received-DESC order (the Collections default) — column sorting is a
 *  follow-up, not a v1.1 knob. Non-PHI projection by construction (CmdExplorerRow carries no
 *  identifier; dollar strip happens in the core's choke point). */
export async function loadPayerIntelGridRows(
  filter: CmdExplorerFilter,
  cursor: PayerIntelGridCursor | null,
  entityIds: string[],
): Promise<{ rows: CmdExplorerRow[]; nextCursor: PayerIntelGridCursor | null }> {
  const sort = { ...CMD_EXPLORER_DEFAULT_SORT };
  const resolved = resolveCmdExplorerCursor(cursor);
  const q = buildCmdExplorerQuery(resolved, filter, sort, CMD_EXPLORER_PAGE_SIZE + 1, entityIds);
  const res = await payerIntelReader().query<CmdExplorerRow>(q.sql, q.params);
  const rows = res.rows.slice(0, CMD_EXPLORER_PAGE_SIZE).map((r) => ({ ...r, id: Number(r.id) }));
  const last = rows[rows.length - 1];
  const nextCursor =
    res.rows.length > CMD_EXPLORER_PAGE_SIZE && last !== undefined
      ? { id: last.id, value: cmdExplorerSortValue(last, sort.column) }
      : null;
  return { rows, nextCursor };
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
