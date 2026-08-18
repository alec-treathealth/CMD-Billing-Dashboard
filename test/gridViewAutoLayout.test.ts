/**
 * STICKY COLUMNS — the reserved auto-saved layout (2026-08-17).
 *
 * Reported as "the column setting sticky and savable … doesn't work". The named-view stack was
 * verified HEALTHY against production first (the save_grid_view definer upserts on
 * (app_user_id, view_name); claims_reader holds EXECUTE on all four definers and SELECT — never
 * INSERT — on the table; RLS on with two policies; the default view applies on both the seeded and
 * the fetched mount). What was missing is that a column change lived in component state only.
 *
 * Production showed the shape of it exactly: ONE saved view, created_at = updated_at — the
 * save-a-named-view ritual performed once and abandoned.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_GRID_VIEW_NAME,
  deriveGridLayout,
  isAutoGridView,
} from '../src/collections/gridViewLayout.js';

const ALL = ['charge_date', 'payment_received', 'cpt_code', 'employer_name', 'charge_amount'];
const PHI = new Set(['patient_name']);

test('the reserved layout name is recognised, and ordinary names are not', () => {
  assert.equal(isAutoGridView(AUTO_GRID_VIEW_NAME), true);
  for (const n of ['alec', 'Auto', '__AUTO__', 'my __auto__ view', '']) {
    assert.equal(isAutoGridView(n), false, `${n} is a user view`);
  }
});

test('the reserved name is a legal view_name for the definer (1..80 chars)', () => {
  // save_grid_view raises check_violation outside that range, so a reserved name that failed the
  // length check would make every layout save throw — silently, since the client ignores the result.
  assert.ok(AUTO_GRID_VIEW_NAME.length >= 1 && AUTO_GRID_VIEW_NAME.length <= 80);
});

test('a layout saved before a column existed still shows that column', () => {
  // THE LIVE CASE, and the reason this is asserted rather than assumed: the production default view
  // was saved 2026-08-14 with 16 columns; migration 0101 added `employer_name` on 2026-08-15. If a
  // column added after a save were treated as hidden, Alec's own saved layout would permanently hide
  // the very column he was trying to search by.
  const saved = {
    columns: ['charge_date', 'payment_received', 'cpt_code', 'charge_amount'],
    hidden: ['charge_amount'],
  };
  const { order, hidden } = deriveGridLayout(saved, ALL, PHI);
  assert.ok(order.includes('employer_name'), 'the new column is in the order');
  assert.equal(hidden.has('employer_name'), false, 'and it is VISIBLE, not hidden');
  assert.equal(hidden.has('charge_amount'), true, 'the explicit hide still applies');
});

test('a LEGACY layout (hidden === null) still treats absence as hidden', () => {
  // 0046 semantics: membership was visibility. A new column is `missing` there too, so it lands in
  // the hidden set — correct for that format, and the reason the two cases must stay distinguished.
  const { order, hidden } = deriveGridLayout(
    { columns: ['charge_date', 'payment_received'], hidden: null },
    ALL,
    PHI,
  );
  assert.deepEqual(order.slice(0, 2), ['charge_date', 'payment_received']);
  assert.equal(hidden.has('cpt_code'), true, 'legacy: unmentioned means hidden');
});

test('a layout that hides everything falls back to showing everything', () => {
  // The auto-save writes whatever the user last had. A layout with no visible column would render an
  // empty grid with no way back, so the derivation refuses it.
  const { hidden } = deriveGridLayout({ columns: [...ALL], hidden: [...ALL] }, ALL, PHI);
  assert.equal(hidden.size, 0);
});
