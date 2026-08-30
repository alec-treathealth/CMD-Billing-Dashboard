/**
 * THE ENTITY AXIS — why `?view=` is NOT in the Billable Days override keys, held as a tripwire
 * rather than as a paragraph.
 *
 * ── THE FINDING ────────────────────────────────────────────────────────────────────────────
 * Override keys carry the week (Qodo 2) but not the entity. Row ids are per-import ORDINALS,
 * so an override that outlived an entity switch would not merely apply to the wrong week — it
 * would re-point at whoever occupies that ordinal under the other tenant, i.e. a different
 * person's billable days. That is strictly worse than the week case.
 *
 * ── WHY NO KEY CHANGE SHIPPED ──────────────────────────────────────────────────────────────
 * It cannot happen today, because the panel never survives an entity switch to see one. The
 * Claims Desk has NO in-place tenant control:
 *   · `?view=` is only ever rewritten by `TenantTabs` (`router.push(`${pathname}?…`)`), and
 *     `TenantTabs` is rendered by /dashboard and /dashboard/collections ONLY;
 *   · the root layout deliberately carries no switcher (removed 2026-08-18, "No dropdowns") —
 *     `SwitcherTenantLogo` is a read-only indicator with no router at all;
 *   · `NavLinks` forwards the CURRENT view onto other routes; it never changes it;
 *   · there is no `app/billing-audit/layout.tsx`, so nothing else wraps this route.
 * Changing entity therefore means navigating to /dashboard*, switching there, and coming back —
 * a route change, which unmounts the workbench and every piece of panel state with it.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────────────────────
 * That is a ROUTING fact, not a guarantee the component makes about itself. `panel.tsx`'s
 * non-BXR branch is an early RETURN that leaves all state intact, so the day a tenant control
 * lands on this route the defect activates silently, with no type error and no failing
 * assertion anywhere. This file is the assertion. If it fails, the premise is gone: add the
 * entity to `cellKey`/`statusKey` in `overrides.ts` (and to the panel's `open-drawer` scope)
 * rather than deleting the test.
 *
 * SOURCE-LEVEL by necessity — the claim is about which components exist on a route, which no
 * amount of rendering can observe. `tenant-tabs.test.tsx` uses the same style for the same reason.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(APP, rel), 'utf8');

/** Every source file that renders as part of the /billing-audit route, plus the root layout. */
function routeFiles(): string[] {
  const dirs = ['app/billing-audit', 'components/billing-audit', 'components/billing-audit/billable-days'];
  const out = ['app/layout.tsx'];
  for (const d of dirs) {
    const abs = path.join(APP, d);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(path.join(d, e.name));
    }
  }
  return out;
}

const FIX = 'If a tenant control now lives on this route, put the entity in cellKey/statusKey (overrides.ts).';

test('the Claims Desk route imports no TenantTabs — the only in-place ?view= control', () => {
  // Matched on the MODULE PATH, not the identifier: `app/layout.tsx` names `<TenantTabs>` in a
  // comment explaining where the switcher went, and a comment is not a render. A component can
  // only render it by importing it, so the import is the honest signal.
  for (const rel of routeFiles()) {
    assert.equal(
      /from\s+['"][^'"]*tenant-tabs['"]/.test(read(rel)),
      false,
      `${rel} imports TenantTabs. ${FIX}`,
    );
  }
});

test('nothing on the route links to /billing-audit with a DIFFERENT ?view=', () => {
  // A <Link> to the same pathname with another view would be a soft navigation: the page
  // re-renders with a new `view` prop and React keeps the panel MOUNTED, state and all. The one
  // ?view=-bearing href on this route points at /billing-audit/facility-resolution — a different
  // route — and forwards the CURRENT view rather than choosing one.
  //
  // The RBAC clamp redirect (`redirect(`/billing-audit?view=${view}`)`) is exempt and lines
  // carrying it are skipped: it runs on the SERVER before this page renders, and it fires only
  // to narrow an unentitled view back to an entitled one — it can never widen or switch entity.
  for (const rel of routeFiles()) {
    const offending = read(rel)
      .split('\n')
      .filter((line) => /['"`]\/billing-audit\?view=/.test(line) && !line.includes('redirect('));
    assert.deepEqual(offending, [], `${rel} links to this route with an explicit view. ${FIX}`);
  }
});

test('no file on the Claims Desk route navigates the router at all', () => {
  // A same-pathname `router.push('?view=…')` would change the entity WITHOUT unmounting, which
  // is the precise condition the key omission depends on not happening. Nothing on this route
  // uses the router today, so the flat ban is both true and the cheapest thing to keep true.
  for (const rel of routeFiles()) {
    const src = read(rel);
    assert.equal(/router\.(push|replace)\s*\(/.test(src), false, `${rel} navigates. ${FIX}`);
    assert.equal(/useRouter\s*\(/.test(src), false, `${rel} takes a router. ${FIX}`);
  }
});

test('the route has no layout of its own that could introduce one', () => {
  assert.equal(
    existsSync(path.join(APP, 'app/billing-audit/layout.tsx')),
    false,
    `a /billing-audit layout now exists and may render a tenant control. ${FIX}`,
  );
});

test('TenantTabs still lives only on the two /dashboard routes — the premise, stated positively', () => {
  // A negative-only proof would also pass if TenantTabs had been deleted or renamed, at which
  // point the reasoning above is stale for a different reason. Pin where it actually is.
  assert.ok(read('app/dashboard/page.tsx').includes('TenantTabs'));
  assert.ok(read('app/dashboard/collections/page.tsx').includes('TenantTabs'));
  assert.ok(
    read('components/dashboard/tenant-tabs.tsx').includes('router.push('),
    'TenantTabs no longer navigates — re-derive how ?view= changes before trusting this file',
  );
});

test('the panel still guards non-BXR by RETURNING, which is why the premise is load-bearing', () => {
  // The guard does not clear state; it renders instead of it. Recorded here so a reader of this
  // file can see why "the panel handles it" is not an answer.
  const src = read('components/billing-audit/billable-days/panel.tsx');
  assert.ok(src.includes("if (view !== 'bxr')"), 'the entity guard moved — re-derive this file');
  assert.equal(
    /view !== 'bxr'[\s\S]{0,400}dispatch\(/.test(src),
    false,
    'the guard now dispatches; if it clears state, this whole file can be simplified',
  );
});
