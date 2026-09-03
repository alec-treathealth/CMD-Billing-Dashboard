/**
 * GROUPED-MODE SORT POLICY — the window cap on ordering groups by an aggregate.
 *
 * This module exists so ONE definition of the rule is imported by both the client (to enable or
 * disable a header control) and the Server Action (to clamp an untrusted request). These tests
 * therefore pin the RULE, not a rendering: if the two sides ever disagree about which orderings are
 * available, the header claims one ordering while the server applies another — and nothing errors.
 *
 * Why 90: ordering by the payment date is index-served and terminates early (~708 rows, ~87 groups,
 * 2.8 ms on BXR at 90d); ordering by a sum cannot terminate early and reads the whole window
 * (14,489 rows, 2,998 groups, 62 ms). Cost is flat in page depth and linear in window size —
 * measured on Consolidated at 10 / 74 / 207 / 402 / 724 ms for 7d / 30d / 90d / 180d / 1y. 90 caps
 * the worst case near 200 ms, and it is where the curve turns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUPED_AGG_SORT_MAX_WINDOW_DAYS,
  GROUPED_SORTABLE,
  customWindowDays,
  groupedSortAllowed,
  resolveGroupedSort,
} from '../src/collections/groupedSort.js';
import { businessWindowBounds } from '../src/businessWindow.js';
import { groupedSortStamp, resolveGroupedCursor } from '../src/collections/cmdExplorerQuery.js';

test('the payment date is orderable at EVERY window, including unresolved', () => {
  // It is a grouping key served by a matching index, so it never pays the aggregate cost. This is
  // the property that makes the clamp safe: there is always somewhere to fall back to.
  for (const days of [1, 7, 30, 90, 180, 365, 100_000, null]) {
    assert.equal(groupedSortAllowed('payment_received', days), true, `payment_received at ${days}`);
  }
});

test('the aggregate is orderable up to the cap and not past it', () => {
  for (const days of [1, 7, 14, 30, 89, 90]) {
    assert.equal(groupedSortAllowed('charge_amount', days), true, `charge_amount at ${days}d`);
  }
  for (const days of [91, 180, 365, 366]) {
    assert.equal(groupedSortAllowed('charge_amount', days), false, `charge_amount at ${days}d`);
  }
  // The boundary is inclusive, and it is the TAB'S DEFAULT WINDOW. A cap of 89 would disable the
  // feature in the state the tab opens in, which reads as broken rather than as a limit.
  assert.equal(GROUPED_AGG_SORT_MAX_WINDOW_DAYS, 90);
  assert.equal(groupedSortAllowed('charge_amount', GROUPED_AGG_SORT_MAX_WINDOW_DAYS), true);
  assert.equal(groupedSortAllowed('charge_amount', GROUPED_AGG_SORT_MAX_WINDOW_DAYS + 1), false);
});

test('an unresolved or nonsense window FAILS CLOSED', () => {
  // null is the state while a custom range is half-typed. NaN/Infinity cannot arrive from the
  // current callers, but a numeric comparison against them silently yields false either way — this
  // pins that the answer is "no", not "undefined behaviour".
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(groupedSortAllowed('charge_amount', bad as number | null), false, String(bad));
  }
});

test('only the two known columns are orderable at all', () => {
  assert.deepEqual([...GROUPED_SORTABLE].sort(), ['charge_amount', 'payment_received']);
  // Everything else is either an aggregate with no keyset path yet, or PHI that exists only as a
  // blind index. An unknown column must not fall through to the aggregate branch.
  for (const col of ['insurance_payments', 'allowed_amount', 'facility', 'patient_name', 'id', '', 'sum(x)']) {
    assert.equal(groupedSortAllowed(col, 7), false, col);
  }
});

test('resolveGroupedSort clamps to the payment date and KEEPS the direction', () => {
  // Direction survives for the same reason it survives the grouping toggle: asc/desc was an
  // intentional choice, and a window change is not a reason to discard it.
  assert.deepEqual(resolveGroupedSort('charge_amount', 'asc', 365), { column: 'payment_received', direction: 'asc' });
  assert.deepEqual(resolveGroupedSort('charge_amount', 'desc', 365), { column: 'payment_received', direction: 'desc' });
  // Inside the cap it passes through untouched.
  assert.deepEqual(resolveGroupedSort('charge_amount', 'asc', 90), { column: 'charge_amount', direction: 'asc' });
});

test('resolveGroupedSort narrows UNTRUSTED input — it crosses a Server Action boundary', () => {
  // The column arrives from the browser as a string. Anything unrecognised must degrade to the
  // default rather than reach an ORDER BY.
  for (const hostile of [undefined, '', 'charge_amount; drop table x', 'CHARGE_AMOUNT', 'g.charge_amount', '1']) {
    assert.equal(resolveGroupedSort(hostile, 'desc', 7).column, 'payment_received', String(hostile));
  }
  // A bad direction normalises rather than propagating.
  assert.equal(resolveGroupedSort('charge_amount', 'sideways' as 'asc', 7).direction, 'desc');
});

test('the clamp is idempotent — resolving twice changes nothing', () => {
  // The client derives the applied sort on every render; a non-idempotent clamp would make the
  // displayed ordering depend on how many times it had been recomputed.
  for (const days of [7, 90, 365, null]) {
    const once = resolveGroupedSort('charge_amount', 'asc', days);
    const twice = resolveGroupedSort(once.column, once.direction, days);
    assert.deepEqual(twice, once, `windowDays=${days}`);
  }
});

test('customWindowDays AGREES with the ops calendar, without importing it', () => {
  /*
   * THE DRIFT GUARD. `customWindowDays` exists only because the Collections client may not import
   * businessWindowBounds — that is the ops calendar, it reads a clock, and #304's rule is that the
   * client never derives the ops day (app/test/cmd-recency-default.test.tsx pins the import).
   * Having two implementations of "how wide is this range" is exactly the kind of duplication that
   * rots, so this asserts they produce the SAME number. The root suite is where that is legal.
   */
  for (const [from, to] of [
    ['2026-09-03', '2026-09-03'], // one day
    ['2026-09-01', '2026-09-07'],
    ['2026-06-04', '2026-09-02'],
    ['2026-01-01', '2026-12-31'],
    ['2025-12-28', '2026-01-04'], // year boundary
    ['2026-02-27', '2026-03-01'], // leap-adjacent
    ['2026-03-06', '2026-03-10'], // across a US DST transition
    ['2026-10-30', '2026-11-05'], // across the other one
  ] as const) {
    const mine = customWindowDays(from, to);
    const ops = businessWindowBounds({ kind: 'custom', from, to }).windowDays;
    assert.equal(mine, ops, `${from}..${to}`);
  }
});

test('customWindowDays refuses malformed, unreal and inverted ranges', () => {
  // Unreal dates must be REFUSED, not rolled forward — Date.parse turns 2026-02-30 into March 2nd,
  // which would silently measure a range the user never picked.
  assert.equal(customWindowDays('2026-02-30', '2026-03-05'), null, 'unreal date');
  assert.equal(customWindowDays('2026-13-01', '2026-13-02'), null, 'unreal month');
  assert.equal(customWindowDays('2026-9-3', '2026-09-05'), null, 'unpadded');
  assert.equal(customWindowDays('', ''), null, 'empty — the half-typed state');
  assert.equal(customWindowDays('not-a-date', '2026-09-05'), null);
  assert.equal(customWindowDays('2026-09-10', '2026-09-01'), null, 'inverted');
  // And every refusal reaches groupedSortAllowed as "too wide", i.e. fails closed.
  assert.equal(groupedSortAllowed('charge_amount', customWindowDays('2026-02-30', '2026-03-05')), false);
});

// ── The cursor must belong to the ordering that produced it (Qodo, PR #317) ─────────────────────
test('resolveGroupedCursor drops a cursor minted under a DIFFERENT ordering', () => {
  /*
   * A keyset cursor is only meaningful for the ordering that produced it. The client can briefly
   * offer a stale one: toggleSort changes the sort synchronously, while the effect that clears the
   * cursor list is passive and runs after paint.
   *
   * Measured consequence before this guard, both directions: Postgres RAISES rather than returning
   * wrong rows — `invalid input syntax for type numeric: "2026-09-02"` and `invalid input syntax
   * for type date: "83930.00"`. Never silent corruption, but a real error on a fast click.
   */
  const dateCur = { id: 10, value: '2026-09-02', sort: groupedSortStamp('payment_received', 'desc') };
  const amtCur = { id: 10, value: '83930.00', sort: groupedSortStamp('charge_amount', 'desc') };

  assert.equal(resolveGroupedCursor(dateCur, 'charge_amount', 'desc'), null, 'date cursor, total ordering');
  assert.equal(resolveGroupedCursor(amtCur, 'payment_received', 'desc'), null, 'total cursor, date ordering');
  // Matching orderings pass through unchanged.
  assert.deepEqual(resolveGroupedCursor(dateCur, 'payment_received', 'desc'), dateCur);
  assert.deepEqual(resolveGroupedCursor(amtCur, 'charge_amount', 'desc'), amtCur);
});

test('the stamp carries DIRECTION too — the one variant that would be silent', () => {
  // Flipping only the direction keeps the value type valid while reversing the comparison, so a
  // stale cursor skips or repeats groups WITHOUT erroring. The column alone cannot catch it.
  const cur = { id: 10, value: '83930.00', sort: groupedSortStamp('charge_amount', 'desc') };
  assert.equal(resolveGroupedCursor(cur, 'charge_amount', 'asc'), null, 'direction flip is a mismatch');
  assert.deepEqual(resolveGroupedCursor(cur, 'charge_amount', 'desc'), cur);
});

test('⚠ an UNSTAMPED cursor is still validated by its value shape', () => {
  /*
   * NOT REDUNDANT WITH THE STAMP, and dropping this would leave the bug open across a deploy:
   * cursors already sitting in a browser when this ships carry no stamp at all, so a stamp-only
   * check waves them through for as long as those tabs stay open. The shape check tests the value
   * itself — a date can never be a total, and a total can never be a date.
   */
  assert.equal(resolveGroupedCursor({ id: 1, value: '2026-09-02' }, 'charge_amount', 'desc'), null);
  assert.equal(resolveGroupedCursor({ id: 1, value: '83930.00' }, 'payment_received', 'desc'), null);
  // Correct pairings still work unstamped, so pagination survives the deploy itself.
  assert.ok(resolveGroupedCursor({ id: 1, value: '2026-09-02' }, 'payment_received', 'desc'));
  assert.ok(resolveGroupedCursor({ id: 1, value: '83930.00' }, 'charge_amount', 'desc'));
  assert.ok(resolveGroupedCursor({ id: 1, value: 83930 }, 'charge_amount', 'desc'), 'a numeric value is fine');
});

test('a NULL-value cursor is valid under either ordering', () => {
  // It addresses the trailing NULLS LAST block, which both orderings have.
  for (const col of ['payment_received', 'charge_amount'] as const) {
    assert.deepEqual(resolveGroupedCursor({ id: 3, value: null }, col, 'desc'), { id: 3, value: null });
  }
});

test('resolveGroupedCursor rejects junk values rather than passing them to a cast', () => {
  for (const v of ['', '   ', 'abc', '2026-9-2', 'NaN']) {
    assert.equal(resolveGroupedCursor({ id: 1, value: v }, 'charge_amount', 'desc'), null, `amount:${v}`);
  }
  for (const v of ['', 'abc', '2026-9-2', '20260902', '1']) {
    assert.equal(resolveGroupedCursor({ id: 1, value: v }, 'payment_received', 'desc'), null, `date:${v}`);
  }
  assert.equal(resolveGroupedCursor(null, 'charge_amount', 'desc'), null, 'null in, null out');
});
