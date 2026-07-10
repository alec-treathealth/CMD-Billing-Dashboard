import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterBhRecords, isBhRelevant } from '../src/jobs/cmsHcpcsSync/filter.js';
import type { HcpcsRecord } from '../src/jobs/cmsHcpcsSync/types.js';

test('isBhRelevant: keeps BH prefixes + explicit codes, drops the rest', () => {
  // BH-relevant
  assert.equal(isBhRelevant('H0018'), true);
  assert.equal(isBhRelevant('H2036'), true);
  assert.equal(isBhRelevant('S9480'), true); // intensive outpatient psychiatric
  assert.equal(isBhRelevant('T2038'), true);
  assert.equal(isBhRelevant('G0410'), true); // explicit group psychotherapy
  assert.equal(isBhRelevant('90791'), true); // explicit CPT dx eval
  // Not BH
  assert.equal(isBhRelevant('A0021'), false); // ambulance
  assert.equal(isBhRelevant('J1200'), false); // drug
  assert.equal(isBhRelevant('99213'), false); // E/M CPT not in explicit set
  assert.equal(isBhRelevant('G0463'), false); // hospital clinic visit, not in explicit set
});

test('filterBhRecords: retains only BH-relevant records', () => {
  const recs: HcpcsRecord[] = [
    { code: 'H0018', shortDesc: 'resid', longDesc: null, effectiveDate: null },
    { code: 'A0021', shortDesc: 'ambulance', longDesc: null, effectiveDate: null },
    { code: 'G0410', shortDesc: 'group psych', longDesc: null, effectiveDate: null },
  ];
  const kept = filterBhRecords(recs).map((r) => r.code);
  assert.deepEqual(kept, ['H0018', 'G0410']);
});
