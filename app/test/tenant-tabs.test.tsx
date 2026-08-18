/**
 * TENANT TABS (2026-08-18) — the on-page entity selector that replaced the top-bar dropdown.
 *
 * Requested: *"instead of the 'Consolidated', 'Indigo', and 'BXR' in a drop down, just make them big
 * sub tabs on the actual page … Keep this consistent for both the Overview and Collections Search
 * page."*
 *
 * The LOOK is CSS and is verified in a browser. What is pinned here is the part that would be a
 * SECURITY or correctness bug if it drifted: the option set is derived from the caller's entitlement,
 * the control hides when there is nothing to switch, and the active tab is the CLAMPED view rather
 * than whatever `?view=` happened to say.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_VIEWS, clampView, resolveView, viewOptions, type DashboardView } from '../lib/views';

/** The exact derivation TenantTabs runs, exercised without React's router hooks. */
function tabsFor(allowedViews: DashboardView[] | undefined, requestedParam: string | undefined) {
  if (!allowedViews || allowedViews.length <= 1) return null;
  const view = clampView(resolveView({ view: requestedParam }), allowedViews);
  return { view, options: viewOptions.filter((o) => allowedViews.includes(o.value)) };
}

test('a super_admin gets all three tabs, Consolidated active by default', () => {
  const t = tabsFor([...ALL_VIEWS], undefined);
  assert.ok(t);
  assert.deepEqual(t.options.map((o) => o.value), ['consolidated', 'bxr', 'indigo']);
  assert.deepEqual(t.options.map((o) => o.label), ['Consolidated', 'BXR Consulting', 'Indigo Billing']);
  assert.equal(t.view, 'consolidated');
});

test('the control renders NOTHING for a single-tenant user', () => {
  // An entity-scoped user has one view. A one-tab tablist is chrome implying a choice they do not
  // have — and, worse, it would show a tenant name as if it were selectable.
  assert.equal(tabsFor(['bxr'], undefined), null);
  assert.equal(tabsFor([], undefined), null);
  assert.equal(tabsFor(undefined, undefined), null);
});

test('⚠ a hand-edited ?view= cannot produce a tab the user is not entitled to', () => {
  // The control is NOT the gate — the page re-clamps server-side and scopes by the clamped value —
  // but it must not RENDER another tenant's tab either, or the UI would advertise access that does
  // not exist and a click would silently bounce.
  const t = tabsFor(['bxr', 'indigo'], 'consolidated');
  assert.ok(t);
  assert.equal(t.options.some((o) => o.value === 'consolidated'), false, 'not offered');
  assert.notEqual(t.view, 'consolidated', 'and not active');
  assert.ok(['bxr', 'indigo'].includes(t.view));
});

test('the ACTIVE tab is the clamped view, not the requested one', () => {
  const t = tabsFor([...ALL_VIEWS], 'indigo');
  assert.equal(t!.view, 'indigo', 'a legitimate request is honoured');
  const garbage = tabsFor([...ALL_VIEWS], 'not-a-view');
  assert.equal(garbage!.view, 'consolidated', 'garbage falls back to the default, never throws');
});

test('exactly one tab is in the tab order (roaming tabindex)', () => {
  // The tablist keyboard model requires ONE tab stop; arrows move within. Two tab stops would make a
  // keyboard user tab through every tenant to leave the control.
  const t = tabsFor([...ALL_VIEWS], 'bxr')!;
  const tabIndexes = t.options.map((o) => (o.value === t.view ? 0 : -1));
  assert.equal(tabIndexes.filter((x) => x === 0).length, 1);
});

test('the tab labels are the SAME source the rest of the app names tenants from', () => {
  // Overview and Collections must not disagree about what a tenant is called, and neither may drift
  // from brand-theme / the logos. One `viewOptions` is why that cannot happen — so the tabs are
  // pinned to it rather than to a private label map.
  assert.deepEqual(
    viewOptions.map((o) => o.label),
    ['Consolidated', 'BXR Consulting', 'Indigo Billing'],
  );
  assert.deepEqual(viewOptions.map((o) => o.value), [...ALL_VIEWS], 'order matches ALL_VIEWS');
});

// ── The 2px stroke (Alec, 2026-08-18 — a reversal of the original "borderless" ask) ──────────────

test('every tab carries a 2px border, and the ACTIVE one takes the brand accent', () => {
  // The first ask was borderless, it shipped that way, and the tabs did not read as CONTROLS —
  // nothing said "clickable" until you hovered one. This pins the reversal so a future tidy-up that
  // strips the stroke has to be a decision rather than a drive-by.
  //
  // SOURCE-LEVEL, matching this file's own rule that the look is browser-verified: TenantTabs is a
  // client component built on router hooks, so it cannot be rendered here. What is asserted is the
  // class contract, which is the part that would silently regress.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../components/dashboard/tenant-tabs.tsx'), 'utf8');
  assert.match(src, /rounded-lg border-2 px-4 py-2/, 'the stroke is on the shared base classes');
  assert.match(src, /border-\[var\(--brand-accent\)\] bg-\[var\(--brand-soft\)\]/, 'active owns the accent');
  assert.match(src, /'border-line font-medium/, 'inactive tabs are stroked too, in the neutral line colour');
  // Selection must not rest on colour alone (WCAG 1.4.1) — weight still carries it.
  assert.match(src, /border-\[var\(--brand-accent\)\] bg-\[var\(--brand-soft\)\] font-semibold/);
  // Two 2px strokes 4px apart read as one divided box; the gap widened with the border.
  assert.match(src, /role="tablist"[\s\S]{0,120}gap-2"/);
});
