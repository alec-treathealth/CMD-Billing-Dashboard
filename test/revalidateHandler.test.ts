import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRevalidateRequest } from '../src/routes/revalidateHandler.js';

const SECRET = 'super-secret-token';
const TAG = 'dashboard-aggregates';

/** A spy `revalidate` + a deps factory mirroring the production wiring. */
function makeDeps(secret: string | undefined = SECRET) {
  const calls: string[] = [];
  const deps = {
    secret,
    allowedTags: new Set([TAG]),
    defaultTag: TAG,
    revalidate: (tag: string) => calls.push(tag),
  };
  return { deps, calls };
}

const authed = `Bearer ${SECRET}`;

// --- auth ------------------------------------------------------------------

test('missing Authorization header → 401, nothing invalidated', () => {
  const { deps, calls } = makeDeps();
  const res = handleRevalidateRequest({ method: 'POST', authorization: null, body: null }, deps);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthorized' });
  assert.equal(calls.length, 0);
});

test('wrong token → 401, nothing invalidated', () => {
  const { deps, calls } = makeDeps();
  const res = handleRevalidateRequest(
    { method: 'POST', authorization: 'Bearer not-the-secret', body: null },
    deps,
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('missing/empty server secret fails closed → 401 even with a Bearer header', () => {
  // Built directly (not via makeDeps) so the undefined case isn't swallowed by a
  // default parameter — we are specifically asserting the no-secret guard.
  for (const secret of [undefined, ''] as (string | undefined)[]) {
    const calls: string[] = [];
    const deps = {
      secret,
      allowedTags: new Set([TAG]),
      defaultTag: TAG,
      revalidate: (tag: string) => calls.push(tag),
    };
    const res = handleRevalidateRequest({ method: 'POST', authorization: authed, body: null }, deps);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  }
});

// --- method ----------------------------------------------------------------

test('non-POST verbs are rejected 405 (independent of auth), nothing invalidated', () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const { deps, calls } = makeDeps();
    const res = handleRevalidateRequest({ method, authorization: authed, body: null }, deps);
    assert.equal(res.status, 405, `${method} must be 405`);
    assert.deepEqual(res.body, { error: 'method_not_allowed' });
    assert.equal(calls.length, 0);
  }
});

// --- success ---------------------------------------------------------------

test('correct token, no body → invalidates the dashboard tag exactly once', () => {
  const { deps, calls } = makeDeps();
  const res = handleRevalidateRequest({ method: 'POST', authorization: authed, body: null }, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { revalidated: true });
  assert.deepEqual(calls, [TAG]);
});

test('correct token, explicit allowlisted tag → invalidates that tag', () => {
  const { deps, calls } = makeDeps();
  const res = handleRevalidateRequest(
    { method: 'POST', authorization: authed, body: { tag: TAG } },
    deps,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [TAG]);
});

// --- tag allowlist (arbitrary tags cannot be invalidated) ------------------

test('arbitrary tag → 400, nothing invalidated', () => {
  for (const tag of ['evil', 'claims-aggregates', 'dashboard', '*', '']) {
    const { deps, calls } = makeDeps();
    const res = handleRevalidateRequest(
      { method: 'POST', authorization: authed, body: { tag } },
      deps,
    );
    assert.equal(res.status, 400, `tag=${JSON.stringify(tag)} must be 400`);
    assert.deepEqual(res.body, { error: 'bad_request' });
    assert.equal(calls.length, 0, `tag=${JSON.stringify(tag)} must invalidate nothing`);
  }
});

test('non-string / malformed tag → 400, nothing invalidated', () => {
  for (const body of [{ tag: 123 }, { tag: ['dashboard-aggregates'] }, 'not-an-object', 42]) {
    const { deps, calls } = makeDeps();
    const res = handleRevalidateRequest(
      { method: 'POST', authorization: authed, body },
      deps,
    );
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  }
});

// --- no leakage ------------------------------------------------------------

test('responses never echo the token, body, or tag value; bodies are generic', () => {
  const { deps } = makeDeps();
  const cases = [
    handleRevalidateRequest({ method: 'GET', authorization: authed, body: null }, deps),
    handleRevalidateRequest({ method: 'POST', authorization: 'Bearer x', body: { tag: 'evil' } }, deps),
    handleRevalidateRequest({ method: 'POST', authorization: authed, body: { tag: 'evil' } }, deps),
    handleRevalidateRequest({ method: 'POST', authorization: authed, body: null }, deps),
  ];
  for (const res of cases) {
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(SECRET), 'must not echo the secret');
    assert.ok(!serialized.includes('evil'), 'must not echo a rejected tag value');
  }
  // The only allowlisted-tag string that appears anywhere is in the spy, never the body.
  const ok = handleRevalidateRequest({ method: 'POST', authorization: authed, body: null }, deps);
  assert.deepEqual(ok.body, { revalidated: true });
});
