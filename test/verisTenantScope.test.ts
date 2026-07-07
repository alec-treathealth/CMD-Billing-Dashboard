/**
 * Hermetic tests for src/veris/tenantScope.ts — the Veris tenant-scope resolver.
 * No DB, no network. These lock in the SECURITY invariants of the authenticated
 * path: a tenant-scoped role's scope comes ONLY from its session entity, a client
 * view can never re-scope it, and entity → business_entity_id uses the canonical
 * constants. The live end-to-end (resolved entityId → GUC → RLS) is exercised by
 * src/veris/isolationProbe.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveVerisScope } from '../src/veris/tenantScope.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

test('admin is scoped to its own entity (bxr)', () => {
  const r = resolveVerisScope('admin', 'bxr');
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.scope.mode === 'tenant');
  assert.equal(r.ok && r.scope.mode === 'tenant' && r.scope.entityId, BXR_ENTITY_ID);
  assert.equal(r.ok && r.anomaly, null);
});

test('user is scoped to its own entity (indigo)', () => {
  const r = resolveVerisScope('user', 'indigo');
  assert.ok(r.ok && r.scope.mode === 'tenant' && r.scope.entityId === INDIGO_ENTITY_ID);
  assert.equal(r.ok && r.anomaly, null);
});

test('SECURITY: a forged client view can NOT re-scope a tenant-scoped role', () => {
  // admin@bxr requests the indigo view → still scoped to BXR, with an anomaly flagged.
  const r = resolveVerisScope('admin', 'bxr', 'indigo');
  assert.ok(r.ok && r.scope.mode === 'tenant' && r.scope.entityId === BXR_ENTITY_ID);
  assert.ok(r.ok && typeof r.anomaly === 'string' && r.anomaly.includes('indigo'));
});

test('SECURITY: a user requesting consolidated is ignored + flagged, stays tenant-scoped', () => {
  const r = resolveVerisScope('user', 'indigo', 'consolidated');
  assert.ok(r.ok && r.scope.mode === 'tenant' && r.scope.entityId === INDIGO_ENTITY_ID);
  assert.ok(r.ok && typeof r.anomaly === 'string');
});

test('super_admin default (no view) → consolidated', () => {
  const r = resolveVerisScope('super_admin', null);
  assert.ok(r.ok && r.scope.mode === 'consolidated');
  assert.equal(r.ok && r.anomaly, null);
});

test('super_admin may switch into either single tenant (within full entitlement)', () => {
  const bxr = resolveVerisScope('super_admin', null, 'bxr');
  assert.ok(bxr.ok && bxr.scope.mode === 'tenant' && bxr.scope.entityId === BXR_ENTITY_ID);
  const ind = resolveVerisScope('super_admin', null, 'indigo');
  assert.ok(ind.ok && ind.scope.mode === 'tenant' && ind.scope.entityId === INDIGO_ENTITY_ID);
  const con = resolveVerisScope('super_admin', null, 'consolidated');
  assert.ok(con.ok && con.scope.mode === 'consolidated');
});

test('defensive: a tenant-scoped role with no entity fails closed', () => {
  const r = resolveVerisScope('admin', null);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'no_tenant');
});

test('defensive: super_admin with an unrecognized view falls back to consolidated (no undefined entityId)', () => {
  // An out-of-type/garbage requestedView (e.g. from an unvalidated boundary) must NEVER index
  // ENTITY_ID with an unknown key — it resolves to the consolidated surface, not a tenant scope
  // whose entityId is undefined.
  const r = resolveVerisScope('super_admin', null, 'garbage' as unknown as 'bxr');
  assert.ok(r.ok && r.scope.mode === 'consolidated');
});

test('resolved entity ids are exactly the two canonical UUIDs (no drift)', () => {
  const bxr = resolveVerisScope('admin', 'bxr');
  const ind = resolveVerisScope('admin', 'indigo');
  assert.equal(bxr.ok && bxr.scope.mode === 'tenant' && bxr.scope.entityId, 'af504ab6-3dcd-4aa4-a93c-27bc58de4088');
  assert.equal(ind.ok && ind.scope.mode === 'tenant' && ind.scope.entityId, '141d459c-f371-4229-9a92-ace198e940bb');
});
