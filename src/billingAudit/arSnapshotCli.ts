/**
 * AR Management — manual snapshot ingest CLI.
 *
 *   npm run ingest:ar-snapshot -- [--from-dir <dir>] [--customer <id>] [--commit] [--staleness-ms <n>]
 *
 * Without --commit: DRY RUN — parse + map each customer's snapshot and print NON-PHI counts
 * (claims / charges / notes / skips) and the derived status distribution. With --commit: run the
 * SAME cron loop production uses (arSnapshotCron) against CLAIMS_AUDIT_WRITER_DATABASE_URL, after
 * asserting the writer identity. `--from-dir` reads saved `customer_<id>_<date>.zip` files (the
 * latest date per customer) instead of calling CMD; without it the live V2 endpoint is used with
 * the CMD_API_USERNAME / CMD_API_PASSWORD credentials. Staleness defaults to 0 here (always pull)
 * — the cron's 20h window is a scheduling concern, not a manual one.
 *
 * Secrets from .env / env only; never logged. No snapshot content is printed — payer names and
 * derived status labels are the only strings, and those are the same non-PHI vocabulary
 * claims.audit_row already carries.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient } from '../collections/db.js';
import { cmdFetchSnapshot, type CmdSnapshotResult } from '../collections/cmdSnapshot.js';
import { AR_EXPECTED_EMPTY_CUSTOMERS, AR_SNAPSHOT_CUSTOMERS } from './arConfig.js';
import { mapSnapshot } from './arSnapshotMap.js';
import { arSnapshotCron } from './arSnapshotCron.js';
import { parseSnapshotZip } from './snapshotParse.js';

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

/** Latest saved ZIP per customer in a directory. */
function savedZips(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(dir).sort()) {
    const m = /^customer_(\d{8})_\d{4}-\d{2}-\d{2}\.zip$/.exec(f);
    if (m) out.set(m[1]!, join(dir, f)); // sorted ascending → last write wins = latest date
  }
  return out;
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const commit = process.argv.includes('--commit');
  const fromDir = arg('from-dir');
  const only = arg('customer');
  const stalenessMs = Number(arg('staleness-ms') ?? '0');

  const zips = fromDir ? savedZips(fromDir) : null;
  const customers = AR_SNAPSHOT_CUSTOMERS.filter((c) => (only ? c.customerId === only : true)).filter((c) => (zips ? zips.has(c.customerId) : true));
  console.log(`ar-snapshot: ${commit ? 'COMMIT' : 'DRY RUN'} · source=${fromDir ? `dir ${fromDir}` : 'live CMD'} · customers=${customers.length}`);

  const fetchSnapshot = async (customerId: string): Promise<CmdSnapshotResult> => {
    if (zips) return { kind: 'zip', bytes: readFileSync(zips.get(customerId)!) };
    const username = process.env.CMD_API_USERNAME?.trim();
    const password = process.env.CMD_API_PASSWORD?.trim();
    if (!username || !password) throw new Error('CMD_API_USERNAME / CMD_API_PASSWORD not set');
    return cmdFetchSnapshot({
      baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
      customerId,
      auth: { kind: 'basic', username, password },
    });
  };

  if (!commit) {
    const totals = { claims: 0, open: 0, openBalance: 0, charges: 0, notes: 0 };
    const statusDist = new Map<string, number>();
    for (const c of customers) {
      const snap = await fetchSnapshot(c.customerId);
      if (snap.kind !== 'zip') { console.log(`  ${c.facilityCode.padEnd(14)} ${c.customerId}  ${snap.kind}`); continue; }
      const m = mapSnapshot(parseSnapshotZip(snap.bytes));
      const open = m.claims.filter((x) => Number(x.balance) > 0);
      const openBal = open.reduce((a, x) => a + Number(x.balance), 0);
      totals.claims += m.claims.length; totals.open += open.length; totals.openBalance += openBal; totals.charges += m.charges.length; totals.notes += m.notes.length;
      for (const cl of open) statusDist.set(cl.statusCategory, (statusDist.get(cl.statusCategory) ?? 0) + 1);
      console.log(
        `  ${c.facilityCode.padEnd(14)} ${c.customerId}  zip=${String(snap.bytes.length).padStart(8)}  claims=${String(m.claims.length).padStart(6)}  open=${String(open.length).padStart(5)}  ` +
          `openBal=$${openBal.toFixed(2).padStart(13)}  charges=${String(m.charges.length).padStart(6)}  notes=${String(m.notes.length).padStart(5)}  remits=${String(m.remits.length).padStart(6)}  ` +
          `statusEvents=${String(m.statusEvents.length).padStart(6)}  asOf=${m.snapshotAsOf ?? '-'}  skips=${JSON.stringify(m.skips)}`,
      );
    }
    console.log(`  TOTAL claims=${totals.claims} open=${totals.open} openBal=$${totals.openBalance.toFixed(2)} charges=${totals.charges} notes=${totals.notes}`);
    console.log('  open claims by status category:', [...statusDist.entries()].sort((a, b) => b[1] - a[1]));
    return;
  }

  const writerUrl = process.env.CLAIMS_AUDIT_WRITER_DATABASE_URL?.trim();
  if (!writerUrl) throw new Error('CLAIMS_AUDIT_WRITER_DATABASE_URL is not set (needed for --commit).');
  const db = makeClient(writerUrl);
  try {
    const who = await db.query<{ u: string; is_super: boolean; has_writer: boolean; is_admin: boolean }>(
      `select current_user as u, coalesce((select rolsuper from pg_roles where rolname = current_user), false) as is_super, ` +
        `pg_has_role(current_user, 'claims_audit_writer', 'USAGE') as has_writer, pg_has_role(current_user, 'claims_admin', 'MEMBER') as is_admin`,
    );
    const row = who.rows[0];
    if (!row || !row.has_writer || row.is_super || row.is_admin) throw new Error(`writer identity check failed (user=${row?.u ?? '?'}) — refusing to write`);
    console.log(`  writer identity ok: ${row.u}`);
    const stats = await arSnapshotCron({
      customers,
      fetchSnapshot,
      writeDb: db,
      writerUser: row.u,
      expectedEmptyCustomerIds: AR_EXPECTED_EMPTY_CUSTOMERS,
      stalenessMs,
      budgetMs: Number.POSITIVE_INFINITY,
    });
    for (const r of stats.per_customer) {
      console.log(`  ${r.facilityCode.padEnd(14)} ${r.customerId}  ${r.outcome.padEnd(15)} claims=${String(r.claims).padStart(6)} charges=${String(r.charges).padStart(6)} notes+=${String(r.notesInserted).padStart(5)}${r.errorLabel ? `  ${r.errorLabel}` : ''}`);
    }
    const { per_customer: _pc, ...summary } = stats;
    console.log('  summary:', summary);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('ar-snapshot failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
