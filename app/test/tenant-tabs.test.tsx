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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE TREATMENT — source-level, because TenantTabs is a client component built on router hooks and
// cannot be rendered here. What is asserted is the CLASS CONTRACT, which is the part that silently
// regresses. jsdom is barred from this by CLAUDE.md anyway (no layout engine: no contrast, no
// target size — `getBoundingClientRect()` returns zeros), so the pixels stay browser-verified.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const rawSrc = readFileSync(join(here, '../components/dashboard/tenant-tabs.tsx'), 'utf8');
const globalsCss = readFileSync(join(here, '../app/globals.css'), 'utf8');

/**
 * COMMENT-STRIPPED, and that is a deliberate upgrade over how this file used to do it.
 *
 * The component's docblocks legitimately QUOTE the banned values (`border-line`, the accent-as-fill
 * hex, the old `/50` alpha) so they cannot come back — which means a naive `doesNotMatch` over the
 * raw file matches the DOCUMENTATION and fails for the wrong reason. The previous fix was to scope
 * each regex to a quoted class string on one line (`/'[^'\n]*…/`, using `[^'\n]` because `[^']`
 * matches newlines in JS and spanned from an unrelated quote into the comment). That worked but was
 * fragile per-assertion, and it punished writing the comment.
 *
 * Stripping is strictly stronger: the banned forms cannot be present in the analysed text at all,
 * so every guard below is checked against CODE only. Same technique as
 * brand-token-alpha.test.tsx's `strip`. Keep both regexes in the strip — block comments carry the
 * contrast tables, line comments carry the per-class rationale.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = strip(rawSrc);

test('the guard is analysing code, not prose', () => {
  // A stripped source that lost the JSX would make every assertion below vacuously pass. Two
  // sentinels: the component still exists, and the raw file still carries the docblock the stripped
  // one must NOT (i.e. strip actually did something).
  assert.match(src, /export function TenantTabs/, 'the component survived the strip');
  assert.match(src, /role="tablist"/, 'and so did its markup');
  assert.match(rawSrc, /border-line/, 'the raw file documents the banned token on purpose');
  assert.doesNotMatch(src, /border-line/, 'and the strip removed that documentation');
});

// ── The active state: a SOLID FILL (Alec, 2026-09-08) ───────────────────────────────────────────

test('the ACTIVE pill is a solid --brand-ink fill with a white label', () => {
  // The ask: the active tenant must read "as the winner from across the room, not as a tinted
  // sibling". A --brand-soft tint behind a stroke is a difference of degree; a solid fill is a
  // difference of kind. MEASURED fill-vs-white-label (WCAG AA text >=4.5:1):
  //   consolidated #135e5a 7.56 · bxr #1a1a2e 17.06 · indigo #5b2a9e 9.25 — all PASS.
  assert.match(
    src,
    /border-\[var\(--brand-ink\)\] bg-\[var\(--brand-ink\)\] font-semibold text-white/,
    'active = ink border + ink fill + semibold white label',
  );
  // The tint it replaced must not creep back as a "softer" active state.
  assert.doesNotMatch(src, /bg-\[var\(--brand-soft\)\]/, 'the --brand-soft active tint is gone');
});

test('⚠ --brand-accent is NOT the fill, and the arithmetic is why', () => {
  // The accent trio has no common foreground: teal #1c8b82 is 4.15:1 on white AND 3.55:1 on ink900
  // (fails BOTH), BXR gold #c8a24b is 2.41:1 on white, Indigo #7c3aed is 2.58:1 on ink900. Only
  // --brand-ink clears AA with ONE foreground across all three tenants. This is the same trap the
  // 2026-08-18 stroke hit; the obvious future "improvement" is to repoint the fill at the brighter
  // accent, so it is pinned as a ban rather than left to the comment.
  assert.doesNotMatch(src, /bg-\[var\(--brand-accent\)\]/, 'never the accent as a fill');
  assert.doesNotMatch(src, /border-\[var\(--brand-accent\)\] bg-/, 'nor as the active pair');
});

test('selection does not rest on colour alone (WCAG 1.4.1)', () => {
  // Three independent carriers, any one of which survives a colour-blind or greyscale reading:
  // the fill's luminance step, font-weight, and the always-present text label.
  assert.match(src, /font-semibold/, 'weight carries it');
  assert.match(src, /font-medium/, 'and the inactive weight differs');
  assert.match(src, /\{o\.label\}/, 'the full text label is ALWAYS rendered, never icon-only');
  assert.match(src, /aria-hidden/, 'the swatch is decorative — it is not the signal');
});

// ── The inactive state: transparent, hairline, NO TINT (ruled 2026-09-08) ───────────────────────

test('INACTIVE pills are transparent with an ink400 hairline and an ink600 label', () => {
  // ⚠ CONTRAST IS THE POINT, NOT THE STROKE — the 2026-08-18 lesson, unchanged. Measured on the
  // #FBF8F4 ground:  line #E4E9E6 1.16:1 FAIL (a border you cannot see) · brand-accent #c8a24b
  // 2.27:1 FAIL · ink400 #63756E 4.61:1 PASS (hairline) · ink600 #4A5C5A 6.68:1 PASS (label).
  assert.match(
    src,
    /border-ink400 bg-transparent font-medium text-ink600/,
    'inactive = ink400 hairline, transparent fill, ink600 label',
  );
  assert.doesNotMatch(src, /border-line\b/, 'the 1.16:1 invisible token must not come back');
});

test('hover strengthens the border and NEVER adds a tint or reduces contrast', () => {
  // "No tint" was explicit in the ruling: the inactive pill stays transparent in every state, so
  // hover moves the border and the label instead of washing --brand-soft behind them.
  assert.match(src, /hover:border-\[var\(--brand-ink\)\] hover:text-ink900/, 'hover deepens both');
  assert.doesNotMatch(src, /hover:bg-\[var\(--brand-soft/, 'no hover tint of any strength');
  // The pre-2026-08-18 hover border was FAINTER than the resting one — pointing at a tab made its
  // outline weaker. Kept as a named ban because it is a specific mistake that was actually made.
  assert.doesNotMatch(src, /hover:border-\[var\(--brand-accent\)\]/, 'nor the faint accent hover');
});

// ── Geometry ────────────────────────────────────────────────────────────────────────────────────

test('the hit target clears 44px (WCAG 2.5.5)', () => {
  // It measured ~40px until 2026-09-08 (`py-2` on a 15px label) — under the floor on every pointer
  // type, not just touch. `min-h` is a FLOOR, so `py-2` stays for the large-zoom case where the
  // label wraps and the natural height exceeds it.
  assert.match(src, /min-h-\[44px\]/, 'an explicit 44px floor on the shared base classes');
  assert.match(src, /rounded-lg border px-4 py-2/, 'hairline stroke on the shared base classes');
});

test('the 2px stroke became a hairline DELIBERATELY — and the 2026-08-18 ask is still met', () => {
  // That ask was *"put 2pt borders around … to make them more visible"*. The GOAL was visibility;
  // the 2026-09-08 ruling reassigns how it is carried — the active pill is a solid fill (louder
  // than any stroke could be) and the inactive ones were ruled a "hairline", which is 1px by
  // definition. So this is a supersession with the goal intact, not a silent revert, and a future
  // tidy-up that restores `border-2` has to be a decision.
  assert.doesNotMatch(src, /border-2/, 'no 2px stroke remains');
  // Two 2px strokes 4px apart read as one divided box; the gap that widened with the border stays.
  assert.match(src, /role="tablist"[\s\S]{0,120}gap-2"/);
});

// ── Theming: the attribute has to be on the pill ────────────────────────────────────────────────

test('⚠ data-view is on the PILL, not inherited from <html>', () => {
  // globals.css's `[data-view=…]` rules are BARE attribute selectors, so they set --brand-ink /
  // --brand-accent on whatever element carries the attribute. `BrandTheme` stamps `<html data-view>`
  // on /dashboard routes ONLY and deletes it elsewhere — so on /billing-audit, which has a real
  // `?view=` and its own two-tenant control, there is no ancestor to inherit from and every pill
  // would paint DEFAULT TEAL. This attribute is the whole reason the fill is tenant-coloured on all
  // three call sites, and it is one line away from being "cleaned up" as redundant.
  const button = src.slice(src.indexOf('<button'), src.indexOf('</button>'));
  assert.match(button, /data-view=\{o\.value\}/, 'the button element carries it');
  // And the tenant palette it reaches for must actually be declared for all three views.
  for (const v of ALL_VIEWS) {
    assert.match(globalsCss, new RegExp(`\\[data-view='${v}'\\][\\s\\S]{0,200}--brand-ink:`), `${v} declares --brand-ink`);
  }
});

test('no class applies an /alpha modifier to a var() colour — it emits NOTHING', () => {
  // Local echo of the repo-wide ban in brand-token-alpha.test.tsx, kept here because this file is
  // one of the five that carried a dead class before 2026-09-04: `bg-[var(--brand-accent)]/10` and
  // every class of that shape emit NO CSS RULE AT ALL, with no warning from tsc or next build.
  // Failing it HERE names the component, which is faster to act on than a repo-wide list.
  assert.doesNotMatch(src, /-\[var\(--[a-z0-9-]+\)\]\/\d+/, 'use a color-mix alpha step from :root');
  // Every --brand-* token referenced must be declared, or it emits a rule that computes transparent.
  for (const token of new Set([...src.matchAll(/var\((--brand-[a-z0-9-]+)\)/g)].map((m) => m[1]!))) {
    assert.match(globalsCss, new RegExp(`${token}\\s*:`), `${token} is declared in globals.css`);
  }
});

// ── The live region ─────────────────────────────────────────────────────────────────────────────

test('a polite live region announces the new tenant scope on change', () => {
  // These tabs NAVIGATE, so a screen-reader user got a route change with no spoken confirmation of
  // which tenant is now in scope — and tenant IS the scope here (a BXR figure read as Consolidated
  // is a wrong answer, not a wrong view).
  assert.match(src, /aria-live="polite"/, 'the region exists');
  assert.match(src, /aria-atomic="true"/, 'and is re-read whole, not diffed');
  assert.match(src, /className="sr-only"[\s\S]{0,40}\{announcement\}/, 'visually hidden, SR-visible');
  // Silent on a cold load: with no PREVIOUS view there has been no change to announce. The null
  // check is the whole mechanism — dropping it makes every page load speak.
  assert.match(src, /announced\.current !== null && announced\.current !== view/, 'change-only');
  // Keyed off the RESOLVED view rather than the click handler, so a browser back/forward that moves
  // `?view=` is announced too. `navigate` is not the only way the scope changes.
  assert.match(src, /useEffect\([\s\S]{0,400}\}, \[view\]\)/, 'the effect depends on `view`');
});

test('the live region cannot become a second flex item — the root is a FRAGMENT', () => {
  // The Collections header is a `justify-between` flex row and collections-header-row.test.tsx pins
  // that this component is an UNWRAPPED direct child of it: a wrapper div took the tablist's
  // max-content width and overflowed the document by 111px at a 390px viewport (WCAG 1.4.10), and
  // an EMPTY one held space-between's first slot and shoved the freshness line 1800px right.
  // A fragment emits no DOM node, so the tablist is still the direct flex item it was; `sr-only` is
  // position:absolute, so the span is not a flex item at all.
  assert.match(src, /return \(\s*<>/, 'the component returns a fragment, not a wrapper element');
  assert.doesNotMatch(src, /return \(\s*<div/, 'no wrapping div around the tablist + live region');
});

// ── Semantics + keyboard: UNCHANGED, and pinned so a restyle cannot quietly move them ──────────

test('the tablist semantics are exactly what they were', () => {
  // `aria-current="page"` and no `aria-controls`: these tabs navigate rather than reveal a panel on
  // the same page, so there is no tabpanel to point at and claiming one would be a lie.
  assert.match(src, /role="tablist" aria-label="Tenant"/);
  assert.match(src, /role="tab"/);
  assert.match(src, /aria-selected=\{active\}/);
  assert.match(src, /aria-current=\{active \? 'page' : undefined\}/);
  assert.doesNotMatch(src, /aria-controls/, 'still no panel to control');
  assert.match(src, /tabIndex=\{active \? 0 : -1\}/, 'roving tabindex: one tab stop');
});

test('the keyboard model is unchanged (Arrows wrap, Home, End)', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(src, new RegExp(`e\\.key === '${key}'`), `${key} still handled`);
  }
  assert.match(src, /e\.preventDefault\(\)/, 'and the arrow keys do not scroll the page');
});

test('a focus ring is visible on BOTH the dark active fill and the page ground', () => {
  // --brand-ink on a 2px offset: the offset gives a light gap against the dark active fill, and the
  // ring itself is 7.14:1 (teal) to 16.11:1 (BXR) against the #FBF8F4 ground. The offset is the
  // load-bearing half — without it the ring is ink-on-ink on the active pill and invisible.
  assert.match(src, /focus-visible:ring-2 focus-visible:ring-\[var\(--brand-ink\)\] focus-visible:ring-offset-2/);
  assert.match(src, /focus-visible:outline-none/, 'the UA outline is replaced, not merely hidden');
});

test('the transition respects prefers-reduced-motion via the GLOBAL reset', () => {
  // The component claims this in its docblock, so the mechanism is pinned rather than restated:
  // globals.css zeroes transition-duration on `*` under the OS setting. There is deliberately no
  // per-component `motion-reduce:` opt-out — globals.css says one is not needed, and adding one
  // here would imply the global reset does not cover this component.
  assert.match(src, /transition-colors/, 'the component does transition colour');
  assert.match(
    globalsCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}transition-duration:\s*0\.01ms\s*!important/,
    'and globals.css collapses every transition under the OS setting',
  );
});
