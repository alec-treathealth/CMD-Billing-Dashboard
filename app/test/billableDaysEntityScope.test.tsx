/**
 * THE ENTITY AXIS — now IN the Billable Days override keys, and pinned as behaviour.
 *
 * ── WHAT THIS FILE USED TO SAY, AND WHY IT CHANGED ─────────────────────────────────────────
 * Until 2026-08-31 this file asserted the OPPOSITE: that the entity was deliberately absent
 * from the override keys, held safe by a ROUTING premise — the Claims Desk carried no in-place
 * tenant control, so `?view=` could only change via a route navigation to /dashboard*, which
 * unmounted the panel and took its state with it. Its own header said it "fails the day a
 * tenant control lands on this route."
 *
 * That day is today. `TenantTabs` now renders on /billing-audit, and the premise is gone —
 * `router.push('?view=…')` on the SAME pathname is a soft navigation, so the page re-renders
 * with a new `view` prop and React keeps the panel MOUNTED, both override maps included.
 *
 * ⚠ THE PREMISE WAS DISPROVED BY MEASUREMENT, NOT BY ARGUMENT, and the evidence is in this
 * repo rather than in framework documentation:
 *   · `cmd-explorer.tsx` (on /dashboard/collections, which has had the control all along) holds
 *     `const [prevView, setPrevView] = useState(view); if (view !== prevView) { …reset… }` and
 *     resets its refinement + facility/payer selections there. That is a SHIPPED fix for this
 *     exact class of defect, and it would be unreachable dead code if a view change remounted.
 *   · the same file puts `view` into an explicit `key=` on its AI panel to FORCE a remount —
 *     redundant if a view change already produced one.
 *   · `workbench.tsx` renders `<BillableDaysPanel view={view} …/>` with no `key`, so React
 *     reconciles it in place.
 *
 * ── WHY THE KEYS AND NOT A STATE RESET ─────────────────────────────────────────────────────
 * Resetting the import on an entity change (cmd-explorer's answer) would also close the hole,
 * and it was rejected: a biller who imports under BXR, glances at Indigo and comes back would
 * lose every unsaved override to a round trip that changed nothing. Scope-keyed entries survive
 * that trip AND stay isolated, which is strictly better. See `overrides.ts`.
 *
 * ── WHY THIS IS BEHAVIOUR NOW, WHERE IT USED TO BE SOURCE-LEVEL ────────────────────────────
 * The old claim was about which components exist on a route, which no amount of rendering can
 * observe — hence a source scan. The new claim is about what a key does, which is ordinary
 * executable behaviour. The two source-level pins that remain are the ones still genuinely
 * unobservable: that the control IS on the route, and that the grid derives its scope from
 * `view` rather than from the week alone.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  adjustedBillableDays,
  cellKey,
  effectiveCodes,
  rowHasOverride,
  statusKey,
  type CellOverrides,
  type StatusOverrides,
} from '../components/billing-audit/billable-days/overrides';
import {
  SCOPE_BXR_A,
  SCOPE_BXR_B,
  SCOPE_INDIGO_A,
  SCOPE_INDIGO_B,
  makeRow,
} from './helpers/billableDays';

const APP = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(APP, rel), 'utf8');

/** Tuesday (index 1) is empty in the fixture, so setting it to `G` moves a count 1 → 2. */
const TUESDAY = 1;

/**
 * THE CATASTROPHIC CASE, made concrete. Row ids are per-import ORDINALS (`row-0`), so the same
 * id denotes a DIFFERENT PERSON under a different tenant's import. `bxrClient` and `indigoClient`
 * share the ordinal and nothing else — different LOC, different engine count — which is exactly
 * the collision the entity half of the key exists to prevent.
 */
const bxrClient = makeRow({ id: 'row-0', loc: 'SYNTHETIC BXR IOP', billableDays: 1 });

/**
 * ⚠ INDIGO'S FIXTURE MUST BE INTERNALLY COHERENT OR THE LEAK ASSERTION GOES VACUOUS.
 * `adjustedBillableDays` RECOMPUTES from the days array when an override is present, so
 * `billableDays` has to equal the number of billable codes actually in `days` — otherwise the
 * "leaked" value named below is a number the function cannot return, and `notEqual` passes no
 * matter what. First draft set `billableDays: 3` on makeRow's default days (which carry exactly
 * ONE billable code), so the leak recomputed to 2 while the test asserted `!== 4`: inert.
 * Days 0/2/4 billable = 3, Tuesday deliberately EMPTY, capDays 5 for headroom so the recompute
 * is not capped before it reaches 4.
 */
const indigoBase = makeRow({ id: 'row-0', loc: 'SYNTHETIC INDIGO PHP', capDays: 5 });
const indigoClient = {
  ...indigoBase,
  billableDays: 3,
  days: indigoBase.days.map((d) => (d.i === 2 || d.i === 4 ? { ...d, codes: ['I'], hrs: 3 } : d)),
};

/** An edit a biller made while the BXR tab was active, on week A. */
const editedOnBxrA: CellOverrides = new Map([
  [cellKey(SCOPE_BXR_A, bxrClient.id, TUESDAY), ['G'] as readonly string[]],
]);
const statusOnBxrA: StatusOverrides = new Map([
  [statusKey(SCOPE_BXR_A, bxrClient.id), 'NEEDS BILLED' as const],
]);

test('an override made under BXR does not reach the SAME ORDINAL under Indigo', () => {
  // `leaked` is the value the REAL regression produces: drop the entity from the scope and the
  // BXR-written key collides with this lookup, so the recompute adds a phantom Tuesday to
  // Indigo's three engine days → 4. Verified reachable (capDays is 5, so nothing caps it first)
  // — that is what keeps this assertion live rather than vacuous. Asserted first, then the
  // untouched engine count, because each catches a different failure: a leak, and a drift.
  const leaked = indigoClient.billableDays + 1;
  const got = adjustedBillableDays(indigoClient, editedOnBxrA, SCOPE_INDIGO_A);
  assert.notEqual(got, leaked, "BXR's edit raised a different person's billable days under Indigo");
  assert.equal(got, indigoClient.billableDays, 'Indigo count drifted from the engine without an edit');
});

test("the leaked cell's CODES do not surface under Indigo either", () => {
  // adjustedBillableDays could be right while the grid still rendered the wrong codes in the
  // cell — the count and the cell read the map separately, so both need pinning.
  const codes = effectiveCodes(indigoClient, TUESDAY, editedOnBxrA, SCOPE_INDIGO_A);
  assert.equal(codes.includes('G'), false, "BXR's 'G' is rendered in Indigo's Tuesday cell");
  assert.deepEqual(codes, indigoClient.days[TUESDAY]!.codes, "Indigo's cell is not the engine's");
});

test('Indigo does not claim an edit it never had', () => {
  assert.equal(
    rowHasOverride(indigoClient, editedOnBxrA, SCOPE_INDIGO_A),
    false,
    'the "adjusted" badge would light on an untouched Indigo row',
  );
});

test("a week STATUS set under BXR does not apply to Indigo's same ordinal", () => {
  assert.equal(
    statusOnBxrA.get(statusKey(SCOPE_INDIGO_A, indigoClient.id)),
    undefined,
    "BXR's NEEDS BILLED is set on a different person under Indigo",
  );
  // And the entry it WAS set on is still there — a key change that isolated by losing the
  // override entirely would pass every assertion above.
  assert.equal(statusOnBxrA.get(statusKey(SCOPE_BXR_A, bxrClient.id)), 'NEEDS BILLED');
});

test('all four (entity, week) scopes are mutually distinct for one row and day', () => {
  // BOTH halves of the scope are load-bearing, so the honest claim is over the cross product,
  // not over either axis alone. Four scopes → four distinct keys, or some pair collides.
  const scopes = [SCOPE_BXR_A, SCOPE_BXR_B, SCOPE_INDIGO_A, SCOPE_INDIGO_B];
  const cells = scopes.map((s) => cellKey(s, 'row-0', TUESDAY));
  const statuses = scopes.map((s) => statusKey(s, 'row-0'));
  assert.equal(new Set(cells).size, 4, `cell keys collide across scopes: ${cells.join(' , ')}`);
  assert.equal(new Set(statuses).size, 4, `status keys collide across scopes: ${statuses.join(' , ')}`);
});

test('the BXR edit still works on its own scope — isolation is not achieved by dropping it', () => {
  assert.deepEqual(effectiveCodes(bxrClient, TUESDAY, editedOnBxrA, SCOPE_BXR_A), ['G']);
  assert.equal(rowHasOverride(bxrClient, editedOnBxrA, SCOPE_BXR_A), true);
  assert.equal(adjustedBillableDays(bxrClient, editedOnBxrA, SCOPE_BXR_A), bxrClient.billableDays + 1);
});

/* ---------------------------------------------------------------------------
 * The two source-level pins that remain — claims rendering cannot observe.
 * ------------------------------------------------------------------------- */

test('the tenant control IS on the Claims Desk route — the premise, stated positively', () => {
  // The inverse of what this file asserted before 2026-08-31. Pinned positively so a reader who
  // finds the header confusing can confirm which way round it is today, and so silently removing
  // the control (which would make the entity keys harmless but the header wrong) is visible.
  assert.match(
    read('app/billing-audit/page.tsx'),
    /from\s+['"][^'"]*tenant-tabs['"]/,
    'the Claims Desk no longer renders TenantTabs — re-read this file’s header before trusting it',
  );
});

test('the grid derives its override scope from `view`, not from the week alone', () => {
  // The wiring is what makes every behavioural test above reach production. A refactor that
  // dropped the `view` prop would leave these tests green (they call the functions directly)
  // while the grid silently wrote week-only keys again.
  const src = read('components/billing-audit/billable-days/grid.tsx');
  assert.match(src, /overrideScope\(view, weekStart\)/, 'the grid no longer scopes keys by entity');
  assert.match(
    read('components/billing-audit/billable-days/panel.tsx'),
    /view=\{view\}/,
    'the panel no longer passes `view` to the grid, so the grid cannot scope by entity',
  );
});
