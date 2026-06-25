/**
 * One-off CMD Web API probe — run BEFORE trusting src/collections/cmdPayer.ts.
 *
 *   npm run probe:cmd
 *
 * Purpose: exercise the real CollaborateMD batch-reporting contract end-to-end and
 * reveal the report's STRUCTURE so the mapping in cmdPayer.ts stays grounded in
 * reality. The flow is the documented two-step async one:
 *   1. POST .../reports/{report}/filter/{filter}/run  → Identifier (requestSeq)
 *   2. POST .../reports/results/{requestSeq}          → base64 → .zip of CSV(s)
 * polling while Status is "REPORT RUNNING".
 *
 * PHI SAFETY: this prints STRUCTURE ONLY — the run-step envelope keys, the zip
 * entry filenames, each CSV's column headers, and row COUNTS. It never prints any
 * field VALUE, so no patient-level data is emitted. Credentials are read from env
 * and never printed.
 *
 * Credentials (env only): CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD.
 * Optional overrides: CMD_API_BASE_URL, CMD_CUSTOMER_ID, CMD_REPORT_ID,
 * CMD_FILTER_ID. Poll tuning: CMD_POLL_ATTEMPTS, CMD_POLL_INTERVAL_MS.
 */
import {
  cmdRunReport,
  cmdFetchResults,
  describeReportZip,
  type CmdApiConfig,
} from './cmdPayer.js';

function configFromEnv(): CmdApiConfig {
  const token = process.env.CMD_API_TOKEN?.trim();
  const username = process.env.CMD_API_USERNAME?.trim();
  const password = process.env.CMD_API_PASSWORD?.trim();
  let auth: CmdApiConfig['auth'];
  if (token) auth = { kind: 'token', token };
  else if (username && password) auth = { kind: 'basic', username, password };
  else {
    throw new Error(
      'CMD credentials not set. Provide CMD_API_TOKEN, or CMD_API_USERNAME + CMD_API_PASSWORD, in your env.',
    );
  }
  return {
    baseUrl: process.env.CMD_API_BASE_URL?.trim() || 'https://webapi.collaboratemd.com',
    customerId: process.env.CMD_CUSTOMER_ID?.trim() || '10027973',
    reportId: process.env.CMD_REPORT_ID?.trim() || '10091828',
    filterId: process.env.CMD_FILTER_ID?.trim() || '10147241',
    auth,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const intervalMs = Number(process.env.CMD_POLL_INTERVAL_MS) || 15_000;
  const maxAttempts = Number(process.env.CMD_POLL_ATTEMPTS) || 40;

  console.log(`Probing CMD report ${cfg.reportId} / filter ${cfg.filterId} (window set by filter)`);

  // Step 1 — fire the run; the window is baked into the saved filter (no date param).
  const requestSeq = await cmdRunReport(cfg);
  console.log(`run → requestSeq: ${requestSeq}`);

  // Step 2 — poll results until the base64 zip is ready (PHI-safe: status only).
  let zip: Buffer | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await cmdFetchResults(cfg, requestSeq);
    if (Buffer.isBuffer(out)) {
      zip = out;
      console.log(`results → ready on attempt ${attempt} (${out.byteLength} zip bytes)`);
      break;
    }
    if (out === 'TIMED_OUT') {
      console.error('results → REPORT TIMED OUT (narrow the saved filter and retry).');
      process.exitCode = 1;
      return;
    }
    console.log(`results → REPORT RUNNING (attempt ${attempt}/${maxAttempts}); waiting…`);
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  if (!zip) {
    console.error('results → still running after poll budget exhausted.');
    process.exitCode = 1;
    return;
  }

  // Structure only — entry filenames, CSV column headers, row counts. No values.
  console.log('--- report zip structure (structure only; no values) ---');
  for (const entry of describeReportZip(zip)) {
    console.log(`  entry: ${entry.name}  (rows: ${entry.rowCount})`);
    if (entry.columns.length > 0) {
      console.log(`    columns (${entry.columns.length}): ${entry.columns.join(' | ')}`);
    }
  }
  console.log('--- end ---');
}

main().catch((err) => {
  // Status/label only — the client never includes the body, so this is PHI-safe.
  console.error('CMD probe failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
