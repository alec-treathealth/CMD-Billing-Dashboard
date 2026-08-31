/**
 * The Collections date-window control — the SQL + bounds contract.
 *
 * Hermetic: node:test only, no DB, no clock the test does not inject. Everything here asserts the
 * builder's emitted SQL and the primitive's bounds; the React half is asserted separately.
 *
 * WHAT THIS FILE IS DEFENDING. Before 2026-08-30 the Collections window was:
 *   · anchored on the RAW UTC clock, so from ~17:00 Pacific it was a day ahead of the ops calendar;
 *   · OPEN-ENDED — the recency branch set only `from` and returned early, so every preset was
 *     `today-N .. ∞` and silently swept in 106 future-dated charges as if they were settled cash;
 *   · expressible two ways (recency chips AND a month/year picker) for one calendar month.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessDayIso,
  businessDayPlus,
  businessWindowBounds,
} from '../src/businessWindow.js';
import {
  buildCmdExplorerQuery,
  buildCmdExplorerGroupedQuery,
  buildCmdSearchSummaryQueries,
  cmdExplorerBaseConds,
  type CmdExplorerFilter,
  type ParamAdder,
} from '../src/collections/cmdExplorerQuery.js';
import { FUTURE_PAYMENT_HORIZON_DAYS } from '../src/collections/cmdExplorer.js';

const ENTITY = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088'];
const SORT = { column: 'payment_received', direction: 'desc' } as const;
/** 19:00 PDT on 2026-08-30 — UTC has already rolled to 08-31. The adversarial instant. */
const NOW = new Date('2026-08-31T02:00:00Z');

const daysApart = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ── PRESETS RESOLVE TO EXACTLY N DAYS ──────────────────────────────────────────────────────────
test('every preset is EXACTLY N days, not N+1 and not open-ended', () => {
  for (const days of [7, 14, 30, 90, 180, 365]) {
    const b = businessWindowBounds({ kind: 'trailing', days }, NOW);
    assert.equal(daysApart(b.from, b.to), days, `${days}d must span ${days} days`);
    assert.equal(b.windowDays, days);
  }
});

test('the window anchors on the OPS day even when UTC has already rolled', () => {
  // The failure this replaces: `new Date().toISOString()` at 19:00 PDT reads 2026-08-31.
  assert.equal(businessDayIso(NOW), '2026-08-30');
  assert.equal(businessWindowBounds({ kind: 'trailing', days: 30 }, NOW).to, '2026-08-31');
});

// ── THE DEFAULT UPPER BOUND EXCLUDES TOMORROW ──────────────────────────────────────────────────
test('default upper bound EXCLUDES a row dated business-today + 1', () => {
  // `to` is exclusive, so a charge dated business-today+1 is out. This is the whole of W3: 106 such
  // rows exist today and were silently inside every preset's totals.
  const b = businessWindowBounds({ kind: 'trailing', days: 90 }, NOW);
  const tomorrow = businessDayPlus(1, NOW);
  assert.equal(b.to, tomorrow);
  assert.ok(tomorrow >= b.to, 'a row dated business-today+1 sits AT the exclusive bound, so it is out');
  assert.equal(b.to, '2026-08-31');
});

test('"Include scheduled" extends the upper bound to the ingest horizon — and only the bound', () => {
  // horizon + 1 because the window is half-open and the horizon day itself must be INCLUDED.
  const scheduledTo = businessDayPlus(FUTURE_PAYMENT_HORIZON_DAYS + 1, NOW);
  assert.equal(scheduledTo, '2026-09-14');
  const b = businessWindowBounds({ kind: 'trailing', days: 90 }, NOW);
  assert.ok(scheduledTo > b.to, 'the toggle must actually reach further');
  // ⚠ AND THE WINDOW ITSELF IS UNCHANGED. windowDays stays 90, never 104 — 104 would cross
  // windowAgeMultiplier's <=90 → <=180 edge when Qualify adopts this primitive.
  assert.equal(b.windowDays, 90);
});

test('a row beyond the horizon is excluded either way', () => {
  const beyond = businessDayPlus(FUTURE_PAYMENT_HORIZON_DAYS + 1, NOW); // 2026-09-14, the exclusive bound
  const rowAtDay15 = businessDayPlus(15, NOW);
  assert.equal(rowAtDay15, '2026-09-14');
  assert.ok(rowAtDay15 >= beyond, 'business-today + 15 sits at/after the scheduled bound — excluded');
  const dflt = businessWindowBounds({ kind: 'trailing', days: 90 }, NOW).to;
  assert.ok(rowAtDay15 >= dflt, 'and it is far outside the default bound too');
});

// ── THE SQL IS CLOSED AT BOTH ENDS, ALWAYS ─────────────────────────────────────────────────────
test('the Collections builders emit BOTH bounds, unconditionally', () => {
  const b = businessWindowBounds({ kind: 'trailing', days: 90 }, NOW);
  for (const { sql } of [
    buildCmdExplorerQuery(null, { from: b.from, to: b.to }, SORT, 50, ENTITY),
    buildCmdExplorerGroupedQuery(null, { from: b.from, to: b.to }, 'desc', 50, ENTITY),
  ]) {
    assert.match(sql, /payment_received >= \$\d+::date/);
    assert.match(sql, /payment_received < \$\d+::date/);
  }
});

test('an OPEN-ENDED Collections window THROWS — it can no longer be expressed', () => {
  // Fail loud, not fail open. Without this the failure is invisible: a grid quietly returning more
  // rows than it should, which is exactly how the 106 future-dated charges went unnoticed.
  const add: ParamAdder = (v) => `$${v === undefined ? 0 : 1}`;
  assert.throws(
    () => cmdExplorerBaseConds({ from: '2026-06-01' }, ENTITY, add, { requireWindow: true }),
    /must be closed/,
  );
  assert.throws(
    () => cmdExplorerBaseConds({ to: '2026-08-31' }, ENTITY, add, { requireWindow: true }),
    /must be closed/,
  );
  assert.throws(
    () => cmdExplorerBaseConds({}, ENTITY, add, { requireWindow: true }),
    /must be closed/,
  );
});

test('Qualify and Payer Intel are UNAFFECTED — the default still allows a partial window', () => {
  // requireWindow is opt-in for the same reason resolveFacility is: these conds are shared, and
  // flipping the default would change two surfaces that have their own window semantics.
  const params: unknown[] = [];
  const add: ParamAdder = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = cmdExplorerBaseConds({ from: '2026-06-01' }, ENTITY, add).join(' and ');
  assert.match(conds, /payment_received >= \$\d+::date/);
  assert.doesNotMatch(conds, /payment_received < /, 'no upper bound is invented for other callers');
});

// ── is_scheduled ───────────────────────────────────────────────────────────────────────────────
test('is_scheduled is projected in BOTH modes, outside the paged subquery', () => {
  const b = businessWindowBounds({ kind: 'trailing', days: 90 }, NOW);
  const filter = { from: b.from, to: b.to, businessToday: businessDayIso(NOW) };

  const row = buildCmdExplorerQuery(null, filter, SORT, 50, ENTITY);
  assert.match(row.sql, /coalesce\(p\.payment_received > \$\d+, false\) as is_scheduled/);
  const grouped = buildCmdExplorerGroupedQuery(null, filter, 'desc', 50, ENTITY);
  assert.match(grouped.sql, /coalesce\(g\.payment_received > \$\d+, false\) as is_scheduled/);

  // ⚠ THE PLACEMENT IS THE PERFORMANCE CONTRACT. It must sit in the OUTER query, against the
  // already-projected text date. Inside the paged subquery it would widen a pre-LIMIT sort that
  // already spills on the consolidated scope.
  for (const { sql } of [row, grouped]) {
    const inner = sql.slice(sql.indexOf('from ('), sql.indexOf(sql.includes(') p left join') ? ') p left join' : ') g left join'));
    assert.doesNotMatch(inner, /is_scheduled/, 'must not appear inside the paged subquery');
  }
  assert.ok(row.params.includes('2026-08-30'), 'the anchor is BOUND, never interpolated');
});

test('is_scheduled projects literal false when no business day was resolved', () => {
  // Required, not optional, on the row type — an ABSENT field arrives as `undefined`, and
  // `undefined !== null` is the trap. False is the honest value for a caller with no anchor.
  const { sql } = buildCmdExplorerQuery(null, { from: '2026-06-01', to: '2026-08-31' }, SORT, 50, ENTITY);
  assert.match(sql, /false as is_scheduled/);
});

// ── CUSTOM RANGE ───────────────────────────────────────────────────────────────────────────────
test('custom range: a calendar month reproduces the retired month/year picker exactly', () => {
  // THE TEST THAT LICENSES W6. The old picker emitted from='2026-03-01', to='2026-04-01' for
  // March. A custom range of 2026-03-01..2026-03-31 must produce the identical predicate.
  const b = businessWindowBounds({ kind: 'custom', from: '2026-03-01', to: '2026-03-31' }, NOW);
  assert.equal(b.from, '2026-03-01');
  assert.equal(b.to, '2026-04-01', 'the exclusive upper bound the old picker computed as month+1');
  assert.equal(b.windowDays, 31);
});

test('custom range: the 366-day cap is a PRODUCT rule, enforced above the primitive', () => {
  // The primitive represents a two-year range perfectly well — it is Collections that refuses it.
  const twoYears = businessWindowBounds({ kind: 'custom', from: '2024-01-01', to: '2025-12-31' }, NOW);
  assert.equal(twoYears.windowDays, 731, 'the primitive has no opinion about span');
  // 366 is accepted (a full leap year must be expressible); 367 is not.
  assert.equal(businessWindowBounds({ kind: 'custom', from: '2028-01-01', to: '2028-12-31' }, NOW).windowDays, 366);
  assert.equal(businessWindowBounds({ kind: 'custom', from: '2026-01-01', to: '2027-01-02' }, NOW).windowDays, 367);
});

test('custom range: from > to and impossible dates are refused by the primitive', () => {
  assert.throws(() => businessWindowBounds({ kind: 'custom', from: '2026-03-31', to: '2026-03-01' }, NOW), /starts after it ends/);
  assert.throws(() => businessWindowBounds({ kind: 'custom', from: '2026-02-30', to: '2026-03-05' }, NOW), /invalid custom range/);
});

// ── THE SCHEDULED OVERRIDE MUST NOT TOUCH A CUSTOM RANGE ───────────────────────────────────────
// These two tests pin the NUMBERS behind the 2026-08-31 fix (Qodo review of PR #298), so a future
// refactor that re-applies applyScheduledBound to the custom branch fails with the reason attached
// rather than with a vague bounds mismatch. Both were reproduced against the shipped code.
test('custom + scheduled override would BYPASS the 366-day cap the branch just enforced', () => {
  const b = businessWindowBounds({ kind: 'custom', from: '2020-01-01', to: '2020-01-02' }, NOW);
  assert.equal(b.windowDays, 2, 'the cap is checked against windowDays, which is 2 — it passes');

  // What the override WOULD have substituted for `to`, had the custom branch called it.
  const override = businessDayPlus(FUTURE_PAYMENT_HORIZON_DAYS + 1, NOW);
  const effective = daysApart(b.from, override);
  assert.ok(
    effective > 366,
    `substituting the override yields a ${effective}-day span, past the 366-day cap — this is the defect`,
  );
  // And the shipped contract: the bounds are exactly what was asked for.
  assert.equal(b.to, '2020-01-03', 'inclusive end date + 1, untouched by any override');
});

test('custom + scheduled override would INVERT a future-dated range into an empty result', () => {
  const b = businessWindowBounds({ kind: 'custom', from: '2027-01-01', to: '2027-06-30' }, NOW);
  const override = businessDayPlus(FUTURE_PAYMENT_HORIZON_DAYS + 1, NOW);
  assert.ok(
    override < b.from,
    `the override (${override}) lands BEFORE the range start (${b.from}) — to < from returns nothing, silently`,
  );
  assert.equal(b.to, '2027-07-01', 'the resolved upper bound is the one the user asked for');
});

test('the override is only ever an EXTENSION for a trailing preset — never a narrowing', () => {
  // Why the same helper is correct for presets: their `to` is always business-today + 1, so the
  // substitute is always strictly later. This is the property the custom branch does not have.
  const override = businessDayPlus(FUTURE_PAYMENT_HORIZON_DAYS + 1, NOW);
  for (const days of [7, 14, 30, 90, 180, 365]) {
    const b = businessWindowBounds({ kind: 'trailing', days }, NOW);
    assert.equal(b.to, businessDayPlus(1, NOW), `${days}d upper bound is business-today + 1`);
    assert.ok(override > b.to, `${days}d: the override must EXTEND, not replace with something earlier`);
  }
});

// ── #299: THE GUARD IS THREADED FROM THE CALLER, NOT DEFAULTED IN THE BUILDER ──────────────────
// Two of the three Collections builders are shared. Defaulting requireWindow on inside them would
// break QUALIFY, which passes deliberately windowless filters (app/lib/qualify/core.ts's
// `{ primary_payers: [p] }` — "a zero count means 'never billed, ever'"). Payer Intel is NOT the
// hazard: it sets both bounds unconditionally (app/lib/payer-intel/core.ts:432-454).
test('#299: the Collections builders REFUSE an open-ended window when opted in', () => {
  const open = { from: '2026-06-01' } as const; // no `to`
  for (const build of [
    () => buildCmdExplorerQuery(null, open, SORT, 50, ENTITY, { requireWindow: true }),
    () => buildCmdExplorerGroupedQuery(null, open, 'desc', 50, ENTITY, { requireWindow: true }),
    () => buildCmdSearchSummaryQueries(open, ENTITY, undefined, { requireWindow: true }),
  ]) {
    assert.throws(build, /requireWindow needs BOTH from and to/);
  }
});

test('#299: the SAME builders stay permissive when the option is omitted — Payer Intel and Qualify', () => {
  // Qualify's real filter shape: windowless ON PURPOSE. It must keep building.
  const qualify: CmdExplorerFilter = { primary_payers: ['AETNA'] };
  assert.doesNotThrow(() => buildCmdSearchSummaryQueries(qualify, ENTITY));
  assert.doesNotThrow(() => buildCmdExplorerQuery(null, qualify, SORT, 50, ENTITY));
  assert.doesNotThrow(() => buildCmdExplorerGroupedQuery(null, qualify, 'desc', 50, ENTITY));
});

test('#299: PAYER INTEL SQL IS BYTE-IDENTICAL — the opt-in changes no bytes when both bounds exist', () => {
  // Payer Intel's filter shape (app/lib/payer-intel/core.ts:432-454): both bounds, always.
  const payerIntel = { from: '2026-06-01', to: '2026-08-31' } as const;

  // Left: exactly what Payer Intel calls today — no opts argument at all.
  // Right: the same call WITH the guard on. Identical bytes proves two things at once: the opt-in
  // is behaviour-preserving, and Payer Intel could not have been broken by it either way.
  const before = buildCmdExplorerQuery(null, payerIntel, SORT, 51, ENTITY);
  const after = buildCmdExplorerQuery(null, payerIntel, SORT, 51, ENTITY, { requireWindow: true });
  assert.equal(after.sql, before.sql, 'grid SQL must not shift by one byte');
  assert.deepEqual(after.params, before.params, 'and neither may the bound params');

  const sBefore = buildCmdSearchSummaryQueries(payerIntel, ENTITY);
  const sAfter = buildCmdSearchSummaryQueries(payerIntel, ENTITY, undefined, { requireWindow: true });
  assert.equal(sAfter.totals.sql, sBefore.totals.sql, 'summary totals SQL must not shift');
  assert.deepEqual(sAfter.totals.params, sBefore.totals.params);
  assert.equal(
    sAfter.groups.primary_payer.sql,
    sBefore.groups.primary_payer.sql,
    'the payer-group query Payer Intel reads at loaders.ts:331 must not shift',
  );
});
