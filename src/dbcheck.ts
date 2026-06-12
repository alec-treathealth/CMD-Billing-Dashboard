/**
 * Connection smoke test. Proves the node-postgres claims_admin path authenticates
 * and can reach the relocated `claims` schema. Counts only — no PHI, no ingest.
 * Run: npm run dbcheck  (after loading .env).
 */
import { loadConfig } from './config.js';
import { makeClient } from './db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = makeClient(config.claimsAdminDatabaseUrl);
  try {
    const who = await db.query<{ current_user: string; search_path: string }>(
      "select current_user, current_setting('search_path') as search_path",
    );
    const claims = await db.query<{ n: string }>('select count(*) as n from claims.claims');
    const raw = await db.query<{ n: string }>('select count(*) as n from claims.claims_raw');
    console.log(
      `[dbcheck] connected as ${who.rows[0]?.current_user} ` +
        `(search_path=${who.rows[0]?.search_path}); ` +
        `claims=${claims.rows[0]?.n} claims_raw=${raw.rows[0]?.n}`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[dbcheck] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
