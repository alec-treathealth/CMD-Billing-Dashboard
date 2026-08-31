/**
 * QODO 2 — a manual override made on one week must not apply to any other week.
 *
 * Cell keys were `${rowId}:${day}` and week-status keys were a bare `rowId`, while `gotoWeek`
 * PRESERVES both maps across a week change on purpose. The two facts compose into the defect:
 * an edit made on Aug 10 also changed that client's Tuesday — and their week status — on every
 * other week in the export, and the recount, the "adjusted" badge and the override tally all
 * reported the phantom edit as real.
 *
 * Both halves are asserted: the override must NOT apply on the other week, and it MUST still
 * apply on its own. A key change that simply broke overrides would pass a one-sided test.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillableDaysGrid } from '../components/billing-audit/billable-days/grid';
import {
  adjustedBillableDays,
  cellKey,
  effectiveCodes,
  isApproximate,
  rowHasOverride,
  statusKey,
  type CellOverrides,
  type StatusOverrides,
} from '../components/billing-audit/billable-days/overrides';
import { SCOPE_BXR_A, SCOPE_BXR_B, VIEW_BXR, WEEK_A, WEEK_B, makeRow } from './helpers/billableDays';

const ROW = makeRow();
/** Tuesday (index 1) is empty in the fixture, so setting it to `G` moves the count 1 → 2. */
const TUESDAY = 1;
const editedOnA: CellOverrides = new Map([[cellKey(SCOPE_BXR_A, ROW.id, TUESDAY), ['G'] as readonly string[]]]);
const statusOnA: StatusOverrides = new Map([[statusKey(SCOPE_BXR_A, ROW.id), 'NEEDS BILLED' as const]]);

test('a cell override made on week A does not reach week B', () => {
  assert.deepEqual(
    effectiveCodes(ROW, TUESDAY, editedOnA, SCOPE_BXR_B),
    [],
    "week A's override is showing on week B's Tuesday",
  );
  assert.equal(rowHasOverride(ROW, editedOnA, SCOPE_BXR_B), false, 'week B claims an edit it never had');
});

test('the recount on week B is the ENGINE number, not week A’s adjusted one', () => {
  // The wrong value is 2 (1 engine day + the phantom Tuesday). Name it, so the assertion cannot
  // pass by the function happening to return something else that is also not 1.
  const wrong = ROW.billableDays + 1;
  const got = adjustedBillableDays(ROW, editedOnA, SCOPE_BXR_B);
  assert.notEqual(got, wrong, 'week B counted an override made on another week');
  assert.equal(got, ROW.billableDays);
});

test('a week STATUS set on week A does not reach week B', () => {
  assert.notEqual(statusKey(SCOPE_BXR_A, ROW.id), statusKey(SCOPE_BXR_B, ROW.id), 'both weeks share one status key');
  assert.equal(statusOnA.get(statusKey(SCOPE_BXR_B, ROW.id)), undefined, "week A's status is set on week B");
  assert.equal(statusOnA.get(statusKey(SCOPE_BXR_A, ROW.id)), 'NEEDS BILLED');
});

test('the override still applies on the week it was made on — the fix must not break editing', () => {
  assert.deepEqual(effectiveCodes(ROW, TUESDAY, editedOnA, SCOPE_BXR_A), ['G']);
  assert.equal(rowHasOverride(ROW, editedOnA, SCOPE_BXR_A), true);
  assert.equal(adjustedBillableDays(ROW, editedOnA, SCOPE_BXR_A), ROW.billableDays + 1);
});

test('the approximate marker is week-scoped too — an unedited week is not "≈"', () => {
  const multi = makeRow({ multiLoc: true });
  const ov: CellOverrides = new Map([[cellKey(SCOPE_BXR_A, multi.id, TUESDAY), ['G'] as readonly string[]]]);
  assert.equal(isApproximate(multi, ov, SCOPE_BXR_A), true);
  assert.equal(isApproximate(multi, ov, SCOPE_BXR_B), false, 'week B is labelled approximate over another week’s edit');
});

test('RENDERED: week B shows neither the override chip nor the "overridden" / "adjusted" labels', () => {
  const html = renderToStaticMarkup(
    <BillableDaysGrid
      rows={[ROW]}
      view={VIEW_BXR}
      weekStart={WEEK_B}
      phiIncluded={false}
      revealed={false}
      cellOv={editedOnA}
      statusOv={statusOnA}
      onSetCell={() => {}}
      onSetStatus={() => {}}
      onOpen={() => {}}
    />,
  );
  assert.equal(html.includes('>G<'), false, "week A's override code chip rendered on week B");
  assert.equal(html.includes('overridden'), false, 'week B marked a cell as overridden');
  assert.equal(html.includes('adjusted'), false, 'week B marked the row as adjusted');
  assert.equal(html.includes('NEEDS BILLED'), true, 'the status option list should still be present');
  // React emits `<option value="X" selected="">` for the controlled value — the exact string the
  // week-A case below proves is present, so its absence here is a real negative, not a typo.
  assert.equal(
    html.includes('<option value="NEEDS BILLED" selected'),
    false,
    "week A's status is selected on week B",
  );
});

test('RENDERED: week A shows the override, so the assertions above are not vacuous', () => {
  const html = renderToStaticMarkup(
    <BillableDaysGrid
      rows={[ROW]}
      view={VIEW_BXR}
      weekStart={WEEK_A}
      phiIncluded={false}
      revealed={false}
      cellOv={editedOnA}
      statusOv={statusOnA}
      onSetCell={() => {}}
      onSetStatus={() => {}}
      onOpen={() => {}}
    />,
  );
  assert.ok(html.includes('>G<'), 'the override chip is missing on the week it was made on');
  assert.ok(html.includes('overridden'), 'the overridden marker is missing on its own week');
  assert.ok(html.includes('adjusted'), 'the adjusted marker is missing on its own week');
  assert.ok(
    html.includes('<option value="NEEDS BILLED" selected'),
    'the week status is missing on the week it was set on',
  );
});
