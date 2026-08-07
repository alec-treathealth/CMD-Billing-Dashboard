/**
 * Qualify v3 — the shell's state machine (F3b).
 *
 * The point of extracting `shellReducer` was that these rules existed only as ~58 adjacent `setX()`
 * calls in a component that no test could mount (it needs `useActionState`). So: no React here, no
 * rendering, no DOM. Just (state, action) → state.
 *
 * TWO LAYERS:
 *   1 · A FIELD-WRITE TABLE. Every action is dispatched against one maximally-dirty fixture and the
 *       result is compared to `{...before, ...declaredWrites}` — which pins the writes AND the
 *       non-writes in one assertion. If an action ever starts touching a fourteenth field, the row
 *       for it fails.
 *   2 · The named INVARIANTS from the module header (a–l), asserted directly, because "search
 *       clears everything downstream" and "retryNonce is never reset" are the claims a future
 *       refactor will be tempted to break.
 *
 * PHI: the fixture carries no member identifier of any kind — the typed term deliberately does not
 * live in this state (it stays in the shell's ref). Payer and employer strings below are invented.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { QualifySnapshot } from '../lib/qualify/contract';
import { NO_ANSWER_FILTERS } from '../components/qualify/v3/resolution-flow';
import {
  INITIAL_SHELL_STATE,
  shellReducer,
  type ShellAction,
  type ShellState,
} from '../components/qualify/v3/flow-state';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

// Identity is all the reducer cares about; the shape is irrelevant to it.
const SNAP_A = { resolved: { payerName: 'ALPHA MUTUAL' } } as unknown as QualifySnapshot;
const SNAP_B = { resolved: { payerName: 'BETA MUTUAL' } } as unknown as QualifySnapshot;

/**
 * Every field at a NON-default, distinguishable value. `picked` and `skipped` are both true, which
 * the UI can never produce — deliberate: a field-write table wants a fixture where any write to any
 * field is visible, not a reachable screen state.
 */
function dirty(over: Partial<ShellState> = {}): ShellState {
  return {
    payerPick: 'ALPHA MUTUAL',
    picked: true,
    skipped: true,
    filters: { planTypes: ['PPO'], funding: ['self_funded'], employers: ['NORTHWIND LOGISTICS'] },
    employerQuery: 'north',
    planFilter: 'gold',
    autoAsk: true,
    backTo: 'payer',
    snapshot: SNAP_A,
    snapshotError: 'failed',
    retryNonce: 7,
    payerOverride: 'ALPHA MUTUAL OF THE MIDWEST',
    windowDays: 180,
    loadedKey: 'p:ALPHA|w:180|f:|e:',
    ...over,
  };
}

/** Every action, once — the loop set for the cross-cutting invariants (c, d). */
const EVERY_ACTION: ShellAction[] = [
  { type: 'search_submitted' },
  { type: 'skipped' },
  { type: 'plan_submitted' },
  { type: 'went_back', target: 'identify' },
  { type: 'went_back', target: 'payer' },
  { type: 'went_back', target: 'plan' },
  { type: 'payer_picked', payer: 'BETA MUTUAL' },
  { type: 'plan_filter_changed', value: 'silver' },
  { type: 'employer_query_changed', value: 'south' },
  { type: 'filter_toggled', facet: 'planType', value: 'HMO' },
  { type: 'filters_cleared' },
  { type: 'retry_requested' },
  { type: 'snapshot_requested' },
  { type: 'snapshot_resolved', snapshot: SNAP_B, scopeKey: 'p:BETA|w:90|f:|e:' },
  { type: 'snapshot_failed' },
  { type: 'ai_armed' },
  { type: 'ai_disarmed' },
  { type: 'payer_override_changed', label: 'BETA MUTUAL INC' },
  { type: 'window_days_changed', days: 30 },
];

// ── 1 · The field-write table ────────────────────────────────────────────────────────────────────

const TABLE: { name: string; action: ShellAction; writes: Partial<ShellState> }[] = [
  {
    name: 'search_submitted writes twelve and keeps retryNonce + loadedKey',
    action: { type: 'search_submitted' },
    writes: {
      payerPick: null,
      picked: false,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      employerQuery: '',
      planFilter: '',
      autoAsk: false,
      backTo: null,
      snapshot: null,
      snapshotError: null,
      payerOverride: null,
      windowDays: null,
    },
  },
  {
    name: 'skipped writes ten — and NOT windowDays or autoAsk',
    action: { type: 'skipped' },
    writes: {
      skipped: true,
      picked: false,
      payerPick: null,
      planFilter: '',
      backTo: null,
      filters: NO_ANSWER_FILTERS,
      employerQuery: '',
      payerOverride: null,
      snapshot: null,
      snapshotError: null,
    },
  },
  {
    name: 'plan_submitted writes seven — and NOT payerPick/planFilter/payerOverride/windowDays/autoAsk',
    action: { type: 'plan_submitted' },
    writes: {
      picked: true,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      employerQuery: '',
      backTo: null,
      snapshot: null,
      snapshotError: null,
    },
  },
  {
    name: "went_back('identify') writes twelve, payerPick among them",
    action: { type: 'went_back', target: 'identify' },
    writes: {
      snapshot: null,
      snapshotError: null,
      autoAsk: false,
      payerOverride: null,
      windowDays: null,
      picked: false,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      employerQuery: '',
      payerPick: null,
      planFilter: '',
      backTo: 'identify',
    },
  },
  {
    name: "went_back('payer') writes twelve, payerPick among them",
    action: { type: 'went_back', target: 'payer' },
    writes: {
      snapshot: null,
      snapshotError: null,
      autoAsk: false,
      payerOverride: null,
      windowDays: null,
      picked: false,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      employerQuery: '',
      payerPick: null,
      planFilter: '',
      backTo: 'payer',
    },
  },
  {
    name: "went_back('plan') writes eleven — the carrier pick SURVIVES",
    action: { type: 'went_back', target: 'plan' },
    writes: {
      snapshot: null,
      snapshotError: null,
      autoAsk: false,
      payerOverride: null,
      windowDays: null,
      picked: false,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      employerQuery: '',
      planFilter: '',
      backTo: 'plan',
    },
  },
  {
    name: 'payer_picked writes the pick and clears backTo, nothing else',
    action: { type: 'payer_picked', payer: 'BETA MUTUAL' },
    writes: { payerPick: 'BETA MUTUAL', backTo: null },
  },
  {
    name: 'plan_filter_changed writes planFilter only',
    action: { type: 'plan_filter_changed', value: 'silver' },
    writes: { planFilter: 'silver' },
  },
  {
    name: 'employer_query_changed writes employerQuery only',
    action: { type: 'employer_query_changed', value: 'south' },
    writes: { employerQuery: 'south' },
  },
  {
    name: 'filters_cleared writes filters + employerQuery only',
    action: { type: 'filters_cleared' },
    writes: { filters: NO_ANSWER_FILTERS, employerQuery: '' },
  },
  {
    name: 'retry_requested writes snapshotError + retryNonce ONLY',
    action: { type: 'retry_requested' },
    writes: { snapshotError: null, retryNonce: 8 },
  },
  {
    name: 'snapshot_requested writes snapshotError only',
    action: { type: 'snapshot_requested' },
    writes: { snapshotError: null },
  },
  {
    name: 'snapshot_resolved writes snapshot + loadedKey only — and never the error',
    action: { type: 'snapshot_resolved', snapshot: SNAP_B, scopeKey: 'p:BETA|w:90|f:|e:' },
    writes: { snapshot: SNAP_B, loadedKey: 'p:BETA|w:90|f:|e:' },
  },
  {
    name: 'snapshot_failed writes snapshotError ONLY — the F2 rule',
    action: { type: 'snapshot_failed' },
    writes: { snapshotError: 'failed' },
  },
  { name: 'ai_armed writes autoAsk only', action: { type: 'ai_armed' }, writes: { autoAsk: true } },
  { name: 'ai_disarmed writes autoAsk only', action: { type: 'ai_disarmed' }, writes: { autoAsk: false } },
  {
    name: 'payer_override_changed writes payerOverride only — the snapshot stays on screen',
    action: { type: 'payer_override_changed', label: 'BETA MUTUAL INC' },
    writes: { payerOverride: 'BETA MUTUAL INC' },
  },
  {
    name: 'window_days_changed writes windowDays only — the snapshot stays on screen',
    action: { type: 'window_days_changed', days: 30 },
    writes: { windowDays: 30 },
  },
];

for (const row of TABLE) {
  test(`F3b field-write table: ${row.name}`, () => {
    const before = dirty();
    const after = shellReducer(before, row.action);
    assert.deepEqual(after, { ...dirty(), ...row.writes });
    assert.deepEqual(before, dirty(), 'the reducer never mutates the state it was given');
  });
}

test('F3b: the initial state is the fourteen shell defaults, filters by shared reference', () => {
  assert.deepEqual(INITIAL_SHELL_STATE, {
    payerPick: null,
    picked: false,
    skipped: false,
    filters: { planTypes: [], funding: [], employers: [] },
    employerQuery: '',
    planFilter: '',
    autoAsk: false,
    backTo: null,
    snapshot: null,
    snapshotError: null,
    retryNonce: 0,
    payerOverride: null,
    windowDays: null,
    loadedKey: null,
  });
  assert.equal(Object.keys(INITIAL_SHELL_STATE).length, 14, 'fourteen fields, no more');
  assert.equal(INITIAL_SHELL_STATE.filters, NO_ANSWER_FILTERS, 'the SHARED constant, not a copy');
});

// ── 2 · The named invariants ─────────────────────────────────────────────────────────────────────

test('INV a: a new search clears EVERYTHING downstream, from any prior state', () => {
  // Walk the machine into a thoroughly-used state first, so this is not just "dirty fixture in".
  let s = INITIAL_SHELL_STATE;
  s = shellReducer(s, { type: 'payer_picked', payer: 'ALPHA MUTUAL' });
  s = shellReducer(s, { type: 'plan_submitted' });
  s = shellReducer(s, { type: 'filter_toggled', facet: 'funding', value: 'self_funded' });
  s = shellReducer(s, { type: 'employer_query_changed', value: 'north' });
  s = shellReducer(s, { type: 'window_days_changed', days: 365 });
  s = shellReducer(s, { type: 'payer_override_changed', label: 'ALPHA MUTUAL OF THE MIDWEST' });
  s = shellReducer(s, { type: 'ai_armed' });
  s = shellReducer(s, { type: 'snapshot_resolved', snapshot: SNAP_A, scopeKey: 'k1' });
  s = shellReducer(s, { type: 'snapshot_failed' });
  s = shellReducer(s, { type: 'retry_requested' });

  const after = shellReducer(s, { type: 'search_submitted' });
  assert.deepEqual(
    after,
    { ...INITIAL_SHELL_STATE, retryNonce: 1, loadedKey: 'k1' },
    'twelve fields back to their defaults; only the two carry-through fields differ',
  );
});

test('INV b: all four navigation paths clear snapshot AND snapshotError together', () => {
  const nav: ShellAction[] = [
    { type: 'search_submitted' },
    { type: 'skipped' },
    { type: 'plan_submitted' },
    { type: 'went_back', target: 'plan' },
  ];
  for (const action of nav) {
    const after = shellReducer(dirty(), action);
    assert.equal(after.snapshot, null, `${action.type} clears the snapshot`);
    assert.equal(after.snapshotError, null, `${action.type} clears the error with it`);
  }
});

test('INV c: retryNonce is monotonic and is never reset — by ANY action', () => {
  for (const action of EVERY_ACTION) {
    const before = dirty();
    const after = shellReducer(before, action);
    const expected = action.type === 'retry_requested' ? before.retryNonce + 1 : before.retryNonce;
    assert.equal(after.retryNonce, expected, `${action.type} must not move retryNonce except by +1 on retry`);
  }
  // And it keeps climbing across the paths that clear everything else.
  let s = dirty({ retryNonce: 0 });
  s = shellReducer(s, { type: 'retry_requested' });
  s = shellReducer(s, { type: 'search_submitted' });
  s = shellReducer(s, { type: 'retry_requested' });
  s = shellReducer(s, { type: 'skipped' });
  s = shellReducer(s, { type: 'went_back', target: 'identify' });
  s = shellReducer(s, { type: 'retry_requested' });
  assert.equal(s.retryNonce, 3, 'three retries, three increments, nothing in between reset it');
});

test('INV d: loadedKey stamps ONLY on snapshot success, and no action ever clears it', () => {
  for (const action of EVERY_ACTION) {
    const before = dirty();
    const after = shellReducer(before, action);
    if (action.type === 'snapshot_resolved') {
      assert.equal(after.loadedKey, action.scopeKey, 'stamped with the ACTION payload, not the old key');
      assert.notEqual(after.loadedKey, before.loadedKey, 'and the fixture key is genuinely different');
    } else {
      assert.equal(after.loadedKey, before.loadedKey, `${action.type} must leave loadedKey alone`);
    }
  }
});

test('INV e: a failed fetch KEEPS the snapshot and its loadedKey (F2)', () => {
  const before = dirty({ snapshotError: null });
  const after = shellReducer(before, { type: 'snapshot_failed' });
  assert.equal(after.snapshot, SNAP_A, 'the last-known-good answer survives the failure');
  assert.equal(after.loadedKey, before.loadedKey, 'and still describes what is on screen');
  assert.equal(after.snapshotError, 'failed');
});

test('INV f: skip clears the pick and the narrowing, but keeps windowDays and autoAsk', () => {
  const before = dirty();
  const after = shellReducer(before, { type: 'skipped' });
  assert.equal(after.skipped, true);
  assert.equal(after.picked, false);
  assert.equal(after.payerPick, null, 'the carrier pick goes');
  assert.equal(after.planFilter, '');
  assert.deepEqual(after.filters, NO_ANSWER_FILTERS);
  assert.equal(after.payerOverride, null);
  assert.equal(after.windowDays, 180, 'the window is deliberately NOT reset by a skip');
  assert.equal(after.autoAsk, true, 'and neither is the AI arm');
});

test('INV g: choosing a plan supersedes a skip and keeps the scope the user already set', () => {
  const before = dirty();
  const after = shellReducer(before, { type: 'plan_submitted' });
  assert.equal(after.picked, true);
  assert.equal(after.skipped, false, 'a plan pick supersedes a prior skip');
  assert.equal(after.snapshot, null, 'a new plan is a new population — skeleton, not dimmed content');
  assert.equal(after.payerPick, 'ALPHA MUTUAL');
  assert.equal(after.planFilter, 'gold');
  assert.equal(after.payerOverride, 'ALPHA MUTUAL OF THE MIDWEST');
  assert.equal(after.windowDays, 180);
  assert.equal(after.autoAsk, true);
});

test("INV h: going back un-skips, and keeps the carrier pick ONLY for target 'plan'", () => {
  for (const target of ['identify', 'payer', 'plan'] as const) {
    const after = shellReducer(dirty(), { type: 'went_back', target });
    assert.equal(after.backTo, target, 'went_back is the only writer of a non-null backTo');
    assert.equal(after.skipped, false, 'stepping back into the funnel un-skips it');
    assert.equal(after.picked, false);
    assert.equal(after.autoAsk, false, 'and disarms the AI');
    assert.equal(
      after.payerPick,
      target === 'plan' ? 'ALPHA MUTUAL' : null,
      'the machine has exactly one conditional write, and this is it',
    );
  }
});

test('INV i: any forward submit or payer pick clears backTo', () => {
  const forward: ShellAction[] = [
    { type: 'search_submitted' },
    { type: 'skipped' },
    { type: 'plan_submitted' },
    { type: 'payer_picked', payer: 'BETA MUTUAL' },
  ];
  for (const action of forward) {
    assert.equal(shellReducer(dirty(), action).backTo, null, `${action.type} clears backTo`);
  }
});

test('INV j: a re-scope never nulls the snapshot — dim-and-progress rides loadedKey, not a blank', () => {
  const before = dirty({ snapshotError: null });
  for (const action of [
    { type: 'payer_override_changed', label: 'BETA MUTUAL INC' } as const,
    { type: 'window_days_changed', days: 30 } as const,
  ]) {
    const after = shellReducer(before, action);
    assert.equal(after.snapshot, SNAP_A, `${action.type} keeps the rendered snapshot`);
    assert.equal(after.loadedKey, before.loadedKey, 'and keeps the stamp that makes it read as stale');
    assert.equal(after.snapshotError, null);
  }
});

test('INV k: snapshot_requested clears the error at request start and touches nothing else', () => {
  const after = shellReducer(dirty(), { type: 'snapshot_requested' });
  assert.equal(after.snapshotError, null);
  assert.equal(after.snapshot, SNAP_A, 'the stale content stays up while the new request runs');
  assert.equal(after.retryNonce, 7);
});

test('INV l: autoAsk is one-shot — armed once, disarmed by the panel, by a search and by a back', () => {
  let s = shellReducer(INITIAL_SHELL_STATE, { type: 'ai_armed' });
  assert.equal(s.autoAsk, true);
  s = shellReducer(s, { type: 'ai_disarmed' });
  assert.equal(s.autoAsk, false, 'the panel disarms it so a remount cannot re-fire a billed call');

  assert.equal(shellReducer(dirty(), { type: 'search_submitted' }).autoAsk, false);
  assert.equal(shellReducer(dirty(), { type: 'went_back', target: 'plan' }).autoAsk, false);
  assert.equal(shellReducer(dirty(), { type: 'skipped' }).autoAsk, true, 'but a SKIP does not disarm it');
  assert.equal(shellReducer(dirty(), { type: 'plan_submitted' }).autoAsk, true, 'nor does a plan pick');
});

// ── 3 · filter_toggled, both directions, all three facets ────────────────────────────────────────

const FACETS: { facet: 'planType' | 'funding' | 'employer'; key: 'planTypes' | 'funding' | 'employers' }[] = [
  { facet: 'planType', key: 'planTypes' },
  { facet: 'funding', key: 'funding' },
  { facet: 'employer', key: 'employers' },
];

for (const { facet, key } of FACETS) {
  test(`F3b filter_toggled: ${facet} adds when absent and removes when present`, () => {
    const base = shellReducer(INITIAL_SHELL_STATE, { type: 'filter_toggled', facet, value: 'X' });
    assert.deepEqual(base.filters[key], ['X'], 'absent → added');

    const two = shellReducer(base, { type: 'filter_toggled', facet, value: 'Y' });
    assert.deepEqual(two.filters[key], ['X', 'Y'], 'append order is preserved');

    const off = shellReducer(two, { type: 'filter_toggled', facet, value: 'X' });
    assert.deepEqual(off.filters[key], ['Y'], 'present → removed');

    // The other two facets are untouched by any of it.
    for (const other of FACETS) {
      if (other.key === key) continue;
      assert.deepEqual(off.filters[other.key], [], `${other.facet} is not collateral damage`);
    }
  });
}

// ── 4 · The useState bail-out, preserved ─────────────────────────────────────────────────────────

test('F3b: an action that changes nothing returns the IDENTICAL object, as useState did', () => {
  // useReducer skips the re-render only when the reducer hands back the same reference. Losing this
  // would turn every fetch-start dispatch into an extra render pass.
  const clean = dirty({ snapshotError: null });
  assert.equal(shellReducer(clean, { type: 'snapshot_requested' }), clean, 'error already null');

  const failed = dirty({ snapshotError: 'failed' });
  assert.equal(shellReducer(failed, { type: 'snapshot_failed' }), failed, 'already failed');

  const picked = dirty({ payerPick: 'ALPHA MUTUAL', backTo: null });
  assert.equal(shellReducer(picked, { type: 'payer_picked', payer: 'ALPHA MUTUAL' }), picked, 'same pick');

  const armed = dirty({ autoAsk: true });
  assert.equal(shellReducer(armed, { type: 'ai_armed' }), armed, 'already armed');

  const typed = dirty({ planFilter: 'gold' });
  assert.equal(shellReducer(typed, { type: 'plan_filter_changed', value: 'gold' }), typed, 'same text');

  const scoped = dirty({ windowDays: 180 });
  assert.equal(shellReducer(scoped, { type: 'window_days_changed', days: 180 }), scoped, 'same window');

  const stamped = dirty();
  assert.equal(
    shellReducer(stamped, { type: 'snapshot_resolved', snapshot: SNAP_A, scopeKey: stamped.loadedKey ?? '' }),
    stamped,
    'the same snapshot at the same scope is not a state change',
  );

  // A retry is NEVER a no-op — the nonce is what re-fires an otherwise identical request.
  assert.notEqual(shellReducer(clean, { type: 'retry_requested' }), clean, 'retry always produces new state');
});

test('F3b: an unrecognised action leaves the state exactly as it was', () => {
  const before = dirty();
  const after = shellReducer(before, { type: 'not_a_real_action' } as unknown as ShellAction);
  assert.equal(after, before);
});
