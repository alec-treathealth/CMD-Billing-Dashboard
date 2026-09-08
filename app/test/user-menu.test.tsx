/**
 * Top-bar user menu — the entries are CONDITIONAL and only exist in the DOM once the menu is open,
 * so a string render (menu closed) proves nothing about them. jsdom, the dialog-focus pattern: mount,
 * click the avatar, read the real markup. In scope: which links exist for which flags. Out of scope
 * (jsdom has no layout): target size, contrast, what a screen reader announces.
 *
 * What this locks (2026-09-08):
 *  1. `canRulePayerAliases` alone grows the "Payer aliases" entry — it is a DISTINCT flag, resolved
 *     server-side as super_admin + real principal, and NOT a synonym for canManageUsers
 *     (admin ∪ super_admin; `ref.payer_alias_map` has no tenancy column to clamp an entity admin
 *     against, so that role must not see the door);
 *  2. the two existing entries are unaffected by the new flag;
 *  3. nothing admin-shaped is in the DOM while the menu is closed.
 *
 * ⚠️ Must be .tsx and must sit directly in `app/test/` — the runner glob is `test/*.test.tsx`.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as React from 'react';
import { installDom } from './helpers/dom';
import { UserMenu } from '../components/user-menu';

// Installed BEFORE react-dom/client is ever loaded — see helpers/dom.tsx for why the client renderer
// must be imported lazily rather than hoisted with the imports above.
installDom();

let clientRenderer: typeof import('react-dom/client') | null = null;
async function reactDomClient() {
  clientRenderer ??= await import('react-dom/client');
  return clientRenderer;
}

async function mount(t: TestContext, ui: React.ReactElement) {
  const { createRoot } = await reactDomClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  });
  await React.act(async () => {
    root.render(ui);
  });
  return container;
}

/** Click the avatar the way a user would — a bubbling MouseEvent React's root listener receives. */
async function openMenu(container: HTMLElement): Promise<void> {
  const button = container.querySelector('button[aria-haspopup="menu"]');
  assert.ok(button, 'the avatar button must exist');
  await React.act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const hrefs = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('a[role="menuitem"]')].map((a) => a.getAttribute('href') ?? '');

const PAYER_ALIASES = '/admin/payer-aliases';

test('closed: no admin entry is in the DOM at all, whatever the flags', async (t) => {
  const container = await mount(t, <UserMenu email="alec@treathealth.ai" canManageUsers canViewUserLogs canRulePayerAliases />);
  assert.equal(container.querySelector('[role="menu"]'), null);
  assert.equal(container.innerHTML.includes(PAYER_ALIASES), false);
  assert.equal(container.innerHTML.includes('/admin/users'), false);
});

test('canRulePayerAliases ALONE grows the Payer aliases entry — and nothing else', async (t) => {
  const container = await mount(t, <UserMenu email="alec@treathealth.ai" canRulePayerAliases />);
  await openMenu(container);
  assert.deepEqual(hrefs(container), [PAYER_ALIASES]);
  const link = container.querySelector(`a[href="${PAYER_ALIASES}"]`);
  assert.ok(link);
  assert.equal(link.textContent?.trim(), 'Payer aliases');
});

test('canManageUsers does NOT imply the Payer aliases entry — the flags are distinct on purpose', async (t) => {
  // admin ∪ super_admin may manage users; only super_admin may rule a cross-tenant crosswalk.
  const container = await mount(t, <UserMenu email="admin@example.test" canManageUsers />);
  await openMenu(container);
  assert.deepEqual(hrefs(container), ['/admin/users']);
  assert.equal(container.innerHTML.includes(PAYER_ALIASES), false, 'an entity admin must not see the door');
});

test('default (no flags): only Sign out — the entry does not appear by omission', async (t) => {
  const container = await mount(t, <UserMenu email="user@example.test" />);
  await openMenu(container);
  assert.deepEqual(hrefs(container), []);
  assert.ok(container.querySelector('button[type="submit"]'), 'Sign out is still there');
});

test('all three flags: the three entries, in a stable order, each once', async (t) => {
  const container = await mount(t, <UserMenu email="alec@treathealth.ai" canManageUsers canViewUserLogs canRulePayerAliases />);
  await openMenu(container);
  assert.deepEqual(hrefs(container), ['/admin/users', '/admin/user-logs', PAYER_ALIASES]);
});
