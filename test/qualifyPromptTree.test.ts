/**
 * PROMPT TREE — branch selection, the admissions voice, and the contracts that keep the tree from
 * eating the ratified honesty core.
 *
 * What must hold:
 *   1. BRANCHES SELECT ON THE PAYLOAD — each situation flips exactly its own branch, and the path
 *      is stable (it is the audit handle a debugging session will read).
 *   2. THE HONESTY CORE SURVIVES VERBATIM — composePromptSystem prepends, never edits. The pinned
 *      phrases other tests assert (payerScope "all", bedState) must still be present through the
 *      composed prompt.
 *   3. THE AUDIENCE LAYER IS ALWAYS ON and teaches a translation for every banned term.
 *   4. THE USER TURN still starts with `Question: ` (test-pinned upstream) and situation notes land
 *      AFTER the framing, BEFORE the JSON.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMISSIONS_TRANSLATIONS,
  ADMISSIONS_VOICE,
  composePromptSystem,
  promptSituationNotes,
  promptSituationOf,
  promptTreePath,
} from '../src/collections/qualifyPromptTree';
import { buildQualifyAiMessages, type QualifyAiInput } from '../src/collections/qualifyAi';

function facility(patients: number): QualifyAiInput['facilities'][number] {
  return {
    name: 'Nashville Mental Health',
    careSetting: 'IP',
    ratingV2: 60,
    iqBand: '50',
    pctAllowedOfBilled: 49,
    distinctPatients: patients,
    lineCount: 300,
    medianDaysToPayment: 40,
    payerCount: 1,
    factors: [],
  };
}

function base(over: Partial<QualifyAiInput> = {}): QualifyAiInput {
  return {
    question: 'placement',
    payerName: 'Aetna',
    payerScope: 'payer',
    policy: null,
    provenance: 'direct',
    windowDays: 90,
    windowSufficient: true,
    facilities: [facility(30)],
    amountsBlind: false,
    ...over,
  };
}

function ticker(over: Partial<NonNullable<QualifyAiInput['ticker']>> = {}): NonNullable<QualifyAiInput['ticker']> {
  return {
    kind: 'policy',
    facilityName: null,
    payer: 'Aetna',
    careSetting: 'IP',
    area: null,
    facilityCount: 1,
    ratingNow: 60,
    ratingThen: 50,
    deltaPts: 10,
    iqBand: '50',
    distinctMembers: 12,
    distinctPatients: 0,
    lineCount: 500,
    windowDays: 90,
    deltaDays: 90,
    points: [],
    ...over,
  };
}

// ── 1. Branch selection ─────────────────────────────────────────────────────────────────────────
test('a solid direct payer-scoped search walks only audience + leaf', () => {
  assert.deepEqual(promptTreePath(base()), ['audience', 'leaf:placement']);
});

test('each situation flips exactly its own branch', () => {
  assert.ok(promptTreePath(base({ question: 'tape_move', ticker: ticker() })).includes('mode:ticker_policy'));
  assert.ok(
    promptTreePath(base({ question: 'trend_move', ticker: ticker({ kind: 'facility', distinctMembers: 0, distinctPatients: 40 }) })).includes(
      'mode:ticker_facility',
    ),
  );
  assert.ok(promptTreePath(base({ facilities: [facility(4)] })).includes('evidence:thin'));
  assert.ok(promptTreePath(base({ facilities: [], policy: null, provenance: 'none' })).includes('evidence:none'));
  assert.ok(promptTreePath(base({ payerScope: 'all' })).includes('scope:all'));
  assert.ok(promptTreePath(base({ provenance: 'comparable_employer' })).includes('prov:estimated'));
  assert.ok(promptTreePath(base({ provenance: 'comparable_funding' })).includes('prov:estimated'));
  const selfFunded = base({
    policy: {
      carrier: 'Aetna',
      funding: 'Self-Funded',
      policyType: 'PPO',
      planType: null,
      network: null,
      memberCount: 3,
      vobStale: false,
    },
  });
  assert.ok(promptTreePath(selfFunded).includes('funding:self'));
  // and the leaf always closes the path
  assert.equal(promptTreePath(base()).at(-1), 'leaf:placement');
});

test('an insufficient window reads as thin evidence even with a healthy patient count', () => {
  assert.equal(promptSituationOf(base({ windowSufficient: false })).evidence, 'thin');
});

test('a ticker click sizes evidence from the card itself', () => {
  assert.equal(promptSituationOf(base({ ticker: ticker({ distinctMembers: 3 }) })).evidence, 'thin');
  assert.equal(promptSituationOf(base({ ticker: ticker({ distinctMembers: 40 }) })).evidence, 'solid');
});

// ── 2. The honesty core survives verbatim ───────────────────────────────────────────────────────
test('composePromptSystem prepends the core untouched', () => {
  const core = 'THE RATIFIED CORE — byte for byte.';
  const composed = composePromptSystem(core, base({ payerScope: 'all' }));
  assert.ok(composed.startsWith(core), 'the honesty core must be the FIRST thing in the prompt');
  assert.ok(composed.includes(ADMISSIONS_VOICE));
});

test('the full message builder still carries the pinned honesty phrases', () => {
  const { system } = buildQualifyAiMessages(base({ payerScope: 'all' }));
  assert.match(system, /payerScope "all"/);
  assert.match(system, /BLEND across payerCount labels/);
  assert.match(system, /bedState/);
  // and the audience layer rides after it
  assert.match(system, /ADMISSIONS REP/);
  assert.match(system, /LEAD WITH THE CALL/);
});

// ── 3. The audience layer ───────────────────────────────────────────────────────────────────────
test('every banned term teaches its translation', () => {
  for (const [jargon, plain] of ADMISSIONS_TRANSLATIONS) {
    assert.ok(jargon.length > 0 && plain.length > 0);
    assert.ok(ADMISSIONS_VOICE.includes(plain), `the voice layer must carry the translation for "${jargon}"`);
  }
});

// ── 4. The user turn's shape ────────────────────────────────────────────────────────────────────
test('notes land after the Question framing and before the JSON', () => {
  const input = base({ provenance: 'comparable_employer', facilities: [facility(4)] });
  const notes = promptSituationNotes(input);
  assert.ok(notes.length >= 2, 'estimated + thin should both note');
  const { user } = buildQualifyAiMessages(input);
  assert.match(user, /^Question: /);
  const qAt = user.indexOf('Question:');
  const jsonAt = user.indexOf('Aggregates (JSON):');
  for (const note of notes) {
    const at = user.indexOf(note);
    assert.ok(at > qAt && at < jsonAt, `note must sit between framing and JSON: ${note}`);
  }
});

test('a plain solid search adds no notes at all — silence is the default, not a branch', () => {
  assert.deepEqual(promptSituationNotes(base()), []);
});
