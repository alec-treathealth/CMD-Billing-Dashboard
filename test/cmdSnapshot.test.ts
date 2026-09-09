/**
 * Hermetic tests for the CMD V2 snapshot transport (src/collections/cmdSnapshot.ts). A fake fetch
 * exercises every classification branch; no network, no credentials, no PHI (the "zip" is four
 * signature bytes plus filler — never a real snapshot).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CmdSnapshotError, cmdFetchSnapshot, MAX_SNAPSHOT_BYTES } from '../src/collections/cmdSnapshot.js';

const auth = { kind: 'basic', username: 'u', password: 'p' } as const;

function fakeFetch(status: number, body: Buffer | string, headers: Record<string, string> = {}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    // Assert the auth envelope and the method, structurally.
    const h = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(init?.method, 'GET');
    assert.match(h.Authorization ?? '', /^Basic /);
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
}

const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

test('200 + ZIP signature → kind zip with the raw bytes', async () => {
  const res = await cmdFetchSnapshot({ baseUrl: 'https://x.test/', customerId: '10027973', auth, fetchImpl: fakeFetch(200, ZIP_HEAD, { 'content-type': 'application/zip' }) });
  assert.equal(res.kind, 'zip');
  if (res.kind === 'zip') assert.equal(res.bytes.length, ZIP_HEAD.length);
});

test('the URL is the documented v2 customer path (no trailing-slash doubling)', async () => {
  let seen = '';
  const f = (async (url: string | URL | Request) => { seen = String(url); return new Response(ZIP_HEAD, { status: 200 }); }) as unknown as typeof fetch;
  await cmdFetchSnapshot({ baseUrl: 'https://webapi.example/', customerId: '10027973', auth, fetchImpl: f });
  assert.equal(seen, 'https://webapi.example/v2/customer/10027973/snapshot');
});

test('404 → not_configured (a normal outcome, never a throw)', async () => {
  const res = await cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10030472', auth, fetchImpl: fakeFetch(404, '<html>not found</html>') });
  assert.deepEqual(res, { kind: 'not_configured' });
});

test('401 and 403 → unauthorized', async () => {
  for (const status of [401, 403]) {
    const res = await cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10030472', auth, fetchImpl: fakeFetch(status, 'denied') });
    assert.deepEqual(res, { kind: 'unauthorized' });
  }
});

test('200 with a non-ZIP body → unrecognized_body carrying bytes + digest only', async () => {
  await assert.rejects(
    cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10027973', auth, fetchImpl: fakeFetch(200, 'No snapshot available today.') }),
    (e: unknown) => {
      assert.ok(e instanceof CmdSnapshotError);
      assert.equal(e.code, 'unrecognized_body');
      assert.equal(e.status, 200);
      assert.equal(e.byteLength, 'No snapshot available today.'.length);
      assert.match(e.sha256 ?? '', /^[0-9a-f]{64}$/);
      // The message never carries body text.
      assert.equal(e.message.includes('snapshot available'), false);
      return true;
    },
  );
});

test('other non-2xx → http_status with the status', async () => {
  await assert.rejects(
    cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10027973', auth, fetchImpl: fakeFetch(503, 'busy') }),
    (e: unknown) => e instanceof CmdSnapshotError && e.code === 'http_status' && e.status === 503,
  );
});

test('a body over the cap → response_too_large (declared via content-length, or measured)', async () => {
  await assert.rejects(
    cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10027973', auth, maxBytes: 16, fetchImpl: fakeFetch(200, Buffer.concat([ZIP_HEAD, Buffer.alloc(100)])) }),
    (e: unknown) => e instanceof CmdSnapshotError && e.code === 'response_too_large',
  );
  await assert.rejects(
    cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10027973', auth, fetchImpl: fakeFetch(200, ZIP_HEAD, { 'content-length': String(MAX_SNAPSHOT_BYTES + 1) }) }),
    (e: unknown) => e instanceof CmdSnapshotError && e.code === 'response_too_large',
  );
});

test('a thrown fetch → request_failed; a malformed customer id never reaches the wire', async () => {
  const boom = (async () => { throw new Error('ECONNRESET https://secret@host'); }) as unknown as typeof fetch;
  await assert.rejects(
    cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '10027973', auth, fetchImpl: boom }),
    (e: unknown) => e instanceof CmdSnapshotError && e.code === 'request_failed' && !e.message.includes('secret'),
  );
  let called = false;
  const spy = (async () => { called = true; return new Response(ZIP_HEAD); }) as unknown as typeof fetch;
  await assert.rejects(cmdFetchSnapshot({ baseUrl: 'https://x.test', customerId: '1; drop', auth, fetchImpl: spy }));
  assert.equal(called, false);
});
