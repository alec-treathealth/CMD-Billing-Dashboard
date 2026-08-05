/**
 * Qualify-census run-log wrapper (migration 0087).
 *
 * These tests are written to be MUTATION-RESISTANT, because the first draft was not: an adversarial
 * pass mutated the source and the suite stayed green for the ordering guarantee, the
 * synced/failed parameter order, the capacity parameter order, the duration measurement, the
 * triggered_by default, and the derived error label. Every fixture below therefore uses distinct,
 * non-symmetric values so a transposition cannot survive, and the ordering test drives its marker
 * through the SAME fake client so the interleaving is actually observable.
 *
 * Locked behaviours:
 *  1. the start row is INSERTed BEFORE the sync runs — the "killed mid-flight" evidence only
 *     exists if the write precedes the I/O;
 *  2. status derivation, including 'partial' (the state the console-only posture hid best), the
 *     silent all-boards-failed case that returns HTTP 200 today, and the conformance-gap case
 *     where a board reports itself synced while writing zeros over good data;
 *  3. logging is FAIL-SOFT — an unapplied 0087 or a refused INSERT must not take the feed down;
 *  4. a throwing sync still closes the row as 'failed' AND rethrows (never swallowed);
 *  5. a failing close never masks the original outcome;
 *  6. error labels are bounded to the 0087 CHECK (200 chars), keeping the diagnostic HEAD;
 *  7. no PHI and no unbounded value ever reaches a bound parameter;
 *  8. every statement is a frozen literal whose $n arity matches its parameter count.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import {
  deriveCensusRunStatus,
  countConformanceGaps,
  runQualifyCensusSyncLogged,
  truncateErrorLabel,
  ERROR_LABEL_MAX,
  INSERT_START_SQL,
  UPDATE_FINISH_SQL,
} from '../src/collections/qualifyCensusRun.js';
import type { CensusSyncStats } from '../src/collections/qualifyCensusSync.js';

/** A conformance entry, now FACILITY-grain (a facility can have several boards). `missingTitles`
 *  non-empty is the silent-zeroing case; the other three gap causes are exercised below. */
const conf = (
  facilityCode: string,
  missingTitles: string[] = [],
  over: Partial<import('../src/collections/qualifyCensus.js').CensusConformance> = {},
) => ({
  facilityCode,
  family: 'residential' as const,
  boardIds: ['b1'],
  itemCount: 12,
  missingTitles,
  emptyTitles: [] as string[],
  familyMismatch: null,
  settingMismatch: null,
  ...over,
});

/** Deliberately asymmetric defaults: 5/3/2 and capacity 7 vs 2 unmapped, so no two bound
 *  parameters share a value and a transposition cannot pass. */
const stats = (over: Partial<CensusSyncStats> = {}): CensusSyncStats => ({
  facilities_total: 4,
  facilities_synced: 3,
  facilities_failed: 1,
  boards_total: 5,
  boards_synced: 3,
  boards_failed: 2,
  conformance: [conf('f1'), conf('f2')],
  capacity_mapped: 7,
  capacity_unmapped: ['A', 'B'],
  blocked_boards: [],
  ...over,
});

/** An all-clean run: nothing failed, no conformance gap. */
const cleanStats = (over: Partial<CensusSyncStats> = {}): CensusSyncStats =>
  stats({ boards_total: 5, boards_synced: 5, boards_failed: 0, facilities_failed: 0, ...over });

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** Highest $n placeholder in a statement, or 0 if there are none. */
function maxPlaceholder(sql: string): number {
  return [...sql.matchAll(/\$(\d+)/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
}

/**
 * Minimal fake PoolClient recording call order. Unlike the first draft it VALIDATES bind arity the
 * way real pg does, so adding a column to UPDATE_FINISH_SQL without a matching parameter (or vice
 * versa) fails the suite instead of sailing through into a swallowed 08P01 in production.
 */
function fakeClient(opts: { failInsert?: boolean; failUpdate?: boolean; insertNoRows?: boolean } = {}) {
  const calls: Call[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    assert.equal(
      maxPlaceholder(sql),
      params.length,
      `bind arity mismatch: highest placeholder $${maxPlaceholder(sql)} vs ${params.length} params`,
    );
    if (/insert into collections\.qualify_census_run/i.test(sql)) {
      if (opts.failInsert) throw new Error('relation "collections.qualify_census_run" does not exist');
      return { rows: opts.insertNoRows ? [] : [{ id: '41' }], rowCount: 1 };
    }
    if (/update collections\.qualify_census_run/i.test(sql)) {
      if (opts.failUpdate) throw new Error('update refused');
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  // Structural typing against the real client, then one narrow cast at the boundary — `as never`
  // would make the fake's shape unverifiable, since `never` is assignable to everything.
  const client: Pick<pg.PoolClient, 'query'> = { query: query as unknown as pg.PoolClient['query'] };
  return { client: client as pg.PoolClient, calls };
}

const kind = (c: Call): string =>
  /insert into collections\.qualify_census_run/i.test(c.sql) ? 'insert_start'
  : /update collections\.qualify_census_run/i.test(c.sql) ? 'update_finish'
  : 'sync';

/** A sync that announces itself through the SAME client, so ordering is observable in `calls`. */
const markerSync = (result: CensusSyncStats | (() => never)) =>
  async (c: pg.PoolClient): Promise<CensusSyncStats> => {
    await c.query('select 1 /* sync marker */');
    if (typeof result === 'function') return result(); // returns never — narrows the union
    return result;
  };

/** Fixed clock: startedMs = 1000, finish = 1500, so duration is exactly 500. */
const fakeClock = () => {
  const ticks = [1000, 1500];
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)]!;
};

// --- 2. status derivation ------------------------------------------------------

test('status: every board synced, no gaps, is ok', () => {
  assert.equal(
    deriveCensusRunStatus({ boards_total: 2, boards_synced: 2, boards_failed: 0, facilities_failed: 0, conformance: [conf('f1')] }),
    'ok',
  );
});

test('status: SOME synced and SOME failed is partial — the state that used to hide', () => {
  assert.equal(
    deriveCensusRunStatus({ boards_total: 2, boards_synced: 1, boards_failed: 1, facilities_failed: 1, conformance: [] }),
    'partial',
  );
});

test('status: zero synced is failed — the 200-OK-but-dead-token case', () => {
  assert.equal(
    deriveCensusRunStatus({ boards_total: 2, boards_synced: 0, boards_failed: 2, facilities_failed: 2, conformance: [] }),
    'failed',
  );
});

test('status: an empty board config is ok, not failed (nothing to sync is not an incident)', () => {
  assert.equal(
    deriveCensusRunStatus({ boards_total: 0, boards_synced: 0, boards_failed: 0, facilities_failed: 0, conformance: [] }),
    'ok',
  );
});

test('status: a facility that synced with MISSING columns demotes ok to partial', () => {
  // The silent-zeroing case: the board reports itself synced, so without the conformance check
  // this run would read a clean 'ok' over a facility row just overwritten with zeros.
  assert.equal(
    deriveCensusRunStatus({
      boards_total: 2,
      boards_synced: 2,
      boards_failed: 0,
      facilities_failed: 0,
      conformance: [conf('f1'), conf('f2', ['Admit Status'])],
    }),
    'partial',
  );
});

test('status: a facility skipped with every board healthy still demotes to partial', () => {
  // Reachable two ways now that board -> facility is N:1: the upsert itself threw, or ONE board of
  // a multi-board facility failed so the facility was skipped rather than upserted from a partial
  // item set. Both leave boards_failed at 0 for the boards that did read.
  assert.equal(
    deriveCensusRunStatus({ boards_total: 2, boards_synced: 2, boards_failed: 0, facilities_failed: 1, conformance: [] }),
    'partial',
  );
});

test('status: a RESOLVED-BUT-EMPTY column demotes ok to partial — the LOS-formula case', () => {
  // The exact defect this widening exists for: 'Days in RTC' resolved by title on all 30 boards and
  // returned "" for every item, so a title-presence-only check reported conformance_gap_boards: 0
  // while avg_los_days was NULL for every facility.
  assert.equal(
    deriveCensusRunStatus({
      boards_total: 1,
      boards_synced: 1,
      boards_failed: 0,
      facilities_failed: 0,
      conformance: [conf('f1', [], { emptyTitles: ['Total Auth Days'] })],
    }),
    'partial',
  );
});

test('status: a family or care_setting mismatch demotes ok to partial', () => {
  assert.equal(
    deriveCensusRunStatus({
      boards_total: 1,
      boards_synced: 1,
      boards_failed: 0,
      facilities_failed: 0,
      conformance: [conf('f1', [], { familyMismatch: 'declared residential but lacks Admit Status' })],
    }),
    'partial',
  );
  assert.equal(
    deriveCensusRunStatus({
      boards_total: 1,
      boards_synced: 1,
      boards_failed: 0,
      facilities_failed: 0,
      conformance: [conf('f1', [], { settingMismatch: 'care_setting OP but a residential board expects IP' })],
    }),
    'partial',
  );
});

test('countConformanceGaps counts FACILITIES with gaps, not individual causes', () => {
  assert.equal(countConformanceGaps({ conformance: [] }), 0);
  assert.equal(countConformanceGaps({ conformance: [conf('f1'), conf('f2')] }), 0);
  assert.equal(
    countConformanceGaps({ conformance: [conf('f1', ['a', 'b', 'c'])] }),
    1,
    'three missing columns on one facility is ONE gapped facility',
  );
  assert.equal(countConformanceGaps({ conformance: [conf('f1', ['a']), conf('f2'), conf('f3', ['b'])] }), 2);
  // All four causes are counted, and a facility with several causes still counts once.
  assert.equal(
    countConformanceGaps({
      conformance: [
        conf('f1', [], { emptyTitles: ['Total Auth Days'] }),
        conf('f2', [], { familyMismatch: 'x' }),
        conf('f3', [], { settingMismatch: 'y' }),
        conf('f4', ['a'], { emptyTitles: ['b'], familyMismatch: 'c', settingMismatch: 'd' }),
      ],
    }),
    4,
  );
});

// --- 1. write ordering ---------------------------------------------------------

test('the start row is written BEFORE the sync runs', async () => {
  const { client, calls } = fakeClient();
  await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: markerSync(cleanStats()) });
  // The marker goes through the same client, so a hoisted INSERT would reorder this sequence.
  assert.deepEqual(calls.map(kind), ['insert_start', 'sync', 'update_finish']);
});

test('the start row precedes the sync even when the sync throws', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(() =>
    runQualifyCensusSyncLogged({
      client,
      now: fakeClock(),
      sync: markerSync(() => {
        throw new Error('monday 500');
      }),
    }),
  );
  assert.deepEqual(calls.map(kind), ['insert_start', 'sync', 'update_finish']);
});

test('the start row defaults triggered_by to cron', async () => {
  const { client, calls } = fakeClient();
  await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => cleanStats() });
  const insert = calls.find((c) => kind(c) === 'insert_start')!;
  assert.deepEqual(insert.params, ['cron'], 'a wrong default is a 23514 on every INSERT, swallowed fail-soft');
});

test('the start row records an explicit triggered_by, and the close records every count', async () => {
  const { client, calls } = fakeClient();
  const res = await runQualifyCensusSyncLogged({
    client,
    triggeredBy: 'manual',
    now: fakeClock(),
    sync: async () => stats(),
  });
  assert.deepEqual(calls.find((c) => kind(c) === 'insert_start')!.params, ['manual']);

  // ($1 duration, $2 status, $3 total, $4 synced, $5 failed, $6 cap_mapped,
  //  $7 cap_unmapped_count, $8 conformance_gaps, $9 error, $10 id)
  const p = calls.find((c) => kind(c) === 'update_finish')!.params;
  assert.equal(p[0], 500, 'duration is measured, not hardcoded');
  assert.equal(p[1], 'partial');
  assert.equal(p[2], 5, 'boards_total');
  assert.equal(p[3], 3, 'boards_synced — distinct from failed so a transposition fails');
  assert.equal(p[4], 2, 'boards_failed');
  assert.equal(p[5], 7, 'capacity_mapped — distinct from the unmapped count');
  assert.equal(p[6], 2, 'unmapped is stored as a COUNT, never the names');
  assert.equal(p[7], 0, 'no conformance gaps in this fixture');
  assert.equal(p[9], 41, 'closes the same row the insert returned');
  assert.equal(res.status, 'partial');
  assert.equal(res.run_id, 41);
  assert.equal(res.duration_ms, 500);
});

test('a conformance gap is persisted and labelled distinctly from a board failure', async () => {
  const { client, calls } = fakeClient();
  const res = await runQualifyCensusSyncLogged({
    client,
    now: fakeClock(),
    sync: async () => cleanStats({ conformance: [conf('f1'), conf('f2', ['Admit Status', 'ADM Date'])] }),
  });
  const p = calls.find((c) => kind(c) === 'update_finish')!.params;
  assert.equal(p[1], 'partial', 'every board synced, but one wrote zeros');
  assert.equal(p[7], 1, 'conformance_gap_boards');
  assert.match(String(p[8]), /conformance gap/);
  assert.doesNotMatch(String(p[8]), /board\(s\) failed/, 'a gap is NOT a failure — different operator response');
  assert.equal(res.conformance_gap_boards, 1);
});

test('an ok run stores a null error label', async () => {
  const { client, calls } = fakeClient();
  await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => cleanStats() });
  assert.equal(calls.find((c) => kind(c) === 'update_finish')!.params[8], null);
});

test('a partial run records WHICH counts failed, not just the status', async () => {
  const { client, calls } = fakeClient();
  await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => stats() });
  const label = String(calls.find((c) => kind(c) === 'update_finish')!.params[8]);
  assert.match(label, /2 of 5 board\(s\) failed/);
});

test('the all-boards-failed run closes as failed end-to-end — the dead-token case', async () => {
  // The literal scenario in the module docblock: HTTP 200 with boards_synced 0. Covered through
  // the wrapper, not just the pure derivation, so skipping or mislabelling the close is caught.
  const { client, calls } = fakeClient();
  const res = await runQualifyCensusSyncLogged({
    client,
    now: fakeClock(),
    sync: async () => stats({ boards_total: 2, boards_synced: 0, boards_failed: 2 }),
  });
  const update = calls.find((c) => kind(c) === 'update_finish');
  assert.ok(update, 'a failed run MUST still close its row');
  assert.equal(update!.params[1], 'failed');
  assert.match(String(update!.params[8]), /2 of 2 board\(s\) failed/);
  assert.equal(res.status, 'failed');
});

test('the wrapper forwards the client and the opts to the sync', async () => {
  const { client } = fakeClient();
  let seen: unknown[] = [];
  const opts = { today: '2026-08-05' };
  await runQualifyCensusSyncLogged({
    client,
    now: fakeClock(),
    opts,
    sync: async (c, o) => {
      seen = [c, o];
      return cleanStats();
    },
  });
  assert.equal(seen[0], client, 'a dropped client is a total feed failure');
  assert.deepEqual(seen[1], opts, 'a dropped opts silently ignores an operator override');
});

// --- 3. fail-soft --------------------------------------------------------------

test('an unapplied 0087 does NOT take the sync down — it runs, and run_id is null', async () => {
  const { client, calls } = fakeClient({ failInsert: true });
  let ran = false;
  const res = await runQualifyCensusSyncLogged({
    client,
    now: fakeClock(),
    sync: async () => {
      ran = true;
      return cleanStats();
    },
  });
  assert.equal(ran, true, 'the feed must survive a missing run-log table');
  assert.equal(res.run_id, null);
  assert.equal(res.status, 'ok');
  assert.ok(!calls.some((c) => kind(c) === 'update_finish'), 'no close attempted without a row id');
});

test('an INSERT that returns no row leaves run_id null rather than NaN', async () => {
  // Without the undefined guard this yields Number(undefined) = NaN, which passes a `!== null`
  // check and gets bound as the $10 row id — a 22P02 swallowed by the best-effort close.
  const { client, calls } = fakeClient({ insertNoRows: true });
  const res = await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => cleanStats() });
  assert.equal(res.run_id, null);
  assert.ok(!calls.some((c) => kind(c) === 'update_finish'));
});

test('a throwing sync with an unlogged run still propagates, and closes nothing', async () => {
  const { client, calls } = fakeClient({ failInsert: true });
  await assert.rejects(
    () => runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => { throw new Error('monday down'); } }),
    /monday down/,
  );
  assert.ok(!calls.some((c) => kind(c) === 'update_finish'));
});

// --- 4/5. throwing sync, and a failing close ------------------------------------

test('a throwing sync closes the row as failed AND rethrows', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(
    () => runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => { throw new Error('monday 401 unauthorized'); } }),
    /monday 401 unauthorized/,
  );
  const p = calls.find((c) => kind(c) === 'update_finish')!.params;
  assert.equal(p[1], 'failed');
  assert.equal(p[8], 'monday 401 unauthorized', 'the REAL message, not a synthetic count');
  assert.deepEqual(p.slice(2, 8), [0, 0, 0, 0, 0, 0], 'counts are unknown on this path and must be zeroed, not invented');
  assert.equal(p[0], 500, 'a failed run is still timed');
});

test('a failing CLOSE never masks the original error', async () => {
  const { client } = fakeClient({ failUpdate: true });
  await assert.rejects(
    () => runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => { throw new Error('ORIGINAL monday failure'); } }),
    /ORIGINAL monday failure/,
  );
});

test('a failing CLOSE on a successful run still returns the stats', async () => {
  const { client } = fakeClient({ failUpdate: true });
  const res = await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => cleanStats() });
  assert.equal(res.status, 'ok');
  assert.equal(res.boards_synced, 5);
});

// --- 6/7/8. bounds, PHI, and statement shape -------------------------------------

test('error labels are bounded to the 0087 CHECK, keeping the diagnostic HEAD', () => {
  const out = truncateErrorLabel('monday API 401: ' + 'x'.repeat(500));
  assert.equal(out.length, ERROR_LABEL_MAX);
  assert.ok(out.startsWith('monday API 401: '), 'the status code is the diagnostic part — keep the head, not the tail');
  assert.ok(out.endsWith('…'), 'truncation is marked');
});

test('truncation is exact at the CHECK boundary', () => {
  assert.equal(truncateErrorLabel('short'), 'short');
  const exact = 'x'.repeat(ERROR_LABEL_MAX);
  assert.equal(truncateErrorLabel(exact), exact, '200 chars is legal and must pass through unchanged');
  assert.equal(truncateErrorLabel('x'.repeat(ERROR_LABEL_MAX + 1)).length, ERROR_LABEL_MAX);
});

test('a long thrown message is truncated before it reaches a bound param', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(() =>
    runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: async () => { throw new Error('y'.repeat(900)); } }),
  );
  assert.ok(String(calls.find((c) => kind(c) === 'update_finish')!.params[8]).length <= ERROR_LABEL_MAX);
});

test('facility names are never bound — only their count', async () => {
  const { client, calls } = fakeClient();
  const names = ['NASHVILLE MENTAL HEALTH', 'SOME OTHER FACILITY'];
  await runQualifyCensusSyncLogged({
    client,
    now: fakeClock(),
    sync: async () => cleanStats({ capacity_unmapped: names }),
  });
  // Scan EVERY statement, sql and params — not just the update's params.
  for (const c of calls) {
    const flat = c.sql + JSON.stringify(c.params);
    for (const n of names) assert.ok(!flat.includes(n), `${n} must not reach the row`);
  }
  assert.equal(calls.find((c) => kind(c) === 'update_finish')!.params[6], 2);
});

test('every run-log statement is a frozen literal with matching $n arity', async () => {
  const { client, calls } = fakeClient();
  await runQualifyCensusSyncLogged({ client, now: fakeClock(), sync: markerSync(cleanStats()) });
  const logCalls = calls.filter((c) => kind(c) !== 'sync');
  assert.equal(logCalls.length, 2, 'non-vacuous: the loop below must actually iterate');
  // Compare against the exported constants — a runtime string can never contain '${', so sniffing
  // it for interpolation certifies nothing.
  assert.equal(logCalls[0]!.sql, INSERT_START_SQL);
  assert.equal(logCalls[1]!.sql, UPDATE_FINISH_SQL);
  for (const c of logCalls) {
    assert.equal(maxPlaceholder(c.sql), c.params.length, 'every value is bound as $n');
    assert.ok(!/\$\{/.test(c.sql));
  }
});
