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

function stubClient(onQuery: () => void): pg.PoolClient {
  return {
    query: async () => {
      onQuery();
      throw new Error('DB write attempted on the no-credential path');
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
    const errors: string[] = [];
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    try {
      const stats = await runQualifyCensusSync(stubClient(() => writes++));
      assert.equal(stats.boards_synced, 0, 'no board can sync without a credential');
      assert.equal(stats.boards_failed, stats.boards_total, 'every configured board reports failed');
      assert.ok(stats.boards_total > 0, 'the default board registry is non-empty');
      assert.equal(writes, 0, 'the writer connection is never touched');
      assert.equal(stats.capacity_mapped, 0, 'bed capacity cannot resolve without a credential');
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
