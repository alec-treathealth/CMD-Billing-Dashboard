/**
 * "Ask about this policy" chip derivation — the mockup's chipsFor() port (aiChips.ts). Chip
 * selection must be RULE-BASED AND DETERMINISTIC: same snapshot in, same five chips + same
 * suggested chip out, no randomness anywhere. Fixtures cover the five ruled scenarios
 * (thin+OON · rated-strong+INN+self-funded · unrated-all · EPO+fully-insured ·
 * scoped-with-conflict) plus the ruled suggested table and the old conditional semantics
 * (speed needs a median; improve needs a live negative factor).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyAiChips, QUALIFY_AI_CHIP_COUNT } from '../lib/qualify/aiChips';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';
import { QUALIFY_TENANT_SCOPE } from '../lib/qualify/contract';
import type {
  QualifyFacility,
  QualifyFactorReading,
  QualifyPolicyCard,
  QualifySnapshot,
} from '../lib/qualify/contract';

const POS_FACTOR: QualifyFactorReading = {
  key: 'claims',
  label: 'Claims reliability',
  weight: 25,
  score: 0.8,
  available: true,
  direction: 'pos',
  detail: '80% of billed allowed across 120 lines.',
};

const NEG_FACTOR: QualifyFactorReading = {
  key: 'ttp',
  label: 'Time to payment',
  weight: 15,
  score: 0.2,
  available: true,
  direction: 'neg',
  detail: 'Median 130 days on paid lines.',
};

function fac(over: Partial<QualifyFacility> & { rank: number; name: string }): QualifyFacility {
  return {
    ...QUALIFY_FACILITY_V2_NULLS,
    facilityKey: over.name.toLowerCase(),
    city: null,
    state: null,
    pctAllowedOfBilled: null,
    rating: null,
    streakSignal: null,
    billedAmount: null,
    allowedAmount: null,
    lineCount: 0,
    distinctPatients: 0,
    confirmedClaims: 0,
    estimateClaims: 0,
    unknownClaims: 0,
    careSetting: null,
    entity: 'BXR',
    ...over,
  };
}

function policyCard(over: Partial<QualifyPolicyCard>): QualifyPolicyCard {
  return {
    found: true,
    memberCount: 12,
    carrier: 'AETNA',
    employerName: null,
    funding: null,
    policyType: 'PPO',
    planType: null,
    groupOnFile: false,
    network: null,
    vobFreshAsOf: '2026-08-01',
    vobStale: false,
    deductible: null,
    deductibleMet: null,
    oopMax: null,
    oopMet: null,
    ...over,
  };
}

function snap(over: Partial<QualifySnapshot>): QualifySnapshot {
  return {
    resolved: null,
    facilities: [],
    identifierLandingFacility: null,
    viewerHasAmountsCapability: false,
    tenantScope: QUALIFY_TENANT_SCOPE,
    policy: null,
    ladder: null,
    provenance: 'direct',
    ...over,
  };
}

const CONFIDENT_LADDER = {
  rungs: [{ days: 90 as const, distinctPatients: 14, sufficient: true }],
  chosenDays: 90 as const,
  sufficient: true,
};

// ── Scenario 1: thin + OON (unscoped) ────────────────────────────────────────────────────────────

const THIN_OON = snap({
  facilities: [
    fac({ rank: 1, name: 'ALPHA', ratingV2: 60, iqBand: '50', distinctPatients: 4, medianDaysToPayment: 40, factors: [POS_FACTOR, NEG_FACTOR] }),
    fac({ rank: 2, name: 'BETA', ratingV2: 35, iqBand: '30', distinctPatients: 3, medianDaysToPayment: 55, factors: [NEG_FACTOR] }),
  ],
  policy: policyCard({ network: 'OON' }),
});

test('thin + OON: five most-specific-first chips; OON suggests the network chip', () => {
  const { chips, suggestedId } = qualifyAiChips(THIN_OON);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['ranks', 'thin', 'placement', 'network', 'speed'],
  );
  assert.equal(suggestedId, 'network');
  assert.match(chips[3]?.label ?? '', /out of network/);
  assert.match(chips[1]?.label ?? '', /enough history/);
});

// ── Scenario 2: rated-strong + INN + self-funded (unscoped, confident sample) ────────────────────

const STRONG_INN_SELF = snap({
  facilities: [
    fac({ rank: 1, name: 'ALPHA', ratingV2: 70, iqBand: '65', distinctPatients: 9, medianDaysToPayment: 38, factors: [POS_FACTOR] }),
    fac({ rank: 2, name: 'BETA', ratingV2: 55, iqBand: '50', distinctPatients: 5, medianDaysToPayment: 44, factors: [POS_FACTOR, NEG_FACTOR] }),
  ],
  policy: policyCard({ network: 'INN', funding: 'Self-Funded' }),
  ladder: CONFIDENT_LADDER,
});

test('rated-strong + INN + self-funded: network and funding chips take their INN/self variants', () => {
  const { chips, suggestedId } = qualifyAiChips(STRONG_INN_SELF);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['ranks', 'placement', 'network', 'funding', 'speed'],
  );
  assert.equal(suggestedId, 'ranks'); // unscoped, not OON → else-branch
  assert.match(chips[2]?.label ?? '', /In network/);
  assert.match(chips[3]?.label ?? '', /Self-funded/);
});

// ── Scenario 3: unrated-all (no policy, no medians, no factors) ──────────────────────────────────

const UNRATED_ALL = snap({
  facilities: [
    fac({ rank: 1, name: 'ALPHA', distinctPatients: 2 }),
    fac({ rank: 2, name: 'BETA', distinctPatients: 1 }),
  ],
});

test('unrated-all: the head chip never implies a score exists; suggestion may name an unshown chip', () => {
  const { chips, suggestedId } = qualifyAiChips(UNRATED_ALL);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['explain', 'thin'],
  );
  // Nothing is rated, so the head chip asks what we KNOW — never "why does it score".
  assert.equal(chips[0]?.label, 'What do we actually know about this policy?');
  assert.ok(!chips.some((c) => /score/.test(c.label)), 'no label implies a score exists');
  // Ruled table's else-branch: 'ranks' — not in the shown set (mockup-faithful: nothing highlights).
  assert.equal(suggestedId, 'ranks');
  assert.ok(!chips.some((c) => c.id === 'ranks'));
  // Old conditional semantics preserved: no median → no speed chip; no negative factor → no improve.
  assert.ok(!chips.some((c) => c.id === 'speed'));
  assert.ok(!chips.some((c) => c.id === 'improve'));
});

// ── Scenario 4: EPO + fully-insured (slow payer, network not captured) ───────────────────────────

const EPO_FULLY = snap({
  facilities: [
    fac({ rank: 1, name: 'ALPHA', ratingV2: 66, iqBand: '65', distinctPatients: 12, medianDaysToPayment: 120, factors: [POS_FACTOR] }),
    fac({ rank: 2, name: 'BETA', ratingV2: 52, iqBand: '50', distinctPatients: 6, medianDaysToPayment: 130, factors: [POS_FACTOR] }),
  ],
  policy: policyCard({ policyType: 'EPO', funding: 'Fully Insured' }),
  ladder: { ...CONFIDENT_LADDER, rungs: [{ days: 90 as const, distinctPatients: 18, sufficient: true }] },
});

test('EPO + fully-insured: plantype names the plan; null network yields NO network chip; slow speed variant', () => {
  const { chips, suggestedId } = qualifyAiChips(EPO_FULLY);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['ranks', 'placement', 'plantype', 'funding', 'speed'],
  );
  assert.equal(chips[2]?.label, 'EPO plan — is there any path to payment?');
  assert.match(chips[3]?.label ?? '', /Fully insured/);
  assert.ok(!chips.some((c) => c.id === 'network'), 'network null (Phase D gap) → chip absent');
  assert.match(chips[4]?.label ?? '', /pays slowly/); // every median > 100d
  assert.equal(suggestedId, 'ranks');
});

// ── Scenario 5: scoped (single facility) with conflicting factors ────────────────────────────────

const SCOPED_CONFLICT = snap({
  facilities: [
    fac({ rank: 1, name: 'ALPHA', ratingV2: 55, iqBand: '50', distinctPatients: 15, medianDaysToPayment: 41, factors: [POS_FACTOR, NEG_FACTOR] }),
  ],
  policy: policyCard({ network: 'INN', funding: 'Self-Funded' }),
  ladder: { ...CONFIDENT_LADDER, rungs: [{ days: 90 as const, distinctPatients: 15, sufficient: true }] },
});

test('scoped + conflict: explain heads and is the suggested chip (ruled table)', () => {
  const { chips, suggestedId } = qualifyAiChips(SCOPED_CONFLICT);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['explain', 'placement', 'network', 'funding', 'speed'],
  );
  assert.equal(chips[0]?.label, 'Why does this facility score what it does?');
  assert.equal(chips[1]?.label, 'Should I place this client here?'); // scoped placement variant
  assert.equal(suggestedId, 'explain');
});

test('suggested table: scoped+rated(no conflict)→placement; scoped+unrated→ranks', () => {
  const noConflict = snap({
    ...SCOPED_CONFLICT,
    facilities: [{ ...SCOPED_CONFLICT.facilities[0]!, factors: [POS_FACTOR] }],
  });
  assert.equal(qualifyAiChips(noConflict).suggestedId, 'placement');
  const unrated = snap({
    ...SCOPED_CONFLICT,
    facilities: [{ ...SCOPED_CONFLICT.facilities[0]!, ratingV2: null, iqBand: null }],
  });
  assert.equal(qualifyAiChips(unrated).suggestedId, 'ranks');
});

// ── Cap, ordering under pressure, determinism ────────────────────────────────────────────────────

test('at most five chips even when eight candidates qualify — most specific win', () => {
  const maximal = snap({
    facilities: [
      fac({ rank: 1, name: 'ALPHA', ratingV2: 70, iqBand: '65', distinctPatients: 4, medianDaysToPayment: 120, factors: [POS_FACTOR, NEG_FACTOR] }),
      fac({ rank: 2, name: 'BETA', ratingV2: 30, iqBand: '30', distinctPatients: 3, medianDaysToPayment: 140, factors: [NEG_FACTOR] }),
    ],
    policy: policyCard({ policyType: 'HMO', funding: 'Self-Funded', network: 'OON' }),
  });
  const { chips } = qualifyAiChips(maximal);
  assert.equal(chips.length, QUALIFY_AI_CHIP_COUNT);
  // ranks·thin·placement·plantype·network qualify ahead of funding/speed/improve — specificity order.
  assert.deepEqual(
    chips.map((c) => c.id),
    ['ranks', 'thin', 'placement', 'plantype', 'network'],
  );
});

test('chip selection is deterministic — identical input, identical output, no randomness', () => {
  for (const s of [THIN_OON, STRONG_INN_SELF, UNRATED_ALL, EPO_FULLY, SCOPED_CONFLICT]) {
    const a = qualifyAiChips(s);
    const b = qualifyAiChips(s);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a.chips.length <= QUALIFY_AI_CHIP_COUNT);
  }
});
