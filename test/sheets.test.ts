import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildColumnOrder, toRawRow } from '../src/sheets.js';
import { CANONICAL_COLUMNS } from '../src/types.js';
import { HEADER_2024, HEADER_2025, ROW_TRUNCATED_2025, ROW_VANGUARD_2024 } from './fixtures.js';

test('buildColumnOrder accepts both per-year first-column headers', () => {
  assert.deepEqual(buildColumnOrder(HEADER_2024), [...CANONICAL_COLUMNS]);
  assert.deepEqual(buildColumnOrder(HEADER_2025), [...CANONICAL_COLUMNS]);
});

test('buildColumnOrder fails loud on header drift', () => {
  const drifted = [...HEADER_2025];
  drifted[8] = 'Charge Amount'; // not the expected 'Charge/Debit Amount'
  assert.throws(() => buildColumnOrder(drifted), /header mismatch/i);
});

test('buildColumnOrder fails loud when columns are missing', () => {
  assert.throws(() => buildColumnOrder(['Facility Name', 'Date of Service']), /drifted/i);
});

test('toRawRow pads API-truncated trailing cells to blank (not misaligned)', () => {
  const order = buildColumnOrder(HEADER_2025);
  const row = toRawRow(ROW_TRUNCATED_2025, order);
  assert.equal(row.facility_name, 'Hopeful Recovery');
  assert.equal(row.patient_name, 'LEE, SAM');
  assert.equal(row.member_id, '55512');
  assert.equal(row.group_number, ''); // truncated -> blank
  assert.equal(row.employer_name, '');
  assert.equal(row.payer_name, ''); // truncated -> blank (becomes a required-field failure)
});

test('toRawRow keeps embedded-comma cells intact (structured, not CSV)', () => {
  const order = buildColumnOrder(HEADER_2024);
  const row = toRawRow(ROW_VANGUARD_2024, order);
  assert.equal(row.employer_name, 'THE VANGUARD GROUP, INC.');
  assert.equal(row.payer_name, 'Anthem Blue Cross');
});
