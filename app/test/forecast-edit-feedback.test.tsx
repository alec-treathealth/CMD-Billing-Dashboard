/**
 * app/lib/forecast/edit-feedback.ts — the policy that turns a Server Action result into
 * something the operator can read.
 *
 * WHY THIS FILE EXISTS. The panel used to `await` the action and DISCARD the result, so every
 * rejection — forbidden, pick_a_tenant_view, bad_amount, write_failed — was pixel-identical to
 * success: a spinner, a refetch, an unchanged tile. That is how a guaranteed no-op (a bigint id
 * arriving as the string "15", which `Number.isSafeInteger` rejects) survived unnoticed in
 * production. `runForecastEdit` is the seam that ended it, and an untested seam would let it
 * come back silently.
 *
 * ⚠️ THIS MUST BE A .tsx FILE. app/package.json runs `node --test test/*.test.tsx` — a `.ts`
 * test in this directory is never collected, so it would "pass" by never running. Verified
 * 2026-08-07. (The root suite is the mirror image: `test/**\/*.test.ts`, .ts only.)
 *
 * Pure policy, dependency-injected — no DB, no network, no React.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  forecastEditErrorText,
  forecastEditSuccess,
  intentLabel,
  runForecastEdit,
  shouldRefetch,
  type ForecastEditIntent,
  type ForecastSaveInput,
} from '../lib/forecast/edit-feedback';

const ADD: ForecastEditIntent = {
  op: 'add',
  facilityCode: 'KWC',
  payerLabel: 'BCBS AR',
  expectedDate: '2026-09-01',
  methodLabel: 'Check',
  amount: '72000.00',
};
const LANDED: ForecastEditIntent = {
  op: 'suppress',
  facilityCode: 'KWC',
  payerLabel: 'BCBS AR',
  expectedDate: '2026-05-26',
  reason: 'landed',
};
const DEL: ForecastEditIntent = { op: 'delete-edit', id: 7, label: 'KWC · BCBS AR · 2026-05-26' };

/** deps whose save/remove return a fixed result and record what they were handed. */
const deps = (result: { ok: boolean; error?: string; deleted?: boolean }) => {
  const calls: { input?: ForecastSaveInput; id?: number }[] = [];
  return {
    calls,
    save: async (input: ForecastSaveInput) => {
      calls.push({ input });
      return result.ok
        ? ({ ok: true, id: '1' } as const)
        : ({ ok: false, error: result.error ?? 'write_failed' } as const);
    },
    remove: async (id: number) => {
      calls.push({ id });
      return result.ok
        ? ({ ok: true, deleted: result.deleted ?? true } as const)
        : ({ ok: false, error: result.error ?? 'write_failed' } as const);
    },
  };
};

// --- the messages -----------------------------------------------------------

test('every server rejection produces operator English, never the raw code', () => {
  // The codes app/lib/actions.ts can actually return. A code that reached the screen verbatim
  // would be an internals leak AND unactionable.
  const codes = [
    'forbidden',
    'pick_a_tenant_view',
    'facility_not_in_tenant',
    'bad_facility',
    'bad_payer',
    'bad_date',
    'bad_method',
    'bad_amount',
    'add_needs_amount',
    'correct_needs_amount',
    'write_failed',
    'bad_kind',
    'suppress_has_amount',
    'suppress_needs_reason',
    'bad_reason',
    'bad_id',
    'something_nobody_wrote_yet',
  ];
  for (const code of codes) {
    const text = forecastEditErrorText(ADD, code);
    assert.ok(text.length > 20, `${code} must produce a sentence`);
    assert.ok(!text.includes(code), `${code} must not appear verbatim in "${text}"`);
    assert.ok(text.includes('KWC · BCBS AR'), `${code} must name the row it failed on`);
    assert.ok(/[.!]$/.test(text.trim()), `${code} must read as prose`);
  }
});

test('the actionable codes say what to do; the terminal ones do not pretend', () => {
  assert.match(forecastEditErrorText(ADD, 'pick_a_tenant_view'), /BXR or Indigo/);
  assert.match(forecastEditErrorText(ADD, 'bad_amount'), /two decimals/);
  assert.match(forecastEditErrorText(ADD, 'forbidden'), /permission/);
  // write_failed and a transport failure are the SAME epistemic class: the outcome is unknown,
  // so neither may claim the write did or did not land.
  for (const t of [forecastEditErrorText(ADD, 'write_failed'), forecastEditErrorText(ADD, null)]) {
    assert.match(t, /may not have been saved/);
  }
});

test('a delete-edit failure names the row, not an opaque id', () => {
  const text = forecastEditErrorText(DEL, 'bad_id');
  assert.ok(text.includes('KWC · BCBS AR · 2026-05-26'));
  assert.ok(!text.includes('7'), 'the row number is not how an operator identifies the row');
});

test('intentLabel falls back rather than rendering "undefined"', () => {
  assert.equal(intentLabel({ op: 'delete-edit', id: 9 }), 'this edit');
});

test('an idempotent delete of an already-gone row does NOT claim it removed something', () => {
  const gone = forecastEditSuccess(DEL, false);
  assert.equal(gone.tone, 'info');
  assert.match(gone.text, /already gone/);
  const real = forecastEditSuccess(DEL, true);
  assert.equal(real.tone, 'ok');
  assert.match(real.text, /Edit removed/);
});

test('an already-gone delete STILL refetches — deleted:false means the tile is stale', async () => {
  // Pinning a deliberate decision that reads like an inefficiency and was flagged as one in
  // review (PR #146). `deleted` is ROW_COUNT > 0 on (id, business_entity_id), and the id came
  // from this tile's own tenant-scoped render — so false means the row was there at load and is
  // gone now, i.e. somebody else removed it. Not reloading would leave the vanished row on
  // screen with a button that answers "already gone" forever.
  const d = deps({ ok: true, deleted: false });
  const r = await runForecastEdit(DEL, 'bxr', d);
  assert.equal(r.outcome.tone, 'info', 'honest about having changed nothing itself');
  assert.equal(
    r.refetch,
    true,
    'and reloads anyway, because it just learned the tile is out of date',
  );
});

test('success names the action in the past tense and carries the amount where there is one', () => {
  assert.match(forecastEditSuccess(ADD).text, /^Added — KWC · BCBS AR · 2026-09-01 · \$72,000\.00\.$/);
  assert.match(forecastEditSuccess(LANDED).text, /^Marked landed — /);
  assert.ok(!forecastEditSuccess(LANDED).text.includes('$'), 'a suppress moves no amount');
});

// --- the refetch decision ---------------------------------------------------

test('a deterministic pre-write rejection does not refetch', () => {
  // These land before recordAccess runs, so nothing changed. Refetching blanks the tile to
  // "Loading…" and throws away whatever is in the uncontrolled amount box.
  for (const code of ['forbidden', 'pick_a_tenant_view', 'bad_amount', 'bad_id']) {
    assert.equal(shouldRefetch(code, false), false, code);
  }
});

test('an unknown outcome DOES refetch — success, write_failed, and transport failure', () => {
  assert.equal(shouldRefetch(undefined, true), true, 'a successful write');
  assert.equal(shouldRefetch('write_failed', false), true, 'may have half-landed');
  assert.equal(shouldRefetch(null, false), true, 'a thrown action is equally unknown');
});

// --- marshalling ------------------------------------------------------------

test('each intent marshals to the shape the Server Action validates', async () => {
  const add = deps({ ok: true });
  await runForecastEdit(ADD, 'bxr', add);
  assert.deepEqual(add.calls[0]!.input, {
    kind: 'add',
    facilityCode: 'KWC',
    payerLabel: 'BCBS AR',
    expectedDate: '2026-09-01',
    methodLabel: 'Check',
    amount: '72000.00',
  });

  const sup = deps({ ok: true });
  await runForecastEdit(LANDED, 'bxr', sup);
  assert.deepEqual(sup.calls[0]!.input, {
    kind: 'suppress',
    facilityCode: 'KWC',
    payerLabel: 'BCBS AR',
    expectedDate: '2026-05-26',
    // 024's per-kind CHECK rejects a suppress carrying an amount, so this null is load-bearing.
    amount: null,
    suppressReason: 'landed',
    matchedEraKey: null,
  });

  const del = deps({ ok: true });
  await runForecastEdit(DEL, 'bxr', del);
  assert.equal(del.calls[0]!.id, 7, 'the id goes through as a NUMBER — see manualRowFromDb');
  assert.ok(
    Number.isSafeInteger(del.calls[0]!.id),
    'the exact predicate deleteUpcomingManual guards with, and the one that used to reject',
  );
});

test('runForecastEdit NEVER rejects — a thrown action becomes a readable outcome', async () => {
  // The call site is `void applyEdit(intent)`, so a rejection here would be an unhandled one
  // AND would leave the busy flag stuck on.
  const boom = {
    save: async () => {
      throw new Error('socket hang up');
    },
    remove: async () => {
      throw new Error('socket hang up');
    },
  };
  const r = await runForecastEdit(ADD, 'bxr', boom as never);
  assert.equal(r.outcome.tone, 'error');
  assert.match(r.outcome.text, /Could not add that payment/);
  assert.ok(!r.outcome.text.includes('socket hang up'), 'the internal error never reaches the UI');
  assert.equal(r.refetch, true, 'a thrown action leaves the server state unknown');
});

test('a rejection is surfaced, not swallowed — the regression this seam exists to stop', async () => {
  const d = deps({ ok: false, error: 'bad_id' });
  const r = await runForecastEdit(DEL, 'bxr', d);
  assert.equal(r.outcome.tone, 'error', 'the failure REACHES the operator');
  assert.match(r.outcome.text, /Could not remove that edit/);
  assert.equal(r.refetch, false, 'and nothing was written, so nothing to reload');
});
