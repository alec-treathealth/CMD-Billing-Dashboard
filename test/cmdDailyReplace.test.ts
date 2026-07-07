/**
 * Guards replaceCmdDailyForFacility's DATE-SCOPED, TENANT-SCOPED replace. The cron's saved CMD
 * filter windows on a rolling (current-month) payment-received range, so the per-facility
 * replace must delete ONLY the payment_date span the pull covers — never a facility-wide wipe
 * that would erase the earlier months the Master BXR chart still needs. An empty pull must
 * delete nothing.
 *
 * Migration-B era additions (2026-07-06): the write runs inside a withTenant transaction
 * (transaction-local set_config of app.business_entity_id — what migration C's writer policies
 * enforce); the DELETE carries an explicit business_entity_id predicate (facility-name
 * disjointness is NOT the isolation mechanism); every inserted row is stamped with the tenant
 * id; and the INSERT's ON CONFLICT is TARGETLESS so the code works under both the pre- and
 * post-0031 shapes of the collections_daily_bucket unique index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceCmdDailyForFacility, type Db } from '../src/collections/db.js';
import type { CmdDailyDeposit } from '../src/collections/cmdExplorer.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';

interface Recorded { sql: string; params?: unknown[] }

function fakeDb(): { db: Db; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      queries.push({ sql: s, params });
      if (/^delete/i.test(s)) return { rowCount: 5, rows: [] };
      if (/^insert/i.test(s)) return { rowCount: (params ? params.length / 9 : 0), rows: [] };
      return { rowCount: 0, rows: [] }; // begin / set_config / commit
    },
    release: () => {},
  };
  const db = { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client } as unknown as Db;
  return { db, queries };
}

const deposit = (payment_date: string): CmdDailyDeposit => ({
  facility_code: 'CAMH', payment_date, checks_amount: '0', eft_amount: '100.00', gross_amount: '100.00',
});

test('replaceCmdDailyForFacility: DELETE is scoped to the pulled [min,max] span AND the tenant', async () => {
  const { db, queries } = fakeDb();
  await replaceCmdDailyForFacility(db, 'CAMH', [deposit('2026-07-02'), deposit('2026-07-01'), deposit('2026-07-03')], BXR_ENTITY_ID);
  const del = queries.find((q) => /^delete/i.test(q.sql));
  assert.ok(del, 'a scoped DELETE should run for a non-empty pull');
  assert.match(del!.sql, /payment_date between \$2 and \$3/i, 'DELETE must be span-scoped, not a facility-wide wipe');
  assert.match(del!.sql, /business_entity_id = \$4/i, 'DELETE must be tenant-scoped — disjoint facility names are not the mechanism');
  assert.deepEqual(del!.params, ['CAMH', '2026-07-01', '2026-07-03', BXR_ENTITY_ID], 'span = min..max of the pulled dates + the tenant id');
});

test('replaceCmdDailyForFacility: an EMPTY pull deletes nothing (history is preserved)', async () => {
  const { db, queries } = fakeDb();
  const res = await replaceCmdDailyForFacility(db, 'CAMH', [], BXR_ENTITY_ID);
  assert.equal(queries.some((q) => /^delete/i.test(q.sql)), false, 'no DELETE may run when the window is empty');
  assert.deepEqual(res, { deleted: 0, inserted: 0 });
});

test('replaceCmdDailyForFacility: sets the tenant GUC transaction-locally BEFORE any write', async () => {
  const { db, queries } = fakeDb();
  await replaceCmdDailyForFacility(db, 'CAMH', [deposit('2026-07-01')], BXR_ENTITY_ID);
  const gucIdx = queries.findIndex((q) => /set_config\('app\.business_entity_id'/.test(q.sql));
  const delIdx = queries.findIndex((q) => /^delete/i.test(q.sql));
  const insIdx = queries.findIndex((q) => /^insert/i.test(q.sql));
  assert.ok(gucIdx >= 0, 'set_config(app.business_entity_id, ..., true) must run');
  assert.deepEqual(queries[gucIdx]!.params, [BXR_ENTITY_ID], 'GUC value is the bound tenant id');
  assert.ok(gucIdx < delIdx && gucIdx < insIdx, 'GUC precedes every write in the transaction');
});

test('replaceCmdDailyForFacility: INSERT stamps business_entity_id and uses a TARGETLESS on conflict', async () => {
  const { db, queries } = fakeDb();
  await replaceCmdDailyForFacility(db, 'CAMH', [deposit('2026-07-01')], BXR_ENTITY_ID);
  const ins = queries.find((q) => /^insert/i.test(q.sql));
  assert.ok(ins, 'an INSERT should run for a non-empty pull');
  assert.match(ins!.sql, /business_entity_id/i, 'business_entity_id is an explicit INSERT column');
  assert.match(ins!.sql, /on conflict do nothing/i, 'targetless conflict — works under both bucket-index shapes (0031)');
  assert.ok(!/on conflict \(/i.test(ins!.sql), 'no column-list conflict target (would break across the 0031 refold)');
  assert.equal(ins!.params?.at(-1), BXR_ENTITY_ID, 'each tuple is stamped with the tenant id');
});

test('replaceCmdDailyForFacility: rejects a malformed tenant id before touching the pool', async () => {
  const { db, queries } = fakeDb();
  await assert.rejects(
    () => replaceCmdDailyForFacility(db, 'CAMH', [deposit('2026-07-01')], 'not-a-uuid'),
    /canonical UUID/,
  );
  assert.equal(queries.length, 0, 'no query may run under a malformed tenant id');
});
