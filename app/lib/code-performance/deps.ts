/**
 * Code Performance real deps — the least-privilege claims_reader executor, built lazily and cached for
 * the process (the codeIntel.ts precedent: a per-feature PgExecutor over makeReaderPool, verify-full
 * TLS applied centrally in src/ssl.ts). SERVER-ONLY. Sync factory on purpose: a `'use server'` file
 * may export only async functions, so factories live here, not in actions.ts.
 */
import { makeReaderPool, PgExecutor, readerConnectionStringFromEnv } from '../../../src/queries/executor.js';
import type { CodePerfDeps } from './core';

let cached: PgExecutor | undefined;

function executor(): PgExecutor {
  cached ??= new PgExecutor(makeReaderPool(readerConnectionStringFromEnv(), 'code-performance'));
  return cached;
}

export function buildCodePerfRealDeps(): CodePerfDeps {
  return {
    query: async <T,>(sql: string, params: readonly unknown[]) => {
      const res = await executor().query<T>(sql, params);
      return { rows: res.rows };
    },
  };
}
