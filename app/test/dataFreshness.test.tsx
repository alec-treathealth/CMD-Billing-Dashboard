/**
 * The collections freshness probe: retry, loud failure, and — the point of the whole change — a
 * stale value that can no longer be presented as current.
 *
 * Background (2026-08-12): a BACKGROUND revalidation of the `collections-data-updated-at` entry
 * failed with `Connection terminated due to connection timeout` while an 87.7s refresh of a 475 MB
 * matview saturated I/O and connection slots. Next swallows a failed background revalidation and
 * serves the previous value, so the page returned 200 in 93ms with old numbers and no signal.
 * These tests pin the three behaviours that fix: retry the transient acquire, log loudly with the
 * cache key, and never render a stale value in the same words as a fresh one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  collectionsFreshness,
  FRESHNESS_CACHE_KEY,
  FRESHNESS_STALE_AFTER_MS,
  readCollectionsFreshness,
  __restoreFreshnessQueryForTests,
  __setFreshnessQueryForTests,
} from '../lib/dataFreshness';

const SCOPE = ['af504ab6-3dcd-4aa4-a93c-27bc58de4088'];

/** Capture console.error for the duration of one call. */
async function withCapturedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  try {
    return { result: await fn(), logs };
  } finally {
    console.error = original;
  }
}

/**
 * unstable_cache does NOT execute outside a Next request context — it throws, which silently
 * short-circuited an earlier draft of these tests so the probe was never reached and every
 * assertion "passed" against an unavailable state. So drive the UNCACHED probe explicitly through
 * collectionsFreshness's loader seam. Production still goes through the cached wrapper.
 */
const callProbe = (scope: string[], now: () => number = Date.now) =>
  collectionsFreshness(scope, now, readCollectionsFreshness);

// ── Retry ──────────────────────────────────────────────────────────────────────────────────────

test('a transient acquire failure is retried and succeeds on the second attempt', async () => {
  let attempts = 0;
  const prev = __setFreshnessQueryForTests(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Connection terminated due to connection timeout');
    return '2026-08-12T19:10:00.000Z';
  });
  try {
    const state = await callProbe(SCOPE);
    assert.equal(attempts, 2, 'the probe must retry once');
    assert.ok(state.status === 'current');
    assert.equal(state.updatedAt, '2026-08-12T19:10:00.000Z');
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

test('the probe gives up after TWO attempts rather than retrying forever', async () => {
  let attempts = 0;
  const prev = __setFreshnessQueryForTests(async () => {
    attempts += 1;
    throw new Error('Connection terminated due to connection timeout');
  });
  try {
    await withCapturedErrors(() => callProbe(SCOPE));
    assert.equal(attempts, 2);
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

// ── Loud failure ───────────────────────────────────────────────────────────────────────────────

test('a sustained failure logs the CACHE KEY and the tenant scope', async () => {
  const prev = __setFreshnessQueryForTests(async () => {
    throw new Error('Connection terminated due to connection timeout');
  });
  try {
    const { logs } = await withCapturedErrors(() => callProbe(SCOPE));
    const line = logs.join('\n');
    // Without the key, a swallowed background revalidation leaves nothing identifying WHICH entry
    // went stale — which is precisely what made this invisible.
    assert.match(line, new RegExp(FRESHNESS_CACHE_KEY));
    assert.match(line, /af504ab6-3dcd-4aa4-a93c-27bc58de4088/);
    assert.match(line, /Connection terminated due to connection timeout/);
    assert.match(line, /STALE/i);
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

test('a cold-miss failure degrades to unavailable instead of throwing into the page render', async () => {
  // Before this change the throw escaped an async server component and broke the whole dashboard.
  // A freshness LABEL must never be able to take down the page it annotates.
  const prev = __setFreshnessQueryForTests(async () => {
    throw new Error('Connection terminated due to connection timeout');
  });
  try {
    const { result } = await withCapturedErrors(() => callProbe(SCOPE));
    assert.equal(result.status, 'unavailable');
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

// ── Never invent a timestamp ───────────────────────────────────────────────────────────────────

test('the unavailable state carries NO timestamp at all', async () => {
  const prev = __setFreshnessQueryForTests(async () => {
    throw new Error('boom');
  });
  try {
    const { result } = await withCapturedErrors(() => callProbe(SCOPE));
    assert.equal(result.status, 'unavailable');
    assert.ok(!('updatedAt' in result), 'must not fabricate an updatedAt');
    assert.ok(!('measuredAt' in result), 'must not fabricate a measuredAt');
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

test('a genuine null (nothing ingested) is distinct from a failure', async () => {
  const prev = __setFreshnessQueryForTests(async () => null);
  try {
    const state = await callProbe(SCOPE);
    assert.ok(state.status === 'current');
    assert.equal(state.updatedAt, null);
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

test('measuredAt is a real read time, and reflects when the query actually ran', async () => {
  const before = Date.now();
  const prev = __setFreshnessQueryForTests(async () => '2026-01-01T00:00:00.000Z');
  try {
    const state = await callProbe(SCOPE);
    assert.ok(state.status !== 'unavailable');
    const measured = Date.parse(state.measuredAt);
    assert.ok(measured >= before && measured <= Date.now(), 'measuredAt must be the actual read time');
    // And it is emphatically NOT the data timestamp — conflating them is how a stale value would
    // start looking fresh.
    assert.notEqual(state.measuredAt, state.updatedAt);
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

// ── Staleness classification ───────────────────────────────────────────────────────────────────

test('the stale threshold is two full TTLs, not one', async () => {
  // One TTL would flag the ordinary stale-while-revalidate window as a problem.
  assert.equal(FRESHNESS_STALE_AFTER_MS, 600_000);
});

test('an aged measuredAt classifies as stale while keeping the REAL updatedAt', async () => {
  const prev = __setFreshnessQueryForTests(async () => '2026-08-12T19:10:00.000Z');
  try {
    // Drive the clock forward past the threshold rather than waiting.
    const future = Date.now() + FRESHNESS_STALE_AFTER_MS + 60_000;
    const state = await callProbe(SCOPE, () => future);
    assert.ok(state.status === 'stale');
    // The value itself is untouched — marking it stale must not alter what it reports.
    assert.equal(state.updatedAt, '2026-08-12T19:10:00.000Z');
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

test('a fresh read inside the window classifies as current', async () => {
  const prev = __setFreshnessQueryForTests(async () => '2026-08-12T19:10:00.000Z');
  try {
    const state = await callProbe(SCOPE, () => Date.now() + 60_000);
    assert.equal(state.status, 'current');
  } finally {
    __restoreFreshnessQueryForTests(prev);
  }
});

// ── The connection posture (fix #3: do NOT paper over contention with a longer timeout) ────────

const SRC = readFileSync(new URL('../lib/dataFreshness.ts', import.meta.url), 'utf8');

test('the probe pool is ONE connection — smaller than the shared reader pool it left', () => {
  assert.match(SRC, /max:\s*1\b/);
});

test('the acquire timeout is SHORTER than the shared pool 10s, never longer', () => {
  const m = SRC.match(/PROBE_CONNECT_TIMEOUT_MS\s*=\s*([0-9_]+)/);
  assert.ok(m, 'PROBE_CONNECT_TIMEOUT_MS not found');
  const ms = Number(m![1]!.replace(/_/g, ''));
  // Raising connectionTimeoutMillis converts a fast failure into a slow one and hides the
  // contention behind a page that merely feels sluggish. This guard is the explicit ruling.
  assert.ok(ms < 10_000, `acquire timeout must stay under the shared pool's 10s, got ${ms}`);
});

test('the probe does not reuse makeReaderPool (max:4, 10s acquire, 120s statement)', () => {
  // Match a CALL, not the identifier — the header discusses makeReaderPool by name on purpose.
  assert.doesNotMatch(SRC, /makeReaderPool\s*\(/);
});

test('a failure is rethrown, not returned as a cacheable sentinel', () => {
  // Returning a sentinel would let unstable_cache memoize the failure for the full TTL, pinning a
  // transient blip into five minutes of "no data" and discarding the last good value.
  assert.match(SRC, /throw lastErr/);
});
