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
    employerCount: 1,
    carrierCount: 1,
    carriers: [],
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
    // S2 fields at their honest "not counted / no book" values. `aiChips` reads neither — the chip
    // vocabulary comes from the member ranking and the policy card — but the contract declares them,
    // and a fixture that omits a declared field has stopped describing the real wire.
    memberCount: null,
    bookFacilities: null,
    provenance: 'direct',
    payerOptions: [],
    payerOverridden: false,
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

// ── Scenario 6: nothing-strong + confident sample — the ONLY state that PRODUCES takeit ──────────
//
// Without this fixture the takeit and improve candidate lines could both be deleted with a green
// suite (every other fixture either caps at five before reaching improve, or has something >= 50).

const NOTHING_STRONG = snap({
  facilities: [
    fac({ rank: 1, name: 'ALPHA', ratingV2: 40, iqBand: '30', distinctPatients: 12, medianDaysToPayment: 60, factors: [NEG_FACTOR] }),
    fac({ rank: 2, name: 'BETA', ratingV2: 22, iqBand: '15', distinctPatients: 8, medianDaysToPayment: 70, factors: [NEG_FACTOR] }),
  ],
  ladder: { ...CONFIDENT_LADDER, rungs: [{ days: 90 as const, distinctPatients: 20, sufficient: true }] },
});

test('nothing-strong + confident: takeit AND improve are both produced; placement is suppressed', () => {
  const { chips, suggestedId } = qualifyAiChips(NOTHING_STRONG);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['ranks', 'takeit', 'speed', 'improve'],
  );
  assert.equal(chips[1]?.label, 'Should we be taking this policy at all?');
  assert.equal(chips[3]?.label, 'What would move this rating?');
  // placement is deliberately withheld when nothing reads strong — yet the ruled suggested table's
  // else-branch still returns ranks, which IS shown here.
  assert.ok(!chips.some((c) => c.id === 'placement'));
  assert.equal(suggestedId, 'ranks');
});

test('takeit is mutually exclusive with thin — a thin sample asks about history, not appetite', () => {
  // Weak (nothing >= 50) AND thin (4 < 10): the mockup gates takeit on `!thin`, because "should we
  // take this policy" is unanswerable on evidence too thin to read.
  const thinAndWeak = snap({
    facilities: [fac({ rank: 1, name: 'ALPHA', ratingV2: 40, iqBand: '30', distinctPatients: 4, factors: [NEG_FACTOR] })],
  });
  const ids = qualifyAiChips(thinAndWeak).chips.map((c) => c.id);
  assert.ok(ids.includes('thin'));
  assert.ok(!ids.includes('takeit'));
});

// ── The ladder is load-bearing: it OVERRIDES the facility sum for the thin decision ──────────────

test('thin reads the chosen ladder rung, not the facility sum — both directions', () => {
  const base = NOTHING_STRONG.facilities;
  // Facility sum is 20 (confident) but the chosen rung says 4 — the RUNG wins, so thin fires.
  const rungThin = snap({
    facilities: base,
    ladder: { rungs: [{ days: 90 as const, distinctPatients: 4, sufficient: false }], chosenDays: 90, sufficient: false },
  });
  assert.ok(qualifyAiChips(rungThin).chips.some((c) => c.id === 'thin'), 'rung 4 → thin');
  // Converse: a tiny facility sum (2) with a confident rung (14) must NOT read as thin.
  const rungConfident = snap({
    facilities: [fac({ rank: 1, name: 'ALPHA', ratingV2: 60, iqBand: '50', distinctPatients: 2 })],
    ladder: CONFIDENT_LADDER,
  });
  assert.ok(!qualifyAiChips(rungConfident).chips.some((c) => c.id === 'thin'), 'rung 14 → not thin');
  // No ladder at all → fall back to the facility sum (2 → thin).
  const noLadder = snap({ facilities: rungConfident.facilities });
  assert.ok(qualifyAiChips(noLadder).chips.some((c) => c.id === 'thin'), 'no ladder → facility sum');
});

test('thin boundary is exactly the confident floor: 9 thin, 10 not', () => {
  const at = (n: number) =>
    qualifyAiChips(
      snap({
        facilities: [fac({ rank: 1, name: 'ALPHA', ratingV2: 60, iqBand: '50', distinctPatients: n })],
      }),
    ).chips.some((c) => c.id === 'thin');
  assert.equal(at(9), true);
  assert.equal(at(10), false);
});

// ── Guards that would otherwise be deletable with a green suite ──────────────────────────────────

test('a policy card with found:false contributes NO policy chips — an unmatched VOB is not a fact', () => {
  const notFound = snap({
    facilities: [fac({ rank: 1, name: 'ALPHA', ratingV2: 60, iqBand: '50', distinctPatients: 14 })],
    // Every policy-derived chip would fire on these values if `found` were ignored.
    policy: policyCard({ found: false, policyType: 'EPO', funding: 'Self-Funded', network: 'OON' }),
  });
  const ids = qualifyAiChips(notFound).chips.map((c) => c.id);
  for (const leaked of ['plantype', 'funding', 'network']) {
    assert.ok(!ids.includes(leaked as never), `${leaked} must not fire on an unmatched policy`);
  }
  // And the suggested table must not claim OON either — this facility is scoped+rated with no
  // conflict, so the ruled table lands on placement; 'network' would mean an unmatched VOB had
  // asserted a posture.
  assert.equal(qualifyAiChips(notFound).suggestedId, 'placement');
});

test('an UNAVAILABLE factor is not a signal — no improve lever, no conflict', () => {
  const unavailableNeg: QualifyFactorReading = { ...NEG_FACTOR, available: false, score: null };
  const s = snap({
    facilities: [fac({ rank: 1, name: 'ALPHA', ratingV2: 60, iqBand: '50', distinctPatients: 14, factors: [POS_FACTOR, unavailableNeg] })],
  });
  const { chips, suggestedId } = qualifyAiChips(s);
  assert.ok(!chips.some((c) => c.id === 'improve'), 'unavailable factors need data, not effort');
  // Not a conflict either (pos + unavailable-neg) → scoped+rated falls through to placement.
  assert.equal(suggestedId, 'placement');
});

test('policy-only with ZERO facilities is a supported state and still offers chips', () => {
  const policyOnly = snap({ policy: policyCard({ policyType: 'EPO', funding: 'Self-Funded' }) });
  const { chips, suggestedId } = qualifyAiChips(policyOnly);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['explain', 'thin', 'plantype', 'funding'],
  );
  assert.equal(chips[0]?.label, 'What do we actually know about this policy?');
  assert.equal(suggestedId, 'ranks'); // nothing to rank — panel highlights nothing, by design
});

test('the neutral speed label appears when any facility pays inside the slow threshold', () => {
  const fast = snap({
    facilities: [fac({ rank: 1, name: 'ALPHA', ratingV2: 60, iqBand: '50', distinctPatients: 14, medianDaysToPayment: 35 })],
  });
  const speed = qualifyAiChips(fast).chips.find((c) => c.id === 'speed');
  assert.equal(speed?.label, 'How long until we see the money?');
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
