import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionsDaily,
  collectionsDailySql,
  collectionsKpis,
  collectionsKpisSql,
  type CollectionsQueryContext,
} from '../src/collections/daily.js';
import type { ExecResult, QueryExecutor } from '../src/queries/types.js';

const DAILY_SQL =
  `with anchor as (select max(payment_date) as max_d from collections.daily_collections) ` +
  `select ` +
  `to_char(dc.payment_date, 'YYYY-MM-DD') as payment_date, ` +
  `dc.facility_code as facility_code, ` +
  `f.facility_name as facility_name, ` +
  `dc.checks_amount as checks_amount, ` +
  `dc.eft_amount as eft_amount, ` +
  `dc.gross_amount as gross_amount ` +
  `from collections.daily_collections dc ` +
  `cross join anchor a ` +
  `left join collections.facilities f on f.facility_code = dc.facility_code ` +
  `where (case when $1::date is null and $2::date is null ` +
  `then dc.payment_date >= date_trunc('month', a.max_d)::date ` +
  `and dc.payment_date < (date_trunc('month', a.max_d) + interval '1 month')::date ` +
  `else (($1::date is null or dc.payment_date >= $1::date) ` +
  `and ($2::date is null or dc.payment_date < $2::date)) end) ` +
  `and ($3::text is null or dc.facility_code = $3::text) ` +
  `order by dc.payment_date desc, f.facility_name nulls last, dc.facility_code`;

const KPIS_SQL =
  `with anchor as (select coalesce($1::date, max(payment_date)) as d from collections.daily_collections) ` +
  `select ` +
  `to_char(a.d, 'YYYY-MM-DD') as as_of, ` +
  `dc.facility_code as facility_code, ` +
  `f.facility_name as facility_name, ` +
  `coalesce(sum(dc.checks_amount) filter (where dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d), 0) as mtd_checks, ` +
  `coalesce(sum(dc.eft_amount) filter (where dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d), 0) as mtd_eft, ` +
  `coalesce(sum(dc.gross_amount) filter (where dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d), 0) as mtd_gross, ` +
  `coalesce(sum(dc.checks_amount) filter (where dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d), 0) as ytd_checks, ` +
  `coalesce(sum(dc.eft_amount) filter (where dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d), 0) as ytd_eft, ` +
  `coalesce(sum(dc.gross_amount) filter (where dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d), 0) as ytd_gross ` +
  `from collections.daily_collections dc ` +
  `cross join anchor a ` +
  `left join collections.facilities f on f.facility_code = dc.facility_code ` +
  `group by a.d, dc.facility_code, f.facility_name ` +
  `order by ytd_gross desc`;

interface Capture {
  sql?: string;
  params?: readonly unknown[];
}

function fakeExecutor(rows: Record<string, unknown>[], cap: Capture): QueryExecutor {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<ExecResult<T>> {
      cap.sql = sql;
      cap.params = params;
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

function ctx(executor: QueryExecutor, audit?: (l: string) => void): CollectionsQueryContext {
  return { executor, createdBy: 'test', now: () => new Date('2026-06-14T00:00:00Z'), audit: audit ?? (() => {}) };
}

// --- SQL exactness + forbidden-table guards ---------------------------------

test('collectionsDailySql: exact + reads only daily_collections/facilities', () => {
  const sql = collectionsDailySql();
  assert.equal(sql, DAILY_SQL);
  assert.ok(!sql.includes('collections_raw'));
  assert.ok(!sql.includes('payment_lines'));
  assert.ok(!sql.includes('source_group_code'));
  assert.ok(sql.includes('$1::date') && sql.includes('$2::date') && sql.includes('$3::text'));
});

test('collectionsKpisSql: exact + reads only daily_collections/facilities', () => {
  const sql = collectionsKpisSql();
  assert.equal(sql, KPIS_SQL);
  assert.ok(!sql.includes('collections_raw'));
  assert.ok(!sql.includes('payment_lines'));
  assert.ok(!sql.includes('source_group_code'));
  assert.ok(sql.includes('$1::date'));
});

// --- collectionsDaily params --------------------------------------------------

test('daily: no args → [null, null, null] (SQL CASE applies latest-month default)', async () => {
  const cap: Capture = {};
  await collectionsDaily({}, ctx(fakeExecutor([], cap)));
  assert.equal(cap.sql, DAILY_SQL);
  assert.deepEqual(cap.params, [null, null, null]);
});

test('daily: explicit window + facility are passed/trimmed as $1/$2/$3', async () => {
  const cap: Capture = {};
  await collectionsDaily({ facility_code: ' CAMH ', from: '2026-06-01', to: '2026-07-01' }, ctx(fakeExecutor([], cap)));
  assert.deepEqual(cap.params, ['2026-06-01', '2026-07-01', 'CAMH']);
});

test('daily: malformed date rejected before any query', async () => {
  const cap: Capture = {};
  await assert.rejects(() => collectionsDaily({ from: '6/1/2026' }, ctx(fakeExecutor([], cap))), /invalid from date/);
  assert.equal(cap.sql, undefined);
});

test('daily: numeric (text) amounts parsed; echo + row_count correct; no PHI/group keys', async () => {
  const cap: Capture = {};
  const rows = [
    { payment_date: '2026-06-30', facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH', checks_amount: '100.00', eft_amount: '0', gross_amount: '100.00' },
    { payment_date: '2026-06-29', facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH', checks_amount: '5.50', eft_amount: '44.50', gross_amount: '50.00' },
  ];
  const res = await collectionsDaily({ facility_code: 'CAMH' }, ctx(fakeExecutor(rows, cap)));
  assert.equal(res.row_count, 2);
  assert.equal(res.facility_code, 'CAMH');
  assert.strictEqual(res.rows[0]!.gross_amount, 100);
  assert.strictEqual(res.rows[1]!.eft_amount, 44.5);
  assert.deepEqual(Object.keys(res.rows[0]!).sort(), [
    'checks_amount', 'eft_amount', 'facility_code', 'facility_name', 'gross_amount', 'payment_date',
  ]);
  const s = JSON.stringify(res);
  for (const bad of ['source_group_code', 'patient', 'member_id', 'inpatient', 'outpatient']) {
    assert.ok(!s.toLowerCase().includes(bad), `must not include ${bad}`);
  }
});

// --- collectionsKpis MTD/YTD + checks/eft split ------------------------------

test('kpis: as_of param passthrough; overall = sum of by_facility; checks/eft split present', async () => {
  const cap: Capture = {};
  const rows = [
    { as_of: '2026-06-30', facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH',
      mtd_checks: '10', mtd_eft: '5', mtd_gross: '15', ytd_checks: '100', ytd_eft: '50', ytd_gross: '150' },
    { as_of: '2026-06-30', facility_code: 'DMH', facility_name: 'DALLAS MENTAL HEALTH LLC',
      mtd_checks: '2', mtd_eft: '3', mtd_gross: '5', ytd_checks: '20', ytd_eft: '30', ytd_gross: '50' },
  ];
  const k = await collectionsKpis({ as_of: '2026-06-30' }, ctx(fakeExecutor(rows, cap)));
  assert.deepEqual(cap.params, ['2026-06-30']);
  assert.equal(k.as_of, '2026-06-30');
  // MTD overall
  assert.strictEqual(k.mtd.checks, 12);
  assert.strictEqual(k.mtd.eft, 8);
  assert.strictEqual(k.mtd.gross, 20);
  // YTD overall
  assert.strictEqual(k.ytd.checks, 120);
  assert.strictEqual(k.ytd.eft, 80);
  assert.strictEqual(k.ytd.gross, 200);
  // checks + eft reconcile to gross in the fixture
  assert.strictEqual(k.ytd.checks + k.ytd.eft, k.ytd.gross);
  assert.deepEqual(Object.keys(k.by_facility[0]!).sort(), [
    'facility_code', 'facility_name', 'mtd_checks', 'mtd_eft', 'mtd_gross', 'ytd_checks', 'ytd_eft', 'ytd_gross',
  ]);
});

test('kpis: overall totals are rounded to cents (no float artifacts)', async () => {
  // 0.1 + 0.2 is the canonical float trap; summed totals must round to 0.30.
  const rows = [
    { as_of: '2026-06-30', facility_code: 'A', facility_name: 'A',
      mtd_checks: '0.1', mtd_eft: '0', mtd_gross: '0.1', ytd_checks: '0.1', ytd_eft: '0', ytd_gross: '0.1' },
    { as_of: '2026-06-30', facility_code: 'B', facility_name: 'B',
      mtd_checks: '0.2', mtd_eft: '0', mtd_gross: '0.2', ytd_checks: '0.2', ytd_eft: '0', ytd_gross: '0.2' },
  ];
  const k = await collectionsKpis({}, ctx(fakeExecutor(rows, {})));
  assert.strictEqual(k.mtd.gross, 0.3);
  assert.strictEqual(k.mtd.checks, 0.3);
  assert.strictEqual(k.ytd.gross, 0.3);
});

test('kpis: per-facility money fields are rounded to cents', async () => {
  const rows = [
    { as_of: '2026-06-30', facility_code: 'A', facility_name: 'A',
      mtd_checks: '1.005', mtd_eft: '2.999', mtd_gross: '4.004',
      ytd_checks: '10.1', ytd_eft: '20.2', ytd_gross: '30.30000000000001' },
  ];
  const k = await collectionsKpis({}, ctx(fakeExecutor(rows, {})));
  const f = k.by_facility[0]!;
  assert.strictEqual(f.mtd_eft, 3.0);
  assert.strictEqual(f.mtd_gross, 4.0);
  assert.strictEqual(f.ytd_gross, 30.3);
});

test('daily: row money fields are rounded to cents', async () => {
  const rows = [
    { payment_date: '2026-06-30', facility_code: 'A', facility_name: 'A',
      checks_amount: 12.30000000000001, eft_amount: '0.1', gross_amount: 12.4 },
  ];
  const res = await collectionsDaily({}, ctx(fakeExecutor(rows, {})));
  assert.strictEqual(res.rows[0]!.checks_amount, 12.3);
  assert.strictEqual(res.rows[0]!.eft_amount, 0.1);
  assert.strictEqual(res.rows[0]!.gross_amount, 12.4);
});

test('kpis: empty data → as_of falls back to arg, zeros everywhere', async () => {
  const cap: Capture = {};
  const k = await collectionsKpis({ as_of: '2026-03-15' }, ctx(fakeExecutor([], cap)));
  assert.equal(k.as_of, '2026-03-15');
  assert.deepEqual(k.mtd, { checks: 0, eft: 0, gross: 0 });
  assert.deepEqual(k.ytd, { checks: 0, eft: 0, gross: 0 });
  assert.equal(k.by_facility.length, 0);
});

test('kpis: no IP/OP keys anywhere (deferred this slice)', async () => {
  const cap: Capture = {};
  const rows = [{ as_of: '2026-06-30', facility_code: 'CAMH', facility_name: 'X',
    mtd_checks: '1', mtd_eft: '1', mtd_gross: '2', ytd_checks: '1', ytd_eft: '1', ytd_gross: '2' }];
  const k = await collectionsKpis({}, ctx(fakeExecutor(rows, cap)));
  const keys = JSON.stringify(k).toLowerCase();
  for (const bad of ['inpatient', 'outpatient', 'ip_billing', 'billing_amt', 'source_group_code']) {
    assert.ok(!keys.includes(bad), `must not include ${bad}`);
  }
});

test('kpis + daily each emit exactly one non-PHI audit line', async () => {
  const dl: string[] = [];
  await collectionsDaily({}, ctx(fakeExecutor([], {}), (l) => dl.push(l)));
  assert.equal(dl.length, 1);
  assert.equal(JSON.parse(dl[0]!).event, 'collections_daily');

  const kl: string[] = [];
  await collectionsKpis({}, ctx(fakeExecutor([], {}), (l) => kl.push(l)));
  assert.equal(kl.length, 1);
  assert.equal(JSON.parse(kl[0]!).event, 'collections_kpis');
});
