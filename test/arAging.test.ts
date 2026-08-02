/**
 * Hermetic tests for the AR-aging read builders. No DB, no network, no PHI.
 *
 * `src/collections/arAging.ts` shipped in f538648 with ZERO test coverage. These were added
 * alongside the single-tenant fast path, so the highest-value assertions are the ones locking
 * the predicate/binding pair that makes 0071's index usable at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArAgingDistributionQuery,
  buildArAgingWorklistQuery,
} from '../src/collections/arAging.js';

const BXR = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';
const INDIGO = '141d459c-f371-4229-9a92-ace198e940bb';
const AS_OF = '2026-08-02';

test('worklist: ONE entity emits scalar equality — the only form 0071 index can order on', () => {
  const q = buildArAgingWorklistQuery({ entityIds: [BXR], asOf: AS_OF, limit: 100 });
  assert.match(q.text, /business_entity_id = \$1::uuid\b/);
  assert.ok(!q.text.includes('any($1::uuid[])'), 'must NOT use the ScalarArrayOpExpr form');
  // The binding has to move with the predicate: `= $1::uuid` against a bound ARRAY fails the cast.
  assert.equal(q.values[0], BXR, '$1 must be the scalar uuid, not a one-element array');
  assert.ok(!Array.isArray(q.values[0]), '$1 must not be an array in the single-tenant branch');
});

test('worklist: MULTIPLE entities keep the array form and the array binding', () => {
  const q = buildArAgingWorklistQuery({ entityIds: [BXR, INDIGO], asOf: AS_OF, limit: 100 });
  assert.match(q.text, /business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(q.values[0], [BXR, INDIGO], '$1 stays the array for cross-tenant reads');
});

test('worklist: ordering and keyset shape are unchanged by the fast path', () => {
  for (const entityIds of [[BXR], [BXR, INDIGO]]) {
    const q = buildArAgingWorklistQuery({ entityIds, asOf: AS_OF, limit: 100 });
    assert.match(
      q.text,
      /order by charge_date asc nulls last, charge_id asc/,
      'oldest-first with unknown-age last, both branches',
    );
    assert.ok(!/\boffset\b/i.test(q.text), 'keyset only — never OFFSET (§3.8)');
  }
});

test('worklist: keyset cursor pages dated rows before the null-date tail', () => {
  const dated = buildArAgingWorklistQuery({
    entityIds: [BXR],
    asOf: AS_OF,
    limit: 50,
    after: { chargeDate: '2026-03-19', chargeId: '900123456' },
  });
  // A dated cursor must still admit the null-date tail, else those rows are unreachable.
  assert.match(dated.text, /charge_date is null/);
  assert.match(dated.text, /charge_date > \$\d+/);
  assert.match(dated.text, /charge_date = \$\d+ and charge_id > \$\d+/);

  const nullTail = buildArAgingWorklistQuery({
    entityIds: [BXR],
    asOf: AS_OF,
    limit: 50,
    after: { chargeDate: null, chargeId: '900123456' },
  });
  assert.match(nullTail.text, /\(charge_date is null and charge_id > \$\d+\)/);
});

test('worklist: facility narrow is parameterised, never interpolated', () => {
  const q = buildArAgingWorklistQuery({
    entityIds: [BXR],
    asOf: AS_OF,
    limit: 100,
    facility: "TEEN MENTAL HEALTH TEXAS LLC'; drop table x --",
  });
  assert.match(q.text, /facility = \$\d+/);
  assert.ok(!q.text.includes('drop table'), 'facility value must not reach the SQL text');
  assert.ok(q.values.includes("TEEN MENTAL HEALTH TEXAS LLC'; drop table x --"));
});

test('worklist: selects raw ciphertext columns, never plaintext PHI expressions', () => {
  const q = buildArAgingWorklistQuery({ entityIds: [BXR], asOf: AS_OF, limit: 100 });
  // The three PHI columns are selected as stored bytea; decryption happens at the composition root.
  for (const col of ['patient_name', 'member_id', 'group_number']) {
    assert.ok(q.text.includes(col), `${col} projected for the composition root to decrypt`);
  }
  assert.ok(!q.text.includes('select *'), 'no SELECT * — explicit allowlist only');
  assert.ok(!/decrypt|pgp_sym|convert_from/i.test(q.text), 'no in-query decryption');
});

test('distribution: entity-scoped and parameterised; no PHI projected', () => {
  const q = buildArAgingDistributionQuery([BXR], AS_OF);
  assert.match(q.text, /business_entity_id = any\(\$1::uuid\[\]\)/);
  assert.deepEqual(q.values, [[BXR], AS_OF]);
  for (const phi of ['patient_name', 'member_id', 'group_number']) {
    assert.ok(!q.text.includes(phi), `aggregate must not project ${phi}`);
  }
});
