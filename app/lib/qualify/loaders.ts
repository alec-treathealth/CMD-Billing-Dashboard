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
  buildQualifyVobFreshnessQuery,
  buildQualifyWindowRungsQuery,
  type QualifyPolicyRow,
  type QualifyWindowRungsRow,
} from '../../../src/collections/qualifyPolicyQuery';
import {
  buildCurrentCodingDecisionsQuery,
  buildCodingDecisionHistoryQuery,
  type CodingDecisionRow,
} from '../../../src/collections/codingRegistryQuery';
import type { QualifyTokenKind } from '../../../src/collections/qualifyQuery';

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

/** Global VOB feed high-water mark (Phase 0 staleness disclosure). Null on an empty matview. */
export async function loadQualifyVobFreshness(): Promise<string | null> {
  const q = buildQualifyVobFreshnessQuery();
  const res = await qualifyV2Reader().query<{ fresh_as_of: string | null }>(q.sql, q.params);
  return res.rows[0]?.fresh_as_of ?? null;
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
