/**
 * Guards replaceCmdDailyForFacility's DATE-SCOPED replace. The cron's saved CMD filter windows
 * on a rolling (current-month) payment-received range, so the per-facility replace must delete
 * ONLY the payment_date span the pull covers — never a facility-wide wipe that would erase the
 * earlier months the Master BXR chart still needs. An empty pull must delete nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceCmdDailyForFacility, type Db } from '../src/collections/db.js';
import type { CmdDailyDeposit } from '../src/collections/cmdExplorer.js';

interface Recorded { sql: string; params?: unknown[] }

function fakeDb(): { db: Db; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      queries.push({ sql: s, params });
      if (/^delete/i.test(s)) return { rowCount: 5, rows: [] };
      if (/^insert/i.test(s)) return { rowCount: (params ? params.length / 8 : 0), rows: [] };
      return { rowCount: 0, rows: [] }; // begin / commit
    },
    release: () => {},
  };
  const db = { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => client } as unknown as Db;
  return { db, queries };
}

const deposit = (payment_date: string): CmdDailyDeposit => ({
  facility_code: 'CAMH', payment_date, checks_amount: '0', eft_amount: '100.00', gross_amount: '100.00',
});

test('replaceCmdDailyForFacility: DELETE is scoped to the pulled [min,max] payment_date span', async () => {
  const { db, queries } = fakeDb();
  await replaceCmdDailyForFacility(db, 'CAMH', [deposit('2026-07-02'), deposit('2026-07-01'), deposit('2026-07-03')]);
  const del = queries.find((q) => /^delete/i.test(q.sql));
  assert.ok(del, 'a scoped DELETE should run for a non-empty pull');
  assert.match(del!.sql, /payment_date between \$2 and \$3/i, 'DELETE must be span-scoped, not a facility-wide wipe');
  assert.deepEqual(del!.params, ['CAMH', '2026-07-01', '2026-07-03'], 'span = min..max of the pulled dates');
});

test('replaceCmdDailyForFacility: an EMPTY pull deletes nothing (history is preserved)', async () => {
  const { db, queries } = fakeDb();
  const res = await replaceCmdDailyForFacility(db, 'CAMH', []);
  assert.equal(queries.some((q) => /^delete/i.test(q.sql)), false, 'no DELETE may run when the window is empty');
  assert.deepEqual(res, { deleted: 0, inserted: 0 });
});
