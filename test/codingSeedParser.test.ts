/**
 * Seed parser (Phase A) — pins every ingest defect the plan names (§4): corrupt dates, STILL
 * PENDING, date+prose cells, the NO-HCPCS sentinel, REV ONLY suppression, DOS-batch/TOB/DRG/
 * condition-code/modifier/units extraction, facility aliasing, and unmapped payer labels.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  parseSheetDate,
  parseCodesCell,
  parseBillingRules,
  parseCodingSeedTsv,
} from '../src/collections/codingSeedParser';

const HEADER = 'facility_code\tpayer_label\tdecided_on\tcodes_utilizing\tbilling_rules\tlifecycle\tnotes';
const tsv = (...rows: string[]) => [HEADER, ...rows].join('\n');

test('parseSheetDate: both zero-padded forms parse; the 0714/2026 class and impossibles do not', () => {
  assert.equal(parseSheetDate('5/21/2026'), '2026-05-21');
  assert.equal(parseSheetDate('05/21/2026'), '2026-05-21');
  assert.equal(parseSheetDate('0714/2026'), null);
  assert.equal(parseSheetDate('2/30/2026'), null);
  assert.equal(parseSheetDate('13/01/2026'), null);
});

test('parseCodesCell: the three real shapes + the header-noise literal', () => {
  assert.deepEqual(parseCodesCell('H0017/0158'), { hcpcs: 'H0017', rev: '0158', suppressed: false });
  assert.deepEqual(parseCodesCell('NO HCPCS / 1001'), { hcpcs: null, rev: '1001', suppressed: true });
  assert.deepEqual(parseCodesCell('0124'), { hcpcs: null, rev: '0124', suppressed: false });
  assert.equal(parseCodesCell('HCPCS/REV'), null);
  assert.deepEqual(parseCodesCell('158'), { hcpcs: null, rev: '0158', suppressed: false }); // pad to 4
});

test('parseBillingRules: the seven conflated axes come apart', () => {
  const r = parseBillingRules('2-3 DOS per claim; 863; add DRG 951; Add Condition code 92; removing GT mod; 12 units; denied for interim');
  assert.equal(r.dos_batch_min, 2);
  assert.equal(r.dos_batch_max, 3);
  assert.equal(r.type_of_bill, '863');
  assert.equal(r.drg_code, '951');
  assert.deepEqual(r.condition_codes, ['92']);
  assert.deepEqual(r.modifiers_removed, ['GT']);
  assert.equal(r.units_per_dos, 12);
  assert.equal(r.billing_span, 'admit_dc'); // denied for interim ⇒ bill admit-through-DC

  const r2 = parseBillingRules('Single DOS, 86X TOB, REV ONLY 0124');
  assert.equal(r2.dos_batch_min, 1);
  assert.equal(r2.dos_batch_max, 1);
  assert.equal(r2.type_of_bill, '86X');
  assert.equal(r2.rev_only, '0124');

  const r3 = parseBillingRules('Bulk 5 DOS; TOB 133; 3 units per code (PER HOUR)');
  assert.equal(r3.dos_batch_min, 5);
  assert.equal(r3.dos_batch_max, 5);
  assert.equal(r3.type_of_bill, '133');
  assert.equal(r3.units_per_dos, 3);

  const r4 = parseBillingRules('7 DOS Bulked · interim · some free prose the parser must keep');
  assert.equal(r4.dos_batch_min, 7);
  assert.equal(r4.billing_span, 'interim');
  assert.deepEqual(r4.residue, ['some free prose the parser must keep']);
});

test('full row: happy path lands with family normalization, aliasing, ISO dates', () => {
  const out = parseCodingSeedTsv(
    tsv('KY Wellness\tAnthem BCBS (ALL OTHERS)\t05/21/2026\tH0017/0158\tSingle DOS\tCONFIRMED CODES\t'),
    { 'KY Wellness': 'KWC' },
  );
  assert.equal(out.defects.length, 0);
  assert.equal(out.decisions.length, 1);
  const d = out.decisions[0]!;
  assert.equal(d.payer_family, 'BCBS');
  assert.equal(d.payer_variant_label, 'Anthem BCBS (ALL OTHERS)');
  assert.equal(d.facility_code, 'KWC');
  assert.equal(d.decided_on, '2026-05-21');
  assert.equal(d.effective_from, '2026-05-21');
  assert.equal(d.dos_batch_min, 1);
  assert.equal(d.lifecycle, 'CONFIRMED CODES');
});

test('date + trailing prose: date extracted, prose preserved through the rules residue into notes', () => {
  const out = parseCodingSeedTsv(
    tsv('NMH\tCIGNA\t04/07/2026 Single DOS per CB as of 6/10\tNO HCPCS / 1001\t\tOPEN TEST\t'),
  );
  assert.equal(out.decisions.length, 1);
  const d = out.decisions[0]!;
  assert.equal(d.decided_on, '2026-04-07');
  assert.equal(d.dos_batch_min, 1); // 'Single DOS' claimed from the residue
  assert.equal(d.hcpcs_suppressed, true);
  assert.equal(d.hcpcs_code, null);
  assert.match(d.notes ?? '', /as of 6\/10/);
});

test('defect rows are named, counted, and skipped — never guessed', () => {
  const out = parseCodingSeedTsv(
    tsv(
      'NMH\tCIGNA\t0714/2026\tH0017/0158\t\tCONFIRMED CODES\t', // corrupt date
      'NMH\tCIGNA\tSTILL PENDING\tH0017/0158\t\tOPEN TEST\t', // pending in a date column
      'NMH\tTOTALLY UNKNOWN PAYER\t05/01/2026\tH0017/0158\t\tOPEN TEST\t', // unmapped family
      'NMH\tCIGNA\t05/01/2026\tHCPCS/REV\t\tOPEN TEST\t', // header noise
      'NMH\tCIGNA\t05/01/2026\tH0017/0158\t\tMight be discontinued\t', // not an enum value
    ),
  );
  assert.equal(out.decisions.length, 0);
  assert.equal(out.skipped, 5);
  assert.equal(out.defects.length, 5);
  const reasons = out.defects.map((d) => d.reason).join(' | ');
  assert.match(reasons, /0714\/2026 class/);
  assert.match(reasons, /STILL PENDING/);
  assert.match(reasons, /payer-family rule/);
  assert.match(reasons, /unparseable codes/);
  assert.match(reasons, /Test Status enum/);
});

test('unrecognized facility long-form: defect recorded, row kept payer-wide (facility null)', () => {
  const out = parseCodingSeedTsv(tsv('Trat TX\tCIGNA\t05/01/2026\tH0017/0158\t\tOPEN TEST\t'));
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0]!.facility_code, null);
  assert.equal(out.defects.length, 1);
  assert.match(out.defects[0]!.reason, /alias map/);
});

test('REV ONLY in the rules column rescues a blank codes cell as suppression', () => {
  const out = parseCodingSeedTsv(tsv('NMH\tGEHA\t05/01/2026\t\tREV ONLY 0124\tCONTINUE TESTS\t'));
  assert.equal(out.decisions.length, 1);
  const d = out.decisions[0]!;
  assert.equal(d.revenue_code, '0124');
  assert.equal(d.hcpcs_suppressed, true);
  assert.equal(d.payer_family, 'GEHA');
});

test('blank lines and unknown extra columns are tolerated', () => {
  const out = parseCodingSeedTsv(
    ['facility_code\tpayer_label\tdecided_on\tcodes_utilizing\tbilling_rules\tlifecycle\tnotes\tzzz_extra', 'NMH\tAETNA\t05/01/2026\tH0017/0158\t\tFINALIZED CODES\t\tignored', '', ''].join('\n'),
  );
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0]!.payer_family, 'AETNA');
});
