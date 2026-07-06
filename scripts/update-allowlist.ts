/**
 * One-off: update auth_config.allowed_emails — remove 2 stale placeholder entries and
 * add the 5 correct ones. Runs as claims_admin (the table OWNER, migration 0018) over a
 * verify-full TLS pg connection (src/ssl.ts via makeClient). NOT committed.
 *
 * Standing rules: parameterized queries only ($n bound params — emails are bound, never
 * interpolated). Emails are staff identities (NOT patient PHI), so printing the final
 * allowlist is fine and is the requested confirmation. Idempotent: DELETE of an absent
 * row is a no-op; INSERT ... ON CONFLICT DO NOTHING skips existing rows. Atomic: the two
 * mutations run in one transaction.
 *
 * Run (after go-ahead):  npx tsx scripts/update-allowlist.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient } from '../src/db.js';

/** Minimal non-overriding repo-root .env loader (mirrors cmdExplorerSeed.ts). An already
 *  exported value always wins. No dotenv dependency. */
function loadDotEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!k || k in process.env) continue;
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch {
    /* no .env — rely on the exported environment */
  }
}

/** Stale placeholder entries to remove. */
const STALE = ['derek@treathealth.ai', 'blake@treathealth.ai'];

/** Correct entries to add (idempotent). */
const ADD = [
  'derek@opustreatment.com',
  'blake@opustreatment.com',
  'iman@bloomhousemarketing.com',
  'catherine@bxrconsulting.com',
  'jess@bxrconsulting.com',
];

async function main(): Promise<void> {
  loadDotEnv();
  const url = process.env.CLAIMS_ADMIN_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Missing CLAIMS_ADMIN_DATABASE_URL (claims_admin owns auth_config.allowed_emails); never log it');
  }
  const db = makeClient(url);
  try {
    await db.query('begin');
    const del = await db.query('delete from auth_config.allowed_emails where email = any($1::text[])', [STALE]);
    const ins = await db.query(
      'insert into auth_config.allowed_emails (email) select lower(unnest($1::text[])) on conflict do nothing',
      [ADD],
    );
    await db.query('commit');
    console.log(`deleted ${del.rowCount ?? 0}; inserted ${ins.rowCount ?? 0} (existing skipped by ON CONFLICT)`);

    const { rows } = await db.query<{ email: string }>(
      'select email from auth_config.allowed_emails order by email',
    );
    console.log('final allowlist (emails only):');
    for (const r of rows) console.log(`  ${r.email}`);
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('update-allowlist failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
