/**
 * Real (pg-backed) QueryExecutor for the query library. Connects as
 * claims_reader (CLAIMS_READER_DATABASE_URL) over the Supavisor transaction
 * pooler — unnamed parameterized queries only (no named prepared statements),
 * which is what the pooler supports. TLS is on (see the SSL note in src/db.ts;
 * harden to verify-full before Phase 3 per CLAUDE.md).
 */
import pg from 'pg';
import type { ExecResult, QueryExecutor } from './types.js';

export function makeReaderPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 4,
    application_name: 'claims-query',
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
