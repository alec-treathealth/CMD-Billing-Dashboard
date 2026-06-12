import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readmissionCandidates,
  readmissionCandidatesSql,
} from '../src/queries/readmission_candidates.js';
import type { QueryContext, QueryExecutor } from '../src/queries/types.js';

interface FakeRow {
  confidence: 'exact' | 'strong' | 'possible';
  facility_name: string;
  payer_name: string;
}

function makeFake(dataRows: FakeRow[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: QueryExecutor = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      if (sql.includes('claims.log_query')) {
        return { rows: [{ id: params[0] }] as T[], rowCount: 1 };
      }
      return { rows: dataRows as T[], rowCount: dataRows.length };
    },
  };
  return { executor, calls };
}

function ctxWith(executor: QueryExecutor, audit: string[]): QueryContext {
  return {
    executor,
    createdBy: 'sess-1',
    uuid: () => 'fixed-uuid-0000',
    now: () => new Date('2026-06-10T00:00:00.000Z'),
    audit: (line) => audit.push(line),
  };
}

// The full no-filter SQL, pinned literally so a builder regression is caught.
const SQL_NO_FILTER =
  "with f as (select * from claims.claims), " +
  "pairs as (select case " +
  "when a.member_id_norm is not null and a.member_id_norm <> '' " +
  "and b.member_id_norm is not null and b.member_id_norm <> '' " +
  "and a.member_id_norm = b.member_id_norm " +
  "and lower(a.patient_last) = lower(b.patient_last) " +
  "then 'exact' " +
  "when lower(a.patient_last) = lower(b.patient_last) " +
  "and a.payer_name = b.payer_name " +
  "and a.member_id_norm is not null and a.member_id_norm <> '' " +
  "and b.member_id_norm is not null and b.member_id_norm <> '' " +
  "and a.member_id_norm <> b.member_id_norm " +
  "then 'strong' " +
  "when claims.similarity(a.patient_last, b.patient_last) >= 0.7 " +
  "and a.payer_name = b.payer_name " +
  "and (a.member_id_norm is null or a.member_id_norm = '' " +
  "or b.member_id_norm is null or b.member_id_norm = '') " +
  "then 'possible' " +
  "end as confidence, " +
  "a.facility_name as facility_name, " +
  "a.payer_name as payer_name " +
  "from f a " +
  "join f b on a.id <> b.id " +
  "and b.date_of_service > a.date_of_service " +
  "and b.date_of_service <= a.date_of_service + ($1 * interval '1 day')" +
  ") " +
  "select confidence, facility_name, payer_name from pairs where confidence is not null";

test('readmission_candidates: no filter, default gap — exact SQL, tiers pivoted, no PHI logged', async () => {
  const { executor, calls } = makeFake([
    { confidence: 'exact', facility_name: 'My Time Recovery', payer_name: 'Aetna' },
    { confidence: 'exact', facility_name: 'My Time Recovery', payer_name: 'Aetna' },
    { confidence: 'strong', facility_name: 'Covenant Hills', payer_name: 'Cigna' },
    { confidence: 'possible', facility_name: 'My Time Recovery', payer_name: 'Beacon Carelon' },
  ]);
  const audit: string[] = [];
  const res = await readmissionCandidates({}, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    candidate_pairs: 4,
    by_confidence: { exact: 2, strong: 1, possible: 1 },
    facilities: ['Covenant Hills', 'My Time Recovery'], // distinct + sorted
    payers: ['Aetna', 'Beacon Carelon', 'Cigna'],
  });
  assert.equal(res.query_id, 'fixed-uuid-0000');

  // Exact SQL (no WHERE in the CTE) + gap_days bound at $1 = 30.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.sql, SQL_NO_FILTER);
  assert.deepEqual(calls[0]!.params, [30]);

  // query_log: function_name, non-PHI args, identity_hash null.
  const log = calls[1]!;
  assert.equal(log.params[2], 'readmission_candidates');
  assert.deepEqual(JSON.parse(log.params[3] as string), { gap_days: 30, filter: {} });
  assert.equal(log.params[5], null);

  // Audit: presence-only shape, no identity fields.
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]!), {
    timestamp: '2026-06-10T00:00:00.000Z',
    function_name: 'readmission_candidates',
    args_shape: { filter_keys: [], gap_days: 30 },
    query_id: 'fixed-uuid-0000',
    result_row_count: 4,
  });
});

test('readmission_candidates: with filter — facility $2 / payer $3, stored args non-PHI', async () => {
  const { executor, calls } = makeFake([
    { confidence: 'exact', facility_name: 'My Time Recovery', payer_name: 'Aetna' },
  ]);
  const audit: string[] = [];
  const res = await readmissionCandidates(
    { facility: 'My Time Recovery', payer: 'Aetna' },
    ctxWith(executor, audit),
  );

  assert.equal(res.summary_stats.candidate_pairs, 1);
  // Filter lives inside the pre-filter CTE; values bound at $2/$3.
  assert.equal(
    calls[0]!.sql,
    readmissionCandidatesSql('lower(facility_name) = lower($2) and lower(payer_name) = lower($3)'),
  );
  assert.ok(
    calls[0]!.sql.includes(
      'where lower(facility_name) = lower($2) and lower(payer_name) = lower($3)',
    ),
  );
  assert.deepEqual(calls[0]!.params, [30, 'My Time Recovery', 'Aetna']);

  assert.deepEqual(JSON.parse(calls[1]!.params[3] as string), {
    gap_days: 30,
    filter: { facility: 'My Time Recovery', payer: 'Aetna' },
  });
  assert.deepEqual(JSON.parse(audit[0]!).args_shape, {
    filter_keys: ['facility', 'payer'],
    gap_days: 30,
  });
});

test('readmission_candidates: custom gap_days — $1 carries the bound value', async () => {
  const { executor, calls } = makeFake([
    { confidence: 'possible', facility_name: 'Covenant Hills', payer_name: 'Cigna' },
  ]);
  const audit: string[] = [];
  const res = await readmissionCandidates({ gap_days: 7 }, ctxWith(executor, audit));

  assert.equal(calls[0]!.params[0], 7);
  assert.equal(calls[0]!.sql, SQL_NO_FILTER); // SQL identical — gap is a bound param
  assert.deepEqual(JSON.parse(calls[1]!.params[3] as string), { gap_days: 7, filter: {} });
  assert.equal(JSON.parse(audit[0]!).args_shape.gap_days, 7);
  assert.equal(res.summary_stats.candidate_pairs, 1);
});

test('readmission_candidates: empty result — zeroed tiers, empty arrays, row_count 0', async () => {
  const { executor } = makeFake([]);
  const audit: string[] = [];
  const res = await readmissionCandidates({ date_from: '2026-01-01' }, ctxWith(executor, audit));

  assert.deepEqual(res.summary_stats, {
    candidate_pairs: 0,
    by_confidence: { exact: 0, strong: 0, possible: 0 },
    facilities: [],
    payers: [],
  });
  assert.equal(JSON.parse(audit[0]!).result_row_count, 0);
});

test('readmission_candidates: gap_days out of range throws before any SQL or log', async () => {
  const { executor, calls } = makeFake([]);
  const audit: string[] = [];
  await assert.rejects(
    () => readmissionCandidates({ gap_days: 0 }, ctxWith(executor, audit)),
    /gap_days must be an integer in \[1, 365\]/,
  );
  await assert.rejects(
    () => readmissionCandidates({ gap_days: 366 }, ctxWith(executor, audit)),
    /gap_days must be an integer in \[1, 365\]/,
  );
  assert.equal(calls.length, 0); // nothing executed, nothing logged
});

test('readmissionCandidatesSql: WHERE present iff filter supplied; gap_days always $1', () => {
  const noFilter = readmissionCandidatesSql('');
  assert.ok(!noFilter.includes('where lower'));
  assert.ok(noFilter.includes("$1 * interval '1 day'"));

  const withFilter = readmissionCandidatesSql('lower(payer_name) = lower($2)');
  assert.ok(withFilter.includes('where lower(payer_name) = lower($2)'));
  assert.ok(withFilter.includes("$1 * interval '1 day'"));
});
