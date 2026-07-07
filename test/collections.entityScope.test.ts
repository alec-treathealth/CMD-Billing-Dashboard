import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertEntityScope } from '../src/collections/entityScope.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

test('assertEntityScope: valid non-empty UUID scope returns a copy', () => {
  const scope = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
  const out = assertEntityScope(scope, 'test');
  assert.deepEqual(out, scope);
  assert.notEqual(out, scope, 'returns a defensive copy, not the same reference');
});

test('assertEntityScope: fail-closed on empty / undefined (never read all tenants)', () => {
  assert.throws(() => assertEntityScope([], 'test'), /entityIds required/);
  assert.throws(() => assertEntityScope(undefined, 'test'), /entityIds required/);
});

test('assertEntityScope: rejects non-canonical UUIDs', () => {
  assert.throws(() => assertEntityScope(['not-a-uuid'], 'test'), /canonical business_entity_id/);
  assert.throws(() => assertEntityScope([BXR_ENTITY_ID, 'nope'], 'test'), /canonical business_entity_id/);
  // A SQL-injection-shaped value is rejected by the format gate (it is also always bound as a
  // parameter downstream, never interpolated — this is defense in depth).
  assert.throws(() => assertEntityScope(["' OR '1'='1"], 'test'), /canonical business_entity_id/);
});
