/**
 * The shell seam (lib/shell.ts) + the nav model (lib/nav-model.ts).
 *
 * The nav-model half is a REGRESSION LOCK, not a feature test: `linksFor` was moved out of
 * components/nav-links.tsx so the top bar and the M3 rail share one RBAC-visibility decision.
 * These assertions pin the exact per-role link sets the top bar shipped with, so the extraction
 * is provably behaviour-preserving and a future edit to the rail cannot quietly widen what a
 * role sees in the nav. (Nav visibility is not authorization — routes still gate server-side.)
 *
 * Pure leaves, relative imports only — these run under tsx without path-alias resolution.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SHELL_MODE,
  RAIL_COLLAPSED_PX,
  RAIL_EXPANDED_PX,
  isFullPageRoute,
  isShellMode,
  railActive,
  resolveShellModeEnv,
} from '../lib/shell';
import { isActiveNav, linksFor, navHref } from '../lib/nav-model';

// ---------------------------------------------------------------------------
// shell mode
// ---------------------------------------------------------------------------

test('shell: the default is the shipped top bar, so production is unchanged until opted in', () => {
  assert.equal(DEFAULT_SHELL_MODE, 'bar');
  assert.equal(resolveShellModeEnv(undefined), 'bar');
  assert.equal(resolveShellModeEnv(''), 'bar');
  assert.equal(resolveShellModeEnv('   '), 'bar');
});

test('shell: SHELL_MODE accepts the mode names and the truthy kill-switch spellings', () => {
  assert.equal(resolveShellModeEnv('rail'), 'rail');
  assert.equal(resolveShellModeEnv('RAIL'), 'rail');
  assert.equal(resolveShellModeEnv(' Rail '), 'rail');
  assert.equal(resolveShellModeEnv('1'), 'rail');
  assert.equal(resolveShellModeEnv('true'), 'rail');
  assert.equal(resolveShellModeEnv('on'), 'rail');
  assert.equal(resolveShellModeEnv('yes'), 'rail');
  assert.equal(resolveShellModeEnv('bar'), 'bar');
});

test('shell: an unrecognized SHELL_MODE falls back to the default rather than throwing', () => {
  assert.equal(resolveShellModeEnv('sidebar'), 'bar');
  assert.equal(resolveShellModeEnv('off'), 'bar');
  assert.equal(resolveShellModeEnv('0'), 'bar');
});

test('shell: isShellMode narrows only the two real modes', () => {
  assert.equal(isShellMode('bar'), true);
  assert.equal(isShellMode('rail'), true);
  assert.equal(isShellMode('drawer'), false);
  assert.equal(isShellMode(undefined), false);
  assert.equal(isShellMode(null), false);
  assert.equal(isShellMode(1), false);
});

test('shell: the expanded rail overlays — the content inset stays at the collapsed width', () => {
  assert.equal(RAIL_COLLAPSED_PX, 80);
  assert.ok(RAIL_EXPANDED_PX > RAIL_COLLAPSED_PX);
});

// ---------------------------------------------------------------------------
// full-page routes — one predicate behind the header, the rail, and the inset
// ---------------------------------------------------------------------------

test('isFullPageRoute: the auth screens draw their own chrome', () => {
  assert.equal(isFullPageRoute('/login'), true);
  assert.equal(isFullPageRoute('/forgot-password'), true);
  assert.equal(isFullPageRoute('/set-password'), true);
});

test('isFullPageRoute: /qualify/m matches by prefix, desktop /qualify keeps the chrome', () => {
  assert.equal(isFullPageRoute('/qualify/m'), true);
  assert.equal(isFullPageRoute('/qualify/m/anything'), true);
  assert.equal(isFullPageRoute('/qualify'), false);
});

test('isFullPageRoute: ordinary routes and a nullish pathname keep the chrome', () => {
  assert.equal(isFullPageRoute('/dashboard'), false);
  assert.equal(isFullPageRoute('/dashboard/collections'), false);
  assert.equal(isFullPageRoute('/billing-audit'), false);
  // Pre-hydration: preserve the shipped HeaderGate behaviour of rendering chrome.
  // HeaderGate relies on this ONE predicate to null-guard — cover both spellings.
  assert.equal(isFullPageRoute(null), false);
  assert.equal(isFullPageRoute(undefined), false);
});

// ---------------------------------------------------------------------------
// railActive — the ONE gate NavRail and ContentInset both consult.
//
// The two components render in different subtrees (rail = fixed left panel,
// inset = the wrapper around the header + page), so they cannot share a hook
// invocation. Whatever they *can* share is this pure predicate; if they ever
// disagree — a rail with no reserved gutter, or a phantom gutter with no rail —
// the page shifts silently on the full-page routes. These tests are the
// regression lock for that.
// ---------------------------------------------------------------------------

test('railActive: only fires when SHELL_MODE=rail — the shipped bar mode never insets', () => {
  assert.equal(railActive('bar', '/dashboard'), false);
  assert.equal(railActive('bar', '/dashboard/collections'), false);
  assert.equal(railActive('bar', '/login'), false);
  assert.equal(railActive('bar', '/qualify/m'), false);
});

test('railActive: in rail mode, the auth screens hide the rail AND drop the inset', () => {
  // The two chrome-owning full-page routes named in the PR description — plus the
  // other auth screens for completeness. Both the rail and the content inset gate
  // on this predicate, so a `false` here proves neither renders.
  assert.equal(railActive('rail', '/login'), false);
  assert.equal(railActive('rail', '/forgot-password'), false);
  assert.equal(railActive('rail', '/set-password'), false);
});

test('railActive: /qualify/m PWA hides the rail; desktop /qualify keeps it', () => {
  // The mobile PWA draws its own chrome (bottom nav, full-bleed) — a phantom 80px
  // left gutter here would visibly shift the whole app on a phone.
  assert.equal(railActive('rail', '/qualify/m'), false);
  assert.equal(railActive('rail', '/qualify/m/anything'), false);
  // Desktop qualify is not full-page — it lives inside the standard shell.
  assert.equal(railActive('rail', '/qualify'), true);
});

test('railActive: ordinary routes in rail mode render the rail AND reserve the inset', () => {
  assert.equal(railActive('rail', '/dashboard'), true);
  assert.equal(railActive('rail', '/dashboard/collections'), true);
  assert.equal(railActive('rail', '/billing-audit'), true);
  assert.equal(railActive('rail', '/code-reference'), true);
});

test('railActive: a nullish pathname (pre-hydration) still lets the rail render', () => {
  // Mirrors the HeaderGate posture: default to showing chrome until the router settles.
  assert.equal(railActive('rail', null), true);
  assert.equal(railActive('rail', undefined), true);
});

// ---------------------------------------------------------------------------
// nav model — per-role visibility lock
// ---------------------------------------------------------------------------

const hrefs = (role: Parameters<typeof linksFor>[0]) => linksFor(role).map((l) => l.href);

test('nav: admissions_seat is a single-surface persona — Qualify only', () => {
  assert.deepEqual(hrefs('admissions_seat'), ['/qualify']);
});

test('nav: super_admin sees Qualify slotted between Overview and Collections', () => {
  assert.deepEqual(hrefs('super_admin'), [
    '/dashboard',
    '/qualify',
    '/dashboard/collections',
    '/billing-audit',
    '/code-reference',
  ]);
});

test('nav: entity admin / user / unknown get the base set with NO Qualify entry', () => {
  const base = ['/dashboard', '/dashboard/collections', '/billing-audit', '/code-reference'];
  assert.deepEqual(hrefs('admin'), base);
  assert.deepEqual(hrefs('user'), base);
  assert.deepEqual(hrefs(undefined), base);
  for (const role of ['admin', 'user', undefined] as const) {
    assert.equal(
      linksFor(role).some((l) => l.href === '/qualify'),
      false,
    );
  }
});

test('nav: every link carries a rail icon — an icon-first rail cannot render without one', () => {
  for (const role of ['super_admin', 'admissions_seat', 'admin', undefined] as const) {
    for (const link of linksFor(role)) {
      assert.ok(link.railIcon, `${link.href} is missing railIcon`);
    }
  }
});

test('nav: Claims Audit and Qualify are the Beta-flagged surfaces', () => {
  const beta = linksFor('super_admin')
    .filter((l) => l.isBeta)
    .map((l) => l.href);
  assert.deepEqual(beta.sort(), ['/billing-audit', '/qualify']);
});

// ---------------------------------------------------------------------------
// ?view= forwarding + active-route matching (shared by both shells)
// ---------------------------------------------------------------------------

test('navHref: the tenant scope rides along to view-scoped routes only', () => {
  assert.equal(navHref('/dashboard', 'bxr'), '/dashboard?view=bxr');
  assert.equal(navHref('/dashboard/collections', 'bxr'), '/dashboard/collections?view=bxr');
  assert.equal(navHref('/billing-audit', 'indigo'), '/billing-audit?view=indigo');
  // Qualify is cross-tenant and pins its own scope; Code Reference is global.
  assert.equal(navHref('/qualify', 'bxr'), '/qualify');
  assert.equal(navHref('/code-reference', 'bxr'), '/code-reference');
});

test('navHref: no active view means no param, and the value is encoded', () => {
  assert.equal(navHref('/dashboard', null), '/dashboard');
  assert.equal(navHref('/dashboard', 'a b&c'), '/dashboard?view=a%20b%26c');
});

test('isActiveNav: /dashboard matches exactly so Collections does not light up Overview', () => {
  assert.equal(isActiveNav('/dashboard', '/dashboard'), true);
  assert.equal(isActiveNav('/dashboard', '/dashboard/collections'), false);
  assert.equal(isActiveNav('/dashboard/collections', '/dashboard/collections'), true);
});

test('isActiveNav: every other link still matches its subroutes', () => {
  assert.equal(isActiveNav('/billing-audit', '/billing-audit'), true);
  assert.equal(isActiveNav('/billing-audit', '/billing-audit/detail'), true);
  assert.equal(isActiveNav('/qualify', '/qualify'), true);
  assert.equal(isActiveNav('/code-reference', '/dashboard'), false);
  assert.equal(isActiveNav('/dashboard', null), false);
});
