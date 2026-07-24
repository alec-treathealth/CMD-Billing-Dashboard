/**
 * One-shot backfill: compute the CLIENT-NAME blind index (migration 0066) for existing
 * cmd_explorer_rows. New rows get it at ingest (cmdExplorerSeed/Cron); this fills the rows
 * loaded before the column existed. The exact clone of cmdBlindIndexBackfill.ts, scoped to
 * patient_name → patient_name_bidx (exact normalized-name HMAC only — no prefix variant, per
 * the Change-C ruling: a short name prefix is far too broad across PHI).
 *
 * For each row missing `patient_name_bidx`, it DECRYPTS the encrypted patient_name
 * (LIBSODIUM_KEY), computes the keyed HMAC token (INDEX_HMAC_KEY, blindIndex.ts
 * patientNameBlindIndex — the SAME normalization the 0049 audit plane uses), and writes it
 * back. The plaintext is decrypted only in-process, never logged, never persisted in the
 * clear; only the one-way HMAC token is stored.
 *
 * CONNECTION: same two paths as cmdBlindIndexBackfill (BLIND_INDEX_* envs win, else
 * CLAIMS_READER_DATABASE_URL — claims_reader has column-scoped UPDATE on patient_name_bidx
 * via 0066, riding the 0037 UPDATE policy). Run locally.
 *
 * SAFETY: dry-run by default. Pass --commit to write. Idempotent + resumable (NULL-walk by
 * id keyset). After a completed backfill, REFRESH the charge rollup (or apply 0067, whose
 * CREATE ... WITH DATA picks the tokens up) so the Qualify name resolve sees them.
 *
 *   tsx src/collections/cmdNameBidxBackfill.ts            # dry run
 *   tsx src/collections/cmdNameBidxBackfill.ts --commit   # write
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sanitizeConnectionString, verifyFullSsl } from '../ssl.js';
import { decryptPhi } from './phiCrypto.js';
import { patientNameBlindIndex } from './blindIndex.js';

const BATCH = 500;

interface CipherRow {
  id: string; // int8 → string from pg
  patient_name: Buffer | null;
}

/** Minimal non-overriding .env loader (matches the seed CLI; already-exported values win). */
function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    text = readFileSync(join(here, '..', '..', '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Direct-connection host derived from SUPABASE_URL (https://<ref>.supabase.co → db.<ref>.supabase.co). */
function supabaseDbHost(): string | undefined {
  const u = process.env.SUPABASE_URL?.trim();
  if (!u) return undefined;
  const host = u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? `db.${host}` : undefined;
}

/** Build the backfill pool — identical resolution ladder to cmdBlindIndexBackfill.ts. */
function buildPool(): pg.Pool {
  const opts = { ssl: verifyFullSsl(), max: 4, application_name: 'name-bidx-backfill' } as const;
  const rawPw = process.env.BLIND_INDEX_PGPASSWORD;
  if (rawPw) {
    const host =
      process.env.BLIND_INDEX_PGHOST?.trim() ||
      (process.env.BLIND_INDEX_DB_URL ? new URL(process.env.BLIND_INDEX_DB_URL).hostname : undefined) ||
      supabaseDbHost();
    if (!host) throw new Error('cannot resolve DB host (set BLIND_INDEX_PGHOST or SUPABASE_URL)');
    return new pg.Pool({
      host,
      port: Number(process.env.BLIND_INDEX_PGPORT ?? 5432),
      user: process.env.BLIND_INDEX_PGUSER?.trim() || 'postgres',
      password: rawPw,
      database: process.env.BLIND_INDEX_PGDATABASE?.trim() || 'postgres',
      ...opts,
    });
  }
  const url = (process.env.BLIND_INDEX_DB_URL ?? process.env.CLAIMS_READER_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
  if (!url) throw new Error('BLIND_INDEX_DB_URL or BLIND_INDEX_PGPASSWORD must be set (never log it)');
  return new pg.Pool({ connectionString: sanitizeConnectionString(url), ...opts });
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const commit = process.argv.includes('--commit');
  if (!process.env.LIBSODIUM_KEY) throw new Error('LIBSODIUM_KEY must be set (to decrypt existing PHI)');
  if (!process.env.INDEX_HMAC_KEY) throw new Error('INDEX_HMAC_KEY must be set (to compute blind indexes)');

  const db = buildPool();
  try {
    const who = await db.query<{ current_user: string; bypass: boolean }>(
      'select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypass',
    );
    console.log(`connected as ${who.rows[0]?.current_user} (bypassrls=${who.rows[0]?.bypass}) — ${commit ? 'COMMIT' : 'DRY RUN'}`);

    let cursor = 0;
    let scanned = 0;
    let updated = 0;
    let undecryptable = 0;
    for (;;) {
      const { rows } = await db.query<CipherRow>(
        `select id, patient_name from collections.cmd_explorer_rows
         where id > $1 and patient_name_bidx is null order by id limit $2`,
        [cursor, BATCH],
      );
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1]!.id);
      scanned += rows.length;

      // Decrypt + compute the token per row (in memory only). A row whose name can't be decrypted
      // is counted and skipped (never crashes the whole backfill).
      const updates: { id: string; n: string | null }[] = [];
      for (const r of rows) {
        let name: string | null = null;
        try {
          if (r.patient_name) name = await decryptPhi(r.patient_name);
        } catch {
          undecryptable += 1;
          continue;
        }
        updates.push({ id: r.id, n: patientNameBlindIndex(name) });
      }

      if (commit && updates.length > 0) {
        const params: unknown[] = [];
        const tuples = updates.map((u) => {
          const b = params.length;
          params.push(u.id, u.n);
          return `($${b + 1}::bigint, $${b + 2}::text)`;
        });
        await db.query(
          `update collections.cmd_explorer_rows t
             set patient_name_bidx = v.n
           from (values ${tuples.join(', ')}) as v(id, n)
           where t.id = v.id`,
          params,
        );
      }
      updated += updates.length;
      console.log(`  scanned ${scanned}, ${commit ? 'updated' : 'would update'} ${updated}, undecryptable ${undecryptable}`);
    }

    console.log(
      `\n${commit ? 'DONE' : 'DRY RUN COMPLETE'}: ${scanned} rows scanned, ` +
        `${updated} ${commit ? 'updated' : 'to update'}, ${undecryptable} undecryptable.` +
        (commit ? '  REFRESH the charge rollup (or apply 0067) so Qualify sees the tokens.' : '  Re-run with --commit to write.'),
    );
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  // Never print PHI/keys — only the error name/message (phiCrypto/blindIndex errors are safe).
  console.error(`backfill failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
