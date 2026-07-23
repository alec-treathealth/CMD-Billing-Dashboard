import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CollectionsAiInputSchema,
  SELECTION_MIN_CHARGES,
  isSufficientForAi,
  buildAiMessages,
  parseAiSections,
  INSUFFICIENT_COPY,
  AI_SECTIONS,
  type CollectionsAiInput,
} from '../src/collections/aiAnalysis.js';

const baseSelection: CollectionsAiInput = {
  mode: 'selection',
  yield_pct: { pct_allowed: 42.5, pct_paid: 70, pct_collected: 29.75 },
  scope: { charge_lines: 100, total_charge: 100000, total_allowed: 42500, total_paid: 29750, total_balance: 12000 },
  top_payers: [{ name: 'AETNA', count: 40, charge: 50000 }],
  top_facilities: [{ name: 'DALLAS MENTAL HEALTH LLC', count: 60, charge: 60000 }],
  top_cpt_rev: [{ cpt: '90837', revenue: '0900', lines: 30, pct_allowed: 45, pct_paid: 72 }],
};

const baseCohort: CollectionsAiInput = {
  mode: 'cohort',
  yield_pct: { pct_allowed: 33.11, pct_paid: 76.09, pct_collected: 25.19 },
  scope: { charge_lines: 800, total_charge: 500000, total_paid: 126000, total_balance: 60000, cohort_patients: 42 },
  top_payers: [{ name: 'BCBS', count: 300, charge: 250000 }],
  top_facilities: [{ name: 'HOUSTON BH', count: 500, charge: 300000 }],
  top_cpt_rev: [{ cpt: '90853', revenue: '0915', lines: 200, pct_allowed: 30, pct_paid: 74 }],
  series: {
    by_visit: [{ bucket: 1, patients: 42, charge_lines: 42, pct_allowed: 40, pct_paid: 80 }],
    by_days: [{ bucket: 0, patients: 42, charge_lines: 42, pct_allowed: 40, pct_paid: 80 }],
  },
};

test('PHI firewall: strict schema strips/rejects unknown keys (no member id / prefix / name can ride in)', () => {
  const withPhi = {
    ...baseSelection,
    member_id: 'PGE081', // attacker-injected PHI-adjacent fields
    alpha_prefix: 'PGE',
    patient_name: 'DOE, JANE',
  };
  const parsed = CollectionsAiInputSchema.safeParse(withPhi);
  // .strict() REJECTS unknown keys outright — the object never reaches the model.
  assert.equal(parsed.success, false);
});

test('PHI firewall: a clean aggregate parses and carries only allowlisted fields', () => {
  const parsed = CollectionsAiInputSchema.safeParse(baseCohort);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(Object.keys(parsed.data).sort(), [
      'mode',
      'scope',
      'series',
      'top_cpt_rev',
      'top_facilities',
      'top_payers',
      'yield_pct',
    ]);
  }
});

test('sufficiency gate — selection mode: needs >= SELECTION_MIN_CHARGES lines AND total_allowed > 0', () => {
  assert.equal(isSufficientForAi({ ...baseSelection, scope: { ...baseSelection.scope, charge_lines: SELECTION_MIN_CHARGES } }), true);
  // one under the line floor → insufficient
  assert.equal(
    isSufficientForAi({ ...baseSelection, scope: { ...baseSelection.scope, charge_lines: SELECTION_MIN_CHARGES - 1 } }),
    false,
  );
  // enough lines but zero-allowed scalar → insufficient (no %-allowed/%-paid story to tell)
  assert.equal(isSufficientForAi({ ...baseSelection, scope: { ...baseSelection.scope, total_allowed: 0 } }), false);
  // absent total_allowed (defensive) → insufficient
  const { total_allowed: _omit, ...scopeNoAllowed } = baseSelection.scope;
  assert.equal(isSufficientForAi({ ...baseSelection, scope: scopeNoAllowed }), false);
});

test('sufficiency gate — cohort mode: any resolved percentage means it cleared the min-patient floor', () => {
  assert.equal(isSufficientForAi(baseCohort), true);
  // A below-floor cohort would arrive with all-null yield (server returns totals=null) → insufficient.
  assert.equal(
    isSufficientForAi({ ...baseCohort, yield_pct: { pct_allowed: null, pct_paid: null, pct_collected: null } }),
    false,
  );
});

test('buildAiMessages: user turn = fixed prose + EXACTLY the validated aggregate JSON, nothing else', () => {
  const { system, user } = buildAiMessages(baseCohort);
  assert.match(system, /revenue-cycle analyst/i);
  assert.match(user, /Mode: COHORT/);
  assert.match(user, /42 patients/); // the aggregate count is fine (non-PHI)
  // The ONLY data the model sees is JSON.stringify(input) — so whatever the PHI firewall admitted
  // (allowlisted aggregate fields only) is the whole of the model input; no side channel adds more.
  assert.ok(user.includes(JSON.stringify(baseCohort)), 'user turn must embed exactly the validated aggregate');
  // A concrete PHI value never appears (it has no schema field to arrive in, and none is injected).
  assert.doesNotMatch(user, /PGE081|DOE, JANE/);
});

test('parseAiSections: splits the three sections, tolerant of a missing one', () => {
  const text = '## TL;DR\nAetna underpays.\n## Signals\n- 90837 low at 72%\n## Risks\n- thin buckets';
  const out = parseAiSections(text);
  assert.equal(out['TL;DR'], 'Aetna underpays.');
  assert.match(out.Signals, /90837 low at 72%/);
  assert.match(out.Risks, /thin buckets/);

  const partial = parseAiSections('## TL;DR\nJust the headline.');
  assert.equal(partial['TL;DR'], 'Just the headline.');
  assert.equal(partial.Signals, '');
  assert.equal(partial.Risks, '');
});

test('insufficient copy + section markers are the agreed constants', () => {
  assert.equal(INSUFFICIENT_COPY.cohort, 'Not enough data on this cohort to create a reliable summary.');
  assert.match(INSUFFICIENT_COPY.selection, /this selection/);
  assert.deepEqual([...AI_SECTIONS], ['TL;DR', 'Signals', 'Risks']);
});
