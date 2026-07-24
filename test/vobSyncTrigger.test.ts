import assert from 'node:assert/strict';
import { test } from 'node:test';

// CRON_SECRET must be set before importing the handler's env-reading paths; the handler reads it
// at call time (process.env), so setting it here is sufficient.
process.env.CRON_SECRET = 'test-cron-secret';
delete process.env.GITHUB_DISPATCH_TOKEN;

import { handleVobSyncTrigger, dispatchWorkflow } from '../app/lib/vobSyncTrigger.js';

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
  const r = await handleVobSyncTrigger({ method: 'POST', authorization: AUTH });
  assert.equal(r.status, 405);
});

test('rejects missing/wrong bearer with 401', async () => {
  assert.equal((await handleVobSyncTrigger({ method: 'GET', authorization: null })).status, 401);
  assert.equal((await handleVobSyncTrigger({ method: 'GET', authorization: 'Bearer wrong' })).status, 401);
});

test('authorized but no token → 500 dispatch_token_missing', async () => {
  const r = await handleVobSyncTrigger({ method: 'GET', authorization: AUTH });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'dispatch_token_missing' });
});

test('authorized + token + GitHub 204 → 200 and dispatches the right workflow', async () => {
  const { impl, calls } = fakeFetch(204);
  const r = await handleVobSyncTrigger({ method: 'GET', authorization: AUTH }, { token: 'gh-tok', fetchImpl: impl });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, dispatched: 'vob-sync.yml', ref: 'main' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/repos\/alec-treathealth\/CMD-Billing-Dashboard\/actions\/workflows\/vob-sync\.yml\/dispatches$/);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { ref: 'main' });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer gh-tok');
});

test('authorized + token + GitHub non-204 → 502 with github_status', async () => {
  const { impl } = fakeFetch(403);
  const r = await handleVobSyncTrigger({ method: 'GET', authorization: AUTH }, { token: 'gh-tok', fetchImpl: impl });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'dispatch_failed', github_status: 403 });
});

test('dispatchWorkflow returns ok only on 204, never echoes the token', async () => {
  const ok = fakeFetch(204);
  assert.deepEqual(await dispatchWorkflow({ token: 'secret-tok', fetchImpl: ok.impl }), { ok: true, status: 204 });

  const bad = fakeFetch(401);
  const res = await dispatchWorkflow({ token: 'secret-tok', fetchImpl: bad.impl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.ok(!JSON.stringify(res).includes('secret-tok')); // token never surfaced
});
