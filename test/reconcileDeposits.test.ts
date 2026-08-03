/**
 * Hermetic tests for the deposit reconciler. No DB, no network, no PHI.
 *
 * The behaviour worth protecting is not the arithmetic — it is that an INCOMPLETE run can never
 * look clean. A customer that fails or is cut off contributes nothing on the report side, so the
 * naive comparison would report its entire stored total as a shortfall. The first live run hit
 * exactly this: FRCA failed to pull and manufactured a fake $25,890.08 gap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatReconcileLog,
  reconcileDeposits,
  type ReconcileDeps,
  type StoredGrossRow,
} from '../src/collections/reconcileDeposits.js';
import type { CmdReportRow } from '../src/collections/cmdPayer.js';

/** A deposit row in the shape aggregateDailyDeposits reads. */
const dep = (date: string, check: string, eft = '0.00'): CmdReportRow => ({
  'Payment Received': date,
  'Check Payment': check,
  'EFT Payment': eft,
});

const TARGETS = [
  { customerId: '1', facilityCode: 'CAMH' },
  { customerId: '2', facilityCode: 'NASH' },
];

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    customers: TARGETS,
    fetchRows: async () => [dep('2026-07-01', '100.00')],
    readStoredGross: async () => [],
    now: () => 0,
    ...over,
  };
}

test('reconcileDeposits: an exact match reports zero mismatches and no alert', async () => {
  const stored: StoredGrossRow[] = [
    { facility_code: 'CAMH', payment_date: '2026-07-01', gross: 100 },
    { facility_code: 'NASH', payment_date: '2026-07-01', gross: 100 },
  ];
  const s = await reconcileDeposits(deps({ readStoredGross: async () => stored }));
  assert.equal(s.facility_days_matched, 2);
  assert.equal(s.facility_days_mismatched, 0);
  assert.equal(s.delta_total, 0);
  assert.equal(s.alert, false);
  assert.equal(s.incomplete, false);
});

test('reconcileDeposits: a material overstatement is flagged and sorted worst-first', async () => {
  // Mirrors the real LAMH 2026-07-21 finding: the dashboard showed more than the bank.
  const s = await reconcileDeposits(
    deps({
      fetchRows: async (id) => (id === '1' ? [dep('2026-07-21', '46439.80')] : [dep('2026-07-01', '100.00')]),
      readStoredGross: async () => [
        { facility_code: 'CAMH', payment_date: '2026-07-21', gross: 66514.57 },
        { facility_code: 'NASH', payment_date: '2026-07-01', gross: 100 },
      ],
    }),
  );
  assert.equal(s.facility_days_mismatched, 1);
  assert.equal(s.material_mismatches.length, 1);
  assert.equal(s.material_mismatches[0]?.facility_code, 'CAMH');
  assert.equal(s.material_mismatches[0]?.delta, -20074.77, 'negative = dashboard shows MORE than the bank');
  assert.equal(s.alert, true);
});

test('reconcileDeposits: sub-threshold noise is counted but does not alert', async () => {
  // The live run had ~16 of these, mostly under $50. Alerting on them would be noise from day one.
  const s = await reconcileDeposits(
    deps({
      fetchRows: async () => [dep('2026-07-01', '100.00')],
      readStoredGross: async () => [
        { facility_code: 'CAMH', payment_date: '2026-07-01', gross: 99.5 },
        { facility_code: 'NASH', payment_date: '2026-07-01', gross: 99.5 },
      ],
      materialUsd: 100,
      totalUsd: 1000,
    }),
  );
  assert.equal(s.facility_days_mismatched, 2);
  assert.equal(s.material_mismatches.length, 0);
  assert.equal(s.alert, false, 'a dollar of noise must not page anyone');
});

test('reconcileDeposits: a big total delta alerts even with no single material day', async () => {
  const many: StoredGrossRow[] = [];
  const rows: CmdReportRow[] = [];
  for (let i = 1; i <= 20; i += 1) {
    const d = `2026-07-${String(i).padStart(2, '0')}`;
    rows.push(dep(d, '100.00'));
    many.push({ facility_code: 'CAMH', payment_date: d, gross: 60 });
    many.push({ facility_code: 'NASH', payment_date: d, gross: 60 });
  }
  const s = await reconcileDeposits(
    deps({ fetchRows: async () => rows, readStoredGross: async () => many, materialUsd: 100, totalUsd: 1000 }),
  );
  assert.equal(s.material_mismatches.length, 0, 'each day differs by only $40');
  assert.equal(s.delta_total, 1600);
  assert.equal(s.alert, true, 'the aggregate still matters');
});

// --- the invariant that actually matters -------------------------------------

test('reconcileDeposits: a FAILED customer is excluded, never reported as a shortfall', async () => {
  // The FRCA case. Without the exclusion this would report -$5,000 that does not exist.
  const s = await reconcileDeposits(
    deps({
      fetchRows: async (id) => {
        if (id === '2') throw new Error('CMD report.results request failed');
        return [dep('2026-07-01', '100.00')];
      },
      readStoredGross: async () => [
        { facility_code: 'CAMH', payment_date: '2026-07-01', gross: 100 },
        { facility_code: 'NASH', payment_date: '2026-07-01', gross: 5000 },
      ],
    }),
  );
  assert.equal(s.customers_failed, 1);
  assert.equal(s.customers_reconciled, 1);
  assert.equal(s.facility_days_mismatched, 0, 'the unreached facility must not appear as a mismatch');
  assert.equal(s.stored_total, 100, 'its stored total must not enter the comparison either');
  assert.equal(s.incomplete, true);
  assert.equal(s.alert, true, 'incomplete coverage is itself alert-worthy');
  assert.ok(s.unreached[0]?.includes('NASH'));
});

test('reconcileDeposits: a budget-skipped customer is excluded the same way', async () => {
  let t = 0;
  const s = await reconcileDeposits(
    deps({
      now: () => (t += 200_000), // second customer is past the default 210s budget
      readStoredGross: async () => [
        { facility_code: 'CAMH', payment_date: '2026-07-01', gross: 100 },
        { facility_code: 'NASH', payment_date: '2026-07-01', gross: 5000 },
      ],
    }),
  );
  assert.equal(s.customers_skipped_budget, 1);
  assert.equal(s.facility_days_mismatched, 0);
  assert.equal(s.incomplete, true);
  assert.equal(s.alert, true);
});

test('reconcileDeposits: an empty report is not an alert on its own, but is when incomplete', async () => {
  // Normal early in a month — BXR posts nothing at a weekend, so "this month" legitimately empty.
  const quiet = await reconcileDeposits(deps({ fetchRows: async () => [] }));
  assert.equal(quiet.window_from, null);
  assert.equal(quiet.alert, false);

  const partial = await reconcileDeposits(
    deps({
      fetchRows: async (id) => {
        if (id === '2') throw new Error('boom');
        return [];
      },
    }),
  );
  assert.equal(partial.alert, true, 'empty may only mean we never asked');
});

test('reconcileDeposits: never reads back outside the window the report covered', async () => {
  let seen: [string, string] | null = null;
  await reconcileDeposits(
    deps({
      fetchRows: async () => [dep('2026-07-05', '10.00'), dep('2026-07-09', '10.00')],
      readStoredGross: async (from, to) => {
        seen = [from, to];
        return [];
      },
    }),
  );
  assert.deepEqual(seen, ['2026-07-05', '2026-07-09']);
});

test('formatReconcileLog: one non-PHI line carrying the verdict inputs', () => {
  const line = formatReconcileLog({
    customers_total: 15,
    customers_reconciled: 14,
    customers_failed: 1,
    customers_skipped_budget: 0,
    unreached: ['10032340 (FRCA): fetch_failed'],
    incomplete: true,
    rows_fetched: 13263,
    window_from: '2026-07-01',
    window_to: '2026-07-31',
    facility_days_matched: 234,
    facility_days_mismatched: 24,
    material_mismatches: [],
    report_total: 6082936.86,
    stored_total: 6130804.6,
    delta_total: -47867.74,
    alert: true,
  });
  assert.match(line, /customers 14\/15/);
  assert.match(line, /INCOMPLETE/);
  assert.match(line, /matched 234, mismatched 24/);
  assert.match(line, /delta -47867\.74/);
  assert.ok(!/patient/i.test(line));
});
