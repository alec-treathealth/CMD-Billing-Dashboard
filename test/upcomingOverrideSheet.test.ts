/**
 * "Upcoming Payments" override sheet — PURE parser tests.
 *
 * The load-bearing assertions here are the PHI drop (a patient name must be unreachable
 * from every output surface, including error paths) and the money arithmetic (exact integer
 * cents, never parseFloat). Header drift and facility-alias resolution are next: both are
 * silent-mis-attribution risks on a money surface.
 *
 * Fixtures are modelled on the REAL sheet as observed 2026-08-03 — the same round-thousand
 * amounts, the `Multiple` batch sentinel, the `TMHWA`/`DLMH` label spellings that disagree
 * with the roster, and the unmapped `Teen Mental Health` label.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OVERRIDE_HEADERS,
  centsFromCurrency,
  findOverrideHeader,
  fixed2FromCents,
  isoFromSheetDate,
  knownFacilityCodes,
  normalizeFacilityLabel,
  parseOverrideSheet,
  resolveFacilityCode,
  resolveMethodLabel,
  type OverrideGrid,
} from '../src/veris/upcomingOverrideSheet.js';

const HEADER = [...OVERRIDE_HEADERS];

/** A patient name that must never appear in any parser output. */
const PHI_NAME = 'Jordan M';

function grid(...dataRows: string[][]): OverrideGrid {
  return {
    rows: [
      { rowNum: 1, cells: HEADER },
      ...dataRows.map((cells, i) => ({ rowNum: i + 2, cells })),
    ],
  };
}

// --- header contract ---------------------------------------------------------

/** The live sheet's ABANDONED row-3 header — also six columns. Must never match. */
const ABANDONED_HEADER = [
  'Facility',
  'Insurance',
  'Client',
  'Date/Range',
  'Auth or Claim Issue',
  'Last Update',
];

function gridOfRows(rows: string[][]): OverrideGrid {
  return { rows: rows.map((cells, i) => ({ rowNum: i + 1, cells })) };
}

test('findOverrideHeader finds the canonical header wherever it sits', () => {
  assert.equal(findOverrideHeader(gridOfRows([HEADER])), 1);
  assert.equal(findOverrideHeader(gridOfRows([['junk'], [], ['note', 'x'], HEADER])), 4);
});

test('findOverrideHeader is case-insensitive and trims', () => {
  assert.equal(
    findOverrideHeader(
      gridOfRows([['  facility ', 'INSURANCE', 'Client', 'date', 'Check or EFT', ' amount']]),
    ),
    1,
  );
});

test('findOverrideHeader tolerates EXTRA trailing columns (operator scratch notes)', () => {
  assert.equal(findOverrideHeader(gridOfRows([[...HEADER, 'Notes', 'Follow-up']])), 1);
});

test('EXACT MATCH IS LOAD-BEARING: the abandoned 6-column header must NEVER match', () => {
  // A loose "first six-column row" finder would latch onto ABANDONED_HEADER and map
  // Amount onto "Last Update". Its Date/Range cell must disqualify it.
  assert.equal(findOverrideHeader(gridOfRows([ABANDONED_HEADER, HEADER])), 2);
  assert.throws(() => findOverrideHeader(gridOfRows([ABANDONED_HEADER])), /not found/i);
});

test('findOverrideHeader does not match a reordered header', () => {
  // Amount and Date swapped — the exact drift that would land a date in a money column.
  const drifted = [...HEADER];
  drifted[3] = 'Amount';
  drifted[5] = 'Date';
  assert.throws(() => findOverrideHeader(gridOfRows([drifted])), /not found/i);
});

test('findOverrideHeader fails loud with the scanned-row count when no header exists', () => {
  assert.throws(
    () => findOverrideHeader(gridOfRows([['Facility', 'Insurance'], ['junk']])),
    /not found in the 2 row/i,
  );
});

test('findOverrideHeader gives up past the scan limit rather than scanning forever', () => {
  const rows: string[][] = Array.from({ length: 60 }, () => ['x']);
  rows[55] = [...HEADER]; // rowNum 56 — beyond the limit of 50
  assert.throws(() => findOverrideHeader(gridOfRows(rows)), /not found/i);
});

test('parseOverrideSheet propagates a missing header as a throw (fail-soft happens upstream)', () => {
  const bad: OverrideGrid = { rows: [{ rowNum: 1, cells: ['Nope', 'Wrong'] }] };
  assert.throws(() => parseOverrideSheet(bad), /drifted/i);
});

// --- facility alias resolution -----------------------------------------------

test('normalizeFacilityLabel folds spacing, underscores, hyphens and dots', () => {
  for (const v of ['TMH WA', 'TMHWA', 'tmh_wa', 'TMH-WA', 't.m.h.w.a', '  TMH   WA  ']) {
    assert.equal(normalizeFacilityLabel(v.trim()), 'TMHWA', v);
  }
});

test('resolveFacilityCode maps the sheet spellings that DISAGREE with the roster', () => {
  // These are the whole reason the alias table exists.
  assert.equal(resolveFacilityCode('TMHWA'), 'TREAT_WA');
  assert.equal(resolveFacilityCode('TMH WA'), 'TREAT_WA');
  assert.equal(resolveFacilityCode('TMHCA'), 'TREAT_CA');
  assert.equal(resolveFacilityCode('DLMH'), 'DMH'); // sheet DLMH → roster DMH
  assert.equal(resolveFacilityCode('Telehealth MH'), 'TELEHEALTH_MH');
});

test('resolveFacilityCode passes through labels that already match the roster', () => {
  for (const c of ['CAMH', 'PCMH', 'LAMH', 'LSMH', 'KWC', 'TBH', 'NASH', 'FRCA']) {
    assert.equal(resolveFacilityCode(c), c);
  }
});

test('resolveFacilityCode also accepts the canonical codes themselves', () => {
  assert.equal(resolveFacilityCode('TREAT_WA'), 'TREAT_WA');
  assert.equal(resolveFacilityCode('DMH'), 'DMH');
  assert.equal(resolveFacilityCode('TELEHEALTH_MH'), 'TELEHEALTH_MH');
});

test('resolveFacilityCode returns null for "Teen Mental Health" — NEEDS A RULING, never guessed', () => {
  // Closest roster match is Indigo's MY TEEN MENTAL HEALTH (10034230) — a DIFFERENT tenant.
  // Mapping it either way would cross-attribute money, so it must stay unresolved.
  assert.equal(resolveFacilityCode('Teen Mental Health'), null);
});

test('resolveFacilityCode returns null for an unknown label rather than inventing a code', () => {
  assert.equal(resolveFacilityCode('SOME NEW FACILITY'), null);
  assert.equal(resolveFacilityCode(''), null);
});

test('every alias resolves to a real BXR roster facilityCode', () => {
  // Guards against a typo'd value in the alias table silently creating a phantom facility.
  const roster = new Set([
    'CAMH', 'DMH', 'KWC', 'LAMH', 'LSMH', 'NASH', 'PCMH', 'TBH',
    'FRCA', 'TELEHEALTH_MH', 'TREAT_CA', 'TREAT_NV', 'TREAT_TN', 'TREAT_TX', 'TREAT_WA',
  ]);
  for (const code of knownFacilityCodes()) {
    assert.ok(roster.has(code), `${code} is not a BXR roster facilityCode`);
  }
});

// --- money: exact integer cents ---------------------------------------------

test('centsFromCurrency handles BOTH workbook currency formats', () => {
  assert.equal(centsFromCurrency('$35,000.00'), 3_500_000); // tab-1 / footer: no space
  assert.equal(centsFromCurrency('$ 19,832.60'), 1_983_260); // grid cells: one space
  assert.equal(centsFromCurrency('  $  1,234.5  '), 123_450); // one decimal digit pads
  assert.equal(centsFromCurrency('72000'), 7_200_000); // bare number
});

test('centsFromCurrency REJECTS the "$ -" zero sentinel (023 CHECKs amount > 0)', () => {
  assert.equal(centsFromCurrency('$ -'), null);
  assert.equal(centsFromCurrency('$-'), null);
  assert.equal(centsFromCurrency(''), null);
});

test('centsFromCurrency REJECTS negatives — a takeback is not an expected payment', () => {
  for (const v of ['-$10.00', '$-10.00', '($10.00)', '-10', '(1,234.00)']) {
    assert.equal(centsFromCurrency(v), null, v);
  }
});

test('centsFromCurrency rejects junk rather than coercing it to a number', () => {
  for (const v of ['Total', 'EFT', '12.345', '1,23.00', 'abc', '$', '1e5']) {
    assert.equal(centsFromCurrency(v), null, v);
  }
});

test('cents arithmetic is exact where float addition would drift', () => {
  // 0.1 + 0.2 !== 0.3 in float. In cents it is exact, which is the whole point.
  const a = centsFromCurrency('$0.10')!;
  const b = centsFromCurrency('$0.20')!;
  assert.equal(a + b, 30);
  assert.equal(fixed2FromCents(a + b), '0.30');
});

test('fixed2FromCents round-trips through centsFromCurrency', () => {
  // Includes 0: an explicit "$0.00" PARSES to 0 (it is well-formed currency). Rejecting
  // zero is the caller's job, not the tokenizer's — parseOverrideSheet drops it via
  // `amountCents <= 0` and migration 023 CHECKs amount > 0. Only the "$ -" sentinel, which
  // is not a number at all, returns null. Asserted separately below.
  for (const cents of [0, 1, 99, 100, 3_500_000, 29_100_000]) {
    assert.equal(centsFromCurrency(`$${fixed2FromCents(cents)}`), cents);
  }
});

test('an explicit $0.00 parses to 0 but is REJECTED as a forecast row', () => {
  assert.equal(centsFromCurrency('$0.00'), 0); // well-formed currency
  assert.equal(centsFromCurrency('$ -'), null); // the sentinel is not a number
  const out = parseOverrideSheet(grid(['CAMH', 'BCBS', 'Multiple', '08/04/2026', 'EFT', '$0.00']));
  assert.equal(out.rows.length, 0, 'a $0 expected payment is not a forecast');
  assert.equal(out.rejects[0]!.reason, 'bad_amount');
});

// --- dates: strict, no rollover ---------------------------------------------

test('isoFromSheetDate converts MM/DD/YYYY to ISO', () => {
  assert.equal(isoFromSheetDate('08/03/2026'), '2026-08-03');
  assert.equal(isoFromSheetDate('8/3/2026'), '2026-08-03'); // single-digit tolerated
  assert.equal(isoFromSheetDate('12/31/2026'), '2026-12-31');
});

test('isoFromSheetDate REJECTS dates that would silently roll over', () => {
  // Date's rollover would turn these into real-but-WRONG days on a money timeline.
  assert.equal(isoFromSheetDate('02/30/2026'), null);
  assert.equal(isoFromSheetDate('04/31/2026'), null);
  assert.equal(isoFromSheetDate('02/29/2026'), null); // 2026 is not a leap year
  assert.equal(isoFromSheetDate('13/01/2026'), null);
  assert.equal(isoFromSheetDate('00/01/2026'), null);
});

test('isoFromSheetDate accepts a real leap day', () => {
  assert.equal(isoFromSheetDate('02/29/2028'), '2028-02-29');
});

test('isoFromSheetDate rejects non-MM/DD/YYYY shapes rather than guessing', () => {
  for (const v of ['2026-08-03', '08-03-2026', '08/03/26', 'Aug 3 2026', '', '8/3']) {
    assert.equal(isoFromSheetDate(v), null, v);
  }
});

// --- method label ------------------------------------------------------------

test('resolveMethodLabel normalizes to the sheet closed set, not BPR04 codes', () => {
  assert.equal(resolveMethodLabel('EFT'), 'EFT');
  assert.equal(resolveMethodLabel('eft'), 'EFT');
  assert.equal(resolveMethodLabel('Check'), 'Check');
  assert.equal(resolveMethodLabel(' CHK '), 'Check');
  assert.equal(resolveMethodLabel('NON'), null); // an X12 code is NOT a sheet value
  assert.equal(resolveMethodLabel(''), null);
});

// --- the PHI boundary --------------------------------------------------------

test('THE PHI DROP: a patient name never reaches any parser output', () => {
  const g = grid(
    ['TMHWA', 'Regence', PHI_NAME, '08/03/2026', 'EFT', '$35,000.00'],
    ['PCMH', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$44,000.00'],
  );
  const out = parseOverrideSheet(g);
  assert.equal(out.rows.length, 2);

  // The named row is flagged; the batch row is not.
  assert.equal(out.rows[0]!.isPatientSpecific, true);
  assert.equal(out.rows[1]!.isPatientSpecific, false);

  // THE ASSERTION THAT MATTERS: serialize the ENTIRE output and prove the name is absent.
  // This catches the name leaking via any field, including one added later.
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes(PHI_NAME), false, 'patient name leaked into parser output');
  assert.equal(serialized.includes('Jordan'), false);

  // And no row object carries a name-shaped key at all.
  for (const row of out.rows) {
    for (const key of Object.keys(row)) {
      assert.doesNotMatch(key, /client|patient(?!Specific)|name|member/i, `suspicious key ${key}`);
    }
  }
});

test('THE PHI DROP holds on the REJECT path too', () => {
  // A row that is mis-keyed (name in the Insurance column, unmapped facility) must not echo
  // any cell content except the facility label. This is the sneaky leak route.
  const g = grid(['Teen Mental Health', PHI_NAME, PHI_NAME, 'garbage', 'nope', 'nope']);
  const out = parseOverrideSheet(g);
  assert.equal(out.rows.length, 0);
  assert.equal(out.rejects.length, 1);
  assert.equal(out.rejects[0]!.reason, 'unmapped_facility');
  assert.equal(out.rejects[0]!.facilityLabel, 'Teen Mental Health');
  assert.equal(
    JSON.stringify(out).includes(PHI_NAME),
    false,
    'patient name leaked through a reject',
  );
});

test('a blank Client cell is treated as a batch, not as a named patient', () => {
  const out = parseOverrideSheet(grid(['CAMH', 'Aetna', '', '08/04/2026', 'EFT', '$17,000.00']));
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]!.isPatientSpecific, false);
});

// --- whole-sheet parse behaviour --------------------------------------------

test('parseOverrideSheet parses a realistic sheet and totals in exact cents', () => {
  const g = grid(
    ['TMHWA', 'Regence', PHI_NAME, '08/03/2026', 'EFT', '$35,000.00'],
    ['CAMH', 'BCBS', 'Multiple', '08/03/2026', 'EFT', '$11,000.00'],
    ['PCMH', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$44,000.00'],
    ['KWC', 'BCBS AR', 'Multiple', '05/26/2026', 'Check', '$72,000.00'],
  );
  const out = parseOverrideSheet(g);
  assert.equal(out.rows.length, 4);
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(out.unmappedFacilities, []);

  const total = out.rows.reduce((s, r) => s + r.amountCents, 0);
  assert.equal(total, 16_200_000); // $162,000.00 exactly
  assert.equal(fixed2FromCents(total), '162000.00');

  // Alias resolution applied, sheet labels NOT stored.
  assert.deepEqual(
    out.rows.map((r) => r.facilityCode),
    ['TREAT_WA', 'CAMH', 'PCMH', 'KWC'],
  );
  // Payer label kept verbatim (trimmed) — non-PHI, operator shorthand.
  assert.equal(out.rows[3]!.payerLabel, 'BCBS AR');
  assert.equal(out.rows[3]!.methodLabel, 'Check');
  // A stale past date still parses — "upcoming" filtering is the READ's job (cutoff), not
  // the parser's. Landing it keeps the table an honest mirror of the sheet.
  assert.equal(out.rows[3]!.expectedDate, '2026-05-26');
  // Traceability: real 1-based sheet rows.
  assert.deepEqual(out.rows.map((r) => r.sourceRowNum), [2, 3, 4, 5]);
});

test('fully blank rows are skipped SILENTLY, not reported as rejects', () => {
  const g = grid(
    ['CAMH', 'BCBS', 'Multiple', '08/03/2026', 'EFT', '$11,000.00'],
    ['', '', '', '', '', ''],
    ['   ', '', '', '', '', ''], // whitespace-only, as the real sheet has
    [],
    ['PCMH', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$44,000.00'],
  );
  const out = parseOverrideSheet(g);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rejects, [], 'sheet whitespace must not be reported as failures');
});

test('partially-filled rows ARE rejected with a reason code and no cell content', () => {
  const g = grid(
    ['CAMH', 'BCBS', 'Multiple', 'not-a-date', 'EFT', '$11,000.00'],
    ['PCMH', '', 'Multiple', '08/04/2026', 'EFT', '$44,000.00'],
    ['LAMH', 'Aetna', 'Multiple', '08/04/2026', 'Carrier Pigeon', '$1,000.00'],
    ['LSMH', 'Aetna', 'Multiple', '08/04/2026', 'EFT', '$ -'],
  );
  const out = parseOverrideSheet(g);
  assert.equal(out.rows.length, 0);
  assert.deepEqual(
    out.rejects.map((r) => [r.rowNum, r.reason]),
    [
      [2, 'bad_date'],
      [3, 'missing_payer'],
      [4, 'bad_method'],
      [5, 'bad_amount'],
    ],
  );
  // Only unmapped_facility may carry a label; nothing else echoes a cell.
  for (const r of out.rejects) assert.equal(r.facilityLabel, undefined);
});

test('a blank-Facility row is a NON-DATA row — skipped silently, never rejected', () => {
  // The Total footer and section spacers leave Facility blank; 'missing_facility' left the
  // reject union DELIBERATELY (Alec, 2026-08-03). This includes a half-keyed row that has
  // other content — the accepted trade for a footer that would otherwise reject every sync.
  const g = grid(
    ['', 'Aetna', 'Multiple', '08/04/2026', 'EFT', '$1,000.00'],
    ['', '', '', '', 'Total ', '$481,000.00'], // the live footer, trailing space and all
  );
  const out = parseOverrideSheet(g);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.rejects, [], 'blank-Facility rows must never surface as rejects');
});

test('unmapped facilities are collected DISTINCT and sorted for the needs-a-ruling list', () => {
  const g = grid(
    ['Teen Mental Health', 'BCBS', 'Multiple', '08/03/2026', 'EFT', '$1,000.00'],
    ['Teen Mental Health', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$2,000.00'],
    ['Brand New Place', 'UHC', 'Multiple', '08/04/2026', 'EFT', '$3,000.00'],
    ['CAMH', 'BCBS', 'Multiple', '08/05/2026', 'EFT', '$4,000.00'],
  );
  const out = parseOverrideSheet(g);
  assert.equal(out.rows.length, 1, 'the one mappable row still lands');
  assert.deepEqual(out.unmappedFacilities, ['Brand New Place', 'Teen Mental Health']);
  assert.equal(out.rejects.length, 3);
});

test('the Total footer row is skipped structurally, never counted and never a reject', () => {
  // The real sheet's Total row puts its label in column 5 and the amount in column 6,
  // leaving Facility blank — the structural signal, robust to the label's exact text.
  for (const label of ['Total', 'Total ', 'TOTAL', 'Grand Total']) {
    const out = parseOverrideSheet(grid(['', '', '', '', label, '$291,000.00']));
    assert.equal(out.rows.length, 0, label);
    assert.deepEqual(out.rejects, [], label);
  }
});

test('an empty data region parses to nothing without throwing', () => {
  const out = parseOverrideSheet(grid());
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(out.unmappedFacilities, []);
});

// --- THE LIVE "Current Updates" SHAPE ----------------------------------------

test('THE LIVE SHEET SHAPE: junk row, abandoned header, section title, interior gap, Total footer', () => {
  // The exact 26-row shape of the "Current Updates" tab as dictated from the CSV export
  // (Alec, 2026-08-03). Client cells use the invented PHI_NAME placeholder — fixtures are
  // committed, so the sheet's real names must never appear here.
  const g: OverrideGrid = {
    rows: [
      { rowNum: 1, cells: ['leav', '', '', '', '', ''] },
      { rowNum: 2, cells: [] },
      { rowNum: 3, cells: [...ABANDONED_HEADER] },
      { rowNum: 4, cells: [] },
      { rowNum: 5, cells: [] },
      { rowNum: 6, cells: [] },
      { rowNum: 7, cells: ['Upcoming Payments', '', '', '', '', ''] },
      { rowNum: 8, cells: [...HEADER] },
      { rowNum: 9, cells: ['PCMH', 'BCBS', 'Multiple', '08/05/2026', 'EFT', '$35,000.00'] },
      { rowNum: 10, cells: ['CAMH', 'UHC', PHI_NAME, '08/06/2026', 'EFT', '$44,000.00'] },
      { rowNum: 11, cells: ['LAMH', 'Aetna', 'Multiple', '08/07/2026', 'Check', '$28,000.00'] },
      { rowNum: 12, cells: ['TMHCA', 'BCBS', 'Multiple', '08/10/2026', 'EFT', '$21,000.00'] },
      { rowNum: 13, cells: ['TMHWA', 'Regence', 'Multiple', '08/11/2026', 'EFT', '$19,000.00'] },
      { rowNum: 14, cells: ['LSMH', 'BCBS TX', 'Multiple', '08/12/2026', 'Check', '$33,000.00'] },
      { rowNum: 15, cells: ['NASH', 'BCBS TN', 'Multiple', '08/13/2026', 'EFT', '$25,000.00'] },
      { rowNum: 16, cells: ['TBH', 'Cigna', 'Multiple', '08/14/2026', 'EFT', '$18,000.00'] },
      { rowNum: 17, cells: ['PCMH', 'Anthem', PHI_NAME, '08/18/2026', 'Check', '$27,000.00'] },
      { rowNum: 18, cells: ['CAMH', 'BCBS', 'Multiple', '08/19/2026', 'EFT', '$22,000.00'] },
      { rowNum: 19, cells: ['KWC', 'Anthem KY', 'Multiple', '08/20/2026', 'EFT', '$31,000.00'] },
      { rowNum: 20, cells: ['LAMH', 'UHC', 'Multiple', '08/21/2026', 'Check', '$26,000.00'] },
      { rowNum: 21, cells: ['LSMH', 'Aetna', 'Multiple', '08/25/2026', 'EFT', '$20,000.00'] },
      { rowNum: 22, cells: [] }, // ← THE GAP. Real data resumes BELOW it.
      { rowNum: 23, cells: ['KWC', 'BCBS AR', PHI_NAME, '05/26/2026', 'Check', '$72,000.00'] },
      { rowNum: 24, cells: [] },
      { rowNum: 25, cells: [] },
      { rowNum: 26, cells: ['', '', '', '', 'Total ', '$481,000.00'] },
    ],
  };
  const out = parseOverrideSheet(g);

  // THE SINGLE MOST IMPORTANT ASSERTION: the row BELOW the interior gap survives.
  // Terminating on the first blank row would silently drop this $72,000 forecast.
  const postGapRow = out.rows.find((r) => r.sourceRowNum === 23);
  assert.ok(postGapRow, 'the post-gap row was dropped — blanks must be skipped, not terminate');
  assert.equal(postGapRow.facilityCode, 'KWC');
  assert.equal(postGapRow.payerLabel, 'BCBS AR');
  assert.equal(postGapRow.methodLabel, 'Check');
  assert.equal(postGapRow.amount, '72000.00');
  // A PAST expected date is KEPT — it is a legitimate outstanding expected payment.
  // "Upcoming" windowing belongs to the read path (a known, separate follow-up).
  assert.equal(postGapRow.expectedDate, '2026-05-26');
  assert.equal(postGapRow.isPatientSpecific, true);

  // 13 data rows (9–21) + the post-gap row 23. Nothing above the header parsed; the junk
  // row, abandoned header, and section title produced NO rows and NO reject noise; the
  // Total footer was skipped structurally.
  assert.equal(out.rows.length, 14);
  assert.deepEqual(out.rejects, []);
  assert.deepEqual(out.unmappedFacilities, []);

  // Had the abandoned row-3 header matched, Amount would have mapped onto "Last Update"
  // and every amount would have failed. The exact total proves full column mapping:
  const total = out.rows.reduce((s, r) => s + r.amountCents, 0);
  assert.equal(fixed2FromCents(total), '421000.00');

  // Alias resolution applied where the sheet spelling disagrees with the roster.
  assert.equal(out.rows.find((r) => r.sourceRowNum === 12)!.facilityCode, 'TREAT_CA');
  assert.equal(out.rows.find((r) => r.sourceRowNum === 13)!.facilityCode, 'TREAT_WA');

  // And the PHI drop holds across the whole live shape.
  assert.equal(JSON.stringify(out).includes(PHI_NAME), false, 'patient name leaked');
});
