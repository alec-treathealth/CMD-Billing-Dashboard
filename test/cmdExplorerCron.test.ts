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
import { BXR_ENTITY_ID } from '../src/tenants.js';

const isoMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/** A deposit-only report row: aggregates into daily_collections, but fails mapRow (no PHI). */
const depositRow = (date: string, check: string, eft: string): Record<string, string> => ({
  'Payment Received': date,
  'Check Payment': check,
  'EFT Payment': eft,
});

/** Minimal fake pg pool: pool.query (insertRows) + pool.connect()->client (replace txn).
 *  The client simulates the withTenant GUC handshake — set_config stores the bound tenant id and
 *  the current_setting read-back returns it — so the hardened withTenant's read-back assertion
 *  (src/veris/withTenant.ts) passes under the fake instead of throwing on an empty result. */
function fakeDb(): { db: Db; deletes: number; inserts: number } {
  const counters = { deletes: 0, inserts: 0 };
  let guc: string | null = null;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      if (/set_config/i.test(s)) {
        guc = params?.[0] === undefined ? null : String(params[0]);
        return { rowCount: 1, rows: [{ set_config: guc }] };
      }
      if (/current_setting/i.test(s)) {
        return { rowCount: 1, rows: [{ v: guc }] };
      }
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
    businessEntityId: BXR_ENTITY_ID,
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
    businessEntityId: BXR_ENTITY_ID,
    now,
    budgetMs: 100,
  });
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.customers_skipped_budget, 2);
  assert.equal(fetched, 1, 'budget-skipped customers are never fetched');
});

/** A FULL charge-line report row (all 14 headers) so mapRow succeeds and insertRows runs —
 *  the path that must trigger the 0050 charge-rollup refresh. PHI values are obvious fakes. */
const chargeReportRow = (): Record<string, string> => ({
  'Charge From Date': '6/21/2026',
  'Payment Received': '6/25/2026',
  'Charge CPT Code': '90853',
  'Revenue Code': '0915',
  'Facility Name': 'CAMH',
  'Patient Full Name': 'TEST, PATIENT',
  'Claim Primary Member ID': 'ZZZ000000',
  'Primary Group Number': 'GRP0',
  'Charge/Debit Amount': '$100.00',
  'Payment Allowed Amount': '$50.00',
  'Charge Insurance Payments': '$40.00',
  'Charge Total Adjustments w/o Transfers': '$0.00',
  'Charge Balance Due Pat': '$10.00',
  'Charge Primary Payer Name': 'TEST PAYER',
});

/** Throwaway 64-hex test key (obvious dummy) so encryptPhi can run hermetically — NOT a secret. */
const TEST_LIBSODIUM_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

test('cmdExplorerCron: charge inserts trigger the 0050 rollup refresh; a refresh failure is NON-FATAL', async () => {
  const prevKey = process.env.LIBSODIUM_KEY;
  process.env.LIBSODIUM_KEY = TEST_LIBSODIUM_KEY;
  try {
    const fake = fakeDb();
    let refreshes = 0;
    let revalidated = false;
    const stats = await cmdExplorerCron({
      customers: [{ customerId: '1', facilityCode: 'CAMH' }],
      fetchRows: async () => [chargeReportRow()],
      writeDb: fake.db,
      businessEntityId: BXR_ENTITY_ID,
      refreshChargeRollup: () => {
        refreshes += 1;
        throw new Error('refresh timed out'); // non-fatal by contract
      },
      revalidate: () => { revalidated = true; },
    });
    assert.equal(stats.charge_inserted, 1, 'the full charge row must map + insert');
    assert.equal(refreshes, 1, 'refresh fires exactly once, after inserts');
    assert.equal(stats.customers_failed, 0, 'a throwing refresh must not fail the run');
    assert.equal(revalidated, true, 'caches still bust after a failed refresh');
  } finally {
    if (prevKey === undefined) delete process.env.LIBSODIUM_KEY;
    else process.env.LIBSODIUM_KEY = prevKey;
  }
});

test('cmdExplorerCron: deposit-only pass (no charge rows) skips the rollup refresh', async () => {
  const fake = fakeDb();
  let refreshes = 0;
  const stats = await cmdExplorerCron({
    customers: [{ customerId: '1', facilityCode: 'CAMH' }],
    fetchRows: async () => [depositRow('06/01/2026', '$100.00', '$0.00')],
    writeDb: fake.db,
    businessEntityId: BXR_ENTITY_ID,
    refreshChargeRollup: () => { refreshes += 1; },
  });
  assert.equal(stats.charge_inserted, 0);
  assert.equal(refreshes, 0, 'nothing the matview summarizes changed → no refresh');
});

test('cmdExplorerCron: no successful customers → no revalidation', async () => {
  const fake = fakeDb();
  let revalidated = false;
  const stats = await cmdExplorerCron({
    customers: [{ customerId: '9', facilityCode: 'CAMH' }],
    fetchRows: async () => { throw new Error('boom'); },
    writeDb: fake.db,
    businessEntityId: BXR_ENTITY_ID,
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
    businessEntityId: BXR_ENTITY_ID,
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
