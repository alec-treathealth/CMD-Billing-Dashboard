/**
 * COMPLETED-STAY OUTCOMES SYNC (0091 refresh). Hermetic — both databases are injected stubs.
 *
 * The two properties that matter and must not regress: the aggregate runs in the SOURCE so no
 * patient row ever crosses projects, and facility mapping is EXPLICIT so a rename can never
 * attribute one building's length of stay to another.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  runFacilityOutcomesSync,
  OUTCOMES_SOURCE_SQL,
  OUTCOMES_UPSERT_SQL,
  OUTCOME_FACILITY_CODES,
  OUTCOME_EXCLUDED,
  OUTCOMES_MIN_STAYS,
  OUTCOMES_WINDOW_DAYS,
} from '../src/collections/facilityOutcomesSync.js';

type Call = { sql: string; params: unknown[] };
function stubs(sourceRows: unknown[]) {
  const writes: Call[] = [];
  const reads: Call[] = [];
  return {
    writes,
    reads,
    source: { query: async (sql: string, params: unknown[]) => { reads.push({ sql, params }); return { rows: sourceRows, rowCount: sourceRows.length }; } } as never,
    writer: { query: async (sql: string, params: unknown[]) => { writes.push({ sql, params }); return { rows: [], rowCount: 1 }; } } as never,
  };
}
const row = (o: Partial<Record<string, unknown>> & { facility: string }) => ({
  stays_sample: 100, avg_los_days: 30.5, auth_sample: 80, avg_auth_days: 32.1, ...o,
});

test('PHI: the source query AGGREGATES — it selects no patient-grain column', () => {
  // The GROUP BY runs in the source database; only facility-grain rows cross the wire. A regression
  // to a row-level copy would move a limited data set (facility + admit + discharge) across a
  // project boundary for data this factor does not need.
  assert.match(OUTCOMES_SOURCE_SQL, /group by facility/);
  assert.match(OUTCOMES_SOURCE_SQL, /count\(\*\)::int as stays_sample/);
  for (const bare of ['adm_date as', 'dc_date as', 'select \\*', 'dc_terms', 'is_ama']) {
    assert.doesNotMatch(OUTCOMES_SOURCE_SQL, new RegExp(bare), `must not project ${bare}`);
  }
  // Dates appear ONLY inside aggregate/window predicates, never as output columns.
  assert.match(OUTCOMES_SOURCE_SQL, /avg\(dc_date - adm_date\)/);
});

test('source query counts COMPLETED stays only, and cannot average a negative length', () => {
  assert.match(OUTCOMES_SOURCE_SQL, /dc_date is not null/, 'a stay in progress is not a completed stay');
  // A reversed pair would contribute a negative LOS to an average that feeds a rating factor.
  assert.match(OUTCOMES_SOURCE_SQL, /dc_date >= adm_date/);
  // Windowed by DISCHARGE date — a stay belongs to the period it finished in.
  assert.match(OUTCOMES_SOURCE_SQL, /dc_date >= current_date - \$1::int/);
  assert.doesNotMatch(OUTCOMES_SOURCE_SQL, /adm_date >= current_date/);
});

test('window days is BOUND, never interpolated, and defaults to the measured 365', async () => {
  const s = stubs([]);
  await runFacilityOutcomesSync(s.source, s.writer);
  assert.deepEqual(s.reads[0]!.params, [OUTCOMES_WINDOW_DAYS]);
  assert.equal(OUTCOMES_WINDOW_DAYS, 365);
});

test('mapped facilities upsert under their ROSTER code, not their source label', async () => {
  const s = stubs([row({ facility: 'Opus' }), row({ facility: 'Hillside' })]);
  const stats = await runFacilityOutcomesSync(s.source, s.writer);
  assert.equal(stats.facilities_written, 2);
  assert.equal(s.writes[0]!.params[0], '10021573', 'Opus -> its 8-digit CMD customer id');
  assert.equal(s.writes[1]!.params[0], '10026624', 'Hillside -> 10026624');
  assert.match(String(s.writes[0]!.sql), /on conflict \(facility_code\) do update/, 'idempotent');
  assert.equal(s.writes[0]!.params[5], OUTCOMES_WINDOW_DAYS, 'window rides the row, self-describing');
});

test('an UNKNOWN source facility is reported, never guessed at', async () => {
  const s = stubs([row({ facility: 'Opus' }), row({ facility: 'Brand New House' })]);
  const saved = console.error;
  console.error = () => {};
  try {
    const stats = await runFacilityOutcomesSync(s.source, s.writer);
    assert.deepEqual(stats.unmapped, ['Brand New House']);
    assert.equal(stats.facilities_written, 1, 'the unknown one is NOT written under a guessed code');
  } finally {
    console.error = saved;
  }
});

test('a KNOWN exclusion is silent — a decision is not a defect', async () => {
  const s = stubs([row({ facility: 'MHC' }), row({ facility: 'AMH' }), row({ facility: 'Wellness Recovery' })]);
  const stats = await runFacilityOutcomesSync(s.source, s.writer);
  assert.deepEqual(stats.unmapped, [], 'excluded facilities do not read as unmapped');
  assert.equal(stats.facilities_written, 0);
  // Each exclusion carries its reason, so a later reader can tell "decided against" from "missed".
  for (const k of Object.keys(OUTCOME_EXCLUDED)) assert.ok(OUTCOME_EXCLUDED[k]!.length > 20, `${k} states why`);
});

test('a THIN window does not overwrite a good previous row with a worse one', async () => {
  const s = stubs([row({ facility: 'Opus', stays_sample: OUTCOMES_MIN_STAYS - 1 })]);
  const stats = await runFacilityOutcomesSync(s.source, s.writer);
  assert.deepEqual(stats.skipped_thin, ['Opus']);
  assert.equal(s.writes.length, 0, 'nothing written — the rating layer would suppress it anyway');
});

test('a facility with stays but NO authorized days stores a null average, never a fabricated one', async () => {
  const s = stubs([row({ facility: 'Opus', auth_sample: 0, avg_auth_days: null })]);
  await runFacilityOutcomesSync(s.source, s.writer);
  assert.equal(s.writes[0]!.params[3], 0, 'auth_sample 0');
  assert.equal(s.writes[0]!.params[4], null, 'avg_auth_days null — the rating reads the sample and suppresses');
});

test('every mapped code is a plausible roster key, and the map has no duplicate targets', () => {
  const codes = Object.values(OUTCOME_FACILITY_CODES);
  assert.equal(new Set(codes).size, codes.length, 'two source facilities must never share one code');
  for (const c of codes) assert.match(c, /^(\d{8}|[A-Z]{3,12})$/, `${c} is a mnemonic or an 8-digit CMD id`);
  // A facility cannot be both mapped and excluded — that would be two answers to one question.
  for (const k of Object.keys(OUTCOME_EXCLUDED)) {
    assert.equal(OUTCOME_FACILITY_CODES[k], undefined, `${k} is excluded, so it must not also be mapped`);
  }
});

test('the upsert binds every value and names only fixed identifiers', () => {
  assert.match(OUTCOMES_UPSERT_SQL, /insert into collections\.qualify_facility_outcomes/);
  const placeholders = (OUTCOMES_UPSERT_SQL.match(/\$\d+/g) ?? []).length;
  assert.equal(placeholders, 7, 'seven bound values; now() is SQL, not a client clock');
  assert.doesNotMatch(OUTCOMES_UPSERT_SQL, /'\s*\|\|/, 'no string concatenation into SQL');
});
