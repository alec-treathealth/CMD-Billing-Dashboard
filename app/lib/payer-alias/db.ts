/**
 * Payer-alias surface — the ONE claims_reader pool shared by the queue read and the ruling write.
 *
 * SERVER-ONLY: this builds a pg pool. Importing it from a Client Component fails the build loudly.
 *
 * Both halves of the surface connect as `claims_reader` and nothing else. That is not a shortcut —
 * it is the whole least-privilege design: the reader holds SELECT on the three `ref.*` tables and
 * EXECUTE on `ref.rule_payer_alias`, and no UPDATE on the crosswalk at all. The write happens inside
 * the definer, under `claims_admin` (its owner), never under the connecting role. So one pool serves
 * both paths correctly, and a second pool would buy nothing but another four connections.
 *
 * The pool is built LAZILY. Importing this module reads no env and opens no socket, which is what
 * lets the loader and the ruling action both be exercised hermetically against a fake.
 *
 * Supavisor transaction pooler (6543): `pool.query(sql, params)` only — no named prepared statements.
 * Verify-full TLS comes from the single ssl.ts path via makeReaderPool.
 */
import { PgExecutor, makeReaderPool, readerConnectionStringFromEnv } from '../../../src/queries/executor';

/**
 * The ONLY capability either half of this surface needs from a database handle. Declared
 * structurally rather than as `PgExecutor` so both can be tested with no pg, no pool and no network.
 * PgExecutor satisfies it as-is.
 */
export interface PayerAliasDb {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

let executor: PgExecutor | null = null;

/** Module-cached executor on a small dedicated claims_reader pool (the verisReaderPool precedent). */
export function payerAliasDb(): PayerAliasDb {
  if (!executor) {
    executor = new PgExecutor(makeReaderPool(readerConnectionStringFromEnv(), 'payer-alias'));
  }
  return executor;
}
