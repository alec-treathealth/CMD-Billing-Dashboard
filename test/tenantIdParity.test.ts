/**
 * Cross-side tenant-id parity. The two real tenants' business_entity_id UUIDs are declared
 * TWICE — once on the root-library side (src/tenants.ts) and once on the Next app side
 * (app/lib/views.ts) — because deps point app → src and the src library cannot import from
 * app/. The two declarations MUST agree; a silent divergence would tag writes under one id and
 * scope reads under another (cross-tenant leak / data loss). This locks them together so any
 * edit to one without the other fails the suite. Also asserts the two tenants are DISTINCT
 * (a copy-paste making them equal would collapse the tenancy boundary and let viewToEntityIds
 * de-dup 'consolidated' down to a single tenant).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BXR_ENTITY_ID as SRC_BXR, INDIGO_ENTITY_ID as SRC_INDIGO } from '../src/tenants.js';
import { BXR_ENTITY_ID as APP_BXR, INDIGO_ENTITY_ID as APP_INDIGO } from '../app/lib/views.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('BXR_ENTITY_ID agrees across the src and app declarations', () => {
  assert.equal(APP_BXR, SRC_BXR);
});

test('INDIGO_ENTITY_ID agrees across the src and app declarations', () => {
  assert.equal(APP_INDIGO, SRC_INDIGO);
});

test('both tenant ids are canonical UUIDs and distinct from each other', () => {
  assert.match(SRC_BXR, UUID_RE);
  assert.match(SRC_INDIGO, UUID_RE);
  assert.notEqual(SRC_BXR, SRC_INDIGO);
});
