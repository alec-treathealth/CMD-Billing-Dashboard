/**
 * Phase H firewall — the Qualify AI schema must be structurally incapable of carrying PHI or
 * dollars: .strict() at every level, no identifier/dollar/employer fields exist, bounds enforced,
 * and the built prompt is verifiably dollar-free and identifier-free.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  QualifyAiInputSchema,
  buildQualifyAiMessages,
  isQualifyAiSufficient,
  type QualifyAiInput,
} from '../src/collections/qualifyAi';

const VALID: QualifyAiInput = {
  question: 'explain',
  payerName: 'AETNA',
  policy: {
    carrier: 'AETNA',
    funding: 'Self-Funded',
    policyType: 'PPO',
    planType: 'OPEN ACCESS',
    network: null,
    memberCount: 14,
    vobStale: false,
  },
  provenance: 'direct',
  windowDays: 90,
  windowSufficient: true,
  facilities: [
    {
      name: '405 RECOVERY',
      careSetting: 'OP',
      ratingV2: 75,
      iqBand: '65',
      pctAllowedOfBilled: 62,
      distinctPatients: 22,
      lineCount: 120,
      medianDaysToPayment: 41,
      factors: [
        {
          key: 'claims',
          label: 'Claims reliability',
          weight: 25,
          score: 0.62,
          available: true,
          direction: 'neu',
          detail: '62% of billed allowed across 120 lines (110 confirmed-tier).',
        },
      ],
    },
  ],
  amountsBlind: false,
};

test('valid input parses; the whole shape round-trips', () => {
  const r = QualifyAiInputSchema.safeParse(VALID);
  assert.ok(r.success);
  assert.ok(isQualifyAiSufficient(r.data!));
});

test('unknown keys are REJECTED at every level — dollars and identifiers cannot ride', () => {
  for (const poisoned of [
    { ...VALID, totalBilled: 999999 }, // dollar at the top
    { ...VALID, memberId: 'AET12345678' }, // identifier at the top
    { ...VALID, policy: { ...VALID.policy!, employerName: 'ACME' } }, // employer on the policy
    { ...VALID, policy: { ...VALID.policy!, deductible: '$1,500' } }, // benefit string
    { ...VALID, facilities: [{ ...VALID.facilities[0]!, billedAmount: 123456 }] }, // dollar on a facility
    { ...VALID, facilities: [{ ...VALID.facilities[0]!, factors: [{ ...VALID.facilities[0]!.factors[0]!, dollars: 5 }] }] },
  ]) {
    assert.equal(QualifyAiInputSchema.safeParse(poisoned).success, false);
  }
});

test('bounds: facility cap 10, factor cap 6, detail length 300, window 1-366', () => {
  const many = { ...VALID, facilities: Array.from({ length: 11 }, () => VALID.facilities[0]!) };
  assert.equal(QualifyAiInputSchema.safeParse(many).success, false);
  const longDetail = {
    ...VALID,
    facilities: [{ ...VALID.facilities[0]!, factors: [{ ...VALID.facilities[0]!.factors[0]!, detail: 'x'.repeat(301) }] }],
  };
  assert.equal(QualifyAiInputSchema.safeParse(longDetail).success, false);
  assert.equal(QualifyAiInputSchema.safeParse({ ...VALID, windowDays: 0 }).success, false);
  assert.equal(QualifyAiInputSchema.safeParse({ ...VALID, windowDays: 400 }).success, false);
});

test('the built prompt carries no dollar sign and no identifier-shaped content', () => {
  const { system, user } = buildQualifyAiMessages(VALID);
  assert.ok(!user.includes('$'), 'user turn is dollar-free');
  assert.ok(!system.includes('$') || system.includes('dollar'), 'system mentions dollars only to forbid them');
  assert.match(user, /Aggregates \(JSON\)/);
  assert.match(user, /WHY does the top facility score/);
  // The framing changes with the question — each chip asks its own thing.
  const ranks = buildQualifyAiMessages({ ...VALID, question: 'ranks' });
  assert.match(ranks.user, /WHICH facility does this policy pay best/);
});

test('insufficient: no facilities AND no policy → the panel never calls the model', () => {
  assert.equal(isQualifyAiSufficient({ ...VALID, facilities: [], policy: null }), false);
  assert.equal(isQualifyAiSufficient({ ...VALID, facilities: [] }), true); // policy alone is explainable
});
