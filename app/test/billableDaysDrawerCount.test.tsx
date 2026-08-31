/**
 * QODO 8 — the drawer header and the grid row must show ONE billable-day count for a client.
 *
 * The grid renders `adjustedBillableDays(...)`; the drawer header rendered `r.billableDays`
 * unconditionally. After a manual edit the same client's week therefore had two totals on
 * screen, and the drawer's was the one a biller would trust — it sits directly under the
 * client's name, where a header number reads as the authoritative figure.
 *
 * ⚠ THE COUNT LOGIC IS NOT UNDER TEST HERE, ON PURPOSE. Qodo 3 (the BPS-outside-the-cap clamp
 * in `adjustedBillableDays`) is a SEPARATE finding and is sequenced separately. These tests
 * assert only that both surfaces read the SAME function; the expected value is computed by
 * calling it, never by restating what it should return. If `adjustedBillableDays` changes,
 * these tests follow it rather than fighting it.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillableDaysDrawer } from '../components/billing-audit/billable-days/drawer';
import { BillableDaysGrid } from '../components/billing-audit/billable-days/grid';
import {
  adjustedBillableDays,
  cellKey,
  isApproximate,
  type CellOverrides,
} from '../components/billing-audit/billable-days/overrides';
import { SCOPE_BXR_A, VIEW_BXR, WEEK_A, makeRow } from './helpers/billableDays';

const TUESDAY = 1;

/** Renders the drawer exactly as the panel does — the count comes from the shared function. */
function drawerHtml(row: ReturnType<typeof makeRow>, ov: CellOverrides): string {
  return renderToStaticMarkup(
    <BillableDaysDrawer
      target={{ row, dayIndex: 0 }}
      billableDays={adjustedBillableDays(row, ov, SCOPE_BXR_A)}
      approximate={isApproximate(row, ov, SCOPE_BXR_A)}
      phiIncluded={false}
      revealed={false}
      onClose={() => {}}
    />,
  );
}

function gridHtml(row: ReturnType<typeof makeRow>, ov: CellOverrides): string {
  return renderToStaticMarkup(
    <BillableDaysGrid
      rows={[row]}
      view={VIEW_BXR}
      weekStart={WEEK_A}
      phiIncluded={false}
      revealed={false}
      cellOv={ov}
      statusOv={new Map()}
      onSetCell={() => {}}
      onSetStatus={() => {}}
      onOpen={() => {}}
    />,
  );
}

test('an EDITED row shows the adjusted count in the drawer, and never the pre-edit one', () => {
  const row = makeRow();
  const ov: CellOverrides = new Map([[cellKey(SCOPE_BXR_A, row.id, TUESDAY), ['G'] as readonly string[]]]);
  const adjusted = adjustedBillableDays(row, ov, SCOPE_BXR_A);
  // The fixture exists to make these differ; if they ever stop differing the test proves nothing.
  assert.notEqual(adjusted, row.billableDays, 'fixture no longer produces a changed count');

  const html = drawerHtml(row, ov);
  assert.equal(
    html.includes(`${row.billableDays}/${row.capDays} billable days`),
    false,
    'the drawer is still showing the engine count for an edited row',
  );
  assert.ok(
    html.includes(`${adjusted}/${row.capDays} billable days`),
    'the drawer is not showing the adjusted count',
  );
});

test('the grid row shows that SAME number — the two surfaces cannot disagree', () => {
  const row = makeRow();
  const ov: CellOverrides = new Map([[cellKey(SCOPE_BXR_A, row.id, TUESDAY), ['G'] as readonly string[]]]);
  const adjusted = adjustedBillableDays(row, ov, SCOPE_BXR_A);

  const grid = gridHtml(row, ov);
  // The grid's Days cell renders `<adjusted> / <cap>` across two spans, with the pre-edit number
  // surviving only inside the "was N" tooltip — so match the cell, not a bare digit.
  assert.ok(
    grid.includes(`>${adjusted}</span>`),
    'the grid row is not showing the adjusted count',
  );
  assert.ok(grid.includes('adjusted'), 'the grid did not mark the row as edited');
  assert.ok(drawerHtml(row, ov).includes(`${adjusted}/${row.capDays} billable days`));
});

test('an UN-edited row is unchanged in both surfaces — the fix must not move a clean row', () => {
  const row = makeRow();
  const none: CellOverrides = new Map();
  assert.ok(drawerHtml(row, none).includes(`${row.billableDays}/${row.capDays} billable days`));
  assert.equal(
    drawerHtml(row, none).includes('≈'),
    false,
    'an un-edited row was marked approximate',
  );
  assert.equal(gridHtml(row, none).includes('adjusted'), false);
});

test('the approximate marker carries into the drawer, with the same glyph the grid uses', () => {
  const row = makeRow({ multiLoc: true });
  const ov: CellOverrides = new Map([[cellKey(SCOPE_BXR_A, row.id, TUESDAY), ['G'] as readonly string[]]]);
  assert.equal(isApproximate(row, ov, SCOPE_BXR_A), true, 'fixture is no longer multi-LOC');

  const html = drawerHtml(row, ov);
  assert.ok(html.includes('≈'), 'the drawer dropped the approximate marker the grid shows');
  assert.ok(gridHtml(row, ov).includes('≈'), 'the grid dropped its own approximate marker');
});
