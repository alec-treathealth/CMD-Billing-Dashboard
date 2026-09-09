/**
 * TENANT SCOPE (2026-09-08) — the nav-resident entity selector.
 *
 * Alec reversed his own 2026-08-18 "No dropdowns" ruling: the selector left the page body
 * (TenantTabs, deleted) for the top bar, as a filled LABELLED pill with a menu plus a 4px rail. The
 * reversal is recorded at its old site in app/layout.tsx. These tests are the ported SECURITY-shaped
 * half of tenant-tabs.test.tsx — the option set derives from entitlement, the control narrows and
 * never widens, the active view is the CLAMPED one — plus the render contract of the new control.
 *
 * WHAT DIED WITH TenantTabs, PER ASSERTION (not deleted silently):
 *   · "ACTIVE pill is a solid --brand-ink fill / white label"  → treatment gone; the nav pill is a
 *     LIGHT --entity-fill chip with ink900 text, because --brand-ink measured 1.35-1.65:1 on the bar.
 *   · "--brand-accent is NOT the fill"                          → successor below (accent still banned).
 *   · "INACTIVE pills transparent / ink400 hairline / ink600"    → no inactive pills exist at rest.
 *   · "hover strengthens the border, never adds a tint"          → no at-rest siblings to hover.
 *   · "2px stroke became a hairline"                             → no stroke at all on the chip.
 *   · "role=tablist / aria-selected / aria-current"              → the control is a menu button now;
 *     successors assert aria-haspopup / aria-expanded / menuitemradio / aria-checked instead.
 *   · "Arrows wrap, Home, End"                                   → ported to the MENU (source-level).
 *   · "focus ring visible on the dark fill and the ground"       → the chip sits on the BAR; successor
 *     asserts a white ring with a bar-coloured offset.
 *   · "44px", "data-view on the PILL", "aria-live", "fragment root", "alpha-on-var ban",
 *     "reduced-motion via the global reset"                      → PORTED, below.
 *
 * NAMING. Source-regex and static-markup tests cannot observe rendered pixels, focus movement, or
 * what a screen reader says (CLAUDE.md; Qodo rule 2726594 on #338; the code review of THIS change
 * caught five names that still overclaimed). Every name below states the CONTRACT it checks — a
 * class or attribute is in the markup, a handler calls a function — never the outcome. The 44px
 * target, the resolved fill colours, and the nav widths were measured in headless Chromium against
 * the shipped stylesheet and are recorded in the PR; the announcement needs VoiceOver; the focus
 * behaviour is the listed jsdom follow-up.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { ALL_VIEWS, clampView, resolveView, viewOptions, type DashboardView } from '../lib/views';
import { CLAIMS_DESK_VIEWS } from '../lib/billing-audit/views';
import { VIEW_SCOPED } from '../lib/nav-model';
import {
  SHORT_LABEL,
  TenantScopeRailView,
  TenantScopeView,
  fullLabel,
  isClaimsDeskRoute,
  isViewScopedRoute,
  offeredViews,
  scopeHref,
} from '../components/nav/tenant-scope';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const rawSrc = readFileSync(join(appRoot, 'components/nav/tenant-scope.tsx'), 'utf8');
const globalsCss = readFileSync(join(appRoot, 'app/globals.css'), 'utf8');
const layoutSrc = readFileSync(join(appRoot, 'app/layout.tsx'), 'utf8');
/** Comment-stripped, so guards match CODE and never the docblocks that quote the banned forms. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = strip(rawSrc);

/** The exact derivation the mounted component runs (useTenantScope), without React's router. */
function scopeFor(pathname: string, allowed: DashboardView[] | undefined, param: string | undefined) {
  const offered = offeredViews(pathname, allowed);
  const active = offered.length === 0 ? null : clampView(resolveView({ view: param }), offered);
  return { offered, active, interactive: isViewScopedRoute(pathname) };
}
const render = (p: {
  offered: DashboardView[];
  active: DashboardView | null;
  pathname?: string;
  search?: string;
  interactive?: boolean;
}) =>
  renderToStaticMarkup(
    <TenantScopeView
      offered={p.offered}
      active={p.active}
      pathname={p.pathname ?? '/dashboard'}
      search={p.search ?? ''}
      interactive={p.interactive ?? true}
    />,
  );

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PORTED: entitlement derivation — the option set is the caller's entitlement, narrowed per route
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('a super_admin is offered all three tenants on /dashboard, Consolidated active by default', () => {
  const s = scopeFor('/dashboard', [...ALL_VIEWS], undefined);
  assert.deepEqual(s.offered, ['consolidated', 'bxr', 'indigo']);
  assert.equal(s.active, 'consolidated');
  assert.equal(s.interactive, true, '/dashboard reads ?view=, so the pill is a control here');
  assert.deepEqual(s.offered.map(fullLabel), ['Consolidated', 'BXR Consulting', 'Indigo Billing']);
});

test('⚠ on the Claims Desk INDEX the SAME super_admin is offered two — the route narrows, via claimsDeskViews', () => {
  // The nav cannot know the route's plane set on its own; it calls the SAME helper the desk page
  // uses, so the two cannot disagree. Consolidated is absent because the desk has no cross-tenant
  // plane, and the default is BXR (route default first), exactly as lib/billing-audit/views.ts rules.
  const s = scopeFor('/billing-audit', [...ALL_VIEWS], undefined);
  assert.deepEqual(s.offered, [...CLAIMS_DESK_VIEWS], '/billing-audit offers the desk planes');
  assert.equal(s.active, 'bxr', '/billing-audit defaults to BXR');
  assert.equal(s.interactive, true, '/billing-audit reads ?view= (it canonicalises it), so the pill is a control');
  assert.equal(isClaimsDeskRoute('/dashboard'), false);
  assert.equal(isClaimsDeskRoute(null), false);
  // isViewScopedRoute is VIEW_SCOPED by exact path OR sub-route — the desk's sub-route must count.
  for (const href of VIEW_SCOPED) assert.equal(isViewScopedRoute(href), true, `${href} is scoped`);
  assert.equal(isViewScopedRoute('/dashboard/collections/explorer'), true, 'sub-routes of a scoped route are scoped');
  for (const p of ['/payer-intel', '/admin', '/admin/users', '/account', '/code-reference', '/qualify', '/', null]) {
    assert.equal(isViewScopedRoute(p), false, `${p} does not read ?view=`);
  }
});

test('⚠ Facility Resolution is NOT desk-narrowed: the pill offers exactly what that page scopes its data by', () => {
  // /billing-audit/facility-resolution hangs under the Claims Desk tab, but its page runs
  // clampView(resolveView(params), allowedViews) — Consolidated included, Consolidated the default.
  // The first draft's prefix match offered ['bxr','indigo'] there and clamped an absent ?view= to
  // BXR, so the pill and rail said BXR while the page queried BOTH tenants and its attribution
  // writes ran Consolidated (Qodo #344 finding 3). The pill must state the scope the PAGE uses.
  assert.equal(isClaimsDeskRoute('/billing-audit/facility-resolution'), false);
  const s = scopeFor('/billing-audit/facility-resolution', [...ALL_VIEWS], undefined);
  assert.deepEqual(s.offered, ['consolidated', 'bxr', 'indigo'], 'the generic offer, in viewOptions order');
  assert.equal(s.active, 'consolidated', "absent ?view= → the page's DEFAULT_VIEW, which is what it queries");
  assert.equal(s.interactive, true, 'still a control: the route reads ?view= (VIEW_SCOPED by sub-route)');
  const explicit = scopeFor('/billing-audit/facility-resolution', [...ALL_VIEWS], 'consolidated');
  assert.equal(explicit.active, 'consolidated', 'an explicit consolidated is honoured, not clamped to BXR');
  const admin = scopeFor('/billing-audit/facility-resolution', ['indigo'], undefined);
  assert.deepEqual(admin.offered, ['indigo'], 'an Indigo admin is offered their tenant and nothing else');
});

test('⚠ PARITY: a route is desk-narrowed in the nav IFF its page imports the desk resolver — classified by what the page IMPORTS', () => {
  // The docblock's "the nav and the page cannot disagree" held only by coincidence of classification
  // until this test. Every page.tsx under app/billing-audit is read: resolveClaimsDeskView → the nav
  // must narrow; the generic resolveView → it must not. A new desk sub-route fails here on day one
  // unless its resolver and its classification agree.
  const pages: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'page.tsx') pages.push(['/' + relative(join(appRoot, 'app'), dirname(p)), readFileSync(p, 'utf8')]);
    }
  };
  walk(join(appRoot, 'app/billing-audit'));
  assert.ok(pages.length >= 2, `found ${pages.length} desk pages; expected the index and facility-resolution at least`);
  for (const [route, source] of pages) {
    const code = strip(source);
    const usesDesk = /\bresolveClaimsDeskView\b/.test(code);
    const usesGeneric = /\bresolveView\(/.test(code);
    assert.ok(usesDesk !== usesGeneric, `${route}: exactly one resolver (desk=${usesDesk}, generic=${usesGeneric})`);
    assert.equal(isClaimsDeskRoute(route), usesDesk, `${route}: nav narrowing must match the page's resolver`);
  }
});

test('⚠ a hand-edited ?view= cannot produce a tenant the user is not entitled to, on any route', () => {
  // The control is NOT the gate — the page re-clamps server-side — but it must not OFFER another
  // tenant either, or the UI advertises access that does not exist.
  const desk = scopeFor('/billing-audit', ['bxr', 'indigo'], 'consolidated');
  assert.equal(desk.offered.includes('consolidated'), false, 'not offered on the desk');
  assert.notEqual(desk.active, 'consolidated', 'and not active');
  const entity = scopeFor('/dashboard', ['indigo'], 'bxr');
  assert.deepEqual(entity.offered, ['indigo'], 'an Indigo admin is never offered BXR');
  assert.equal(entity.active, 'indigo', 'a request for BXR clamps to their own tenant');
  const garbage = scopeFor('/dashboard', [...ALL_VIEWS], 'not-a-view');
  assert.equal(garbage.active, 'consolidated', 'garbage falls back to the default, never throws');
});

test('the offered set is never WIDER than the entitlement — narrowing is the only direction', () => {
  for (const allowed of [[...ALL_VIEWS], ['bxr'], ['indigo'], ['bxr', 'indigo'], []] as DashboardView[][]) {
    for (const p of ['/dashboard', '/dashboard/collections', '/billing-audit', '/payer-intel', '/']) {
      for (const v of offeredViews(p, allowed)) assert.ok(allowed.includes(v), `${p}: ${v} ⊄ ${allowed}`);
    }
  }
});

test('the tenant names come from the ONE place the app names tenants', () => {
  assert.deepEqual(viewOptions.map((o) => o.label), ['Consolidated', 'BXR Consulting', 'Indigo Billing']);
  for (const v of ALL_VIEWS) {
    assert.equal(fullLabel(v), viewOptions.find((o) => o.value === v)!.label);
    assert.ok(SHORT_LABEL[v].length > 0, `${v} has a non-empty short label`);
  }
  assert.deepEqual(SHORT_LABEL, { consolidated: 'Consolidated', bxr: 'BXR', indigo: 'Indigo' });
});

test('scopeHref replaces ONLY ?view= and keeps every other param on the current route', () => {
  assert.equal(scopeHref('/dashboard/collections', 'q=abc&view=bxr&page=2', 'indigo'), '/dashboard/collections?q=abc&view=indigo&page=2');
  assert.equal(scopeHref('/billing-audit', '', 'bxr'), '/billing-audit?view=bxr');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RENDER CONTRACT — static markup of the View, per entitlement shape
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('MULTI-tenant on a scoped route: the trigger is a button with popup semantics and the active tenant as text', () => {
  const html = render({ offered: [...ALL_VIEWS], active: 'bxr' });
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/, 'closed at rest');
  assert.match(html, /aria-controls="/);
  assert.match(html, /<button[^>]*data-view="bxr"/, 'the pill carries its own data-view');
  assert.match(html, /bg-\[var\(--entity-fill\)\] text-\[var\(--entity-on\)\]/, 'entity fill + paired foreground');
  assert.match(html, /min-h-\[44px\]/, 'the 44px floor is declared');
  assert.doesNotMatch(html, /role="menu"/, 'the menu is not in the DOM while closed');
});

test('both label spans and the lg: collapse classes are in the markup (full name >=lg, short label below)', () => {
  // What a static render can show: the two spans exist with their responsive classes. That the
  // pill is never icon-only at any width is the Chromium measurement in the PR (169px / 74px).
  const html = render({ offered: [...ALL_VIEWS], active: 'indigo' });
  assert.match(html, /<span class="hidden lg:inline">Indigo Billing<\/span>/, 'full name span, hidden below lg');
  assert.match(html, /<span class="lg:hidden">Indigo<\/span>/, 'short label span, hidden at lg');
  // Ruling 2(a), verbatim: "drop the building icon from the pill below lg, short label only."
  assert.match(html, /<svg[^>]*class="[^"]*hidden h-4 w-4 lg:block/, 'icon class-hidden below lg');
});

test('a LABEL, not a control: SINGLE tenant OR an UNSCOPED route renders the non-interactive <span>', () => {
  // TenantTabs rendered NOTHING for a single-tenant user, leaving them with no tenant indicator at
  // all. And on a route that does not read ?view= (/payer-intel, /admin, …) a super_admin must not
  // be OFFERED a change that does nothing — RULED 2026-09-08 on the code review of this change;
  // the pill STATES the carried scope (navHref forwards it) and offers no menu.
  for (const c of [
    { label: 'single tenant', html: render({ offered: ['bxr'], active: 'bxr' }) },
    { label: 'super_admin on /payer-intel', html: render({ offered: [...ALL_VIEWS], active: 'bxr', pathname: '/payer-intel', interactive: false }) },
  ]) {
    assert.match(c.html, /^<span data-view="bxr"/, `${c.label}: a span, carrying its own data-view`);
    assert.match(c.html, />BXR Consulting</, `${c.label}: full name present`);
    assert.doesNotMatch(c.html, /<button/, `${c.label}: not a button`);
    assert.doesNotMatch(c.html, /aria-haspopup/, `${c.label}: no popup semantics`);
    assert.doesNotMatch(c.html, /aria-expanded/, `${c.label}: no expanded state`);
    assert.doesNotMatch(c.html, /role="menu"/, `${c.label}: no menu`);
    assert.doesNotMatch(c.html, /m6 9 6 6 6-6/, `${c.label}: no chevron (ChevronDown path)`);
  }
  // The derivation agrees: the mounted component computes interactive=false off VIEW_SCOPED.
  assert.equal(scopeFor('/payer-intel', [...ALL_VIEWS], 'bxr').interactive, false);
  assert.equal(scopeFor('/payer-intel', [...ALL_VIEWS], 'bxr').active, 'bxr', 'and still states the carried scope');
});

test('ZERO-tenant (admissions_seat): renders NOTHING — no tenant scope means no tenant pill', () => {
  // allowedViewsFor returns [] for the seat by design; its only surface is cross-tenant. Any tenant
  // name would be a lie, and "Consolidated" would advertise a dashboard scope it does not have.
  assert.equal(render({ offered: [], active: null }), '');
  assert.equal(renderToStaticMarkup(<TenantScopeRailView active={null} />), '');
  assert.deepEqual(scopeFor('/payer-intel', [], undefined), { offered: [], active: null, interactive: false });
  assert.deepEqual(scopeFor('/dashboard', undefined, undefined), { offered: [], active: null, interactive: true });
});

test('the rail markup carries data-view, h-1, bg-[var(--entity-fill)] and aria-hidden', () => {
  const html = renderToStaticMarkup(<TenantScopeRailView active="indigo" />);
  assert.equal(html, '<div data-view="indigo" aria-hidden="true" class="h-1 w-full bg-[var(--entity-fill)]"></div>');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SOURCE CONTRACTS — what static markup cannot reach (the open menu, the handlers)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('options are next/link with prefetch={false}, NOT a bare <a> — a same-route ?view= change must stay a SOFT nav', () => {
  // A hard navigation would destroy the Billable Days panel's uploaded CSV corpus and unsaved
  // edits on a BXR → Indigo → BXR glance (billable-days/overrides.ts), and would make the
  // key={view} remount guard (billingAuditViewRemount.test.tsx) redundant. <Link> keeps a real
  // href for middle-click / new-tab AND soft-navigates on a plain click.
  assert.match(src, /import Link from 'next\/link'/);
  assert.match(src, /<Link[\s\S]{0,400}href=\{scopeHref\(pathname, search, v\)\}/);
  assert.match(src, /<Link[\s\S]{0,400}prefetch=\{false\}/, 'dynamic destinations — the viewport prefetch buys nothing');
  assert.doesNotMatch(src, /<a\s/, 'no bare anchor anywhere in the control');
});

test('menu semantics in source: role=menu, menuitemradio + aria-checked; the Escape and activation handlers call triggerRef.focus()', () => {
  assert.match(src, /role="menu"/);
  assert.match(src, /role="menuitemradio"/);
  assert.match(src, /aria-checked=\{checked\}/);
  assert.match(src, /aria-haspopup="menu"/);
  assert.match(src, /aria-expanded=\{open\}/);
  // ONE Escape path, at document level while open (the user-menu.tsx shape), closing and refocusing.
  assert.match(src, /document\.addEventListener\('keydown', onKey\)/, 'document-level keydown while open');
  assert.match(src, /e\.key !== 'Escape'\) return;\s*e\.preventDefault\(\);\s*setOpen\(false\);\s*triggerRef\.current\?\.focus\(\)/, 'Escape: close + refocus trigger');
  assert.doesNotMatch(src, /onKeyDown[\s\S]{0,600}e\.key === 'Escape'/, 'no second, per-element Escape path to drift from the first');
  // Activation: the option's onClick closes AND refocuses the trigger (I1 — else focus falls to <body>).
  assert.match(src, /function onActivate\(\) \{\s*setOpen\(false\);\s*triggerRef\.current\?\.focus\(\);/, 'activation refocuses');
  assert.match(src, /<Link[\s\S]{0,600}onClick=\{onActivate\}/, 'and the options use it');
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(src, new RegExp(`e\\.key === '${key}'`), `${key} handled in the menu`);
  }
  // Space activates a menuitemradio; a native anchor only activates on Enter (Qodo #344 f1). ONE path:
  // `.click()` re-enters the same onClick + next/link handler a pointer uses — nothing is duplicated.
  assert.match(
    src,
    /e\.key === ' '\) \{\s*e\.preventDefault\(\);\s*e\.currentTarget\.click\(\);\s*return;/,
    'Space → preventDefault + click() on the focused option',
  );
  // A navigation the menu did not initiate (back/forward) closes it: the component lives in the
  // persistent root layout, so `open` would otherwise survive the route change (Qodo #344 f2).
  assert.match(src, /useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[pathname, search\]\);/, 'a pathname or query change closes the menu');
  assert.match(src, /\{checked \? <Check/, 'the active option carries a check');
  // The focus-on-open effect acts on the closed→open TRANSITION only (M1): offeredViews returns a
  // fresh array each render, so an unguarded effect would re-fire on every upstream re-render.
  assert.match(src, /const justOpened = open && !wasOpen\.current;\s*wasOpen\.current = open;/, 'transition guard');
});

test('data-view is on the PILL, every menu OPTION, and the RAIL — never inherited', () => {
  // BrandTheme stamps <html data-view> on /dashboard* only; on /billing-audit an inheriting element
  // paints consolidated for every tenant (measured: rgb(95,191,168) vs rgb(192,160,240)). Each
  // element resolves --entity-fill from its own attribute.
  assert.match(src, /<button[\s\S]{0,200}data-view=\{active\}/, 'the trigger');
  assert.match(src, /<span data-view=\{active\} className=\{PILL\}/, 'the non-interactive span');
  assert.match(src, /<Link[\s\S]{0,400}data-view=\{v\}/, 'each option');
  assert.match(src, /<div data-view=\{active\} aria-hidden className="h-1 w-full bg-\[var\(--entity-fill\)\]"/, 'the rail');
  for (const v of ALL_VIEWS) {
    assert.match(globalsCss, new RegExp(`\\[data-view='${v}'\\][\\s\\S]{0,300}--entity-fill: var\\(--entity-${v}\\);`), `${v} resolves --entity-fill`);
  }
});

test('the ruled entity fills are declared verbatim, with ONE dark foreground', () => {
  // Ruled 2026-09-08: #5FBFA8 / #D4B36A / #C0A0F0 on ink900. #B08A3E rejected at 4.60:1 (0.10 margin).
  // Every candidate clearing every bar it can sit on used a DARK foreground — there is no white variant.
  assert.match(globalsCss, /--entity-consolidated: #5fbfa8;/);
  assert.match(globalsCss, /--entity-bxr: #d4b36a;/);
  assert.match(globalsCss, /--entity-indigo: #c0a0f0;/);
  assert.match(globalsCss, /--entity-on: #1b2b2a;/, 'ink900');
  assert.doesNotMatch(globalsCss, /--entity-[a-z]+: #b08a3e/i, 'the rejected brass must not come back');
  // And the control never reaches for --brand-ink or --brand-accent as its FILL.
  assert.doesNotMatch(src, /bg-\[var\(--brand-ink\)\]/, '--brand-ink is 1.35-1.65:1 on the bar');
  assert.doesNotMatch(src, /bg-\[var\(--brand-accent\)\]/, 'the accent trio has no common foreground');
});

test('a polite live region is declared, and its effect is gated on a change of the resolved view', () => {
  // Ported from TenantTabs (#338). Source contract only — what a screen reader says needs VoiceOver.
  assert.match(src, /aria-live="polite" aria-atomic="true" className="sr-only"/);
  assert.match(src, /announced\.current !== null && announced\.current !== active/, 'no announcement on first mount');
  assert.match(src, /\}, \[active\]\);/, 'keyed off the resolved view, so a back/forward change also fires it');
});

test('no class applies an /alpha modifier to a var() colour, and every --brand-*/--entity-* it reads is declared', () => {
  assert.doesNotMatch(src, /-\[var\(--[a-z0-9-]+\)\]\/\d+/, 'that shape emits NO rule — use a :root color-mix step');
  const declared = new Set([...globalsCss.matchAll(/^\s*(--(?:brand|entity)-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
  for (const m of src.matchAll(/var\((--(?:brand|entity)-[a-z0-9-]+)\)/g)) {
    assert.ok(declared.has(m[1]!), `${m[1]} is not declared in globals.css (would compute to transparent)`);
  }
});

test('the focus ring classes are WHITE with a bar-coloured offset — a --brand-ink ring measured 1.35-1.65:1 on the bar', () => {
  assert.match(src, /focus-visible:ring-2 focus-visible:ring-white/);
  assert.match(src, /focus-visible:ring-offset-2 focus-visible:ring-offset-\[var\(--brand-bar\)\]/);
});

test('transitions rely on the GLOBAL prefers-reduced-motion reset, which is pinned here as the mechanism', () => {
  assert.match(src, /transition-(?:colors|transform)/, 'the control does transition');
  assert.doesNotMatch(src, /motion-reduce:/, 'no per-component opt-out — globals.css says none is needed');
  assert.match(globalsCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}transition-duration:\s*0\.01ms\s*!important/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE INVARIANT — exactly one interactive writer of ?view=
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("⚠ exactly ONE 'use client' file writes ?view= in code — by .set(…'view'…) or a ?view= literal — with panel.tsx's FormData allowlisted", () => {
  // Ruled 2026-09-08. "Interactive writer" ≈ a client component that writes the param, so the scan
  // is: every 'use client' file, comments stripped, matched for a `.set(…'view'…)` call in ANY
  // spelling (params / searchParams / url.searchParams; single, double or backtick quotes) OR a
  // `?view=` / `&view=` literal. Two OTHER writer classes exist and are load-bearing — the page
  // files' server-side canonicalisation redirects and navHref's link forwarding — and neither is a
  // client component, so neither is scanned; they are deliberately not this invariant's subject.
  // ALLOWLIST: billing-audit/billable-days/panel.tsx does `fd.set('view', view)` — a FormData field
  // for a Server Action, not a URL write. Named here so the exemption is visible and singular.
  const ALLOW = new Set(['components/billing-audit/billable-days/panel.tsx']);
  const WRITE = /\.set\(\s*['"`]view['"`]|[?&]view=/;
  const hits: string[] = [];
  const allowedHits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== '.next') walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(name) || /\.test\./.test(name)) continue;
      const raw = readFileSync(p, 'utf8');
      if (!/^\s*['"]use client['"]/.test(raw)) continue;
      if (!WRITE.test(strip(raw))) continue;
      const rel = relative(appRoot, p);
      (ALLOW.has(rel) ? allowedHits : hits).push(rel);
    }
  };
  for (const d of ['components', 'lib', 'app']) walk(join(appRoot, d));
  assert.deepEqual(hits, ['components/nav/tenant-scope.tsx']);
  // The allowlist must still be EARNING its entry — if panel.tsx stops writing the field, drop it.
  assert.deepEqual(allowedHits, [...ALLOW], 'every allowlisted file still matches; prune stale entries');
});

test('the layout mounts the pill AND the rail from the same allowedViews, and no page mounts TenantTabs', () => {
  assert.match(layoutSrc, /<TenantScope allowedViews=\{allowedViews\} \/>/);
  assert.match(layoutSrc, /<TenantScopeRail allowedViews=\{allowedViews\} \/>/);
  assert.doesNotMatch(layoutSrc, /SwitcherTenantLogo allowedViews/, 'the redundant logo indicator is gone');
  for (const p of ['app/dashboard/page.tsx', 'app/dashboard/collections/page.tsx', 'app/billing-audit/page.tsx']) {
    const code = strip(readFileSync(join(appRoot, p), 'utf8'));
    assert.doesNotMatch(code, /<TenantTabs/, `${p} no longer renders the in-body row`);
    assert.doesNotMatch(code, /tenant-tabs'/, `${p} no longer imports it`);
  }
  assert.equal(existsSync(join(appRoot, 'components/dashboard/tenant-tabs.tsx')), false, 'the component is deleted');
  assert.equal(existsSync(join(appRoot, 'components/dashboard/switcher-tenant-logo.tsx')), false, 'and so is the logo indicator');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE AUTHORISED NEW COVERAGE — the collapse classes must EMIT (the .lg\:inline trap)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('SHIPPED CSS: the responsive collapse classes and the --entity-fill rules actually emit', (t) => {
  // ⚠ Tailwind emits only what it scans. Before this component existed, `.lg\:inline` and `.lg\:block`
  // had ZERO rules in the shipped stylesheet (no source used them), and a replica built on that CSS
  // rendered an ICON-ONLY pill at >=1024 — the exact failure the ruling forbids. This is the same
  // trap as `bg-[var(--x)]/N`: no tsc error, no build error, the element simply has no such style.
  // Reading the JSX cannot catch it; only the built output can. This is the FIRST test in the repo
  // to read `.next/`, so it SKIPS when no build is present rather than failing a fresh clone —
  // run `cd app && npm run build` and re-run `npm test` for it to bite. (No CI workflow runs this
  // suite at all — see the PR — so today it is a local tripwire by construction.)
  const cssDir = join(appRoot, '.next/static/css');
  if (!existsSync(cssDir)) return t.skip('no app/.next/static/css — run `cd app && npm run build` first');
  const css = readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(cssDir, f), 'utf8')).join('\n');
  assert.ok(css.length > 10_000, 'the shipped stylesheet is present and non-trivial');
  const count = (needle: string) => css.split(needle).length - 1;
  for (const cls of ['.lg\\:inline{display:inline}', '.lg\\:block{display:block}', '.lg\\:hidden{display:none}', '.lg\\:gap-3{gap:.75rem}']) {
    assert.ok(count(cls) >= 1, `${cls} must emit — an absent rule leaves the label hidden or the icon alone`);
  }
  assert.ok(count('background-color:var(--entity-fill)') >= 1, 'bg-[var(--entity-fill)] emits');
  assert.ok(count('color:var(--entity-on)') >= 1, 'text-[var(--entity-on)] emits');
  assert.ok(count('--entity-fill:var(--entity-bxr)') >= 1 || count('--entity-fill: var(--entity-bxr)') >= 1, 'the per-view token resolution ships');
});
