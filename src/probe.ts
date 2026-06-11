/**
 * Connectivity probe — run BEFORE the full ingest. Fetches only row 1 (the
 * header, not PHI) of all three sheets and confirms each is reachable and the
 * first column header matches the expected per-year variant:
 *   2024 -> "Office Name", 2025/2026 -> "Facility Name".
 * Exits non-zero on any unreachable sheet or header mismatch.
 */
import { google } from 'googleapis';
import { getOAuthClient } from './auth.js';
import { SHEET_SOURCES } from './config.js';

async function main(): Promise<void> {
  const auth = await getOAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  let allOk = true;
  console.log('\n=== Connectivity probe (row 1 only — no PHI) ===');
  for (const s of SHEET_SOURCES) {
    const expected = s.year === 2024 ? 'Office Name' : 'Facility Name';
    let firstHeader = '';
    let ok = false;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.sheetId,
        range: `${s.tab}!1:1`,
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
      });
      firstHeader = String(res.data.values?.[0]?.[0] ?? '');
      ok = firstHeader.trim().toLowerCase() === expected.toLowerCase();
    } catch (e) {
      firstHeader = `<unreachable: ${e instanceof Error ? e.message : 'error'}>`;
    }
    allOk &&= ok;
    console.log(
      `  ${s.year} (${s.sheetId}): first header = ${JSON.stringify(firstHeader)} ` +
        `expected ${JSON.stringify(expected)} -> ${ok ? 'OK' : 'MISMATCH'}`,
    );
  }

  if (!allOk) {
    console.error('[probe] FAILED — do NOT run the ingest until all three pass.');
    process.exitCode = 1;
    return;
  }
  console.log('[probe] All three sheets reachable and first-column headers match. Safe to ingest.');
}

main().catch((err) => {
  console.error('[probe] FAILED:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
