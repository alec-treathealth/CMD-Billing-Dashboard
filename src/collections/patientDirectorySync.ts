/**
 * One-shot CLI: build (or catch up) collections.cmd_patient_directory.
 *
 *   tsx src/collections/patientDirectorySync.ts            # dry run - reads, decrypts, writes NOTHING
 *   tsx src/collections/patientDirectorySync.ts --commit    # writes
 *
 * WHY A CLI WHEN THE HOURLY CRON ALREADY SYNCS: the cron carries a 120s budget so it cannot extend
 * a production-critical route's wall clock, and the INITIAL build has 686,503 rows to walk. Left to
 * the cron it would take several hours of hourly slices to catch up - correct, but it means name
 * search is partial (and silently so) for that whole window. Run this once after applying 0105, and
 * the cron only ever handles the hourly delta from then on.
 *
 * IT IS THE SAME CODE PATH. This is a thin driver over syncPatientDirectory - no second
 * implementation to drift. --commit swaps a counting no-op writer for the real one, which also
 * makes the dry run genuinely representative: it does every read, every decrypt and every dedup,
 * and only the INSERT is withheld.
 *
 * CONNECTIONS, and the split is the point (0105):
 *   - CLAIMS_READER_DATABASE_URL   reads cmd_explorer_rows.patient_name. claims_reader is the ONLY
 *                                  role with SELECT on the PHI columns.
 *   - CMD_ROLLUP_WRITER_DATABASE_URL  writes the directory. It holds INSERT there and NO select
 *                                  grant on patient_name, which is why one pool cannot do both.
 * Both go through makeClient, so verify-full TLS is applied and any sslmode in the URL is stripped
 * (an sslmode in a DB URL silently drops the CA).
 *
 * SAFETY: idempotent and resumable. The watermark is committed after every batch, so an interrupted
 * run resumes where it stopped; ON CONFLICT DO NOTHING absorbs anything already indexed. Re-running
 * a completed build is a no-op that scans nothing.
 *
 * PHI: names are decrypted in-process to be fingerprinted and are then dropped. This prints COUNTS
 * ONLY - never a name, a member id, or a token.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient } from './db.js';
import { decryptPhi } from './phiCrypto.js';
import { syncPatientDirectory, type DirectoryWriter } from './patientDirectory.js';

/** Minimal non-overriding .env loader (matches the other collections CLIs). */
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

/**
 * Dry-run writer: counts what WOULD be written and writes nothing.
 *
 * It reports `rowCount` as the tuple count, which is an UPPER BOUND rather than the truth - the
 * real INSERT's ON CONFLICT DO NOTHING would drop names already indexed by an earlier batch. Stated
 * because a dry run on a partly-built directory therefore over-reports inserts, and reading that
 * number as "this many are missing" would be wrong.
 */
function countingWriter(counts: { inserts: number; statements: number }): DirectoryWriter {
  return {
    query(sql: string): Promise<{ rowCount: number | null }> {
      counts.statements += 1;
      const values = sql.indexOf(') values ');
      if (values === -1) return Promise.resolve({ rowCount: 0 }); // the state upsert
      const tuples = sql.slice(values).split('), (').length;
      counts.inserts += tuples;
      return Promise.resolve({ rowCount: tuples });
    },
  };
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const commit = process.argv.includes('--commit');

  const readerUrl = process.env.CLAIMS_READER_DATABASE_URL?.trim();
  const writerUrl = process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim();
  if (!readerUrl) throw new Error('CLAIMS_READER_DATABASE_URL is not set.');
  if (commit && !writerUrl) throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL is not set (needed for --commit).');

  const reader = makeClient(readerUrl);
  const writer = commit && writerUrl ? makeClient(writerUrl) : null;
  const counts = { inserts: 0, statements: 0 };

  console.log(`patient-directory sync: ${commit ? 'COMMIT' : 'DRY RUN (no writes)'}`);
  try {
    const stats = await syncPatientDirectory({
      read: reader,
      write: writer ?? countingWriter(counts),
      decrypt: decryptPhi,
      // No wall-clock budget: this is the one-shot build and it should finish, unlike the hourly
      // slice that must yield the route back inside maxDuration.
      budgetMs: Number.POSITIVE_INFINITY,
    });
    console.log(
      `  rows scanned        ${stats.rows_scanned.toLocaleString()}\n` +
        `  distinct names seen ${stats.keys_seen.toLocaleString()}\n` +
        `  names ${commit ? 'inserted' : 'that WOULD insert'}  ${(commit ? stats.names_inserted : counts.inserts).toLocaleString()}` +
        `${commit ? '' : '   (upper bound - ON CONFLICT would drop cross-batch repeats)'}\n` +
        `  watermark           ${stats.last_row_id.toLocaleString()}\n` +
        `  skipped no member   ${stats.skipped_no_member.toLocaleString()}\n` +
        `  decrypt failures    ${stats.decrypt_failures.toLocaleString()}\n` +
        `  reached end         ${stats.exhausted}\n` +
        `  duration            ${(stats.duration_ms / 1000).toFixed(1)}s`,
    );
    if (!commit) console.log('\nDry run - nothing was written. Re-run with --commit to build.');
  } finally {
    await reader.end();
    if (writer) await writer.end();
  }
}

main().catch((err) => {
  // Never print the error object wholesale: a pg error can carry the failing statement, and this
  // module's statements carry ciphertext parameters.
  console.error('patient-directory sync failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
