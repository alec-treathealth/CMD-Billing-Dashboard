/**
 * Google Sheets reader. Reads cells as STRUCTURED VALUES (one array element per
 * cell) so embedded commas in Patient Name (`LAST, FIRST`) and Employer Name
 * (`THE VANGUARD GROUP, INC.`) can never shift columns — this is the
 * correctness requirement from CLAUDE.md "Why not CSV".
 *
 * The header-mapping helpers are pure and unit-tested; only `readSheet` does I/O.
 */
import { google } from 'googleapis';
import {
  CANONICAL_COLUMNS,
  EXPECTED_HEADERS,
  type CanonicalColumn,
  type RawRow,
} from './types.js';

export interface SheetRows {
  header: string[];
  rows: { rowNum: number; cells: string[] }[];
}

/**
 * Validate a sheet's header against the expected per-position headers and
 * return the canonical column order. Fails LOUD on any drift — mis-mapping PHI
 * columns silently is unacceptable. The only permitted variation is the first
 * column (`Office Name` vs `Facility Name`).
 */
export function buildColumnOrder(header: string[]): CanonicalColumn[] {
  if (header.length < EXPECTED_HEADERS.length) {
    throw new Error(
      `Header has ${header.length} columns, expected at least ${EXPECTED_HEADERS.length}. ` +
        `Sheet shape has drifted — refusing to map PHI columns by guess.`,
    );
  }
  EXPECTED_HEADERS.forEach((accepted, i) => {
    const actual = (header[i] ?? '').trim();
    const ok = accepted.some((a) => a.toLowerCase() === actual.toLowerCase());
    if (!ok) {
      throw new Error(
        `Column ${i} header mismatch: got ${JSON.stringify(actual)}, ` +
          `expected one of ${JSON.stringify(accepted)}. Refusing to map by guess.`,
      );
    }
  });
  return [...CANONICAL_COLUMNS];
}

/**
 * Map a row's cells to a canonical RawRow. The Sheets API TRUNCATES trailing
 * empty cells, so a row array can be shorter than the header — missing indices
 * become '' (which downstream normalizes to NULL). Verbatim values otherwise.
 */
export function toRawRow(cells: string[], columnOrder: CanonicalColumn[]): RawRow {
  const row = {} as RawRow;
  columnOrder.forEach((col, i) => {
    const v = cells[i];
    row[col] = v === undefined || v === null ? '' : String(v);
  });
  return row;
}

/**
 * Read a whole sheet tab as structured cells.
 * `FORMATTED_VALUE` + `FORMATTED_STRING` return exactly what a human sees in
 * the cell (e.g. "$-1,660.05", "1/5/2024", "PGE081", "-11724767"), preserving
 * the dirty patterns the normalizer is specced to handle and keeping the raw
 * landing faithful to the source.
 */
export async function readSheet(
  spreadsheetId: string,
  tab: string,
  auth: Parameters<typeof google.sheets>[0]['auth'],
): Promise<SheetRows> {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tab,
    majorDimension: 'ROWS',
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const values = (res.data.values ?? []) as unknown[][];
  if (values.length === 0) {
    throw new Error(`Sheet ${spreadsheetId} tab ${tab} returned no rows.`);
  }
  const header = (values[0] ?? []).map((c) => (c == null ? '' : String(c)));
  const rows = values.slice(1).map((cells, i) => ({
    // Row 1 is the header; first data row is sheet row 2. source_row_num is the
    // real 1-based sheet row, so the idempotency key is stable & traceable.
    rowNum: i + 2,
    cells: (cells ?? []).map((c) => (c == null ? '' : String(c))),
  }));
  return { header, rows };
}
