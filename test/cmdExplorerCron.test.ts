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

// ---------------------------------------------------------------------------
// HEADER CONTRACT — the guard that stands between a shape change and a wiped feed.
//
// Ordering is the whole point: the check sits immediately after fetchRows and BEFORE
// insertRows / replaceCmdDailyForFacility, so a mismatch must leave the database
// completely untouched. fakeDb() counts DELETEs and INSERTs, so "untouched" is asserted
// against real call counts rather than inferred from stats.
// ---------------------------------------------------------------------------

/** The exact column set these tests pin. Small on purpose — this exercises the MECHANISM;
 *  the real BXR_REPORT_COLUMNS is covered by its own invariant test below. */
const GUARD_COLUMNS = ['Payment Received', 'Check Payment', 'EFT Payment'] as const;

/** Capture console.error so the failure LABEL can be asserted (it must name the columns). */
async function withCapturedErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.error = original; }
  return lines;
}

const ONE: CmdCustomerTarget[] = [{ customerId: '1', facilityCode: 'CAMH' }];

test('header contract: the exact expected name set passes and writes normally', async () => {
  const fake = fakeDb();
  const stats = await cmdExplorerCron({
    customers: ONE,
    fetchRows: async () => [depositRow('2026-07-15', '100.00', '50.00')],
    writeDb: fake.db,
    businessEntityId: BXR_ENTITY_ID,
    expectedColumns: GUARD_COLUMNS,
  });
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.customers_failed, 0);
  assert.ok(fake.deletes > 0, 'the per-facility replace ran — so a FAILING case losing this is meaningful');
});

test('header contract: same names in a DIFFERENT ORDER pass (positional-lock regression)', async () => {
  // A positional lock was tried on this project and replaced after two upstream CMD projection
  // edits in 30 hours. CMD reorders columns freely — 'Charge Entered Date' moved position between
  // two probes on 2026-08-01 — so ORDER must never be part of the contract.
  const reordered: Record<string, string> = {};
  reordered['EFT Payment'] = '50.00';
  reordered['Payment Received'] = '2026-07-15';
  reordered['Check Payment'] = '100.00';
  assert.notDeepEqual(Object.keys(reordered), [...GUARD_COLUMNS], 'fixture really is reordered');

  const fake = fakeDb();
  const stats = await cmdExplorerCron({
    customers: ONE,
    fetchRows: async () => [reordered],
    writeDb: fake.db,
    businessEntityId: BXR_ENTITY_ID,
    expectedColumns: GUARD_COLUMNS,
  });
  assert.equal(stats.customers_failed, 0, 'reordering the same names is NOT a mismatch');
  assert.equal(stats.customers_processed, 1);
  assert.ok(fake.deletes > 0);
});

test('header contract: an UNEXPECTED column fails and the label names it', async () => {
  const fake = fakeDb();
  let stats: Awaited<ReturnType<typeof cmdExplorerCron>> | undefined;
  const logs = await withCapturedErrors(async () => {
    stats = await cmdExplorerCron({
      customers: ONE,
      fetchRows: async () => [{ ...depositRow('2026-07-15', '100.00', '50.00'), 'Surprise Column': 'x' }],
      writeDb: fake.db,
      businessEntityId: BXR_ENTITY_ID,
      expectedColumns: GUARD_COLUMNS,
    });
  });
  assert.equal(stats!.customers_failed, 1);
  assert.equal(stats!.customers_processed, 0);
  const joined = logs.join('\n');
  assert.match(joined, /header mismatch/, 'the failure is identified as a header mismatch');
  assert.match(joined, /extra \[Surprise Column\]/, 'and NAMES the unexpected column');
  assert.equal(fake.deletes, 0, 'NO DELETE on the failure path');
  assert.equal(fake.inserts, 0, 'and nothing inserted either');
});

test('header contract: a MISSING column fails and the label names it', async () => {
  const fake = fakeDb();
  let stats: Awaited<ReturnType<typeof cmdExplorerCron>> | undefined;
  const logs = await withCapturedErrors(async () => {
    stats = await cmdExplorerCron({
      customers: ONE,
      // 'EFT Payment' dropped — exactly the class of silent projection edit this guard exists for.
      fetchRows: async () => [{ 'Payment Received': '2026-07-15', 'Check Payment': '100.00' }],
      writeDb: fake.db,
      businessEntityId: BXR_ENTITY_ID,
      expectedColumns: GUARD_COLUMNS,
    });
  });
  assert.equal(stats!.customers_failed, 1);
  const joined = logs.join('\n');
  assert.match(joined, /header mismatch/);
  assert.match(joined, /missing \[EFT Payment\]/, 'and NAMES the missing column');
  assert.equal(fake.deletes, 0, 'NO DELETE on the failure path');
});

test('THE ONE THAT MATTERS: a mismatch leaves existing rows intact — zero DELETEs across the roster', async () => {
  // Without the guard these rows map + aggregate cleanly, so every customer would issue a
  // per-facility DELETE and re-insert. That is the silent-destruction path: good deposit rows
  // deleted hourly and replaced with whatever the changed report happens to yield. The guard must
  // convert that into a frozen feed — recoverable — with the database never touched.
  const fake = fakeDb();
  let stats: Awaited<ReturnType<typeof cmdExplorerCron>> | undefined;
  await withCapturedErrors(async () => {
    stats = await cmdExplorerCron({
      customers: CUSTOMERS, // all three facilities
      fetchRows: async () => [{ ...depositRow('2026-07-15', '900.00', '100.00'), 'Renamed Col': 'x' }],
      writeDb: fake.db,
      businessEntityId: BXR_ENTITY_ID,
      expectedColumns: GUARD_COLUMNS,
    });
  });
  assert.equal(stats!.customers_failed, CUSTOMERS.length, 'every customer refused');
  assert.equal(stats!.customers_processed, 0);
  assert.equal(fake.deletes, 0, 'ZERO deletes — nothing was destroyed');
  assert.equal(fake.inserts, 0, 'ZERO inserts — nothing was written');
  assert.equal(stats!.daily_rows_deleted, 0);
  assert.equal(stats!.rows_fetched, 0, 'a refused pull is not counted as fetched');
});

test('header contract: omitting expectedColumns leaves the path unguarded (Indigo behaviour)', async () => {
  const fake = fakeDb();
  const stats = await cmdExplorerCron({
    customers: ONE,
    fetchRows: async () => [{ ...depositRow('2026-07-15', '100.00', '50.00'), 'Anything At All': 'x' }],
    writeDb: fake.db,
    businessEntityId: BXR_ENTITY_ID,
  });
  assert.equal(stats.customers_failed, 0, 'no guard configured ⇒ no shape enforcement');
  assert.ok(fake.deletes > 0, 'and the normal write path still runs');
});

test('an EMPTY pull skips the guard and still writes nothing (no shape to police)', async () => {
  const fake = fakeDb();
  const stats = await cmdExplorerCron({
    customers: ONE,
    fetchRows: async () => [],
    writeDb: fake.db,
    businessEntityId: BXR_ENTITY_ID,
    expectedColumns: GUARD_COLUMNS,
  });
  assert.equal(stats.customers_failed, 0, 'an empty month is not a contract violation');
  assert.equal(stats.customers_processed, 1);
  assert.equal(fake.deletes, 0, 'and an empty pull never deletes (the rows.length>0 guard in db.ts)');
});
