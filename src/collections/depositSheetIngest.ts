/**
 * Deposit-Sheet daily ingest — consolidated 2026 IP/OP deposit Sheet →
 * collections.daily_collections (source_tag='deposit_sheet').
 *
 *   tsx src/collections/depositSheetIngest.ts            # DRY-RUN (no DB writes)
 *   tsx src/collections/depositSheetIngest.ts --commit   # load (claims_admin)
 *
 * WHY: re-source the "By Location" daily deposit series from the consolidated Sheet
 * (current through the latest banking day, all 15 facilities incl. Dallas), WITHOUT
 * wiping the legacy 'workbook' history. The resolved view (migration 0014) prefers
 * deposit_sheet rows for display; legacy rows are retained.
 *
 * Idempotent: replaceDepositSheetDaily upserts the verbatim raw rows, then DELETEs
 * and re-inserts only the source_tag='deposit_sheet' daily rows, in one transaction.
 * A re-run with identical source yields identical rows (adds nothing).
 *
 * PHI: none — Shape A is non-PHI (facility/date/checks/eft/gross). Logs carry COUNTS
 * + facility codes/months only. SECRETS: CLAIMS_ADMIN_DATABASE_URL from env only
 * (never logged). DRY-RUN makes no DB connection.
 */
import { getOAuthClient } from '../auth.js';
import { loadConfig } from '../config.js';
import { DEPOSIT_SHEET_ID } from './config.js';
import { makeClient, replaceDepositSheetDaily } from './db.js';
import { parseDepositSheet } from './depositSheet.js';
import { CollectionsReport } from './report.js';
import { listTabs, readTab } from './sheets.js';
import type { Tab } from './shapes.js';

function parseArgs(argv: string[]): { commit: boolean } {
  return { commit: argv.includes('--commit') };
}

async function main(): Promise<void> {
  const { commit } = parseArgs(process.argv.slice(2));
  const auth = await getOAuthClient();
  const report = new CollectionsReport(commit ? 'commit-deposit' : 'dryrun-deposit');

  try {
    const titles = await listTabs(DEPOSIT_SHEET_ID, auth);
    const tabs: Tab[] = [];
    for (const title of titles) tabs.push(await readTab(DEPOSIT_SHEET_ID, title, auth));

    const result = parseDepositSheet(tabs, DEPOSIT_SHEET_ID, report);
    const months = [...result.months].sort();

    console.log(`Deposit-Sheet ingest — ${commit ? 'LOAD' : 'DRY-RUN'} (source: ${DEPOSIT_SHEET_ID})`);
    console.log(`  tabs read: ${tabs.length}`);
    console.log(`  daily rows parsed: ${result.daily.length}`);
    console.log(`  raw rows: ${result.raws.length}`);
    console.log(`  facilities (${result.facilities.size}): ${[...result.facilities].sort().join(', ')}`);
    console.log(`  months: ${months.length === 0 ? '(none)' : `${months[0]}..${months[months.length - 1]} (${months.length})`}`);
    console.log(`  gross != checks+eft (kept): ${result.grossMismatches}`);
    console.log(`  failed-coercion rows: ${report.failures} (${report.failPath})`);
    if (result.unresolved.size > 0) {
      console.log(`  !! UNRESOLVED facility labels (skipped, never auto-created):`);
      for (const [label, n] of [...result.unresolved.entries()].sort()) console.log(`     ${JSON.stringify(label)} -> ${n} block-rows`);
    } else {
      console.log(`  unresolved facility labels: 0 (all blocks resolved to a real facility_code)`);
    }

    if (!commit) {
      console.log('DRY-RUN — no database connection made. Re-run with --commit to load.');
      return;
    }

    const db = makeClient(loadConfig().claimsAdminDatabaseUrl);
    try {
      const { rawUpserted, dailyDeleted, dailyInserted } = await replaceDepositSheetDaily(
        db,
        DEPOSIT_SHEET_ID,
        result.raws,
        result.daily,
      );
      console.log(
        `COMMIT — raw upserted ${rawUpserted}; deposit_sheet daily deleted ${dailyDeleted}, inserted ${dailyInserted}.`,
      );
    } finally {
      await db.end();
    }
  } finally {
    await report.close();
  }
}

// Only run the CLI when invoked directly (not when imported by tests).
if (process.argv[1] && /depositSheetIngest\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    // Message only — never the sheet contents.
    console.error('Deposit-Sheet ingest failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
