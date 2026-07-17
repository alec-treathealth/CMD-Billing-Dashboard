import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  requireQualifyPrincipalFromAccess,
  type QualifyAccessInput,
} from '../app/lib/qualify/principal.js';
import { isQualifyOnlyRole, QUALIFY_HOME } from '../app/lib/rbac.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../app/lib/views.js';

const authed = (role: string): QualifyAccessInput => ({
  ok: true,
  access: { user: { email: 'staff@treathealth.ai', id: 'u-1' }, role },
});

test('Q-A gate: super_admin is admitted with the pinned cross-tenant scope + amounts capability', () => {
  const p = requireQualifyPrincipalFromAccess(authed('super_admin'));
  assert.ok(p.ok);
  assert.deepEqual(p.entityIds, [BXR_ENTITY_ID, INDIGO_ENTITY_ID]); // finding 2a: BOTH tenants, always
  assert.equal(p.hasAmounts, true); // R-AMOUNTS: super_admin sees dollars
});

test('Q-A gate: admissions_seat is admitted cross-tenant but WITHOUT amounts', () => {
  const p = requireQualifyPrincipalFromAccess(authed('admissions_seat'));
  assert.ok(p.ok);
  assert.deepEqual(p.entityIds, [BXR_ENTITY_ID, INDIGO_ENTITY_ID]);
  assert.equal(p.hasAmounts, false); // R-AMOUNTS: admissions_seat is dollar-stripped
});

test('Q-A gate: entity admin + entity user are DENIED, fail-closed (not just super_admin-passes)', () => {
  for (const role of ['admin', 'user']) {
    const p = requireQualifyPrincipalFromAccess(authed(role));
    assert.equal(p.ok, false, `${role} must be denied`);
  }
});

test('Q-A gate: no-auth fallback / unauthenticated / unprovisioned all fail-closed', () => {
  assert.equal(requireQualifyPrincipalFromAccess({ ok: true, access: { user: null, role: 'super_admin' } }).ok, false);
  assert.equal(requireQualifyPrincipalFromAccess({ ok: false, reason: 'unauthenticated' }).ok, false);
  assert.equal(requireQualifyPrincipalFromAccess({ ok: false, reason: 'unprovisioned' }).ok, false);
});

test('route guard: only admissions_seat is Qualify-only; QUALIFY_HOME is /qualify', () => {
  assert.equal(isQualifyOnlyRole('admissions_seat'), true);
  for (const role of ['super_admin', 'admin', 'user'] as const) {
    assert.equal(isQualifyOnlyRole(role), false, `${role} is NOT redirected off other routes`);
  }
  assert.equal(QUALIFY_HOME, '/qualify');
});
