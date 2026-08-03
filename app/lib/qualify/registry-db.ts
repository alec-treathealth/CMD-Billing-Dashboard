/**
 * Coding registry WRITER pool — the narrow `coding_editor` role's connection (Phase A). The
 * registry is the repo's FIRST editable write surface: writes go through THIS pool only — never
 * claims_admin, never the service key, never the reader.
 *
 * FAIL-SOFT BY DESIGN: CODING_WRITER_DB_URL is absent until the 0077 out-of-band step (role LOGIN +
 * password + env var). Callers receive null and render "registry editing is not configured yet"
 * instead of throwing — reads (claims_reader) keep working regardless.
 */
import type pg from 'pg';
import { makeClient } from '../../../src/collections/db';

let pool: pg.Pool | null = null;
let checked = false;

export function codingWriterPool(): pg.Pool | null {
  if (!checked) {
    checked = true;
    const url = process.env.CODING_WRITER_DB_URL;
    if (url && url.trim() !== '') pool = makeClient(url);
  }
  return pool;
}

/**
 * Run `fn` inside ONE transaction on ONE checked-out coding_editor connection (the withTenant
 * single-client discipline — never pool.query() mid-transaction on the 6543 pooler). Returns null
 * when the writer is not configured. Rethrows on failure after rollback.
 */
export async function withCodingEditor<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T | null> {
  const p = codingWriterPool();
  if (!p) return null;
  const client = await p.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // connection is discarded on release; a failed rollback adds nothing
    }
    throw err;
  } finally {
    client.release();
  }
}
