import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionsMonthlySummary,
  collectionsMonthlySummarySql,
  validateDateBound,
  type CollectionsSummaryContext,
} from '../src/collections/summary.js';
import { facilityLabel } from '../src/collections/summaryTypes.js';
import type { ExecResult, QueryExecutor } from '../src/queries/types.js';

const EXPECTED_SQL =
  `select ` +
  `to_char(date_trunc('month', dc.payment_date), 'YYYY-MM') as month, ` +
  `dc.facility_code as facility_code, ` +
  `f.facility_name as facility_name, ` +
  `count(*)::bigint as day_rows, ` +
  `coalesce(sum(dc.checks_amount), 0) as checks_amount, ` +
  `coalesce(sum(dc.eft_amount), 0) as eft_amount, ` +
  `coalesce(sum(dc.gross_amount), 0) as gross_amount ` +
  `from collections.daily_collections dc ` +
  `left join collections.facilities f on f.facility_code = dc.facility_code ` +
  `where ($1::date is null or dc.payment_date >= $1::date) ` +
  `and ($2::date is null or dc.payment_date < $2::date) ` +
  `group by 1, dc.facility_code, f.facility_name ` +
  `order by month desc, gross_amount desc`;

interface Capture {
  sql?: string;
  params?: readonly unknown[];
}

/** Fake claims_reader executor that records the SQL/params and returns fixed rows. */
function fakeExecutor(rows: Record<string, unknown>[], cap: Capture): QueryExecutor {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<ExecResult<T>> {
      cap.sql = sql;
      cap.params = params;
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

/** Context with a no-op audit sink (assert audit shape separately where needed). */
function ctxWith(executor: QueryExecutor, audit?: (line: string) => void): CollectionsSummaryContext {
  return { executor, createdBy: 'test', now: () => new Date('2026-06-14T00:00:00Z'), audit: audit ?? (() => {}) };
}

test('collectionsMonthlySummarySql: exact SQL string is stable', () => {
  assert.equal(collectionsMonthlySummarySql(), EXPECTED_SQL);
});

test('no args → both date params are null', async () => {
  const cap: Capture = {};
  await collectionsMonthlySummary({}, ctxWith(fakeExecutor([], cap)));
  assert.equal(cap.sql, EXPECTED_SQL);
  assert.deepEqual(cap.params, [null, null]);
});

test('date bounds are passed as $1/$2 verbatim', async () => {
  const cap: Capture = {};
  await collectionsMonthlySummary({ from: '2026-01-01', to: '2026-04-01' }, ctxWith(fakeExecutor([], cap)));
  assert.deepEqual(cap.params, ['2026-01-01', '2026-04-01']);
});

test('malformed date is rejected (fail-closed) before any query', async () => {
  const cap: Capture = {};
  await assert.rejects(
    () => collectionsMonthlySummary({ from: '06/01/2026' }, ctxWith(fakeExecutor([], cap))),
    /invalid from date/,
  );
  assert.equal(cap.sql, undefined, 'executor must not run on invalid input');
});

test('validateDateBound: empty/undefined → undefined; valid passes; junk throws', () => {
  assert.equal(validateDateBound('from', undefined), undefined);
  assert.equal(validateDateBound('to', ''), undefined);
  assert.equal(validateDateBound('from', '2026-12-31'), '2026-12-31');
  assert.throws(() => validateDateBound('to', '2026-13-40x'), /invalid to date/);
});

test('numeric (text) columns are parsed to numbers; rows_analyzed sums day_rows', async () => {
  const cap: Capture = {};
  const rows = [
    { month: '2026-03', facility_code: 'TMH_CA', facility_name: 'Treat CA', day_rows: '3', checks_amount: '100.00', eft_amount: '0', gross_amount: '100.00' },
    { month: '2026-03', facility_code: 'TMH_TN', facility_name: 'Treat TN', day_rows: '2', checks_amount: '5.00', eft_amount: '45.50', gross_amount: '50.50' },
  ];
  const summary = await collectionsMonthlySummary({}, ctxWith(fakeExecutor(rows, cap)));
  assert.equal(summary.rows_analyzed, 5);
  const first = summary.by_month_facility[0]!;
  assert.strictEqual(first.day_rows, 3);
  assert.strictEqual(first.checks_amount, 100);
  assert.strictEqual(first.gross_amount, 100);
  const second = summary.by_month_facility[1]!;
  assert.strictEqual(second.eft_amount, 45.5);
  assert.strictEqual(second.gross_amount, 50.5);
  // from/to echo null when unbounded
  assert.equal(summary.from, null);
  assert.equal(summary.to, null);
});

test('NULL facility_code/name → preserved as null, rendered "(unassigned)"', async () => {
  const cap: Capture = {};
  const rows = [
    { month: '2026-03', facility_code: null, facility_name: null, day_rows: '1', checks_amount: '0', eft_amount: '0', gross_amount: '25.00' },
  ];
  const summary = await collectionsMonthlySummary({}, ctxWith(fakeExecutor(rows, cap)));
  const row = summary.by_month_facility[0]!;
  assert.equal(row.facility_code, null);
  assert.equal(row.facility_name, null);
  assert.equal(facilityLabel(row), '(unassigned)');
});

test('source_group_code never appears in the output (lineage-only invariant)', async () => {
  const cap: Capture = {};
  // Even if the underlying row object carried a stray source_group_code, the
  // typed summary must not surface it.
  const rows = [
    { month: '2026-03', facility_code: null, facility_name: null, day_rows: '1', checks_amount: '0', eft_amount: '0', gross_amount: '25.00', source_group_code: 'TREAT_FRCA' },
  ];
  const summary = await collectionsMonthlySummary({}, ctxWith(fakeExecutor(rows, cap)));
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes('source_group_code'), 'no source_group_code key in output');
  assert.ok(!serialized.includes('TREAT_FRCA'), 'no group-code value in output');
  assert.deepEqual(Object.keys(summary.by_month_facility[0]!).sort(), [
    'checks_amount', 'day_rows', 'eft_amount', 'facility_code', 'facility_name', 'gross_amount', 'month',
  ]);
  // The SQL itself must never select source_group_code.
  assert.ok(!cap.sql!.includes('source_group_code'));
});

test('emits exactly one non-PHI audit line (no PHI, no query_log)', async () => {
  const cap: Capture = {};
  const lines: string[] = [];
  await collectionsMonthlySummary(
    { from: '2026-01-01' },
    ctxWith(fakeExecutor([{ month: '2026-01', facility_code: 'X', facility_name: 'X', day_rows: '1', checks_amount: '1', eft_amount: '0', gross_amount: '1' }], cap), (l) => lines.push(l)),
  );
  assert.equal(lines.length, 1);
  const audit = JSON.parse(lines[0]!);
  assert.equal(audit.event, 'collections_monthly_summary');
  assert.deepEqual(audit.args_shape, { from: '2026-01-01', to: null });
  assert.equal(audit.rows_returned, 1);
  assert.equal(audit.rows_analyzed, 1);
});
