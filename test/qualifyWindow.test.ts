/**
 * QualifyWindow (redesign) — the calendar Month/Year shapes + serialization. Pins:
 *   1) month bounds are [1st, 1st-of-next) with the PREVIOUS MONTH as the prior window (the ruled
 *      Δ semantics — previous equivalent period, NOT prior-year-same-month);
 *   2) year bounds are [Jan 1, Jan 1) with the previous year prior; December/January roll over;
 *   3) serialize/parse round-trip for every shape; malformed/out-of-range parse → null (fail closed);
 *   4) isQualifyWindow validates structure + ranges at the trust boundary (rolling 180/270/365 =
 *      6/9/12mo are VALID; quick pills stay 30/60/90; day-counts off the allowed set fail closed).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isQualifyWindow,
  parseQualifyWindow,
  serializeQualifyWindow,
  qualifyWindowBounds,
  qualifyWindowLabel,
  qualifyRollingLabel,
  qualifyBusinessDayIso,
  trailingWindow,
  QUALIFY_WINDOW_OPTIONS,
  QUALIFY_ROLLING_OPTIONS,
} from '../app/lib/qualify/contract.js';

const NOW = new Date('2026-07-17T12:00:00Z');

test('month bounds: [1st, 1st-of-next) with the PREVIOUS month as prior', () => {
  const b = qualifyWindowBounds({ kind: 'month', year: 2026, month: 7 }, NOW);
  assert.deepEqual(b, { from: '2026-07-01', to: '2026-08-01', priorFrom: '2026-06-01', priorTo: '2026-07-01' });
});

test('month bounds: December rolls into January; January priors into December of the previous year', () => {
  const dec = qualifyWindowBounds({ kind: 'month', year: 2025, month: 12 }, NOW);
  assert.deepEqual(dec, { from: '2025-12-01', to: '2026-01-01', priorFrom: '2025-11-01', priorTo: '2025-12-01' });
  const jan = qualifyWindowBounds({ kind: 'month', year: 2026, month: 1 }, NOW);
  assert.deepEqual(jan, { from: '2026-01-01', to: '2026-02-01', priorFrom: '2025-12-01', priorTo: '2026-01-01' });
});

test('year bounds: [Jan 1, Jan 1) with the previous year as prior', () => {
  const b = qualifyWindowBounds({ kind: 'year', year: 2026 }, NOW);
  assert.deepEqual(b, { from: '2026-01-01', to: '2027-01-01', priorFrom: '2025-01-01', priorTo: '2026-01-01' });
});

test('trailing bounds are unchanged by the refactor (business-TZ anchored, adjacent prior)', () => {
  const b = qualifyWindowBounds(trailingWindow(30), NOW);
  // 2026-07-17T12:00Z is 2026-07-17 in America/Los_Angeles → to = 07-18 (exclusive), from = 06-18.
  assert.equal(b.to, '2026-07-18');
  assert.equal(b.from, '2026-06-18');
  assert.equal(b.priorTo, b.from, 'prior window is adjacent');
});

test('serialize/parse round-trips every shape; labels are human', () => {
  const shapes = [trailingWindow(60), trailingWindow(180), trailingWindow(365), { kind: 'month' as const, year: 2026, month: 7 }, { kind: 'year' as const, year: 2025 }];
  for (const w of shapes) {
    assert.deepEqual(parseQualifyWindow(serializeQualifyWindow(w)), w, `round-trip ${serializeQualifyWindow(w)}`);
  }
  assert.equal(serializeQualifyWindow(trailingWindow(60)), '60d');
  assert.equal(serializeQualifyWindow(trailingWindow(365)), '365d', 'rolling spans serialize as day-count tokens');
  assert.equal(serializeQualifyWindow({ kind: 'month', year: 2026, month: 7 }), '2026-07');
  assert.equal(qualifyWindowLabel({ kind: 'month', year: 2026, month: 7 }), 'Jul 2026');
  assert.equal(qualifyWindowLabel(trailingWindow(90)), '90d');
  // Rolling spans: compact chip label is months; menu label is "Last N months"; day-token round-trips.
  assert.equal(qualifyWindowLabel(trailingWindow(180)), '6mo');
  assert.equal(qualifyWindowLabel(trailingWindow(365)), '12mo');
  assert.deepEqual(parseQualifyWindow('180d'), trailingWindow(180), '180d now parses (rolling 6-month)');
  assert.equal(qualifyRollingLabel(180), 'Last 6 months');
  assert.equal(qualifyRollingLabel(365), 'Last 12 months');
});

test('parse fails CLOSED on malformed / out-of-range tokens (never trusts the URL)', () => {
  for (const bad of ['15d', '200d', '2026-13', '2026-00', '1999-05', '2099', 'abc', '', '30', '30d; drop table x']) {
    assert.equal(parseQualifyWindow(bad), null, `"${bad}" must not parse`);
  }
  assert.equal(parseQualifyWindow(null), null);
  assert.equal(parseQualifyWindow(undefined), null);
});

test('isQualifyWindow: structural + range validation; rolling 6/9/12mo valid; junk objects fail', () => {
  assert.equal(isQualifyWindow(trailingWindow(30)), true);
  assert.equal(isQualifyWindow({ kind: 'trailing', days: 180 }), true, '6-month rolling is valid');
  assert.equal(isQualifyWindow({ kind: 'trailing', days: 365 }), true, '12-month rolling is valid');
  assert.equal(isQualifyWindow({ kind: 'trailing', days: 200 }), false, 'a day-count off the allowed set fails closed');
  assert.equal(isQualifyWindow({ kind: 'month', year: 2026, month: 7 }), true);
  assert.equal(isQualifyWindow({ kind: 'month', year: 2026, month: 13 }), false);
  assert.equal(isQualifyWindow({ kind: 'month', year: 2023, month: 5 }), false, 'below the data floor');
  assert.equal(isQualifyWindow({ kind: 'year', year: 2026 }), true);
  assert.equal(isQualifyWindow({ kind: 'year', year: 2036 }), false, 'beyond the forward cap');
  assert.equal(isQualifyWindow(30), false, 'the old bare-number shape no longer validates');
  assert.equal(isQualifyWindow(null), false);
  assert.equal(isQualifyWindow({ kind: 'nope' }), false);
  assert.deepEqual([...QUALIFY_WINDOW_OPTIONS], [30, 60, 90], 'quick pills stay 30/60/90');
  assert.deepEqual([...QUALIFY_ROLLING_OPTIONS], [180, 270, 365], 'rolling menu = 6/9/12 months');
});

// ── qualifyBusinessDayIso — THE shared "today" anchor (audit 2026-08-12, P1-1) ───────────────────
// Vercel runs TZ=UTC; from ~afternoon-to-midnight Pacific the raw UTC date is already tomorrow. The
// v3 resolve and the tape context used to anchor on the UTC slice while qualifyWindowBounds anchored
// in business TZ, so the resolution evidence and the ranking beside it described different day
// ranges for that whole stretch. These pins are the regression tripwire for any new anchor.

test('businessDayIso: a UTC timestamp past midnight is STILL the previous Pacific day (PDT, UTC-7)', () => {
  // 2026-08-13T03:00Z = 2026-08-12 20:00 PDT — the exact evening stretch the audit flagged.
  assert.equal(qualifyBusinessDayIso(new Date('2026-08-13T03:00:00Z')), '2026-08-12');
  // 06:59Z is 23:59 PDT (still the 12th); 07:01Z crosses Pacific midnight.
  assert.equal(qualifyBusinessDayIso(new Date('2026-08-13T06:59:00Z')), '2026-08-12');
  assert.equal(qualifyBusinessDayIso(new Date('2026-08-13T07:01:00Z')), '2026-08-13');
});

test('businessDayIso: winter (PST, UTC-8) shifts the boundary to 08:00Z — DST is handled by the zone, not hardcoded', () => {
  assert.equal(qualifyBusinessDayIso(new Date('2026-01-15T07:59:00Z')), '2026-01-14');
  assert.equal(qualifyBusinessDayIso(new Date('2026-01-15T08:01:00Z')), '2026-01-15');
});

test('businessDayIso agrees with the trailing-window anchor: bounds.to is ALWAYS business-today + 1', () => {
  for (const iso of ['2026-08-13T03:00:00Z', '2026-08-12T18:00:00Z', '2026-01-15T07:59:00Z']) {
    const now = new Date(iso);
    const day = qualifyBusinessDayIso(now);
    const b = qualifyWindowBounds(trailingWindow(30), now);
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.equal(b.to, next.toISOString().slice(0, 10), `${iso}: one anchor, every surface`);
  }
});
