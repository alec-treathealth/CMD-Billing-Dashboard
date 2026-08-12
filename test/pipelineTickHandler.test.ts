import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handlePipelineTickRequest } from '../src/routes/pipelineTickHandler.js';
import type { TickReport } from '../src/collections/pipelineTick.js';

const SECRET = 'test-cron-secret';

const report: TickReport = {
  ok: true,
  pipeline: 'cmd',
  disposition: 'ran',
  ran: [],
  held: [],
  elapsedMs: 12,
  budgetMs: 200_000,
};

const deps = (over: Partial<Parameters<typeof handlePipelineTickRequest>[1]> = {}) => ({
  secret: SECRET,
  enabled: true,
  tick: async () => report,
  ...over,
});

// ── Auth, matching the other cron handlers exactly ─────────────────────────────────────────────

test('non-GET is 405 before auth is consulted', async () => {
  let ticked = false;
  const res = await handlePipelineTickRequest(
    { method: 'POST', authorization: `Bearer ${SECRET}` },
    deps({
      tick: async () => {
        ticked = true;
        return report;
      },
    }),
  );
  assert.equal(res.status, 405);
  assert.equal(ticked, false);
});

test('a missing secret fails closed with 401 — the endpoint is never open', async () => {
  const res = await handlePipelineTickRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}` },
    deps({ secret: undefined }),
  );
  assert.equal(res.status, 401);
});

test('an empty secret also fails closed', async () => {
  const res = await handlePipelineTickRequest({ method: 'GET', authorization: 'Bearer ' }, deps({ secret: '' }));
  assert.equal(res.status, 401);
});

test('a wrong bearer is 401 and never reaches the tick', async () => {
  let ticked = false;
  const res = await handlePipelineTickRequest(
    { method: 'GET', authorization: 'Bearer nope' },
    deps({
      tick: async () => {
        ticked = true;
        return report;
      },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(ticked, false);
});

// ── Shipped disabled ───────────────────────────────────────────────────────────────────────────

test('disabled returns 200 and runs no tick', async () => {
  // 200 rather than 503 on purpose: a disabled feature is not a failure, and a permanently red cron
  // in the Vercel tab trains everyone to ignore it.
  let ticked = false;
  const res = await handlePipelineTickRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}` },
    deps({
      enabled: false,
      tick: async () => {
        ticked = true;
        return report;
      },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as { disposition: string }).disposition, 'disabled');
  assert.equal(ticked, false);
});

// ── Trigger clamping ───────────────────────────────────────────────────────────────────────────

test("?trigger=manual is passed through as the lease holder", async () => {
  let holder: string | undefined;
  await handlePipelineTickRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}`, trigger: 'manual' },
    deps({
      tick: async (h) => {
        holder = h;
        return report;
      },
    }),
  );
  assert.equal(holder, 'manual');
});

test('any other trigger value is clamped to cron — the value is stored, so it is not free-form', async () => {
  for (const raw of ['', 'cron', 'MANUAL', "'; drop table--", null, undefined]) {
    let holder: string | undefined;
    await handlePipelineTickRequest(
      { method: 'GET', authorization: `Bearer ${SECRET}`, trigger: raw },
      deps({
        tick: async (h) => {
          holder = h;
          return report;
        },
      }),
    );
    assert.equal(holder, 'cron', `trigger=${String(raw)} should clamp to cron`);
  }
});

// ── Outcomes ───────────────────────────────────────────────────────────────────────────────────

test('a successful tick returns the report verbatim', async () => {
  const res = await handlePipelineTickRequest({ method: 'GET', authorization: `Bearer ${SECRET}` }, deps());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, report);
});

test('a tick reporting a FAILED stage is still a 200 — the tick did its job', async () => {
  const failed: TickReport = {
    ...report,
    ok: false,
    ran: [{ stage: 'cmd-explorer', status: 500, ok: false, durationMs: 900, runId: 3 }],
    held: [{ stage: 'refresh-charge-rollup', runnable: false, reason: 'blocked_upstream_error', blockedBy: 'cmd-explorer' }],
  };
  const res = await handlePipelineTickRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}` },
    deps({ tick: async () => failed }),
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as TickReport).ok, false);
  // The hold is reported to the caller, not just swallowed into state.
  assert.equal((res.body as TickReport).held[0]?.reason, 'blocked_upstream_error');
});

test('a thrown tick is a generic 500 that leaks nothing', async () => {
  const res = await handlePipelineTickRequest(
    { method: 'GET', authorization: `Bearer ${SECRET}` },
    deps({
      tick: async () => {
        throw new Error(`connection to db failed for user with password ${SECRET}`);
      },
    }),
  );
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'tick_failed' });
  assert.ok(!JSON.stringify(res.body).includes(SECRET));
});
