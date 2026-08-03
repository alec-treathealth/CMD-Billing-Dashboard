import assert from 'node:assert/strict';
import { test } from 'node:test';

// CRON_SECRET must be set before the handler's env-reading paths run; it reads
// process.env at call time, so setting it here is sufficient. Same convention as
// test/vobSyncTrigger.test.ts.
process.env.CRON_SECRET = 'test-cron-secret';
delete process.env.GITHUB_DISPATCH_TOKEN;

import { handlePayerIntelTrigger } from '../app/lib/payerIntelTrigger.js';

const AUTH = `Bearer ${process.env.CRON_SECRET}`;

/** A fetch fake that records its call and returns a Response with the given status. */
function fakeFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('rejects non-GET with 405', async () => {
  assert.equal((await handlePayerIntelTrigger({ method: 'POST', authorization: AUTH })).status, 405);
  assert.equal((await handlePayerIntelTrigger({ method: 'DELETE', authorization: AUTH })).status, 405);
});

test('rejects missing or wrong bearer with 401 — before any dispatch is attempted', async () => {
  const f = fakeFetch(204);
  assert.equal((await handlePayerIntelTrigger({ method: 'GET', authorization: null }, { token: 't', fetchImpl: f.impl })).status, 401);
  assert.equal((await handlePayerIntelTrigger({ method: 'GET', authorization: 'Bearer wrong' }, { token: 't', fetchImpl: f.impl })).status, 401);
  assert.equal(f.calls.length, 0, 'an unauthorized request must never reach GitHub');
});

test('authorized but no token → 500 dispatch_token_missing (visibly red, not silently skipped)', async () => {
  const r = await handlePayerIntelTrigger({ method: 'GET', authorization: AUTH });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'dispatch_token_missing' });
});

test('dispatches payer-intel.yml on main and reports success', async () => {
  const f = fakeFetch(204);
  const r = await handlePayerIntelTrigger({ method: 'GET', authorization: AUTH }, { token: 'tok', fetchImpl: f.impl });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, dispatched: 'payer-intel.yml', ref: 'main' });
  assert.equal(f.calls.length, 1);
  // Must target the payer-intel workflow, not vob-sync — the two share dispatchWorkflow.
  assert.ok(f.calls[0]!.url.endsWith('/actions/workflows/payer-intel.yml/dispatches'));
  assert.equal(JSON.parse(String(f.calls[0]!.init.body)).ref, 'main');
});

test('never echoes the dispatch token in the response body', async () => {
  const f = fakeFetch(422);
  const r = await handlePayerIntelTrigger({ method: 'GET', authorization: AUTH }, { token: 'super-secret-token', fetchImpl: f.impl });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.body).includes('super-secret-token'));
  assert.deepEqual(r.body, { error: 'dispatch_failed', github_status: 422 });
});

test('a thrown fetch becomes 500 dispatch_error rather than propagating', async () => {
  const impl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  const r = await handlePayerIntelTrigger({ method: 'GET', authorization: AUTH }, { token: 'tok', fetchImpl: impl });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'dispatch_error' });
});
