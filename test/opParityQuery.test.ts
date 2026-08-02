/**
 * Hermetic tests for the OP-scope parity soak criterion. No DB, no network, no PHI —
 * SQL-shape assertions plus pure grading logic over the 2026-08-02 measured figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessOpParity,
  buildOpParityQuery,
  type OpParityRow,
} from '../src/billingAudit/opParityQuery.js';

const BXR = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

function collector() {
  const values: unknown[] = [];
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  return { values, add };
}

test('buildOpParityQuery: parameterises every value, inlines no literal', () => {
  const { values, add } = collector();
  const sql = buildOpParityQuery('2026-08-02', [BXR], add);
  assert.deepEqual(values, ['2026-08-02', [BXR]]);
  // The date and entity list must be bound, never interpolated.
  assert.ok(!sql.includes('2026-08-02'), 'date must not appear as a literal');
  assert.ok(!sql.includes(BXR), 'entity uuid must not appear as a literal');
  assert.match(sql, /\$1::date/);
  assert.match(sql, /any\(\$2::uuid\[\]\)/);
});

test('buildOpParityQuery: splits the two feeds on scope_source, both scoped to OP', () => {
  const { add } = collector();
  const sql = buildOpParityQuery('2026-08-02', [BXR], add);
  assert.match(sql, /scope_source is null/, 'legacy leg keys on NULL provenance');
  assert.match(sql, /scope_source is not null/, 'consolidated leg keys on non-NULL provenance');
  assert.equal((sql.match(/audit_scope = 'OP'/g) ?? []).length, 2, 'both legs pinned to OP');
  assert.match(sql, /full outer join/, 'a consolidated-only class must not be dropped');
});

test('buildOpParityQuery: projects only status_category + counts — never PHI', () => {
  const { add } = collector();
  const sql = buildOpParityQuery('2026-08-02', [BXR], add);
  for (const phi of ['patient_name', 'member_id', 'patient_dob', 'cmd_patient_id', 'charge_amount']) {
    assert.ok(!sql.includes(phi), `must not project ${phi}`);
  }
  assert.ok(!sql.includes('select *'), 'no SELECT *');
});

// The measured 2026-08-02 night: legacy OP 15,181 rows vs consolidated OP 6,857.
const MEASURED_2026_08_02: OpParityRow[] = [
  { status_category: 'BALANCE_DUE_PATIENT', legacy_rows: '5996', consolidated_rows: '2143' },
  { status_category: 'PAID', legacy_rows: '4471', consolidated_rows: '0' },
  { status_category: 'AT_PAYER', legacy_rows: '3870', consolidated_rows: '3870' },
  { status_category: 'OTHER', legacy_rows: '376', consolidated_rows: '376' },
  { status_category: 'NEEDS_RENEGOTIATING', legacy_rows: '358', consolidated_rows: '358' },
  { status_category: 'ON_HOLD', legacy_rows: '95', consolidated_rows: '95' },
  { status_category: 'APPROVED_HIGHER', legacy_rows: '15', consolidated_rows: '15' },
];

test('assessOpParity: the real 2026-08-02 night FAILS parity — this is the whole point', () => {
  const a = assessOpParity(MEASURED_2026_08_02);
  assert.equal(a.totalLegacy, 15181, 'legacy total matches the measured cron log');
  assert.equal(a.totalConsolidated, 6857, 'consolidated total matches the measured cron log');
  assert.equal(a.totalLegacy - a.totalConsolidated, 8324, 'the gap decomposes to the row');
  assert.equal(a.parityHolds, false, 'a night with an 8,324-row gap must NOT grade clean');
  assert.deepEqual(a.droppedClasses, ['PAID'], 'PAID is dropped outright by filter B');

  const bdp = a.verdicts.find((v) => v.statusCategory === 'BALANCE_DUE_PATIENT');
  assert.ok(bdp);
  assert.equal(bdp.delta, 3853, 'aged patient-balance rows outside filter C ~90d window');
  assert.equal(bdp.shortfall, true);
});

test('assessOpParity: classes the consolidated feed covers fully show no shortfall', () => {
  const a = assessOpParity(MEASURED_2026_08_02);
  for (const cls of ['AT_PAYER', 'OTHER', 'NEEDS_RENEGOTIATING', 'ON_HOLD', 'APPROVED_HIGHER']) {
    const v = a.verdicts.find((x) => x.statusCategory === cls);
    assert.ok(v, `${cls} present`);
    assert.equal(v.shortfall, false, `${cls} is fully covered by filter B`);
    assert.equal(v.delta, 0);
  }
});

test('assessOpParity: a fully-covered night grades clean', () => {
  const a = assessOpParity([
    { status_category: 'AT_PAYER', legacy_rows: '3870', consolidated_rows: '3870' },
    { status_category: 'ON_HOLD', legacy_rows: '95', consolidated_rows: '95' },
  ]);
  assert.equal(a.parityHolds, true);
  assert.deepEqual(a.droppedClasses, []);
});

test('assessOpParity: tolerance absorbs intraday drift but never a dropped class', () => {
  // 1% short on a 1,000-row class is within the 2% default — benign cron-timing drift.
  const drift = assessOpParity([{ status_category: 'AT_PAYER', legacy_rows: '1000', consolidated_rows: '990' }]);
  assert.equal(drift.parityHolds, true, '1% drift tolerated');

  // A class going to zero is structural, never tolerated — even at 1 row.
  const dropped = assessOpParity([{ status_category: 'PAID', legacy_rows: '1', consolidated_rows: '0' }]);
  assert.equal(dropped.parityHolds, false, 'a vanished class is never within tolerance');
  assert.deepEqual(dropped.droppedClasses, ['PAID']);
});

test('assessOpParity: a consolidated-only class is surfaced, not treated as a shortfall', () => {
  const a = assessOpParity([{ status_category: 'NEW_STATUS', legacy_rows: '0', consolidated_rows: '42' }]);
  assert.equal(a.parityHolds, true, 'the new feed finding MORE is not a coverage loss');
  assert.equal(a.verdicts[0]!.delta, -42, 'negative delta records the surplus');
  assert.deepEqual(a.droppedClasses, []);
});
