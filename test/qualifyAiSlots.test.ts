/**
 * SLOT-CHIP FIREWALL (Smoke Phase 2, 2026-08-10) — the assertions that keep prose off the wire.
 *
 * The `slots` field exists so a rep can vary a question without a text box. The entire security
 * value of that is the absence of any string-typed field, and "absence" is not something tsc can
 * assert for you: adding `facility: z.string()` later compiles, typechecks, passes every existing
 * test, and quietly opens a path for a member ID to reach a model prompt and an audit row. So the
 * structural assertion is written out longhand below and will fail the moment such a field appears.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QualifyAiInputSchema,
  buildQualifyAiMessages,
  type QualifyAiInput,
} from '../src/collections/qualifyAi';

function facility(name: string): QualifyAiInput['facilities'][number] {
  return {
    name,
    careSetting: 'IP',
    ratingV2: 60,
    iqBand: '50',
    pctAllowedOfBilled: 49,
    distinctPatients: 12,
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
    facilities: [facility('Nashville Mental Health'), facility('Lonestar Mental Health')],
    amountsBlind: false,
    ...over,
  };
}

// ── The structural rule ────────────────────────────────────────────────────────────────────────
test('no slot field accepts a string that is not a closed enum member', () => {
  // Free prose in EVERY slot, one at a time. Each must be rejected outright.
  const prose = 'MEMBER GGS0041881 asked about their deductible';
  const slotKeys = ['facility', 'comparator', 'metric', 'horizonDays', 'careSetting'] as const;
  for (const key of slotKeys) {
    const parsed = QualifyAiInputSchema.safeParse(
      base({
        slots: {
          facility: null,
          comparator: null,
          metric: null,
          horizonDays: null,
          careSetting: null,
          [key]: prose,
        },
      } as unknown as Partial<QualifyAiInput>),
    );
    assert.equal(parsed.success, false, `slots.${key} accepted free text — the firewall has a hole`);
  }
});

test('slots rejects an unknown key outright (.strict)', () => {
  const parsed = QualifyAiInputSchema.safeParse(
    base({
      slots: {
        facility: 0,
        comparator: null,
        metric: null,
        horizonDays: null,
        careSetting: null,
        note: 'anything at all',
      },
    } as unknown as Partial<QualifyAiInput>),
  );
  assert.equal(parsed.success, false);
});

test('a facility slot is an INDEX, and a name is refused', () => {
  assert.equal(
    QualifyAiInputSchema.safeParse(
      base({ slots: { facility: 'Nashville Mental Health', comparator: null, metric: null, horizonDays: null, careSetting: null } } as unknown as Partial<QualifyAiInput>),
    ).success,
    false,
  );
  assert.equal(
    QualifyAiInputSchema.safeParse(
      base({ slots: { facility: 1, comparator: null, metric: null, horizonDays: null, careSetting: null } }),
    ).success,
    true,
  );
});

test('an out-of-enum horizon and an out-of-range index are both refused', () => {
  const bad = (slots: unknown) =>
    QualifyAiInputSchema.safeParse(base({ slots } as unknown as Partial<QualifyAiInput>)).success;
  assert.equal(bad({ facility: null, comparator: null, metric: null, horizonDays: 45, careSetting: null }), false);
  assert.equal(bad({ facility: 10, comparator: null, metric: null, horizonDays: null, careSetting: null }), false);
  assert.equal(bad({ facility: null, comparator: null, metric: 'dollars', horizonDays: null, careSetting: null }), false);
});

// ── Back-compat: the field is optional in BOTH directions ──────────────────────────────────────
//
// The payerCount: min(1) lesson, recorded on facilitySchema — a stricter-than-necessary field here
// does not degrade one chip, it hard-rejects the request and kills Ask AI for the whole snapshot.
test('a payload with no slots at all still validates', () => {
  assert.equal(QualifyAiInputSchema.safeParse(base()).success, true);
  assert.equal(QualifyAiInputSchema.safeParse(base({ slots: null })).success, true);
});

// ── Resolution happens server-side, and degrades rather than throwing ───────────────────────────
test('a facility index is resolved to its name in the prompt, never sent as one', () => {
  const input = base({
    slots: { facility: 1, comparator: 0, metric: 'allowed', horizonDays: null, careSetting: null },
  });
  const { user } = buildQualifyAiMessages(input);
  assert.match(user, /asking specifically about Lonestar Mental Health/);
  assert.match(user, /Compare it against Nashville Mental Health/);
  assert.match(user, /percent allowed of billed/);
});

test('an index past the end of a shorter ranking degrades to silence, not a throw', () => {
  // The ranking can shrink between the render that offered the choice and the click that used it.
  const input = base({ slots: { facility: 9, comparator: null, metric: null, horizonDays: null, careSetting: null } });
  const { user } = buildQualifyAiMessages(input);
  assert.doesNotMatch(user, /asking specifically about/);
  // and the question itself still went out
  assert.match(user, /Question:/);
});

test('a chosen horizon never overrides the window the numbers were actually computed over', () => {
  // The slot is the rep's FRAMING. If the prompt let it read as a re-scoping, the model would narrate
  // a 30-day answer off a 90-day aggregate — confidently, and with no way for the rep to catch it.
  const input = base({
    windowDays: 90,
    slots: { facility: null, comparator: null, metric: null, horizonDays: 30, careSetting: null },
  });
  const { user } = buildQualifyAiMessages(input);
  assert.match(user, /framed the question over 30 days/);
  assert.match(user, /figures here still cover 90 days/);
});
