import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHcpcsFixedWidth, normalizeCmsDate } from '../src/jobs/cmsHcpcsSync/parse.js';
import { buildFixedWidthFile, buildFixedWidthLine } from './fixtures/cmsHcpcs.js';

test('parse: extracts code + descriptions from fixed-width lines, skips the header', () => {
  const text = buildFixedWidthFile([
    { code: 'H0018', longDesc: 'BEHAVIORAL HEALTH; SHORT-TERM RESIDENTIAL', shortDesc: 'BH short-term resid', effective: '20260101' },
    { code: 'H0010', longDesc: 'ALCOHOL AND/OR DRUG SERVICES; SUB-ACUTE DETOX', shortDesc: 'Sub-acute detox (resid)' },
  ]);
  const recs = parseHcpcsFixedWidth(text);
  assert.equal(recs.length, 2);

  const h0018 = recs.find((r) => r.code === 'H0018');
  assert.ok(h0018);
  assert.equal(h0018.shortDesc, 'BH short-term resid');
  assert.equal(h0018.longDesc, 'BEHAVIORAL HEALTH; SHORT-TERM RESIDENTIAL');
  assert.equal(h0018.effectiveDate, '2026-01-01');
});

test('parse: skips lines with no valid code in the code column', () => {
  const good = buildFixedWidthLine({ code: 'H2036', longDesc: 'TREATMENT PROGRAM PER DIEM', shortDesc: 'Tx program per diem' });
  const junk = '   ***** not a data row *****';
  const recs = parseHcpcsFixedWidth([junk, good].join('\n'));
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.code, 'H2036');
});

test('parse: dedupes repeated codes, filling blanks from continuation lines', () => {
  const line1 = buildFixedWidthLine({ code: 'H2035', longDesc: 'ALCOHOL/DRUG TREATMENT PROGRAM, PER HOUR', shortDesc: 'A/D tx program per hr' });
  const line2 = buildFixedWidthLine({ code: 'H2035', longDesc: '', shortDesc: '', effective: '20260401' });
  const recs = parseHcpcsFixedWidth([line1, line2].join('\n'));
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.shortDesc, 'A/D tx program per hr');
  assert.equal(recs[0]?.effectiveDate, '2026-04-01');
});

test('normalizeCmsDate: valid YYYYMMDD → ISO; junk → null', () => {
  assert.equal(normalizeCmsDate('20260701'), '2026-07-01');
  assert.equal(normalizeCmsDate('2026'), null);
  assert.equal(normalizeCmsDate('20261301'), null); // month 13
  assert.equal(normalizeCmsDate('        '), null);
});
