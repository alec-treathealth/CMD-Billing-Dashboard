import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  facilityDimension,
  facilityDimensionSql,
} from '../src/collections/facilities.js';
import {
  DEPOSIT_FACILITIES,
  DEPOSIT_LABEL_TO_FACILITY,
  FACILITY_CODES,
} from '../src/collections/config.js';
import type { ExecResult, QueryExecutor } from '../src/queries/types.js';

const EXPECTED_SQL =
  `select facility_code, facility_name, care_setting, display_acronym ` +
  `from collections.facilities ` +
  `order by care_setting nulls last, display_acronym nulls last, facility_code`;

function fakeExecutor(rows: Record<string, unknown>[], cap: { sql?: string } = {}): QueryExecutor {
  return {
    async query<T>(sql: string): Promise<ExecResult<T>> {
      cap.sql = sql;
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

test('facilityDimensionSql: exact + reads only collections.facilities, no PHI', () => {
  const sql = facilityDimensionSql();
  assert.equal(sql, EXPECTED_SQL);
  for (const bad of ['collections_raw', 'payment_lines', 'daily_collections', 'patient', 'member_id']) {
    assert.ok(!sql.includes(bad), `must not reference ${bad}`);
  }
});

test('facilityDimension: care_setting coerced to IP/OP/null; one non-PHI audit line', async () => {
  const rows = [
    { facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH', care_setting: 'IP', display_acronym: 'CAMH' },
    { facility_code: 'TREAT_CA', facility_name: 'TREAT MENTAL HEALTH CALIFORNIA', care_setting: 'OP', display_acronym: 'TMH CA' },
    { facility_code: 'WRC', facility_name: 'WELLNESS RECOVERY CENTER', care_setting: null, display_acronym: null },
    { facility_code: 'BAD', facility_name: 'BAD', care_setting: 'XX', display_acronym: 'B' },
  ];
  const audit: string[] = [];
  const out = await facilityDimension({
    executor: fakeExecutor(rows),
    createdBy: 'test',
    now: () => new Date('2026-06-25T00:00:00Z'),
    audit: (l) => audit.push(l),
  });
  const by = (c: string) => out.find((r) => r.facility_code === c)!;
  assert.equal(by('CAMH').care_setting, 'IP');
  assert.equal(by('TREAT_CA').display_acronym, 'TMH CA');
  assert.equal(by('WRC').care_setting, null); // unclassified -> null ("Other")
  assert.equal(by('BAD').care_setting, null); // invalid 'XX' coerced to null
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0]!).event, 'facility_dimension');
});

test('DEPOSIT_FACILITIES is the single source: 15 (8 IP + 7 OP), real codes, acronyms locked', () => {
  assert.equal(DEPOSIT_FACILITIES.length, 15);
  assert.equal(DEPOSIT_FACILITIES.filter((f) => f.careSetting === 'IP').length, 8);
  assert.equal(DEPOSIT_FACILITIES.filter((f) => f.careSetting === 'OP').length, 7);
  for (const f of DEPOSIT_FACILITIES) {
    assert.ok(FACILITY_CODES.has(f.facilityCode), `${f.facilityCode} must be a real seeded facility`);
  }
  // The two non-identity relabels the migration seed must mirror.
  assert.equal(DEPOSIT_LABEL_TO_FACILITY['DLMH'], 'DMH');
  assert.equal(DEPOSIT_LABEL_TO_FACILITY['TMH CA'], 'TREAT_CA');
  // Canonical IP/OP acronym sets (the spec's two lists).
  const ip = DEPOSIT_FACILITIES.filter((f) => f.careSetting === 'IP').map((f) => f.label).sort();
  const op = DEPOSIT_FACILITIES.filter((f) => f.careSetting === 'OP').map((f) => f.label).sort();
  assert.deepEqual(ip, ['CAMH', 'DLMH', 'KWC', 'LAMH', 'LSMH', 'NASH', 'PCMH', 'TBH']);
  assert.deepEqual(op, ['FRCA', 'TMH CA', 'TMH NV', 'TMH TN', 'TMH TX', 'TMH WA', 'Telehealth MH']);
});
