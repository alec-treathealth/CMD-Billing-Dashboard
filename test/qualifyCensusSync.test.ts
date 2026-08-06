/**
 * Phase G census SYNC — the credential failure mode, pinned (Phase A0, 2026-08-04).
 *
 * The invariant: a missing/blank MONDAY_SECRET_API_KEY must degrade to the honest
 * "no data yet" state — the sync reports every board failed, writes NOTHING, and never
 * throws (so the cron route returns 200 with failure counts, not a 500, and the
 * auth-fit factor stays `available: false` instead of fabricating a score).
 *
 * This is hermetic despite living in the I/O twin: mondayToken() throws while the
 * fetch OPTIONS are being built — before fetch is invoked — so no network I/O can
 * occur on this path. The invalid-key (API-rejected) path shares the same per-board
 * catch but requires a live call; it is exercised by the operator CLI, not here.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type pg from 'pg';
import { runQualifyCensusSync } from '../src/collections/qualifyCensusSync';
import { FACILITY_BED_CAPACITY, MONDAY_CENSUS_FACILITIES } from '../src/collections/qualifyCensus';

/**
 * Every query throws, which pins two things at once: no WRITE reaches the table on the
 * no-credential path, and the one READ the sync now issues first (care_setting, for the
 * family <-> care_setting assertion) is FAIL-SOFT — a refused select must not take the feed down.
 * `onWrite` counts only mutating statements, so the read cannot mask a regression in the write path.
 */
function stubClient(onWrite: () => void, onRead: () => void = () => {}): pg.PoolClient {
  return {
    query: async (sql?: unknown) => {
      const text = typeof sql === 'string' ? sql.toLowerCase() : '';
      if (/^\s*(insert|update|delete)\b/.test(text)) onWrite();
      else onRead();
      throw new Error('DB statement attempted on the no-credential path');
    },
  } as unknown as pg.PoolClient;
}

for (const [label, value] of [
  ['absent', undefined],
  ['blank', '   '],
] as const) {
  test(`missing monday key (${label}): every board fails, zero writes, no throw — the honest degrade`, async () => {
    const savedKey = process.env.MONDAY_SECRET_API_KEY;
    const savedError = console.error;
    if (value === undefined) delete process.env.MONDAY_SECRET_API_KEY;
    else process.env.MONDAY_SECRET_API_KEY = value;
    let writes = 0;
    let reads = 0;
    const errors: string[] = [];
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    try {
      const stats = await runQualifyCensusSync(stubClient(() => writes++, () => reads++));
      assert.equal(stats.boards_synced, 0, 'no board can sync without a credential');
      assert.equal(stats.boards_failed, stats.boards_total, 'every configured board reports failed');
      assert.ok(stats.boards_total > 0, 'the default board registry is non-empty');
      assert.equal(writes, 0, 'NOTHING is written — the table keeps its previous rows');
      // The care_setting read is attempted and refused; the sync must survive that.
      assert.ok(reads > 0, 'the care_setting read is attempted before any monday I/O');
      assert.equal(stats.facilities_synced, 0, 'no facility is upserted without a credential');
      assert.equal(stats.facilities_failed, stats.facilities_total, 'every facility reports failed');
      // Bed capacity SURVIVES a dead credential now that it is curated in code — that is the point
      // of curating it. It used to be 0 here because the only source was the monday Facility Info
      // board. Every residential facility still reports a capacity; no outpatient one does.
      const residential = MONDAY_CENSUS_FACILITIES.filter((f) => f.family === 'residential').length;
      assert.equal(stats.capacity_mapped, residential, 'curated capacity does not depend on monday');
      assert.ok(errors.length > 0, 'the failure is reported, never swallowed');
      for (const e of errors) {
        assert.ok(!/Bearer|eyJ/.test(e), 'error output never carries token material');
      }
    } finally {
      console.error = savedError;
      if (savedKey === undefined) delete process.env.MONDAY_SECRET_API_KEY;
      else process.env.MONDAY_SECRET_API_KEY = savedKey;
    }
  });
}

/**
 * The two behaviours that ship in the SYNC layer had no coverage at all: the wall-clock budget that
 * stops a 24-board run from being killed mid-flight, and the curated bed capacity that beats the
 * (stale) monday board. Both are exercised here without touching the network — the budget test never
 * reaches monday, and the upsert test stubs `fetch` with canned board payloads.
 */

/** A client that records every statement so the upsert's bound params can be asserted. */
function capturingClient(): { client: pg.PoolClient; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    query: async (sql?: unknown, params?: unknown) => {
      calls.push({ sql: String(sql), params: (params as unknown[]) ?? [] });
      // The care_setting read is the only SELECT the sync issues; give it a residential answer.
      if (/from collections\.facilities/i.test(String(sql))) {
        return { rows: [{ facility_code: 'NASH', care_setting: 'IP' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.PoolClient;
  return { client, calls };
}

test('wall-clock budget: an exhausted budget SKIPS facilities instead of being killed mid-run', async () => {
  // budgetMs 0 with a monotonic clock means the guard trips before the first facility, so this needs
  // no credential and makes no monday call — the guard is checked BEFORE any I/O by design.
  const { client, calls } = capturingClient();
  const stats = await runQualifyCensusSync(client, {
    facilities: [
      { facilityCode: 'NASH', family: 'residential', boardIds: ['1'] },
      { facilityCode: 'LSMH', family: 'residential', boardIds: ['2'] },
    ],
    today: '2026-08-11',
    budgetMs: 0,
    now: (() => {
      let t = 0;
      return () => (t += 1000); // every read advances a second: started=1000, first check=2000 > 0
    })(),
  });
  assert.equal(stats.facilities_skipped_budget, 2, 'both facilities skipped, none attempted');
  assert.equal(stats.facilities_synced, 0);
  assert.equal(stats.facilities_failed, 0, 'skipped is NOT failed — nothing went wrong, there was no time');
  assert.equal(stats.boards_synced, 0);
  assert.ok(
    !calls.some((c) => /insert into collections\.qualify_facility_census/i.test(c.sql)),
    'a skipped facility keeps its previous row — stale beats half-written',
  );
});

test('upsert: curated bed capacity wins over the board, and los_sample is written (0088)', async () => {
  const savedKey = process.env.MONDAY_SECRET_API_KEY;
  const savedFetch = globalThis.fetch;
  const savedInfo = console.info;
  const savedWarn = console.warn;
  process.env.MONDAY_SECRET_API_KEY = 'test-token-not-a-real-key';
  console.info = () => {};
  console.warn = () => {};

  // Canned monday responses. The Facility Info board deliberately reports a DIFFERENT bed count
  // (8) than the curated map holds for NASH (20) — the exact live staleness this precedence fixes.
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown }).body ?? '{}')) as { query: string };
    const q = body.query;
    let data: unknown = {};
    if (/columns \{ id title \}/.test(q)) {
      data = {
        boards: [
          {
            columns: [
              { id: 'st', title: 'Admit Status' },
              { id: 'adm', title: 'ADM Date' },
              { id: 'dc', title: 'DC Date' },
              { id: 'auth', title: 'Total Auth Days' },
              { id: 'ur', title: 'Next UR Date' },
              { id: 'beds', title: '# of Beds' },
            ],
          },
        ],
      };
    } else if (/items \{ name/.test(q)) {
      data = { boards: [{ items_page: { items: [{ name: 'Nashville Mental Health', column_values: [{ id: 'beds', text: '8' }] }] } }] };
    } else {
      // Four admitted clients with computable stays -> clears the 3-sample floor.
      const mk = (adm: string) => ({
        column_values: [
          { id: 'st', text: 'Admitted' },
          { id: 'adm', text: adm },
          { id: 'dc', text: '' },
          { id: 'auth', text: '30' },
          { id: 'ur', text: '' },
        ],
      });
      data = {
        boards: [
          { items_page: { cursor: null, items: [mk('2026-08-01'), mk('2026-08-02'), mk('2026-08-03'), mk('2026-08-04')] } },
        ],
      };
    }
    return { ok: true, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const { client, calls } = capturingClient();
    const stats = await runQualifyCensusSync(client, {
      facilities: [{ facilityCode: 'NASH', family: 'residential', boardIds: ['7422342993'] }],
      today: '2026-08-11',
    });
    assert.equal(stats.facilities_synced, 1);

    const upsert = calls.find((c) => /insert into collections\.qualify_facility_census/i.test(c.sql));
    assert.ok(upsert, 'the facility was upserted');
    // Param order from buildUpsertCensusRowQuery: facility_code, board_id, board_family,
    // admitted_count, open_beds, bed_capacity, avg_auth_days, avg_los_days, auth_sample,
    // los_sample, next_ur_date.
    assert.equal(upsert.params[0], 'NASH');
    assert.equal(upsert.params[5], FACILITY_BED_CAPACITY['NASH'], 'curated 20 wins over the board’s 8');
    assert.equal(upsert.params[5], 20);
    assert.equal(upsert.params[8], 4, 'auth_sample');
    assert.equal(upsert.params[9], 4, 'los_sample is written (0088)');
    // The floor no longer lives here: the average is stored honestly and ratingV2 decides.
    assert.ok(typeof upsert.params[7] === 'number' && (upsert.params[7] as number) > 0, 'avg_los_days stored, not nulled');
  } finally {
    globalThis.fetch = savedFetch;
    console.info = savedInfo;
    console.warn = savedWarn;
    if (savedKey === undefined) delete process.env.MONDAY_SECRET_API_KEY;
    else process.env.MONDAY_SECRET_API_KEY = savedKey;
  }
});

test('upsert: a sample BELOW the floor is still stored honestly — suppression is the rating layer’s job', async () => {
  const savedKey = process.env.MONDAY_SECRET_API_KEY;
  const savedFetch = globalThis.fetch;
  const savedInfo = console.info;
  const savedWarn = console.warn;
  process.env.MONDAY_SECRET_API_KEY = 'test-token-not-a-real-key';
  console.info = () => {};
  console.warn = () => {};

  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown }).body ?? '{}')) as { query: string };
    const q = body.query;
    let data: unknown = {};
    if (/columns \{ id title \}/.test(q)) {
      data = { boards: [{ columns: [
        { id: 'st', title: 'Admit Status' }, { id: 'adm', title: 'ADM Date' },
        { id: 'dc', title: 'DC Date' }, { id: 'auth', title: 'Total Auth Days' },
        { id: 'ur', title: 'Next UR Date' },
      ] }] };
    } else if (/items \{ name/.test(q)) {
      data = { boards: [{ items_page: { items: [] } }] };
    } else {
      data = { boards: [{ items_page: { cursor: null, items: [
        { column_values: [
          { id: 'st', text: 'Admitted' }, { id: 'adm', text: '2026-08-01' },
          { id: 'dc', text: '' }, { id: 'auth', text: '30' }, { id: 'ur', text: '' },
        ] },
      ] } }] };
    }
    return { ok: true, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;

  try {
    const { client, calls } = capturingClient();
    await runQualifyCensusSync(client, {
      facilities: [{ facilityCode: 'NASH', family: 'residential', boardIds: ['7422342993'] }],
      today: '2026-08-11',
    });
    const upsert = calls.find((c) => /insert into collections\.qualify_facility_census/i.test(c.sql));
    assert.ok(upsert);
    assert.equal(upsert.params[9], 1, 'los_sample = 1, below the floor of 3');
    // THE REGRESSION THIS PINS: the floor used to null this here, which made the rating say "no
    // length-of-stay data" about a facility that had some. The table now stores what it measured.
    assert.equal(upsert.params[7], 10, 'avg_los_days stored honestly (2026-08-01 -> 2026-08-11)');
  } finally {
    globalThis.fetch = savedFetch;
    console.info = savedInfo;
    console.warn = savedWarn;
    if (savedKey === undefined) delete process.env.MONDAY_SECRET_API_KEY;
    else process.env.MONDAY_SECRET_API_KEY = savedKey;
  }
});

// ── The saturated-alarm regression (diagnosed 2026-08-06) ───────────────────────────────────────
//
// cmd_rollup_writer had no SELECT on collections.facilities, so the care_setting read raised 42501
// every run. The fail-soft catch absorbed it, checkCareSetting saw `undefined` for every facility,
// and the run log reported `conformance_gap_boards: 23 of 23, status: partial` indefinitely — an
// alarm that could not distinguish a real regression from itself, hiding 6 genuine gaps underneath.
// Migration 0089 grants the SELECT; these pin the code half so the next such omission cannot hide.

/** A pg-shaped error: the driver sets `.code` to the SQLSTATE, which is what the guard reads. */
function pgError(code: string, message = 'permission denied'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function clientThatFailsCareSettingRead(err: Error): pg.PoolClient {
  return {
    query: async (sql?: unknown) => {
      const text = typeof sql === 'string' ? sql.toLowerCase() : '';
      if (text.includes('from collections.facilities')) throw err;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.PoolClient;
}

test('care_setting read denied (42501) THROWS — a permission error is an outage, not a data state', async () => {
  const saved = process.env.MONDAY_SECRET_API_KEY;
  process.env.MONDAY_SECRET_API_KEY = 'test-token-not-used-the-throw-precedes-any-fetch';
  try {
    await assert.rejects(
      () => runQualifyCensusSync(clientThatFailsCareSettingRead(pgError('42501')), {}),
      // Names the SQLSTATE, the role, the table and the migration — an operator can act on it.
      (e: unknown) => {
        const m = e instanceof Error ? e.message : '';
        assert.match(m, /42501/);
        assert.match(m, /cmd_rollup_writer/);
        assert.match(m, /collections\.facilities/);
        assert.match(m, /0089/);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.MONDAY_SECRET_API_KEY;
    else process.env.MONDAY_SECRET_API_KEY = saved;
  }
});

test('a NON-permission care_setting failure still fail-softs — a blip must not take the feed down', async () => {
  const savedKey = process.env.MONDAY_SECRET_API_KEY;
  const savedError = console.error;
  delete process.env.MONDAY_SECRET_API_KEY; // every board then fails fast, with zero network I/O
  const errors: string[] = [];
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    // 08006 = connection_failure: transient, and the distinction that matters. It degrades.
    const stats = await runQualifyCensusSync(clientThatFailsCareSettingRead(pgError('08006', 'conn lost')), {});
    assert.ok(stats.boards_total > 0, 'the sync still ran rather than throwing');
    assert.ok(
      errors.some((e) => e.includes('care_setting read failed')),
      'and the degrade stayed discoverable in the logs',
    );
  } finally {
    console.error = savedError;
    if (savedKey !== undefined) process.env.MONDAY_SECRET_API_KEY = savedKey;
  }
});

test('care_setting read returning ZERO rows for a non-empty ask THROWS — RLS-empty is silent', async () => {
  // The failure 0090 fixed: collections.facilities has RLS and cmd_rollup_writer matched no policy,
  // so the read SUCCEEDED and returned nothing. No error means the 42501 guard cannot see it; the
  // only signal is "we asked for 23 codes and got 0 back".
  const client = {
    query: async (sql?: unknown) => {
      const text = typeof sql === 'string' ? sql.toLowerCase() : '';
      if (text.includes('from collections.facilities')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.PoolClient;
  const saved = process.env.MONDAY_SECRET_API_KEY;
  process.env.MONDAY_SECRET_API_KEY = 'unused-the-throw-precedes-any-fetch';
  try {
    await assert.rejects(
      () => runQualifyCensusSync(client, {}),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : '';
        assert.match(m, /0 rows/);
        assert.match(m, /0089/);   // the GRANT
        assert.match(m, /0090/);   // the RLS policy — both gates named
        assert.match(m, /rolbypassrls/); // and the reason verifying as postgres misses it
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.MONDAY_SECRET_API_KEY;
    else process.env.MONDAY_SECRET_API_KEY = saved;
  }
});

test('a PARTIAL care_setting result stays fail-soft — a roster gap is not a visibility failure', async () => {
  // Exactly-zero is the predicate, deliberately. One configured facility with no roster row yet is a
  // legitimate data state and must not take the whole sync down.
  const client = {
    query: async (sql?: unknown) => {
      const text = typeof sql === 'string' ? sql.toLowerCase() : '';
      if (text.includes('from collections.facilities')) {
        return { rows: [{ facility_code: 'NASH', care_setting: 'IP' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.PoolClient;
  const savedKey = process.env.MONDAY_SECRET_API_KEY;
  const savedError = console.error;
  delete process.env.MONDAY_SECRET_API_KEY; // boards fail fast, zero network I/O
  console.error = () => {};
  try {
    const stats = await runQualifyCensusSync(client, {});
    assert.ok(stats.boards_total > 0, 'one row back is enough to proceed');
  } finally {
    console.error = savedError;
    if (savedKey !== undefined) process.env.MONDAY_SECRET_API_KEY = savedKey;
  }
});
