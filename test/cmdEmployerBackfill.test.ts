import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planEmployerBackfill, planEmployerBackfillFromRows, applyEmployerBackfill, parseArgs } from '../src/collections/cmdEmployerBackfill.js';
import { mapReportRows } from '../src/collections/cmdExplorer.js';
import { mapRow } from '../src/collections/cmdExplorerSeed.js';
import { parseReportCsv } from '../src/collections/cmdPayer.js';

const BXR_ENTITY = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

/** One BXR-shaped CSV row. Employer is the last column, as the 10094775 export emits it. */
function csv(rows: string[][], facilityHeader = 'Facility Name'): string {
  const header = [
    'Charge From Date', 'Payment Received', 'Charge CPT Code', 'Revenue Code',
    facilityHeader, 'Patient Full Name', 'Claim Primary Member ID', 'Primary Group Number',
    'Charge/Debit Amount', 'Payment Allowed Amount', 'Charge Insurance Payments',
    'Charge Total Adjustments w/o Transfers', 'Charge Balance Due Pat', 'Charge Primary Payer Name',
    'Primary Ins Emp Name',
  ];
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

const ROW_A = [
  '03/14/2026', '03/20/2026', '90853', '0915', 'CAMH', 'DOE JANE', 'PGE081', 'GRP-7',
  '250.00', '200.00', '150.00', '10.00', '40.00', 'AETNA', 'BOEING',
];
const ROW_B = [
  '04/02/2026', '04/10/2026', 'H0019', '1002', 'DMH', 'ROE JOHN', 'ABC123', 'GRP-9',
  '500.00', '400.00', '300.00', '20.00', '80.00', 'CIGNA', '',
];

/** A stub matching the narrow db shape applyEmployerBackfill needs; records every call. */
function fakeDb(rowCountPerCall = 0) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: rowCountPerCall };
    },
  };
}

test('plan: the fingerprint it computes is BYTE-IDENTICAL to the ingest path', () => {
  // THE test for this script. The whole design rests on recomputing a key that already exists in
  // the table; a fingerprint that merely LOOKS right matches nothing and reports 0% while looking
  // like missing data rather than a bug. Compare against the production chain directly.
  const text = csv([ROW_A]);
  const plan = planEmployerBackfill(text, 'bxr', 'employer-backfill');

  const viaProduction = mapReportRows(parseReportCsv(text)).map((f) => mapRow(f, 'employer-backfill'));
  const first = viaProduction[0];
  assert.ok(first?.ok, 'the production chain must map this row');
  assert.equal(plan.pairs.size, 1);
  assert.equal([...plan.pairs.keys()][0], first.row.row_fingerprint);
  assert.equal([...plan.pairs.values()][0], 'BOEING');
});

test('plan: a blank employer is EXCLUDED — it is not a value to write', () => {
  // A blank cell means "no employer on this claim", which is already what NULL means in the column.
  // Writing '' would create a third state the UI's null-vs-value logic does not model, and would
  // put an unpickable empty option in the type-ahead.
  const plan = planEmployerBackfill(csv([ROW_A, ROW_B]), 'bxr', 'src');
  assert.equal(plan.mapped, 2, 'both rows map fine');
  assert.equal(plan.withEmployer, 1, 'only the row with an employer is a write candidate');
  assert.deepEqual([...plan.pairs.values()], ['BOEING']);
});

test('plan: Indigo needs the facility alias or every row skips', () => {
  // Indigo's export labels facility "Customer Name". mapRow REQUIRES facility, so without the
  // alias every row is dropped — a 0% match rate that reads like a normalization bug rather than
  // a missing one-line alias. Assert both directions so the alias can never be quietly removed.
  const indigoCsv = csv([ROW_A], 'Customer Name');
  const withAlias = planEmployerBackfill(indigoCsv, 'indigo', 'src');
  assert.equal(withAlias.pairs.size, 1, 'indigo maps once aliased');

  const withoutAlias = planEmployerBackfill(indigoCsv, 'bxr', 'src');
  assert.equal(withoutAlias.pairs.size, 0);
  assert.equal(withoutAlias.mapped, 0);
  assert.ok(withoutAlias.skips['facility: missing']! > 0, 'and the skip reason names the cause');
});

test('plan: skip reasons are counted by LABEL and carry no cell values', () => {
  // The dry run prints these. A label that echoed a cell would put PHI in a terminal and a log.
  const bad = [...ROW_A];
  bad[0] = ''; // charge_date missing → required
  const plan = planEmployerBackfill(csv([bad, ROW_A]), 'bxr', 'src');
  assert.equal(plan.mapped, 1);
  const labels = Object.keys(plan.skips);
  assert.ok(labels.length > 0);
  for (const l of labels) {
    assert.ok(!l.includes('DOE'), 'a skip label must never contain a patient name');
    assert.ok(!l.includes('PGE081'), 'a skip label must never contain a member id');
  }
});

test('plan: identical rows collapse to ONE pair, not two UPDATEs for the same row', () => {
  const plan = planEmployerBackfill(csv([ROW_A, ROW_A]), 'bxr', 'src');
  assert.equal(plan.parsed, 2);
  assert.equal(plan.withEmployer, 2, 'both rows carry an employer');
  assert.equal(plan.pairs.size, 1, 'but they are the same row — one fingerprint, one write');
});

test('apply: fills ONLY nulls, scopes to the tenant, and never writes the fingerprint', async () => {
  const db = fakeDb(1);
  await applyEmployerBackfill(db, new Map([['fp1', 'BOEING']]), BXR_ENTITY);
  assert.equal(db.calls.length, 1);
  const { sql, params } = db.calls[0]!;

  // idempotent + non-destructive: a value the live cron already wrote is fresher than any CSV
  assert.match(sql, /and t\.employer_name is null/);
  // tenant scope is load-bearing — row_fingerprint deliberately excludes business_entity_id (0028)
  assert.match(sql, /and t\.business_entity_id = \$3::uuid/);
  assert.equal(params[2], BXR_ENTITY);
  // The ONLY column it may set. Assert against the ISOLATED set clause, not the whole statement:
  // row_fingerprint legitimately appears in the WHERE as the match key, so a loose
  // /set .*row_fingerprint/ matches the correct SQL and would fail a passing implementation.
  const setClause = sql.slice(sql.indexOf(' set ') + 5, sql.indexOf(' from ('));
  assert.equal(setClause.trim(), 'employer_name = v.employer');
  for (const forbidden of ['row_fingerprint', 'charge_amount', 'patient_name', 'member_id', 'group_number', 'payment_received']) {
    assert.ok(!setClause.includes(forbidden), `${forbidden} must never be assigned`);
  }
  // …and row_fingerprint must still be present as the MATCH key, or nothing would be found.
  assert.match(sql, /where t\.row_fingerprint = v\.fp/);
});

test('apply: every value is a bound param — no fingerprint or employer is interpolated', async () => {
  const db = fakeDb(1);
  // An employer carrying a quote is the injection canary: if it appeared in the SQL text at all,
  // the value was concatenated rather than bound.
  await applyEmployerBackfill(db, new Map([["fp'1", "O'BRIEN CONSTRUCTION"]]), BXR_ENTITY);
  const { sql, params } = db.calls[0]!;
  assert.doesNotMatch(sql, /O'BRIEN/);
  assert.doesNotMatch(sql, /fp'1/);
  assert.deepEqual(params[0], ["fp'1"]);
  assert.deepEqual(params[1], ["O'BRIEN CONSTRUCTION"]);
});

test('apply: batches large inputs and returns the SUM of rows actually updated', async () => {
  // 1200 pairs at BATCH=500 → 3 round trips. The return is the real updated count, which is what
  // the match rate is computed from — reporting pairs.size instead would always claim 100%.
  const pairs = new Map<string, string>();
  for (let i = 0; i < 1200; i++) pairs.set(`fp${i}`, `EMP${i}`);
  const db = fakeDb(500);
  const updated = await applyEmployerBackfill(db, pairs, BXR_ENTITY);
  assert.equal(db.calls.length, 3);
  assert.equal(updated, 1500, 'sums rowCount across batches (stub returns 500 each)');
  assert.equal((db.calls[0]!.params[0] as string[]).length, 500);
  assert.equal((db.calls[2]!.params[0] as string[]).length, 200, 'last batch is the remainder');
});

test('apply: an empty plan issues NO query at all', async () => {
  const db = fakeDb(0);
  const updated = await applyEmployerBackfill(db, new Map(), BXR_ENTITY);
  assert.equal(updated, 0);
  assert.equal(db.calls.length, 0, 'nothing to write must mean nothing sent');
});

test('apply: a null rowCount counts as zero, never as NaN', async () => {
  // node-pg types rowCount as number|null. `updated += null` would produce 0 via coercion, but
  // `updated += undefined` yields NaN and would render the match rate as "NaN%" — assert the guard.
  const db = { calls: [] as unknown[], query: async () => ({ rowCount: null }) };
  const updated = await applyEmployerBackfill(db, new Map([['fp1', 'BOEING']]), BXR_ENTITY);
  assert.equal(updated, 0);
  assert.ok(Number.isInteger(updated));
});

// --- argument surface for the API source (2026-08-17) --------------------------------------

test('parseArgs: api mode REQUIRES --filter — the window must never be implicit', () => {
  const argv = (...a: string[]) => ['node', 'cmdEmployerBackfill.ts', ...a];
  // A saved filter is the ONLY thing bounding an API pull. Defaulting it would quietly backfill
  // some other window than the operator asked for, and the write is not reversible per-row.
  assert.throws(
    () => parseArgs(argv('--tenant=bxr', '--source=api')),
    /--filter=.*required/,
  );
  const ok = parseArgs(argv('--tenant=bxr', '--source=api', '--filter=10148846', '--report=10094775'));
  assert.equal(ok.source, 'api');
  assert.equal(ok.filterId, '10148846');
  assert.equal(ok.reportId, '10094775');
  assert.equal(ok.commit, false, 'dry-run is the default and must stay so');
});

test('parseArgs: csv stays the default source and still requires --file', () => {
  const argv = (...a: string[]) => ['node', 'cmdEmployerBackfill.ts', ...a];
  assert.equal(parseArgs(argv('--tenant=bxr', '--file=x.csv')).source, 'csv', 'back-compat');
  assert.throws(() => parseArgs(argv('--tenant=bxr')), /--file=.*required/);
  // csv mode must NOT demand a filter — it has no API pull to bound.
  assert.doesNotThrow(() => parseArgs(argv('--tenant=indigo', '--file=x.csv')));
});

test('parseArgs: rejects an unknown --source rather than silently picking one', () => {
  const argv = (...a: string[]) => ['node', 'cmdEmployerBackfill.ts', ...a];
  assert.throws(() => parseArgs(argv('--tenant=bxr', '--source=sftp', '--file=x.csv')), /--source must be csv or api/);
  assert.throws(() => parseArgs(argv('--tenant=acme', '--file=x.csv')), /--tenant must be bxr or indigo/);
});

test('planEmployerBackfillFromRows is the SAME planner the CSV path uses', () => {
  // The fingerprint is only useful if it is byte-identical to the one ingest wrote, so the two
  // sources must not drift. Feeding the identical rows through both entry points must agree
  // EXACTLY — a divergence here would surface only as an unexplained low match rate.
  const text = csv([ROW_A, ROW_B]);
  const viaCsv = planEmployerBackfill(text, 'bxr', 'employer-backfill');
  const viaRows = planEmployerBackfillFromRows(parseReportCsv(text), 'bxr', 'employer-backfill');
  assert.deepEqual([...viaRows.pairs.entries()], [...viaCsv.pairs.entries()]);
  assert.equal(viaRows.mapped, viaCsv.mapped);
  assert.equal(viaRows.withEmployer, viaCsv.withEmployer);
  assert.equal(viaRows.parsed, viaCsv.parsed);
});
