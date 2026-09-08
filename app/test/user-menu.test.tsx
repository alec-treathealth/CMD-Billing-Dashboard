/**
 * Top-bar user menu — which entries exist for which flags.
 *
 * STRING RENDER, NOT jsdom (Qodo #343 finding 1). The entries are conditional and only exist once
 * the menu is open, so an earlier version of this file mounted the client shell under jsdom and
 * clicked the avatar to read them. That crossed the harness boundary: CLAUDE.md sanctions jsdom
 * "solely so FOCUS and KEYBOARD behaviour can be executed rather than asserted as markup", and these
 * ARE markup assertions. It also forced a `self` global into the shared helper for every future
 * test that mounts a <Link>. The fix is the payer-alias-leaves.tsx pattern: the menu body is now a
 * PURE leaf (`UserMenuItems`), rendered here with renderToStaticMarkup and the flags set directly.
 * Nothing about focus, keyboard, contrast or announcement is claimed here.
 *
 * What this locks (2026-09-08):
 *  1. `canRulePayerAliases` alone grows the "Payer aliases" entry — a DISTINCT flag, resolved
 *     server-side as super_admin + real principal, and NOT a synonym for canManageUsers
 *     (admin ∪ super_admin; `ref.payer_alias_map` has no tenancy column to clamp an entity admin
 *     against, so that role must not see the door);
 *  2. the two existing entries are unaffected by the new flag, and the order is stable;
 *  3. nothing admin-shaped is in the markup while the shell is closed.
 *
 * ⚠️ Must be .tsx and must sit directly in `app/test/` — the runner glob is `test/*.test.tsx`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserMenu, UserMenuItems } from '../components/user-menu';

const PAYER_ALIASES = '/admin/payer-aliases';

/**
 * Every menuitem anchor's href, in document order — the WHOLE entry set, so an extra entry cannot
 * hide. Attribute-order agnostic on purpose: next/link emits `role` before `href`, and a regex that
 * assumed the JSX order failed a probe for exactly that reason.
 */
function menuHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('role="menuitem"'))
    .map((tag) => /\bhref="([^"]+)"/.exec(tag)?.[1] ?? '');
}

test('closed shell: no menu and no admin entry in the markup, whatever the flags', () => {
  const html = renderToStaticMarkup(
    <UserMenu email="alec@treathealth.ai" canManageUsers canViewUserLogs canRulePayerAliases />,
  );
  assert.equal(html.includes('role="menu"'), false);
  assert.equal(html.includes(PAYER_ALIASES), false);
  assert.equal(html.includes('/admin/users'), false);
  assert.ok(html.includes('aria-haspopup="menu"'), 'the avatar button is the only thing rendered');
});

test('canRulePayerAliases ALONE grows the Payer aliases entry — and nothing else', () => {
  const html = renderToStaticMarkup(<UserMenuItems email="alec@treathealth.ai" canRulePayerAliases />);
  assert.deepEqual(menuHrefs(html), [PAYER_ALIASES]);
  assert.ok(html.includes('>Payer aliases<'), html);
});

test('canManageUsers does NOT imply the Payer aliases entry — the flags are distinct on purpose', () => {
  // admin ∪ super_admin may manage users; only super_admin may rule a cross-tenant crosswalk.
  const html = renderToStaticMarkup(<UserMenuItems email="admin@example.test" canManageUsers />);
  assert.deepEqual(menuHrefs(html), ['/admin/users']);
  assert.equal(html.includes(PAYER_ALIASES), false, 'an entity admin must not see the door');
});

test('no flags: no entries at all — the door does not appear by omission; the header still does', () => {
  const html = renderToStaticMarkup(<UserMenuItems email="user@example.test" />);
  assert.deepEqual(menuHrefs(html), []);
  assert.ok(html.includes('Signed in as'), html);
  assert.ok(html.includes('user@example.test'), html);
});

test('all three flags: the three entries, in a stable order, each once', () => {
  const html = renderToStaticMarkup(
    <UserMenuItems email="alec@treathealth.ai" canManageUsers canViewUserLogs canRulePayerAliases />,
  );
  assert.deepEqual(menuHrefs(html), ['/admin/users', '/admin/user-logs', PAYER_ALIASES]);
});

test('the footer slot renders after the entries — the shell puts Sign out there', () => {
  const html = renderToStaticMarkup(
    <UserMenuItems email="x@example.test" canManageUsers footer={<span data-footer="1">after</span>} />,
  );
  assert.ok(html.indexOf('/admin/users') < html.indexOf('data-footer'), 'footer follows the entries');
});
