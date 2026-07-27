/**
 * Real (pg-backed) QueryExecutor for the query library. Connects as
 * claims_reader (CLAIMS_READER_DATABASE_URL) over the Supavisor transaction
 * pooler — unnamed parameterized queries only (no named prepared statements),
 * which is what the pooler supports. TLS is verify-full (Phase 3 hardening): the
 * pooler certificate is verified against the Supabase Root CA and its hostname is
 * checked. This is the single place the reader pool — including the one the dev
 * harness (src/server.ts) builds — gets its SSL config. See src/ssl.ts.
 */
import pg from 'pg';
import { sanitizeConnectionString, verifyFullSsl } from '../ssl.js';
import type { ExecResult, QueryExecutor } from './types.js';

export function makeReaderPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    // Strip any sslmode/ssl param so it can't override our verify-full ssl (drop the ca).
    connectionString: sanitizeConnectionString(connectionString),
    ssl: verifyFullSsl(),
    max: 4,
    application_name: 'claims-query',
    // Safety ceilings so a runaway/stalled read can't pin a connection in this SHARED reader pool
    // forever (a saturated {max:4} pool otherwise blocks unrelated app reads — collections,
    // dashboard, qualify — with NO upper bound). These are GENEROUS on purpose: one pool serves
    // every app read, INCLUDING known-slow aggregates (collections summary, ~30s cohort curve), so
    // the cap kills only pathological pins, not legitimate slow queries. statement_timeout →
    // Postgres cancels server-side (clean, connection reusable); query_timeout (slightly higher) →
    // a client-side backstop that still fires over the Supavisor transaction pooler if the
    // server-side SET didn't stick; connectionTimeoutMillis → bounds how long we wait to acquire a
    // connection when the pool is momentarily saturated. Tighten per-surface later if needed.
    statement_timeout: 120_000,
    query_timeout: 125_000,
    connectionTimeoutMillis: 10_000,
  });
}

export class PgExecutor implements QueryExecutor {
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<ExecResult<T>> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  /**
   * Run ONE parameterized query inside a transaction with a TRANSACTION-SCOPED work_mem override.
   * Used by the Qualify facility-trend read, whose per-facility distinct-patient sort spills to disk
   * even at the shortest window (the pooler's default work_mem is well under the sort's footprint).
   *
   * Leak-safety on the Supavisor transaction pooler (6543): `SET LOCAL` is reset at COMMIT/ROLLBACK by
   * Postgres itself — atomically with the transaction ending — so the override applies to exactly the
   * SELECT below and CANNOT leak to another query that later reuses the same pooled backend. (Only a
   * session-level `SET`, which this deliberately is not, could leak.) BEGIN/SET/SELECT/COMMIT all run
   * on ONE checked-out client, so they share the one backend the pooler binds for the transaction.
   *
   * `workMem` is a FIXED internal literal (SET cannot take a bound parameter); it is validated against a
   * strict units pattern so a caller can never inject SQL through it. Never pass user input here.
   */
  async queryWithWorkMem<T = Record<string, unknown>>(
    workMem: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<ExecResult<T>> {
    if (!/^\d{1,6}(kB|MB|GB)$/.test(workMem)) {
      throw new Error('queryWithWorkMem: invalid work_mem literal (fixed internal value only)');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local work_mem = '${workMem}'`);
      const res = await client.query(sql, params as unknown[]);
      await client.query('commit');
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    } catch (err) {
      try {
        await client.query('rollback');
      } catch {
        // the connection is being discarded on release; ignore a rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export function readerConnectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.CLAIMS_READER_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Missing CLAIMS_READER_DATABASE_URL (check, do not log, this var)');
  }
  return url;
}
