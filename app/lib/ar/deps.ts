/**
 * AR Management real deps — the least-privilege claims_reader executor, built lazily and cached for
 * the process (the code-performance precedent: a per-feature PgExecutor over makeReaderPool, verify-full
 * TLS applied centrally in src/ssl.ts). SERVER-ONLY. Sync factory on purpose: a `'use server'` file
 * may export only async functions, so factories live here, not in actions.ts.
 */
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../../src/queries/executor.js';

let cached: PgExecutor | undefined;

export function arExecutor(): PgExecutor {
  cached ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv(), 'ar-management'));
  return cached;
}
