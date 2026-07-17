/**
 * Manage Users — entity-coherence tests for the admissions_seat fix (form owns this; canAssign() in
 * admin-actions.ts and the DB check app_user_role_entity_ck in migration 0055 were already correct).
 *
 * WHY leaf tests, not a full UserManager render: UserManager imports the 'use server' admin-actions
 * chain (supabase-admin / next/headers), which fails to LOAD under `node --test`. The repo convention
 * (qualify-render.test.tsx) is to render pure presentational leaves. EntityCell + the user-form helpers
 * are exactly those leaves. These assert admissions_seat behaves IDENTICALLY to super_admin: the entity
 * selector is hidden/disabled, the submitted payload is entity:null, and a stale entity is cleared when
 * the role switches — the three things the DoD requires.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntityCell } from '../components/admin/entity-cell';
import { entityAfterRoleChange, entityForSubmit, isEntityLessRole } from '../lib/admin/user-form';

test('isEntityLessRole: super_admin + admissions_seat are entity-less; admin/user/none are not', () => {
  assert.equal(isEntityLessRole('super_admin'), true);
  assert.equal(isEntityLessRole('admissions_seat'), true);
  assert.equal(isEntityLessRole('admin'), false);
  assert.equal(isEntityLessRole('user'), false);
  assert.equal(isEntityLessRole(''), false);
});

test('entityForSubmit: admissions_seat DROPS any stale entity → null (the bug was sending bxr)', () => {
  assert.equal(entityForSubmit('admissions_seat', 'bxr'), null); // stale value dropped
  assert.equal(entityForSubmit('super_admin', 'indigo'), null);
  assert.equal(entityForSubmit('admin', 'bxr'), 'bxr'); // entity roles keep their selection
  assert.equal(entityForSubmit('user', 'indigo'), 'indigo');
  assert.equal(entityForSubmit('admin', ''), null); // no selection yet → null (guarded upstream)
});

test('entityAfterRoleChange: switching admin(bxr) → admissions_seat/super_admin CLEARS the entity', () => {
  assert.equal(entityAfterRoleChange('admissions_seat', 'bxr', 'bxr'), ''); // stale bxr cleared
  assert.equal(entityAfterRoleChange('super_admin', 'indigo', 'bxr'), '');
  assert.equal(entityAfterRoleChange('admin', '', 'bxr'), 'bxr'); // entity role w/ none → default
  assert.equal(entityAfterRoleChange('user', 'indigo', 'bxr'), 'indigo'); // existing selection kept
  assert.equal(entityAfterRoleChange('', 'bxr', 'bxr'), 'bxr'); // 'none' role leaves it untouched
});

test('EntityCell render: admissions_seat HIDES the entity selector (disabled, only "—")', () => {
  const html = renderToStaticMarkup(
    <EntityCell
      role="admissions_seat"
      entity=""
      assignableEntities={['bxr', 'indigo']}
      ariaLabel="Entity for x@y.z"
      onChange={() => {}}
    />,
  );
  assert.match(html, /disabled=""/); // the <select> is disabled (not the disabled:opacity-50 class)
  assert.match(html, /—/); // shows the single em-dash placeholder
  assert.doesNotMatch(html, /value="bxr"/); // no entity option rendered
  assert.doesNotMatch(html, /value="indigo"/);
});

test('EntityCell render: super_admin hides the selector identically to admissions_seat', () => {
  const html = renderToStaticMarkup(
    <EntityCell role="super_admin" entity="" assignableEntities={['bxr', 'indigo']} ariaLabel="e" onChange={() => {}} />,
  );
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /value="bxr"/);
});

test('EntityCell render: admin SHOWS the entity options (bxr/indigo), enabled', () => {
  const html = renderToStaticMarkup(
    <EntityCell
      role="admin"
      entity="bxr"
      assignableEntities={['bxr', 'indigo']}
      ariaLabel="Entity for x@y.z"
      onChange={() => {}}
    />,
  );
  assert.match(html, /value="bxr"/);
  assert.match(html, /value="indigo"/);
  assert.doesNotMatch(html, /disabled=""/); // enabled for entity roles
});
