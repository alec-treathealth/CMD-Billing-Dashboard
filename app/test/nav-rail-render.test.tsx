/**
 * M3 navigation rail — RENDERED-HTML tests. Renders the pure NavRailView leaf to markup and
 * asserts on the real HTML, matching the qualify-render convention. What these lock:
 *
 *   1) per-role destinations come from the SHARED nav model (an admissions_seat rail must never
 *      grow a Collections or Claims Desk link),
 *   2) the tenant scope (?view=) rides onto view-scoped hrefs and stays OFF cross-tenant ones,
 *   3) the M3 active indicator marks exactly one destination, and it is the current route,
 *   4) collapsed vs expanded both keep every label in the accessible name — the collapsed rail
 *      must not become icon-only for a screen reader,
 *   5) color comes from the --m3-rail-* variables, never a hardcoded hex (the rule that keeps
 *      per-tenant branding working in the new shell).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { NavRailView } from '../components/shell/nav-rail';
import { linksFor } from '../lib/nav-model';

function render(opts: {
  role?: Parameters<typeof linksFor>[0];
  pathname?: string;
  view?: string | null;
  expanded?: boolean;
}) {
  return renderToStaticMarkup(
    <NavRailView
      links={linksFor(opts.role)}
      pathname={opts.pathname ?? '/dashboard'}
      view={opts.view ?? null}
      expanded={opts.expanded ?? false}
      onToggle={() => {}}
      navId="rail-nav"
    />,
  );
}

test('rail: super_admin renders every destination, labelled', () => {
  const html = render({ role: 'super_admin' });
  for (const label of ['Overview', 'Qualify', 'Collections', 'Claims Desk', 'Code Reference']) {
    assert.ok(html.includes(label), `missing destination: ${label}`);
  }
});

test('rail: admissions_seat is Qualify-only — no dashboard destinations leak in', () => {
  const html = render({ role: 'admissions_seat', pathname: '/qualify' });
  assert.ok(html.includes('Qualify'));
  assert.ok(!html.includes('Collections'));
  assert.ok(!html.includes('Claims Desk'));
  assert.ok(!html.includes('Code Reference'));
  assert.ok(!html.includes('href="/dashboard"'));
});

test('rail: an entity role gets no Qualify destination', () => {
  const html = render({ role: 'admin' });
  assert.ok(!html.includes('href="/qualify"'));
  assert.ok(html.includes('Collections'));
});

test('rail: the tenant scope rides onto view-scoped hrefs only', () => {
  const html = render({ role: 'super_admin', view: 'bxr' });
  assert.ok(html.includes('href="/dashboard?view=bxr"'));
  assert.ok(html.includes('href="/dashboard/collections?view=bxr"'));
  assert.ok(html.includes('href="/billing-audit?view=bxr"'));
  // Qualify is cross-tenant; Code Reference is global. Neither may carry the scope.
  assert.ok(html.includes('href="/qualify"'));
  assert.ok(html.includes('href="/code-reference"'));
  assert.ok(!html.includes('/qualify?view='));
  assert.ok(!html.includes('/code-reference?view='));
});

/** The `<a …>` open tags, in render order. Attribute ORDER inside a tag is next/link's business. */
function anchorTags(html: string): string[] {
  return html.match(/<a\s[^>]*>/g) ?? [];
}

/** The href of the single anchor carrying aria-current="page". */
function activeHref(html: string): string | null {
  const current = anchorTags(html).filter((tag) => tag.includes('aria-current="page"'));
  assert.equal(current.length, 1, 'expected exactly one aria-current anchor');
  return current[0]?.match(/href="([^"]*)"/)?.[1] ?? null;
}

test('rail: exactly one destination is aria-current, and it is the active route', () => {
  // '/dashboard' must match EXACTLY — Collections must not also light up Overview.
  assert.equal(activeHref(render({ role: 'super_admin', pathname: '/dashboard/collections' })), '/dashboard/collections');
  assert.equal(activeHref(render({ role: 'super_admin', pathname: '/dashboard' })), '/dashboard');
  assert.equal(activeHref(render({ role: 'super_admin', pathname: '/qualify' })), '/qualify');
  // A subroute still marks its parent destination active.
  assert.equal(activeHref(render({ role: 'super_admin', pathname: '/billing-audit/detail' })), '/billing-audit');
});

test('rail: the active destination keeps the tenant scope on its href', () => {
  assert.equal(
    activeHref(render({ role: 'super_admin', pathname: '/dashboard/collections', view: 'indigo' })),
    '/dashboard/collections?view=indigo',
  );
});

test('rail: the active indicator is painted from the M3 token, not a hex', () => {
  const html = render({ role: 'super_admin', pathname: '/dashboard' });
  assert.ok(html.includes('var(--m3-rail-indicator)'));
  assert.ok(html.includes('var(--m3-rail-surface)'));
  assert.ok(html.includes('var(--m3-rail-on'));
  // No literal brand hexes in the rail chrome — tenant branding must flow through the vars.
  assert.ok(!html.includes('#0e3a3a'));
  assert.ok(!html.includes('#1a1a2e'));
  assert.ok(!html.includes('#5b2a9e'));
});

test('rail: collapsed still carries every label — it is not icon-only for a screen reader', () => {
  const collapsed = render({ role: 'super_admin', expanded: false });
  for (const label of ['Overview', 'Qualify', 'Collections', 'Claims Desk', 'Code Reference']) {
    assert.ok(collapsed.includes(label), `collapsed rail dropped: ${label}`);
  }
  // Collapsed leans on title= for the truncated label.
  assert.ok(collapsed.includes('title="Claims Desk"'));
});

test('rail: the expand toggle exposes its state and controls the nav landmark', () => {
  const collapsed = render({ role: 'super_admin', expanded: false });
  assert.ok(collapsed.includes('aria-expanded="false"'));
  assert.ok(collapsed.includes('aria-controls="rail-nav"'));
  assert.ok(collapsed.includes('aria-label="Expand navigation"'));

  const expanded = render({ role: 'super_admin', expanded: true });
  assert.ok(expanded.includes('aria-expanded="true"'));
  assert.ok(expanded.includes('aria-label="Collapse navigation"'));
});

test('rail: the nav landmark is labelled and matches aria-controls', () => {
  const html = render({ role: 'super_admin' });
  assert.ok(html.includes('aria-label="Main"'));
  assert.ok(html.includes('id="rail-nav"'));
});

test('rail: Beta reads as a badge when expanded and a dot when collapsed', () => {
  const expanded = render({ role: 'super_admin', expanded: true });
  assert.ok(expanded.includes('q-beta-badge'));

  const collapsed = render({ role: 'super_admin', expanded: false });
  assert.ok(!collapsed.includes('q-beta-badge'));
  // Two Beta surfaces (Qualify + Claims Desk) → two collapsed dot markers.
  assert.equal(collapsed.match(/rounded-full bg-coral400/g)?.length, 2);
});

test('rail: expanding widens the panel but never the reserved footprint', () => {
  const collapsed = render({ role: 'super_admin', expanded: false });
  const expanded = render({ role: 'super_admin', expanded: true });
  // The outer fixed element reserves 80px in BOTH states — content must not reflow.
  assert.ok(collapsed.includes('width:80px'));
  assert.ok(expanded.includes('width:80px'));
  // Only the inner panel grows.
  assert.ok(expanded.includes('width:232px'));
  assert.ok(!collapsed.includes('width:232px'));
});
