/**
 * CMD Collections backfill — one-shot loop over all CMD customer accounts to populate
 * collections.daily_collections (source_tag='cmd', Check+EFT by facility/day) AND refresh
 * collections.cmd_explorer_rows from the live report (10091971 / filter 10147499). Run locally
 * (no Vercel function deadline); also doubles as the timing check for the cron's wall-clock guard.
 *
 *   node --env-file=.env --import tsx src/collections/cmdDailyBackfill.ts            # DRY-RUN (no DB)
 *   node --env-file=.env --import tsx src/collections/cmdDailyBackfill.ts --commit   # write (cmd_rollup_writer)
 *
 * Reuses the EXACT cron code path (cmdExplorerCron) on --commit, so a successful backfill
 * validates the daily cron. DRY-RUN opens no DB connection: it fetches + maps + aggregates per
 * customer and prints COUNTS + summed dollars only (non-PHI) — never a cell value.
 *
 * SECURITY: writes as the least-privilege cmd_rollup_writer (CMD_ROLLUP_WRITER_DATABASE_URL) over
 * verify-full TLS. CMD creds + DB URL come from env only and are never logged.
 */
import { mapReportRows } from './cmdExplorer.js';
import { aggregateDailyDeposits } from './cmdExplorer.js';
import { mapRow } from './cmdExplorerSeed.js';
import { cmdExplorerCron } from './cmdExplorerCron.js';
import { CMD_EXPLORER_CUSTOMERS } from './cmdCustomers.js';
import { cmdReportRows, type CmdApiConfig } from './cmdPayer.js';
import { encryptPhi } from './phiCrypto.js';
import { makeClient } from './db.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal non-overriding repo-root .env loader (mirrors cmdExplorerSeed.ts). */
function loadDotEnvIfPresent(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '..', '.env'), 'utf8');
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

/** Base CMD config (auth + base url); customerId is filled per call. Mirrors cmdProbe/server. */
function baseConfig(): Omit<CmdApiConfig, 'customerId'> {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  const auth = token
    ? ({ kind: 'token', token } as const)
    : username && password
      ? ({ kind: 'basic', username, password } as const)
      : (() => {
          throw new Error('CMD credentials not set (CMD_API_TOKEN or CMD_API_USERNAME + CMD_API_PASSWORD)');
        })();
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    reportId: process.env.CMD_EXPLORER_REPORT_ID?.trim() || '10091971',
    filterId: process.env.CMD_EXPLORER_FILTER_ID?.trim() || '10147499',
    auth,
    pollIntervalMs: Number(process.env.CMD_EXPLORER_POLL_INTERVAL_MS) || 5_000,
    maxPollAttempts: Number(process.env.CMD_EXPLORER_POLL_ATTEMPTS) || 40,
  };
}

const f = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const commit = process.argv.slice(2).includes('--commit');
  const base = baseConfig();
  // Fail fast on a bad PHI key before any DB write (charge-line PHI is encrypted on insert).
  await encryptPhi('backfill-key-probe');

  console.log(`CMD daily backfill — ${commit ? 'COMMIT' : 'DRY-RUN'} — ${CMD_EXPLORER_CUSTOMERS.length} customers`);

  if (!commit) {
    let totFetched = 0, totCharge = 0, totDailyRows = 0, totDeposit = 0;
    for (const { customerId, facilityCode } of CMD_EXPLORER_CUSTOMERS) {
      const t0 = Date.now();
      let rows;
      try {
        rows = await cmdReportRows({ ...base, customerId });
      } catch (err) {
        console.log(`  ${facilityCode} (cust ${customerId}): FETCH FAILED — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let charge = 0;
      for (const full of mapReportRows(rows)) if (mapRow(full, 'cmd_api').ok) charge += 1;
      const daily = aggregateDailyDeposits(rows, facilityCode);
      const deposit = daily.reduce((s, d) => s + Number(d.gross_amount), 0);
      totFetched += rows.length; totCharge += charge; totDailyRows += daily.length; totDeposit += deposit;
      console.log(
        `  ${facilityCode} (cust ${customerId}): fetched ${rows.length}, charge-valid ${charge}, ` +
          `daily-days ${daily.length}, deposit $${f(deposit)}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`,
      );
    }
    console.log(`TOTAL: fetched ${totFetched}, charge-valid ${totCharge}, daily-days ${totDailyRows}, deposit $${f(totDeposit)}`);
    console.log('DRY-RUN — no database connection made. Re-run with --commit to load.');
    return;
  }

  const writerUrl = process.env.CMD_ROLLUP_WRITER_DATABASE_URL?.trim();
  if (!writerUrl) throw new Error('CMD_ROLLUP_WRITER_DATABASE_URL not set (required for --commit; never log it)');
  const writeDb = makeClient(writerUrl);
  try {
    const stats = await cmdExplorerCron({
      customers: CMD_EXPLORER_CUSTOMERS,
      fetchRows: (customerId) => cmdReportRows({ ...base, customerId }),
      writeDb,
      budgetMs: Number.MAX_SAFE_INTEGER, // local backfill: no wall-clock guard
    });
    console.log('COMMIT stats:', JSON.stringify(stats, null, 2));
  } finally {
    await writeDb.end();
  }
}

main().catch((err) => {
  console.error('cmd daily backfill failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
