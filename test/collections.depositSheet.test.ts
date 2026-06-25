import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDepositSheet, parseDepositTab } from '../src/collections/depositSheet.js';
import type { Tab } from '../src/collections/shapes.js';
import type { CollectionsFailure, FailSink } from '../src/collections/report.js';

function fakeSink(): FailSink & { fails: CollectionsFailure[] } {
  const fails: CollectionsFailure[] = [];
  return { fails, fail: (f) => fails.push(f) };
}

const FILE = 'DEPOSIT_SHEET_ID';

/**
 * Synthetic two-band tab mirroring the real layout: band 1 (CAMH | DLMH) at rows
 * 0–5, band 2 (TMH CA | BOGUS) at rows 6–8. Bands reuse columns 0–3 / 5–8, so this
 * also guards that band 1's scan does NOT swallow band 2's date rows.
 */
function sampleTab(): Tab {
  return {
    title: 'IP June',
    rows: [
      ['CAMH', '', '', '', '', 'DLMH', '', '', ''], // 0: labels
      ['', 'Checks', 'EFT', 'Gross', '', '', 'Checks', 'EFT', 'Gross'], // 1: sub-header
      ['06/01/2026', '$100.00', '$50.00', '$150.00', '', '06/01/2026', '$ -', '$10.00', '$10.00'], // 2
      ['06/02/2026', '', '', '', '', '06/02/2026', '$5.00', '$5.00', '$10.00'], // 3 (blanks -> 0.00)
      ['06/03/2026', '$1.00', '$2.00', '$99.00', '', '06/03/2026', 'bad$', '$1.00', '$2.00'], // 4: CAMH gross-mismatch (kept); DLMH bad money (skipped)
      ['TOTALS', '$101.00', '$52.00', '$259.00', '', 'TOTALS', '', '', ''], // 5: footer (non-date) -> skipped
      ['TMH CA', '', '', '', '', 'BOGUS', '', '', ''], // 6: band-2 labels
      ['', 'Checks', 'EFT', 'Gross', '', '', 'Checks', 'EFT', 'Gross'], // 7: band-2 sub-header
      ['06/01/2026', '$20.00', '$0.00', '$20.00', '', '06/01/2026', '$1.00', '$1.00', '$2.00'], // 8
    ],
  };
}

test('depositSheet: resolves acronyms (DLMH->DMH, TMH CA->TREAT_CA), tags lineage, no PHI', () => {
  const sink = fakeSink();
  const r = parseDepositTab(sampleTab(), FILE, sink);

  // Emitted: CAMH x3 (06/01,06/02,06/03-mismatch-kept), DMH x2 (06/01,06/02), TREAT_CA x1.
  // DLMH 06/03 (bad money) is skipped; BOGUS is unresolved; TOTALS is a footer.
  assert.equal(r.daily.length, 6);
  assert.deepEqual([...r.facilities].sort(), ['CAMH', 'DMH', 'TREAT_CA']);
  assert.ok(r.daily.every((d) => d.row.source_group_code === null), 'source_group_code must be NULL (§7)');
  assert.ok(r.daily.every((d) => d.row.source_tag === 'deposit_sheet'));
  assert.ok(!r.daily.some((d) => d.row.facility_code === 'DLMH'), 'DLMH must map to DMH, never persist as DLMH');

  // Money normalization: "$ -" and blank -> "0.00"; real values parsed.
  const find = (code: string, date: string) => r.daily.find((d) => d.row.facility_code === code && d.row.payment_date === date)?.row;
  assert.deepEqual(
    (({ checks_amount, eft_amount, gross_amount }) => ({ checks_amount, eft_amount, gross_amount }))(find('CAMH', '2026-06-01')!),
    { checks_amount: '100.00', eft_amount: '50.00', gross_amount: '150.00' },
  );
  assert.equal(find('DMH', '2026-06-01')!.checks_amount, '0.00'); // "$ -" -> 0.00
  assert.equal(find('CAMH', '2026-06-02')!.gross_amount, '0.00'); // blank -> 0.00

  // gross != checks+eft is KEPT (gross authoritative) but reported as a note.
  assert.equal(find('CAMH', '2026-06-03')!.gross_amount, '99.00');
  assert.equal(r.grossMismatches, 1);

  // Unresolved label counted, never auto-created.
  assert.equal(r.unresolved.get('BOGUS'), 1);
  assert.equal(r.facilities.has('BOGUS'), false);

  // Coercion failures: 1 bad-money (DLMH 06/03 checks) + 1 gross-mismatch note.
  assert.equal(sink.fails.length, 2);
  assert.ok(sink.fails.some((f) => f.column === 'checks_amount' && /unparseable/.test(f.reason)));
  assert.ok(sink.fails.some((f) => f.column === 'gross_amount' && /gross != checks/.test(f.reason)));

  // One raw per source row that landed >=1 daily row (rows 2,3,4,8 -> 4).
  assert.equal(r.raws.length, 4);
  assert.ok(r.raws.every((x) => x.source_group_code === null && x.facility_code === null && x.shape === 'daily'));

  // No PHI keys anywhere in the output.
  const json = JSON.stringify(r.daily).toLowerCase();
  for (const bad of ['patient', 'member', 'group_number', 'client_name']) {
    assert.ok(!json.includes(bad), `must not include ${bad}`);
  }
});

test('depositSheet: source_tab + 1-based source_row_num are carried', () => {
  const r = parseDepositTab(sampleTab(), FILE, fakeSink());
  const d = r.daily.find((x) => x.row.facility_code === 'CAMH' && x.row.payment_date === '2026-06-01')!;
  assert.equal(d.source_tab, 'IP June');
  assert.equal(d.source_row_num, 3); // row index 2 -> sheet row 3
});

test('depositSheet: a tab with no Checks/Gross sub-header (e.g. notes) yields nothing', () => {
  const notes: Tab = { title: 'Current Updates', rows: [['Facility', 'Insurance', 'Client'], ['', '', '']] };
  const r = parseDepositTab(notes, FILE, fakeSink());
  assert.equal(r.daily.length, 0);
  assert.equal(r.raws.length, 0);
});

test('depositSheet: parseDepositSheet merges tabs and skips empty ones', () => {
  const notes: Tab = { title: 'Current Updates', rows: [['Facility']] };
  const r = parseDepositSheet([notes, sampleTab()], FILE, fakeSink());
  assert.equal(r.daily.length, 6);
  assert.deepEqual([...r.months], ['2026-06']);
});
