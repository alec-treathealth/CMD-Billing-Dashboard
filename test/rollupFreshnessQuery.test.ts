/**
 * S5 — the ONE honest freshness source, as SQL.
 *
 * `collections.rollup_refresh_run` is the run-log the hourly `/api/cron/refresh-charge-rollup`
 * writes (0054). Until S5 it had ZERO app-path readers: only writers existed. These assertions pin
 * the read's shape, and — more importantly — they pin the two columns it must NEVER reach for,
 * because both were measured wrong in the alarming direction and both are one word away in the same
 * schema.
 *
 * Hermetic string/param assertions in the qualifyPolicyQuery.test.ts idiom.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildRollupRefreshFreshnessQuery,
  ROLLUP_REFRESH_RUN,
} from '../src/collections/rollupFreshnessQuery';

test('rollup freshness: one row, zero params, fixed identifiers only', () => {
  const { sql, params } = buildRollupRefreshFreshnessQuery();
  assert.equal(params.length, 0, 'a global high-water mark takes no bound values');
  assert.equal(ROLLUP_REFRESH_RUN, 'collections.rollup_refresh_run');
  assert.match(sql, new RegExp(`from ${ROLLUP_REFRESH_RUN.replace('.', '\\.')}`));
  assert.match(sql, /limit 1/);
  // Never `select *` — the standing rule, and here it is also what keeps the two banned columns out.
  assert.ok(!sql.includes('*'), 'explicit projection only');
});

test('rollup freshness: only a run that FINISHED and reported ok — "started but never finished" is a failure signal, not a timestamp', () => {
  const { sql } = buildRollupRefreshFreshnessQuery();
  // 0054's header: a hard platform timeout kills the function before the UPDATE, leaving
  // ok IS NULL / finished_at IS NULL. Reading that row as freshness would print the START time of a
  // run that never completed — the one state the table exists to make visible.
  assert.match(sql, /where ok is true/);
  assert.match(sql, /finished_at is not null/);
  assert.match(sql, /to_char\(finished_at at time zone 'UTC'/, 'FULL UTC ISO — the timezone rendering is the UI\'s job');
  assert.match(sql, /HH24:MI:SS/);
});

test('rollup freshness: ordered by started_at desc so the 0054 index answers it — never a scan', () => {
  const { sql } = buildRollupRefreshFreshnessQuery();
  // 0054 creates rollup_refresh_run_started_idx on (started_at desc) and nothing on finished_at.
  // Ordering by finished_at would sort the whole log to return one row; started_at desc walks the
  // index and stops at the first ok row. For an hourly job the two orderings agree by construction.
  assert.match(sql, /order by started_at desc/);
  assert.ok(!/order by finished_at/.test(sql), 'no index on finished_at — that ordering sorts the log');
});

test('rollup freshness: the two disqualified columns are ABSENT, and that is the point of this file', () => {
  const { sql } = buildRollupRefreshFreshnessQuery();
  /* ⚠ `rollup_max_payment_date` READS INTO THE FUTURE. It is max(payment_received) over the rollup,
   * and FUTURE_PAYMENT_HORIZON_DAYS is 14 (src/collections/cmdExplorer.ts) — measured 2026-08-07 it
   * read 2026-08-12, five days ahead of the clock. "Data through 2026-08-12" is not a freshness
   * claim, it is a false one, and the column sits in the row this query selects from. */
  assert.ok(!sql.includes('rollup_max_payment_date'), 'the 14-day future horizon makes this not a freshness column');
  /* ⚠ `ingested_at` IS FIRST-SEEN, not last-checked (ON CONFLICT DO NOTHING). Measured on a healthy
   * pipeline: 3h25m / 3h54m old across three successful hourly refreshes, and the longest healthy
   * gap over 14 days is 42 HOURS. It also costs a 20,961-buffer parallel seq scan. */
  assert.ok(!sql.includes('ingested_at'), 'first-seen semantics — reads 42h stale on a healthy weekend');
  // And the caught error MESSAGE stays server-side: nothing here needs it, so nothing here carries it.
  assert.ok(!sql.includes('error'), 'the run-log\'s error text is not part of a freshness read');
});
