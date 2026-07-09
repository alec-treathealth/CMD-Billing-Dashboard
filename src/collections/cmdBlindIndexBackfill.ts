/**
 * One-shot backfill: compute the searchable-PHI BLIND INDEXES (migration 0036) for existing
 * cmd_explorer_rows. New rows get them at ingest (cmdExplorerSeed/Cron); this fills the rows
 * that were loaded before the columns existed.
 *
 * For each row missing `member_id_bidx`, it DECRYPTS the encrypted member_id + group_number
 * (LIBSODIUM_KEY), computes the keyed HMAC tokens (INDEX_HMAC_KEY, blindIndex.ts), and writes
 * them back. The plaintext is decrypted only in-process, never logged, never persisted in the
 * clear; only the one-way HMAC tokens are stored.
 *
 * CONNECTION: needs a role that can SELECT the ciphertext AND UPDATE the *_bidx columns of
 * collections.cmd_explorer_rows. Two supported paths (BLIND_INDEX_DB_URL wins, else
 * CLAIMS_READER_DATABASE_URL, else DATABASE_URL):
 *   (A) an OWNER/postgres connection as BLIND_INDEX_DB_URL — no schema change needed; or
 *   (B) claims_reader AFTER migration 0037 (grants it column-scoped UPDATE on the 3 bidx
 *       columns + a matching RLS policy) via CLAIMS_READER_DATABASE_URL.
 * The default app roles CANNOT update this RLS table without one of these. Run locally.
 *
 * SAFETY: dry-run by default (prints how many rows WOULD be updated). Pass --commit to write.
 * Idempotent + resumable: only rows with a NULL member_id_bidx are processed, walked by id
 * keyset, so a re-run continues where it left off and a completed backfill is a no-op.
 *
 *   tsx src/collections/cmdBlindIndexBackfill.ts            # dry run
 *   tsx src/collections/cmdBlindIndexBackfill.ts --commit   # write
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient } from './db.js';
import { decryptPhi } from './phiCrypto.js';
import { blindIndexesForRow } from './blindIndex.js';

const BATCH = 500;

interface CipherRow {
  id: string; // int8 → string from pg
  member_id: Buffer | null;
  group_number: Buffer | null;
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

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const commit = process.argv.includes('--commit');
  const url = (
    process.env.BLIND_INDEX_DB_URL ??
    process.env.CLAIMS_READER_DATABASE_URL ??
    process.env.DATABASE_URL
  )?.trim();
  if (!url) throw new Error('BLIND_INDEX_DB_URL / CLAIMS_READER_DATABASE_URL must be set (never log it)');
  if (!process.env.LIBSODIUM_KEY) throw new Error('LIBSODIUM_KEY must be set (to decrypt existing PHI)');
  if (!process.env.INDEX_HMAC_KEY) throw new Error('INDEX_HMAC_KEY must be set (to compute blind indexes)');

  const db = makeClient(url);
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
        `select id, member_id, group_number from collections.cmd_explorer_rows
         where id > $1 and member_id_bidx is null order by id limit $2`,
        [cursor, BATCH],
      );
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1]!.id);
      scanned += rows.length;

      // Decrypt + compute tokens per row (in memory only). A row whose member_id can't be
      // decrypted is counted and skipped (never crashes the whole backfill).
      const updates: { id: string; m: string | null; p: string | null; g: string | null }[] = [];
      for (const r of rows) {
        let memberId: string | null = null;
        let groupNumber: string | null = null;
        try {
          if (r.member_id) memberId = await decryptPhi(r.member_id);
          if (r.group_number) groupNumber = await decryptPhi(r.group_number);
        } catch {
          undecryptable += 1;
          continue;
        }
        const bidx = blindIndexesForRow(memberId, groupNumber);
        updates.push({ id: r.id, m: bidx.member_id_bidx, p: bidx.member_id_prefix_bidx, g: bidx.group_number_bidx });
      }

      if (commit && updates.length > 0) {
        // Batched UPDATE ... FROM (values …). id cast bigint; tokens are text (or null).
        const params: unknown[] = [];
        const tuples = updates.map((u) => {
          const b = params.length;
          params.push(u.id, u.m, u.p, u.g);
          return `($${b + 1}::bigint, $${b + 2}::text, $${b + 3}::text, $${b + 4}::text)`;
        });
        await db.query(
          `update collections.cmd_explorer_rows t
             set member_id_bidx = v.m, member_id_prefix_bidx = v.p, group_number_bidx = v.g
           from (values ${tuples.join(', ')}) as v(id, m, p, g)
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
        (commit ? '' : '  Re-run with --commit to write.'),
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
