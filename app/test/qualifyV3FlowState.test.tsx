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
 *       non-writes in one assertion. If an action ever starts touching a sixteenth field, the row
 *       for it fails. ("Sixteenth" = one MORE than today's fifteen, the same convention
 *       `bailIfUnchanged` uses at flow-state.ts:264 — NOT this header's own older habit of naming
 *       the current total (this comment said "a fourteenth field" back when the module had fourteen,
 *       i.e. named the count itself rather than the next one). Reconciled 2026-08-07 so the two
 *       files share one rule instead of two that happened to differ by one.)
 *   2 · The named INVARIANTS from the module header (a–m), asserted directly, because "search
 *       clears everything downstream" and "retryNonce is never reset" are the claims a future
 *       refactor will be tempted to break.
 *
 * PHI: the fixture carries no member identifier of any kind — the typed term deliberately does not
 * live in this state (it stays in the shell's ref). Payer and employer strings below are invented.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { QualifySnapshot } from '../lib/qualify/contract';
import { AREA_ALL, AREA_OTHER } from '../components/qualify/m/area-chips';
import { NO_ANSWER_FILTERS, NO_FACILITY_NARROW } from '../components/qualify/v3/resolution-flow';
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
    filters: { funding: ['self_funded'], employers: ['NORTHWIND LOGISTICS'] },
    planFilter: 'gold',
    autoAsk: true,
    backTo: 'payer',
    snapshot: SNAP_A,
    snapshotError: 'failed',
    retryNonce: 7,
    payerOverride: 'ALPHA MUTUAL OF THE MIDWEST',
    windowDays: 180,
    loadedKey: 'p:ALPHA|w:180|f:|e:',
    area: 'TN',
    facilityNarrow: ['LONESTAR MENTAL HEALTH'],
    narrowExpanded: true,
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
  { type: 'filter_toggled', facet: 'funding', value: 'fully_insured' },
  { type: 'filters_cleared' },
  { type: 'retry_requested' },
  { type: 'snapshot_requested' },
  { type: 'snapshot_resolved', snapshot: SNAP_B, scopeKey: 'p:BETA|w:90|f:|e:' },
  { type: 'snapshot_failed' },
  { type: 'ai_armed' },
  { type: 'ai_disarmed' },
  { type: 'payer_override_changed', label: 'BETA MUTUAL INC' },
  { type: 'window_days_changed', days: 30 },
  { type: 'area_selected', key: 'CA' },
  { type: 'facility_narrow_toggled', value: 'NASHVILLE MENTAL HEALTH LLC' },
  { type: 'narrow_toggled' },
];

// ── 1 · The field-write table ────────────────────────────────────────────────────────────────────

const TABLE: { name: string; action: ShellAction; writes: Partial<ShellState> }[] = [
  {
    name: 'search_submitted writes fourteen and keeps retryNonce + loadedKey',
    action: { type: 'search_submitted' },
    writes: {
      payerPick: null,
      picked: false,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      planFilter: '',
      autoAsk: false,
      backTo: null,
      snapshot: null,
      snapshotError: null,
      payerOverride: null,
      windowDays: null,
      area: AREA_ALL,
      facilityNarrow: NO_FACILITY_NARROW,
      narrowExpanded: false,
    },
  },
  {
    name: 'skipped writes twelve — and NOT windowDays or autoAsk',
    action: { type: 'skipped' },
    writes: {
      skipped: true,
      picked: false,
      payerPick: null,
      planFilter: '',
      backTo: null,
      filters: NO_ANSWER_FILTERS,
      payerOverride: null,
      snapshot: null,
      snapshotError: null,
      area: AREA_ALL,
      facilityNarrow: NO_FACILITY_NARROW,
      // Declared for the record; the table CANNOT see it (see INV n) because the fixture is already
      // `true`. INV n is what actually pins this write, from the opposite side.
      narrowExpanded: true,
    },
  },
  {
    name: 'plan_submitted writes nine — and NOT payerPick/planFilter/payerOverride/windowDays/autoAsk',
    action: { type: 'plan_submitted' },
    writes: {
      picked: true,
      skipped: false,
      filters: NO_ANSWER_FILTERS,
      backTo: null,
      snapshot: null,
      snapshotError: null,
      area: AREA_ALL,
      facilityNarrow: NO_FACILITY_NARROW,
      narrowExpanded: false,
    },
  },
  {
    name: "went_back('identify') writes fourteen, payerPick among them",
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
      payerPick: null,
      planFilter: '',
      backTo: 'identify',
      area: AREA_ALL,
      facilityNarrow: NO_FACILITY_NARROW,
      narrowExpanded: false,
    },
  },
  {
    name: "went_back('payer') writes fourteen, payerPick among them",
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
      payerPick: null,
      planFilter: '',
      backTo: 'payer',
      area: AREA_ALL,
      facilityNarrow: NO_FACILITY_NARROW,
      narrowExpanded: false,
    },
  },
  {
    name: "went_back('plan') writes thirteen — the carrier pick SURVIVES",
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
      planFilter: '',
      backTo: 'plan',
      area: AREA_ALL,
      facilityNarrow: NO_FACILITY_NARROW,
      narrowExpanded: false,
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
    // The employer DRAFT is no longer machine state (2026-08-07): the shared type-ahead that replaced
    // the hand-rolled tag-search owns its own typed query, so there is no `employer_query_changed`
    // row here and no `employerQuery` in any reset below. What this button still clears is the
    // SELECTION, through `filters`.
    name: 'filters_cleared writes filters + BOTH grid narrows only',
    action: { type: 'filters_cleared' },
    writes: { filters: NO_ANSWER_FILTERS, area: AREA_ALL, facilityNarrow: NO_FACILITY_NARROW },
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
  {
    // THE WHOLE POINT OF THIS ROW IS THE NON-WRITES. `area` is a GRID narrow: if this action ever
    // starts touching `filters`, `snapshot` or `loadedKey`, the facet has become a fetch narrow and
    // the disclosure captions downstream start lying about what was requested (invariant m).
    name: 'area_selected writes area ONLY — never filters, never the snapshot (invariant m)',
    action: { type: 'area_selected', key: 'CA' },
    writes: { area: 'CA' },
  },
  {
    // S4. THE SECOND GRID NARROW, AND THE ROW EXISTS FOR THE SAME NON-WRITES AS AREA'S. A facility
    // selection that touched `filters`, `snapshot` or `loadedKey` would have become a FETCH narrow —
    // and a fetch narrow cannot say "no history at NASHVILLE; they billed at LSMH and KWC", because
    // the un-narrowed list would no longer be in hand. Multi-select: this ADDS to the array.
    name: 'facility_narrow_toggled writes facilityNarrow ONLY — never filters, never the snapshot (invariant m)',
    action: { type: 'facility_narrow_toggled', value: 'NASHVILLE MENTAL HEALTH LLC' },
    writes: { facilityNarrow: ['LONESTAR MENTAL HEALTH', 'NASHVILLE MENTAL HEALTH LLC'] },
  },
  {
    // ...and the same action REMOVES a value already picked. One action, both directions — exactly
    // `filter_toggled`, so the picker's own `Clear N` can walk the selection back through it rather
    // than earning a second writer of the field.
    name: 'facility_narrow_toggled removes a value already picked — one action, both directions',
    action: { type: 'facility_narrow_toggled', value: 'LONESTAR MENTAL HEALTH' },
    writes: { facilityNarrow: [] },
  },
  {
    // The NARROW SEARCH card's open/closed bit. Its value here is unremarkable; the row exists for
    // the NON-writes — a disclosure toggle that touched `filters`, `snapshot` or `loadedKey` would be
    // a presentation control quietly re-issuing a ranking request.
    name: 'narrow_toggled flips narrowExpanded ONLY — a disclosure is not a re-scope',
    action: { type: 'narrow_toggled' },
    writes: { narrowExpanded: false },
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

test('F3b: the initial state is the sixteen shell defaults, filters by shared reference', () => {
  assert.deepEqual(INITIAL_SHELL_STATE, {
    payerPick: null,
    picked: false,
    skipped: false,
    filters: { funding: [], employers: [] },
    planFilter: '',
    autoAsk: false,
    backTo: null,
    snapshot: null,
    snapshotError: null,
    retryNonce: 0,
    payerOverride: null,
    windowDays: null,
    loadedKey: null,
    area: AREA_ALL,
    facilityNarrow: NO_FACILITY_NARROW,
    narrowExpanded: false,
  });
  assert.equal(Object.keys(INITIAL_SHELL_STATE).length, 16, 'sixteen fields, no more');
  assert.equal(INITIAL_SHELL_STATE.filters, NO_ANSWER_FILTERS, 'the SHARED constant, not a copy');
  assert.equal(INITIAL_SHELL_STATE.area, AREA_ALL, 'the area facet starts unnarrowed');
  assert.equal(INITIAL_SHELL_STATE.facilityNarrow, NO_FACILITY_NARROW, 'and so does the facility one');
});

test('F3b: every filters reset is the SHARED constant BY REFERENCE — and clears the area with it', () => {
  // BY REFERENCE, deliberately. The field-write table above compares with deepEqual, which is
  // reference-blind: swapping all five of these resets to `{ funding: [], employers: [] }`
  // left the whole suite green (review MUT-F), even though `narrow`'s useMemo depends on `filters`
  // by identity and a fresh-but-equal object invalidates it on every single navigation. The header
  // calls this rule load-bearing; until now only INITIAL_SHELL_STATE pinned it.
  const resets: ShellAction[] = [
    { type: 'search_submitted' },
    { type: 'skipped' },
    { type: 'plan_submitted' },
    { type: 'went_back', target: 'identify' },
    { type: 'went_back', target: 'payer' },
    { type: 'went_back', target: 'plan' },
    { type: 'filters_cleared' },
  ];
  for (const action of resets) {
    const target = action.type === 'went_back' ? `${action.type}('${action.target}')` : action.type;
    const after = shellReducer(dirty(), action);
    assert.equal(
      after.filters,
      NO_ANSWER_FILTERS,
      `${target} must reset filters to the shared constant, not to an equal copy`,
    );
    // The AREA facet resets at exactly these sites and nowhere else — ONE list, so the two narrows
    // on the answer stage can never drift into clearing at different moments. It is a string, so
    // there is no reference to preserve; what is pinned is the SET of reset sites.
    assert.equal(after.area, AREA_ALL, `${target} must clear the area facet alongside the filters`);
    // S4: the SECOND grid narrow clears at exactly the same sites, and BY REFERENCE — it is an
    // array, so a fresh-but-equal literal here would invalidate the narrow's memo chain on every
    // navigation, which is the MUT-F lesson one field over.
    assert.equal(
      after.facilityNarrow,
      NO_FACILITY_NARROW,
      `${target} must clear the facility narrow to the shared constant, not to an equal copy`,
    );
  }
});

test('F3b: every filters reset is the SHARED constant BY REFERENCE, not a fresh equal literal', () => {
  // BY REFERENCE, deliberately. The field-write table above compares with deepEqual, which is
  // reference-blind: swapping all five of these resets to `{ funding: [], employers: [] }`
  // left the whole suite green (review MUT-F), even though `narrow`'s useMemo depends on `filters`
  // by identity and a fresh-but-equal object invalidates it on every single navigation. The header
  // calls this rule load-bearing; until now only INITIAL_SHELL_STATE pinned it.
  const resets: ShellAction[] = [
    { type: 'search_submitted' },
    { type: 'skipped' },
    { type: 'plan_submitted' },
    { type: 'went_back', target: 'identify' },
    { type: 'went_back', target: 'payer' },
    { type: 'went_back', target: 'plan' },
    { type: 'filters_cleared' },
  ];
  for (const action of resets) {
    const target = action.type === 'went_back' ? `${action.type}('${action.target}')` : action.type;
    assert.equal(
      shellReducer(dirty(), action).filters,
      NO_ANSWER_FILTERS,
      `${target} must reset filters to the shared constant, not to an equal copy`,
    );
  }
});

// ── 2 · The named invariants ─────────────────────────────────────────────────────────────────────

test('INV a: a new search clears EVERYTHING downstream, from any prior state', () => {
  // Walk the machine into a thoroughly-used state first, so this is not just "dirty fixture in".
  let s = INITIAL_SHELL_STATE;
  s = shellReducer(s, { type: 'payer_picked', payer: 'ALPHA MUTUAL' });
  s = shellReducer(s, { type: 'plan_submitted' });
  s = shellReducer(s, { type: 'filter_toggled', facet: 'funding', value: 'self_funded' });
  s = shellReducer(s, { type: 'filter_toggled', facet: 'employer', value: 'NORTHWIND LOGISTICS' });
  s = shellReducer(s, { type: 'window_days_changed', days: 365 });
  s = shellReducer(s, { type: 'payer_override_changed', label: 'ALPHA MUTUAL OF THE MIDWEST' });
  s = shellReducer(s, { type: 'ai_armed' });
  s = shellReducer(s, { type: 'snapshot_resolved', snapshot: SNAP_A, scopeKey: 'k1' });
  s = shellReducer(s, { type: 'snapshot_failed' });
  s = shellReducer(s, { type: 'retry_requested' });
  s = shellReducer(s, { type: 'area_selected', key: 'TN' });
  s = shellReducer(s, { type: 'facility_narrow_toggled', value: 'LONESTAR MENTAL HEALTH' });

  const after = shellReducer(s, { type: 'search_submitted' });
  assert.deepEqual(
    after,
    { ...INITIAL_SHELL_STATE, retryNonce: 1, loadedKey: 'k1' },
    'fourteen fields back to their defaults; only the two carry-through fields differ',
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

// ── 3 · filter_toggled, both directions, both facets ─────────────────────────────────────────────

// ⚠ TWO FACETS, NOT THREE. `planType` was removed 2026-08-07 — not for tidiness: `filterCandidates`
// feeds `employerNarrowFor`, whose employer set IS sent as `market.employers`, so a plan-type press
// could re-rank the whole screen over a narrow nothing on it disclosed. The behavioural proof lives
// in qualifyV3Flow.test.tsx ("a plan type cannot influence the employer narrow"); what this table
// pins is that the reducer offers no arm to press.
const FACETS: { facet: 'funding' | 'employer'; key: 'funding' | 'employers' }[] = [
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

    // The other facet is untouched by any of it.
    for (const other of FACETS) {
      if (other.key === key) continue;
      assert.deepEqual(off.filters[other.key], [], `${other.facet} is not collateral damage`);
    }
  });
}

// ── 3b · The AREA facet: invariant (m) ───────────────────────────────────────────────────────────

test('INV m: area_selected reaches NOTHING the fetch reads — no filters, no snapshot, no loadedKey', () => {
  // The structural claim behind the whole facet. `scopeKeyOf` is built from payerLabel x windowDays
  // x filters.funding x the employer narrow; if `area_selected` cannot move any of those, the fetch
  // effect (which depends on scopeKey and retryNonce alone) cannot see an area change at all.
  const before = dirty();
  const after = shellReducer(before, { type: 'area_selected', key: 'CA' });
  assert.equal(after.area, 'CA');
  assert.equal(after.filters, before.filters, 'the filter bag is not even re-created');
  assert.equal(after.snapshot, before.snapshot, 'the answer on screen is untouched');
  assert.equal(after.loadedKey, before.loadedKey, 'so nothing reads as stale and no refetch is implied');
  assert.equal(after.snapshotError, before.snapshotError);
  assert.equal(after.windowDays, before.windowDays);
  assert.equal(after.payerOverride, before.payerOverride);
});

test('INV m: a re-scope KEEPS the area — it narrows the grid, and the grid is still there', () => {
  // Deliberate asymmetry: only the four navigations and Clear reset it. A window change is the same
  // question over a wider set, not a new question — exactly how `filters` already behaves.
  for (const action of [
    { type: 'payer_override_changed', label: 'BETA MUTUAL INC' } as const,
    { type: 'window_days_changed', days: 30 } as const,
    { type: 'snapshot_requested' } as const,
    { type: 'snapshot_resolved', snapshot: SNAP_B, scopeKey: 'k9' } as const,
    { type: 'snapshot_failed' } as const,
    { type: 'retry_requested' } as const,
  ]) {
    assert.equal(shellReducer(dirty(), action).area, 'TN', `${action.type} must not clear the area`);
  }
});

test('INV m: facility_narrow_toggled reaches NOTHING the fetch reads either (S4)', () => {
  // The SAME structural claim as area_selected's, one field over. It matters more here, not less:
  // a facility narrow is the one narrow with an obvious SQL form (`facility = any($n)`), so the
  // temptation to make it shape the fetch is real — and the measured reason not to is that 86.9% of
  // members bill at exactly ONE facility, which makes the EMPTY state the common case, and only a
  // display narrow still holds the un-narrowed list needed to say where they DID bill.
  const before = dirty();
  const after = shellReducer(before, { type: 'facility_narrow_toggled', value: 'NASHVILLE MENTAL HEALTH LLC' });
  assert.deepEqual(after.facilityNarrow, ['LONESTAR MENTAL HEALTH', 'NASHVILLE MENTAL HEALTH LLC']);
  assert.equal(after.filters, before.filters, 'the filter bag is not even re-created');
  assert.equal(after.snapshot, before.snapshot, 'the answer on screen is untouched');
  assert.equal(after.loadedKey, before.loadedKey, 'so nothing reads as stale and no refetch is implied');
  assert.equal(after.snapshotError, before.snapshotError);
  assert.equal(after.windowDays, before.windowDays);
  assert.equal(after.payerOverride, before.payerOverride);
  assert.equal(after.area, before.area, 'and the OTHER grid narrow is independent of it');
});

test('INV m: a re-scope KEEPS the facility narrow too — same asymmetry as the area (S4)', () => {
  for (const action of [
    { type: 'payer_override_changed', label: 'BETA MUTUAL INC' } as const,
    { type: 'window_days_changed', days: 30 } as const,
    { type: 'snapshot_requested' } as const,
    { type: 'snapshot_resolved', snapshot: SNAP_B, scopeKey: 'k9' } as const,
    { type: 'snapshot_failed' } as const,
    { type: 'retry_requested' } as const,
  ]) {
    assert.deepEqual(
      shellReducer(dirty(), action).facilityNarrow,
      ['LONESTAR MENTAL HEALTH'],
      `${action.type} must not clear the facility narrow`,
    );
  }
});

test('facility_narrow_toggled is MULTI-select and its own inverse — the picker needs no second action', () => {
  let s = shellReducer(INITIAL_SHELL_STATE, { type: 'facility_narrow_toggled', value: 'A' });
  assert.deepEqual(s.facilityNarrow, ['A']);
  s = shellReducer(s, { type: 'facility_narrow_toggled', value: 'B' });
  assert.deepEqual(s.facilityNarrow, ['A', 'B'], 'multi-select: the picker is multi by nature');
  s = shellReducer(s, { type: 'facility_narrow_toggled', value: 'A' });
  assert.deepEqual(s.facilityNarrow, ['B'], 'and the same action removes — this is what Clear N walks');
  s = shellReducer(s, { type: 'facility_narrow_toggled', value: 'B' });
  assert.deepEqual(s.facilityNarrow, [], 'emptied by toggling, and an empty selection is NO restriction');
  // ⚠ BY REFERENCE, and this is the path the ⚠ comment in the reducer claims is load-bearing. Toggling
  // the LAST chip off is exactly when a fresh `[]` would start invalidating the narrow's memo chain on
  // every render, and `deepEqual` above is reference-blind — the mutation that returns a fresh literal
  // ran 200/0 until this line existed. The MUT-F lesson, one field over.
  assert.equal(s.facilityNarrow, NO_FACILITY_NARROW, 'the SHARED constant, not a fresh equal literal');
  // The `Clear N` path is the same action walked over the whole selection, so it lands here too.
  let cleared = shellReducer(INITIAL_SHELL_STATE, { type: 'facility_narrow_toggled', value: 'A' });
  cleared = shellReducer(cleared, { type: 'facility_narrow_toggled', value: 'B' });
  for (const v of [...cleared.facilityNarrow]) cleared = shellReducer(cleared, { type: 'facility_narrow_toggled', value: v });
  assert.equal(cleared.facilityNarrow, NO_FACILITY_NARROW, 'the picker’s Clear N ends on the shared constant too');
});

test('area_selected: All, a state and the Other bucket are all just keys — and All is a real value', () => {
  let s = shellReducer(INITIAL_SHELL_STATE, { type: 'area_selected', key: 'TN' });
  assert.equal(s.area, 'TN');
  s = shellReducer(s, { type: 'area_selected', key: AREA_OTHER });
  assert.equal(s.area, AREA_OTHER, 'the unmapped bucket is selectable, not a null hole');
  s = shellReducer(s, { type: 'area_selected', key: AREA_ALL });
  assert.equal(s.area, AREA_ALL, 'pressing All is how a narrow is undone from the chip row');
});

/**
 * INV n — the NARROW SEARCH card's open/closed bit.
 *
 * ⚠ THE FIELD-WRITE TABLE ABOVE CANNOT PIN THE `skipped` HALF OF THIS, and that is why this test
 * exists rather than a fourth column in the table. The table's fixture sets every field to a
 * NON-default value and compares `{...dirty(), ...writes}` — so any action whose declared write
 * happens to EQUAL the fixture value is invisible there. `narrowExpanded: true` is exactly that case
 * for `skipped` (the same blind spot the pre-existing `skipped: true` row already has). Every case
 * below therefore starts from the OPPOSITE value: a reducer that merely carried the field through
 * fails all of them.
 *
 * The rule being pinned: OPEN is a claim that there is something to narrow. A Skip has just widened
 * the search to the whole footprint, so the fields are the operator's next move and the reveal has
 * rows to stagger; a plan pick has already narrowed it, so the card states what it resolved to and
 * stays shut. Every other navigation is invariant (a) — a kept-open card over a state the user has
 * left is the same kept-but-hidden class, at lower stakes.
 */
test('INV n: Skip lands the NARROW SEARCH card OPEN, every navigation lands it CLOSED, Clear filters leaves it alone', () => {
  assert.equal(
    shellReducer(dirty({ narrowExpanded: false }), { type: 'skipped' }).narrowExpanded,
    true,
    'a skip must OPEN the card — the fields are the next move, and the reveal needs them to stagger',
  );
  for (const action of [
    { type: 'plan_submitted' },
    { type: 'search_submitted' },
    { type: 'went_back', target: 'identify' },
    { type: 'went_back', target: 'payer' },
    { type: 'went_back', target: 'plan' },
  ] as ShellAction[]) {
    const label = action.type === 'went_back' ? `went_back('${action.target}')` : action.type;
    assert.equal(
      shellReducer(dirty({ narrowExpanded: true }), action).narrowExpanded,
      false,
      `${label} must CLOSE the card — invariant (a): nothing downstream survives a navigation`,
    );
  }
  // The deliberate NON-write. "Clear filters" is a filter reset pressed from inside this card's own
  // summary, not a navigation: forcing the card either way would move a surface the operator is
  // standing on, and neither direction is the honest default.
  for (const open of [true, false]) {
    assert.equal(
      shellReducer(dirty({ narrowExpanded: open }), { type: 'filters_cleared' }).narrowExpanded,
      open,
      'filters_cleared must leave the card exactly as the operator left it',
    );
  }
  // And the toggle itself flips from either side — not "sets true".
  assert.equal(shellReducer(dirty({ narrowExpanded: false }), { type: 'narrow_toggled' }).narrowExpanded, true);
  assert.equal(shellReducer(dirty({ narrowExpanded: true }), { type: 'narrow_toggled' }).narrowExpanded, false);
});

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

  const inArea = dirty({ area: 'TN' });
  assert.equal(shellReducer(inArea, { type: 'area_selected', key: 'TN' }), inArea, 'same area chip');

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
