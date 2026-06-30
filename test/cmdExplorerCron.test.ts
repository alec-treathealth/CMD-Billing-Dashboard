/**
 * Hermetic tests for cmdExplorerCron's customer-loop orchestration: per-customer error
 * isolation, the wall-clock budget guard, and cache revalidation. No real DB / network —
 * a fake pg pool (query + connect/release) records calls. Fixtures fail mapRow on purpose
 * (no required charge-line fields) so insertRows gets [] and no libsodium encryption runs;
 * the deposit aggregation path (Payment Received + Check/EFT) is still exercised.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cmdExplorerCron,
  computeFreshnessWarnings,
  type CmdCustomerTarget,
} from '../src/collections/cmdExplorerCron.js';
import type { Db } from '../src/collections/db.js';

const isoMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/** A deposit-only report row: aggregates into daily_collections, but fails mapRow (no PHI). */
const depositRow = (date: string, check: string, eft: string): Record<string, string> => ({
  'Payment Received': date,
  'Check Payment': check,
  'EFT Payment': eft,
});

/** Minimal fake pg pool: pool.query (insertRows) + pool.connect()->client (replace txn). */
function fakeDb(): { db: Db; deletes: number; inserts: number } {
  const counters = { deletes: 0, inserts: 0 };
  const client = {
    query: async (sql: string) => {
      const s = String(sql).trim();
      if (/^delete/i.test(s)) {
        counters.deletes += 1;
        return { rowCount: 0, rows: [] };
      }
      if (/^insert/i.test(s)) {
        counters.inserts += 1;
        return { rowCount: 1, rows: [{ id: 1 }] };
      }
      return { rowCount: 0, rows: [] }; // begin / commit / rollback
    },
    release: () => {},
  };
  const db = {
    query: async () => ({ rowCount: 0, rows: [] }),
    connect: async () => client,
  } as unknown as Db;
  return { db, get deletes() { return counters.deletes; }, get inserts() { return counters.inserts; } };
}

const CUSTOMERS: CmdCustomerTarget[] = [
  { customerId: '1', facilityCode: 'CAMH' },
  { customerId: '2', facilityCode: 'DMH' },
  { customerId: '3', facilityCode: 'TBH' },
];

test('cmdExplorerCron: isolates a failing customer and processes the rest; revalidates once processed', async () => {
  const fake = fakeDb();
  let revalidated = false;
  let dashboardRevalidated = false;
  const stats = await cmdExplorerCron({
    customers: CUSTOMERS,
    fetchRows: async (id) => {
      if (id === '2') throw new Error('CMD report.run returned no identifier (status: INVALID CRITERIA)');
      return [depositRow('06/01/2026', '$100.00', '$0.00')];
    },
    writeDb: fake.db,
    revalidate: () => { revalidated = true; },
    revalidateDashboard: () => { dashboardRevalidated = true; },
  });
  assert.equal(stats.customers_total, 3);
  assert.equal(stats.customers_processed, 2);
  assert.equal(stats.customers_failed, 1);
  assert.equal(stats.customers_skipped_budget, 0);
  assert.equal(stats.rows_fetched, 2, 'only the 2 non-throwing customers contribute rows');
  assert.equal(stats.daily_rows_inserted, 2, 'one deposit day inserted per processed customer');
  assert.equal(fake.deletes, 2, 'per-facility replace DELETE runs for each processed customer');
  assert.equal(revalidated, true);
  assert.equal(dashboardRevalidated, true);
});

test('cmdExplorerCron: wall-clock guard stops launching new customers past the budget', async () => {
  const fake = fakeDb();
  // now() sequence: started=0, then guard checks at 50 (process), 200 (skip), 201 (skip).
  const ticks = [0, 50, 200, 201];
  let i = 0;
  const now = () => ticks[Math.min(i++, ticks.length - 1)] ?? 0;
  let fetched = 0;
  const stats = await cmdExplorerCron({
    customers: CUSTOMERS,
    fetchRows: async () => { fetched += 1; return [depositRow('06/02/2026', '$10.00', '$0.00')]; },
    writeDb: fake.db,
    now,
    budgetMs: 100,
  });
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.customers_skipped_budget, 2);
  assert.equal(fetched, 1, 'budget-skipped customers are never fetched');
});

test('cmdExplorerCron: no successful customers → no revalidation', async () => {
  const fake = fakeDb();
  let revalidated = false;
  const stats = await cmdExplorerCron({
    customers: [{ customerId: '9', facilityCode: 'CAMH' }],
    fetchRows: async () => { throw new Error('boom'); },
    writeDb: fake.db,
    revalidate: () => { revalidated = true; },
  });
  assert.equal(stats.customers_processed, 0);
  assert.equal(stats.customers_failed, 1);
  assert.equal(revalidated, false);
});

test('cmdExplorerCron: tracks newest payment_date and emits no warning when fresh + far from window end', async () => {
  const fake = fakeDb();
  const stats = await cmdExplorerCron({
    customers: [{ customerId: '1', facilityCode: 'CAMH' }],
    fetchRows: async () => [
      depositRow('06/01/2026', '$10.00', '$0.00'),
      depositRow('06/29/2026', '$20.00', '$0.00'),
    ],
    writeDb: fake.db,
    now: () => isoMs('2026-07-01'), // 2 days after the newest payment
    filterWindowEnd: '2027-06-30',
  });
  assert.equal(stats.max_payment_date, '2026-06-29', 'newest payment_date across the pull');
  assert.deepEqual(stats.freshness_warnings, [], 'fresh data, distant window end ⇒ no warnings');
});

test('computeFreshnessWarnings: STALE when newest payment_date lags beyond threshold', () => {
  const w = computeFreshnessWarnings({
    maxPaymentDate: '2026-06-01',
    nowMs: isoMs('2026-07-01'), // 30 days behind > 10d threshold
    filterWindowEnd: '2027-06-30',
  });
  assert.equal(w.length, 1);
  assert.match(String(w[0]), /^STALE: newest payment_date 2026-06-01 is 30 days behind/);
});

test('computeFreshnessWarnings: EXPIRING within 30 days; EXPIRED once past', () => {
  const expiring = computeFreshnessWarnings({
    maxPaymentDate: '2027-06-14',
    nowMs: isoMs('2027-06-15'), // 15 days before window end
    filterWindowEnd: '2027-06-30',
  });
  assert.equal(expiring.length, 1);
  assert.match(String(expiring[0]), /FILTER WINDOW EXPIRING: .* ends 2027-06-30 in 15 days/);

  const expired = computeFreshnessWarnings({
    maxPaymentDate: '2027-07-09', // fresh ⇒ isolate the expiry signal
    nowMs: isoMs('2027-07-10'), // 10 days after window end
    filterWindowEnd: '2027-06-30',
  });
  assert.equal(expired.length, 1);
  assert.match(String(expired[0]), /FILTER WINDOW EXPIRED: .* ended 2027-06-30 \(10 days ago\)/);
});

test('computeFreshnessWarnings: no filterWindowEnd skips expiry; null maxPaymentDate skips stale', () => {
  assert.deepEqual(
    computeFreshnessWarnings({ maxPaymentDate: '2020-01-01', nowMs: isoMs('2026-07-01') }),
    [
      'STALE: newest payment_date 2020-01-01 is ' +
        `${Math.floor((isoMs('2026-07-01') - isoMs('2020-01-01')) / 86_400_000)} days behind now ` +
        '(threshold 10d) — the cmd-explorer pipeline may be stalled.',
    ],
    'no filterWindowEnd ⇒ only the stale signal can fire',
  );
  assert.deepEqual(
    computeFreshnessWarnings({ maxPaymentDate: null, nowMs: isoMs('2026-07-01'), filterWindowEnd: '2027-06-30' }),
    [],
    'null maxPaymentDate + distant window end ⇒ no warnings',
  );
});
