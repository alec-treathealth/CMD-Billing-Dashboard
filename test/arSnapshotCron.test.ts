/**
 * Hermetic tests for the AR snapshot CRON loop (src/billingAudit/arSnapshotCron.ts). The fake pool
 * records every statement with its connection so the run-log lifecycle can be PROVED tenant-scoped;
 * fetch / parse / write are stubbed so no ZIP, crypto or PHI is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CmdCustomerTarget } from '../src/collections/cmdExplorerCron.js';
import type { CmdSnapshotResult } from '../src/collections/cmdSnapshot.js';
import type { ArMapped } from '../src/billingAudit/arSnapshotMap.js';
import { arSnapshotCron } from '../src/billingAudit/arSnapshotCron.js';
import type { ArWriteStats } from '../src/billingAudit/arSnapshotWrite.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';
import { fakeArPool } from './helpers/fakeArPool.js';

const CUSTOMERS: CmdCustomerTarget[] = [
  { customerId: '10000001', facilityCode: 'ONE', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10000002', facilityCode: 'TWO', businessEntityId: BXR_ENTITY_ID },
  { customerId: '10000003', facilityCode: 'THREE', businessEntityId: BXR_ENTITY_ID },
];
const ZIP: CmdSnapshotResult = { kind: 'zip', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]) };
const emptyMapped: ArMapped = { facilityName: 'X', snapshotAsOf: '2026-09-09T06:00:00', patients: [], claims: [], charges: [], remits: [], statusEvents: [], notes: [], skips: {} };
const twoClaims: ArMapped = { ...emptyMapped, claims: [{} as never, {} as never], charges: [{} as never] };
const writeStats = (claims: number): ArWriteStats => ({ patients: 1, claims, charges: claims, remits: 0, statusEvents: 0, notesInserted: 2, claimsMarkedStale: 0, chargesMarkedStale: 0 });

function deps(fake: ReturnType<typeof fakeArPool>, over: Partial<Parameters<typeof arSnapshotCron>[0]> = {}) {
  return {
    customers: CUSTOMERS,
    fetchSnapshot: async () => ZIP,
    writeDb: fake.pool,
    writerUser: 'claims_audit_writer_login',
    expectedEmptyCustomerIds: new Set<string>(['10000003']),
    parseAndMap: () => twoClaims,
    write: async () => writeStats(2),
    ...over,
  };
}

test('stale customer: START row → fetch → write → FINISH ok, every run-log write inside its own tenant transaction', async () => {
  const fake = fakeArPool();
  const fetched: string[] = [];
  const writtenRunIds: number[] = [];
  let revalidated = 0;
  const stats = await arSnapshotCron(deps(fake, {
    customers: [CUSTOMERS[0]!],
    fetchSnapshot: async (id) => { fetched.push(id); return ZIP; },
    write: async (_db, _m, ctx) => { writtenRunIds.push(ctx.runId); assert.equal(ctx.cmdCustomerId, '10000001'); assert.equal(ctx.facilityCode, 'ONE'); return writeStats(2); },
    revalidate: () => { revalidated += 1; },
  }));
  assert.deepEqual(fetched, ['10000001']);
  assert.deepEqual(writtenRunIds, [101]);
  assert.deepEqual(fake.assertAllScoped(), []);
  const start = fake.calls.find((c) => /insert into claims\.ar_snapshot_run/i.test(c.sql))!;
  assert.equal(start.params![1], '10000001');
  assert.equal(start.params![3], 'claims_audit_writer_login');
  const finish = fake.calls.find((c) => /update claims\.ar_snapshot_run/i.test(c.sql))!;
  assert.equal(finish.params![0], 101);
  assert.equal(finish.params![1], 'ok');
  assert.equal(finish.params![2], null);
  assert.equal(finish.params![3], ZIP.kind === 'zip' ? ZIP.bytes.length : 0);
  assert.equal(finish.params![4], '2026-09-09T06:00:00');
  assert.equal(finish.params![5], 2); // claims_seen
  assert.equal(finish.params![8], 2); // claims_upserted
  assert.equal(finish.params![12], 2); // notes_inserted
  assert.equal(finish.params![13], BXR_ENTITY_ID);
  // The START row committed BEFORE the fetch happened (different, earlier connection than the finish).
  const startIdx = fake.calls.indexOf(start);
  const commitAfterStart = fake.calls.slice(startIdx).findIndex((c) => /^COMMIT/i.test(c.sql));
  assert.ok(commitAfterStart > 0);
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.claims_upserted, 2);
  assert.equal(stats.notes_inserted, 2);
  assert.equal(revalidated, 1);
  assert.equal(stats.per_customer[0]!.outcome, 'ok');
});

test('fresh customer: skipped — no fetch, no run row', async () => {
  const fake = fakeArPool({ fresh: new Set(['10000001', '10000002', '10000003']) });
  let fetched = 0;
  const stats = await arSnapshotCron(deps(fake, { fetchSnapshot: async () => { fetched += 1; return ZIP; } }));
  assert.equal(fetched, 0);
  assert.equal(stats.customers_skipped_fresh, 3);
  assert.equal(fake.calls.filter((c) => /insert into claims\.ar_snapshot_run/i.test(c.sql)).length, 0);
  assert.deepEqual(fake.assertAllScoped(), []);
  const freshRead = fake.calls.find((c) => /as fresh/i.test(c.sql))!;
  assert.equal(freshRead.params![2], 72_000); // 20h default, in seconds
});

test('404 / 401 are recorded as their own statuses, nothing is written, the loop continues', async () => {
  const fake = fakeArPool();
  let writes = 0;
  const kinds: Record<string, CmdSnapshotResult> = {
    '10000001': { kind: 'not_configured' },
    '10000002': { kind: 'unauthorized' },
    '10000003': ZIP,
  };
  const stats = await arSnapshotCron(deps(fake, {
    fetchSnapshot: async (id) => kinds[id]!,
    parseAndMap: () => emptyMapped,
    write: async () => { writes += 1; return writeStats(0); },
  }));
  assert.equal(writes, 1);
  assert.equal(stats.customers_not_configured, 1);
  assert.equal(stats.customers_unauthorized, 1);
  assert.equal(stats.customers_empty, 1); // THREE is in the expected-empty set
  const finishes = fake.calls.filter((c) => /update claims\.ar_snapshot_run/i.test(c.sql)).map((c) => c.params![1]);
  assert.deepEqual(finishes, ['not_configured', 'unauthorized', 'empty']);
  assert.deepEqual(stats.per_customer.map((r) => r.outcome), ['not_configured', 'unauthorized', 'empty']);
});

test('a throwing fetch / parse / write closes the run row error with a PHI-safe label and continues', async () => {
  const fake = fakeArPool();
  const stats = await arSnapshotCron(deps(fake, {
    fetchSnapshot: async (id) => { if (id === '10000001') throw new Error('socket hang up https://user:pw@host'); return ZIP; },
    parseAndMap: (zip) => { if (zip.length === 6 && stats0.parseCalls++ === 0) throw new Error('bad zip'); return twoClaims; },
    write: async (_db, _m, ctx) => { if (ctx.cmdCustomerId === '10000003') throw new Error('42501 permission denied'); return writeStats(2); },
  }));
  const finishes = fake.calls.filter((c) => /update claims\.ar_snapshot_run/i.test(c.sql)).map((c) => [c.params![1], c.params![2]]);
  assert.deepEqual(finishes, [['error', 'fetch_failed'], ['error', 'parse_failed'], ['error', 'write_failed']]);
  assert.equal(stats.customers_failed, 3);
  assert.equal(stats.customers_processed, 0);
  for (const c of fake.calls) assert.equal(JSON.stringify(c.params ?? []).includes('user:pw'), false);
  assert.deepEqual(fake.assertAllScoped(), []);
});
const stats0 = { parseCalls: 0 };

test('budget exhausted: remaining customers are skipped without a fetch or a run row', async () => {
  const fake = fakeArPool();
  let t = 0;
  const now = () => t;
  let fetched = 0;
  const stats = await arSnapshotCron(deps(fake, {
    now,
    budgetMs: 1000,
    fetchSnapshot: async () => { fetched += 1; t = 5000; return ZIP; }, // the first pull eats the budget
  }));
  assert.equal(fetched, 1);
  assert.equal(stats.customers_processed, 1);
  assert.equal(stats.customers_skipped_budget, 2);
  assert.equal(fake.calls.filter((c) => /insert into claims\.ar_snapshot_run/i.test(c.sql)).length, 1);
  assert.deepEqual(stats.per_customer.map((r) => r.outcome), ['ok', 'skipped_budget', 'skipped_budget']);
});

test('running guard: a customer with a young `running` run is skipped — no START row, no fetch', async () => {
  const fake = fakeArPool({ running: new Set(['10000002']) });
  const fetched: string[] = [];
  const stats = await arSnapshotCron(deps(fake, { fetchSnapshot: async (id) => { fetched.push(id); return ZIP; } }));
  assert.deepEqual(fetched, ['10000001', '10000003']);
  assert.equal(stats.customers_skipped_running, 1);
  assert.deepEqual(stats.per_customer.map((r) => r.outcome), ['ok', 'skipped_running', 'ok']);
  const starts = fake.calls.filter((c) => /insert into claims\.ar_snapshot_run/i.test(c.sql)).map((c) => c.params![1]);
  assert.deepEqual(starts, ['10000001', '10000003']);
});

test('empty-regression guard: zero claims for a customer WITH live rows is an error and writes nothing', async () => {
  const fake = fakeArPool({ liveRows: new Set(['10000001']) });
  let writes = 0;
  const stats = await arSnapshotCron(deps(fake, {
    customers: [CUSTOMERS[0]!, CUSTOMERS[1]!],
    parseAndMap: () => emptyMapped,
    write: async () => { writes += 1; return writeStats(0); },
  }));
  // ONE: live rows + zero claims → error/empty_regression, writer never called (no stale mark).
  // TWO: no live rows + zero claims → empty (a first-ever empty pull), writer called (harmless).
  assert.deepEqual(stats.per_customer.map((r) => [r.outcome, r.errorLabel]), [['error', 'empty_regression'], ['empty', null]]);
  assert.equal(writes, 1);
  assert.equal(stats.customers_empty_regression, 1);
  assert.equal(stats.customers_failed, 1);
  const finishes = fake.calls.filter((c) => /update claims\.ar_snapshot_run/i.test(c.sql)).map((c) => [c.params![1], c.params![2]]);
  assert.deepEqual(finishes, [['error', 'empty_regression'], ['empty', null]]);
  // An error run is NOT fresh, so the next pass retries — the 20h window never hides the regression.
  assert.deepEqual(fake.assertAllScoped(), []);
});

test('empty-regression guard: an EXPECTED-empty customer with live rows still records empty', async () => {
  const fake = fakeArPool({ liveRows: new Set(['10000003']) });
  const stats = await arSnapshotCron(deps(fake, { customers: [CUSTOMERS[2]!], parseAndMap: () => emptyMapped, write: async () => writeStats(0) }));
  assert.equal(stats.per_customer[0]!.outcome, 'empty');
  assert.equal(stats.customers_empty_regression, 0);
});

test('a writer that throws mid-way still busts the cache — batches before it may have committed', async () => {
  const fake = fakeArPool();
  let revalidated = 0;
  const stats = await arSnapshotCron(deps(fake, {
    customers: [CUSTOMERS[0]!],
    write: async () => { throw new Error('42501 on batch 3'); },
    revalidate: () => { revalidated += 1; },
  }));
  assert.equal(stats.customers_failed, 1);
  assert.equal(revalidated, 1);
});

test('a PARTIAL write closes its run row with the parsed + committed counts, never zeroes', async () => {
  // The writer commits batch by batch, so a later failure leaves earlier upserts durable. Recording
  // zeroes would make a partial ingest read as "nothing happened" during reconciliation.
  const fake = fakeArPool();
  const stats = await arSnapshotCron(deps(fake, {
    customers: [CUSTOMERS[0]!],
    parseAndMap: () => twoClaims,
    write: async (_db, _m, _ctx, progress) => {
      // Two batches commit, then the third throws — exactly the shape writeArSnapshot has.
      if (progress) { progress.claims = 2; progress.charges = 1; progress.notesInserted = 5; progress.patients = 1; }
      throw new Error('42501 on batch 3');
    },
  }));
  const finish = fake.calls.find((c) => /update claims\.ar_snapshot_run/i.test(c.sql))!;
  assert.equal(finish.params![1], 'error');
  assert.equal(finish.params![2], 'write_failed');
  assert.equal(finish.params![4], '2026-09-09T06:00:00', 'snapshot_as_of from the parsed file');
  assert.equal(finish.params![5], 2, 'claims_seen = parsed claims');
  assert.equal(finish.params![6], 1, 'charges_seen = parsed charges');
  assert.equal(finish.params![7], 1, 'patients_upserted = what committed');
  assert.equal(finish.params![8], 2, 'claims_upserted = what committed');
  assert.equal(finish.params![12], 5, 'notes_inserted = what committed');
  // The run summary counts the committed rows too.
  assert.equal(stats.claims_upserted, 2);
  assert.equal(stats.notes_inserted, 5);
  assert.deepEqual(stats.per_customer.map((r) => [r.outcome, r.claims, r.notesInserted]), [['error', 2, 5]]);
});

test('a FETCH failure reports no counts — nothing was parsed and nothing was written', async () => {
  const fake = fakeArPool();
  await arSnapshotCron(deps(fake, {
    customers: [CUSTOMERS[0]!],
    fetchSnapshot: async () => { throw new Error('socket hang up'); },
  }));
  const finish = fake.calls.find((c) => /update claims\.ar_snapshot_run/i.test(c.sql))!;
  assert.equal(finish.params![2], 'fetch_failed');
  assert.equal(finish.params![5], 0);
  assert.equal(finish.params![8], 0);
});

test('a customer without a businessEntityId is a programming error, not a silent unscoped write', async () => {
  const fake = fakeArPool();
  await assert.rejects(arSnapshotCron(deps(fake, { customers: [{ customerId: '10000009', facilityCode: 'X' }] })), /no businessEntityId/);
});
