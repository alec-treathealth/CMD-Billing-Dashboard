import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaimFilter, validateClaimFilter } from '../src/queries/filters.js';
import type { ClaimFilter } from '../src/queries/types.js';

// --- the synthetic `id` filter (Phase 8.0 single-claim reveal) --------------

test('validateClaimFilter: accepts a bounded positive integer id', () => {
  assert.deepEqual(validateClaimFilter({ id: 1 }), { id: 1 });
  assert.deepEqual(validateClaimFilter({ id: 123456 }), { id: 123456 });
});

test('validateClaimFilter: id fails closed on non-positive / non-integer / unsafe values', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateClaimFilter({ id: bad } as ClaimFilter),
      /filter\.id must be a positive safe integer/,
      `id=${String(bad)} must throw`,
    );
  }
});

test('validateClaimFilter: id fails closed on a non-number', () => {
  assert.throws(
    () => validateClaimFilter({ id: '5' as unknown as number } as ClaimFilter),
    /filter\.id must be a positive safe integer/,
  );
});

test('buildClaimFilter: id alone -> a single parameterized equality', () => {
  const { clause, params } = buildClaimFilter({ id: 42 }, 1);
  assert.equal(clause, 'id = $1');
  assert.deepEqual(params, [42]);
});

test('buildClaimFilter: id is appended after the other conditions, numbering preserved', () => {
  const { clause, params } = buildClaimFilter({ facility: 'My Time Recovery', id: 42 }, 1);
  assert.equal(clause, 'lower(facility_name) = lower($1) and id = $2');
  assert.deepEqual(params, ['My Time Recovery', 42]);
});

test('buildClaimFilter: empty filter still yields no clause (id is optional)', () => {
  const { clause, params } = buildClaimFilter({}, 1);
  assert.equal(clause, '');
  assert.deepEqual(params, []);
});
