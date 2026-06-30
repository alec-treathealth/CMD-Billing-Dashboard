import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionsYoy,
  collectionsYoySql,
  windowsFor,
} from '../src/collections/collectionsYoy.js';
import type { ExecResult, QueryExecutor } from '../src/queries/types.js';

const EXPECTED_SQL =
  `select ` +
  `round(coalesce(sum(insurance_paid) filter (where payment_date >= $1::date and payment_date <= $2::date), 0)::numeric, 2) as current_ytd_paid, ` +
  `round(coalesce(sum(insurance_paid) filter (where payment_date >= $3::date and payment_date <= $4::date), 0)::numeric, 2) as prior_ytd_paid, ` +
  `round(coalesce(sum(insurance_paid) filter (where payment_date >= $3::date and payment_date <= $5::date), 0)::numeric, 2) as prior_full_year_paid ` +
  `from collections.payment_lines`;

function fakeExecutor(
  rows: Record<string, unknown>[],
  cap: { sql?: string; params?: readonly unknown[] } = {},
): QueryExecutor {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<ExecResult<T>> {
      cap.sql = sql;
      cap.params = params;
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

test('collectionsYoySql: exact + reads only payment_lines, no PHI, no SELECT *', () => {
  const sql = collectionsYoySql();
  assert.equal(sql, EXPECTED_SQL);
  assert.ok(sql.includes('collections.payment_lines'));
  assert.ok(!/select\s+\*/i.test(sql), 'must not SELECT *');
  for (const bad of [
    'patient',
    'member_id',
    'group_number',
    'source_group_code',
    'collections_raw',
    'daily_collections',
  ]) {
    assert.ok(!sql.includes(bad), `must not reference ${bad}`);
  }
});

test('windowsFor: normal anchor → same-period + full prior-year bounds', () => {
  const { params, currentYear, priorYear } = windowsFor('2026-06-24');
  assert.equal(currentYear, 2026);
  assert.equal(priorYear, 2025);
  assert.deepEqual(params, [
    '2026-01-01', // current YTD start
    '2026-06-24', // current YTD end (= as_of)
    '2025-01-01', // prior start (shared)
    '2025-06-24', // prior same-period end
    '2025-12-31', // prior full-year end
  ]);
});

test('windowsFor: Feb-29 anchor clamps to Feb-28 when prior year is not leap', () => {
  const { params, currentYear, priorYear } = windowsFor('2024-02-29');
  assert.equal(currentYear, 2024);
  assert.equal(priorYear, 2023);
  assert.equal(params[3], '2023-02-28', 'prior same-period end clamped to Feb 28');
});

test('windowsFor: rejects a non-ISO anchor', () => {
  assert.throws(() => windowsFor('2026/06/24'), /invalid as_of/);
  assert.throws(() => windowsFor('garbage'), /invalid as_of/);
});

test('collectionsYoy: maps pg-string numerics, echoes years, one non-PHI audit line', async () => {
  const cap: { params?: readonly unknown[] } = {};
  const audit: string[] = [];
  const out = await collectionsYoy(
    { as_of: '2026-06-24' },
    {
      executor: fakeExecutor(
        [
          {
            current_ytd_paid: '28291649.01',
            prior_ytd_paid: '17774280.40',
            prior_full_year_paid: '35548560.80',
          },
        ],
        cap,
      ),
      createdBy: 'test',
      now: () => new Date('2026-06-25T00:00:00Z'),
      audit: (l) => audit.push(l),
    },
  );
  assert.equal(out.as_of, '2026-06-24');
  assert.equal(out.current_year, 2026);
  assert.equal(out.prior_year, 2025);
  assert.equal(out.current_ytd_paid, 28291649.01);
  assert.equal(out.prior_ytd_paid, 17774280.4);
  assert.equal(out.prior_full_year_paid, 35548560.8);
  // The derived date bounds reach the executor as $1..$5.
  assert.deepEqual(cap.params, [
    '2026-01-01',
    '2026-06-24',
    '2025-01-01',
    '2025-06-24',
    '2025-12-31',
  ]);
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0]!).event, 'collections_yoy');
});

test('collectionsYoy: empty result → zeros (never throws on no rows)', async () => {
  const out = await collectionsYoy(
    { as_of: '2026-06-24' },
    { executor: fakeExecutor([]), createdBy: 'test', now: () => new Date('2026-06-25T00:00:00Z'), audit: () => {} },
  );
  assert.equal(out.current_ytd_paid, 0);
  assert.equal(out.prior_ytd_paid, 0);
  assert.equal(out.prior_full_year_paid, 0);
});
