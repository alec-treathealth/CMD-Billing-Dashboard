/**
 * THE AI PAYLOAD MAPPING — the one seam between the snapshot on screen and the model's input.
 *
 * It had NEVER been tested, and the S1 review found out why that mattered: deleting
 * `bedState: f.bedState` from the map left root 24/24, app 519/519 and both typechecks green,
 * because the schema field is `.optional()`. The prompt would go on describing a field the model
 * never receives, and every gate in the repo would stay green while the availability-ordering rule
 * quietly became unactionable. `.optional()` is still right — a stale cached payload must degrade to
 * "not told about beds", never to a hard-rejected request that kills Ask AI — so the mapping is
 * pinned here instead.
 *
 * MINIMAL BY DESIGN. This covers the payload BUILDER, not the panel: the panel is a client component
 * with streaming state and a `'use server'` action chain, and testing it is a different job.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildQualifyAiInput } from '../lib/qualify/aiPayload';
import { QualifyAiInputSchema } from '../../src/collections/qualifyAi';
import type { QualifyFacility, QualifySnapshot } from '../lib/qualify/contract';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture';

function facility(over: Partial<QualifyFacility>): QualifyFacility {
  return {
    ...QUALIFY_FACILITY_V2_NULLS,
    rank: 1,
    name: 'NASHVILLE MENTAL HEALTH',
    facilityKey: 'NASH',
    city: 'Nashville',
    state: 'TN',
    pctAllowedOfBilled: 62,
    rating: 62,
    streakSignal: null,
    billedAmount: null,
    allowedAmount: null,
    lineCount: 210,
    distinctPatients: 14,
    confirmedClaims: 200,
    estimateClaims: 5,
    unknownClaims: 5,
    careSetting: 'IP',
    entity: 'BXR',
    ratingV2: 62,
    iqBand: '50',
    factors: [],
    availableWeight: 45,
    ...over,
  } as QualifyFacility;
}

function snapshot(facilities: QualifyFacility[]): QualifySnapshot {
  return {
    resolved: { payerName: 'AETNA', payerScope: 'payer' },
    facilities,
    policy: null,
    provenance: 'direct',
    ladder: { chosenDays: 90, sufficient: true },
  } as unknown as QualifySnapshot;
}

test('bedState REACHES the model — the field the availability-ordering prompt rule depends on', () => {
  const input = buildQualifyAiInput(
    'ranks',
    snapshot([
      facility({ name: 'OPEN HOUSE', bedState: 'open' }),
      facility({ name: 'FULL HOUSE', bedState: 'full', rank: 2 }),
      facility({ name: 'OUTPATIENT', bedState: 'not_applicable', rank: 3 }),
      facility({ name: 'NO CENSUS', bedState: 'unknown', rank: 4 }),
    ]),
    false,
  );
  assert.deepEqual(
    input.facilities.map((f) => f.bedState),
    ['open', 'full', 'not_applicable', 'unknown'],
  );
  // The order it arrives in IS the ranking's order — the prompt tells the model to read it that way.
  assert.deepEqual(input.facilities.map((f) => f.name), ['OPEN HOUSE', 'FULL HOUSE', 'OUTPATIENT', 'NO CENSUS']);
});

test('the built payload passes the STRICT firewall — the map cannot drift from the schema', () => {
  // The real protection against a mapping bug: build it the way the panel does and run it through
  // the same zod object the server re-validates with. An added field that the schema does not
  // declare fails here rather than at runtime, on a user's click, as a dead Ask AI panel.
  const r = QualifyAiInputSchema.safeParse(
    buildQualifyAiInput('explain', snapshot([facility({ bedState: 'full' })]), false),
  );
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error?.issues));
});

test('the payload is capped at ten facilities, in array order', () => {
  const many = Array.from({ length: 14 }, (_, i) => facility({ name: `F${i}`, rank: i + 1 }));
  const input = buildQualifyAiInput('ranks', snapshot(many), false);
  assert.equal(input.facilities.length, 10, 'the zod .max(10) bound, respected at the source');
  assert.equal(input.facilities[9]?.name, 'F9');
  // The consequence the prompt has to disclose: F10-F13 are on the rep's screen and not in the
  // model's context, and under an availability-first sort those trailing rows are the full ones.
  assert.ok(!input.facilities.some((f) => f.name === 'F13'));
});

test('no dollars cross, for any viewer — the payload is dollar-free by construction', () => {
  const input = buildQualifyAiInput('ranks', snapshot([facility({ billedAmount: 999999.99, allowedAmount: 888888.88 })]), true);
  const wire = JSON.stringify(input);
  assert.ok(!wire.includes('999999.99') && !wire.includes('888888.88'));
  assert.ok(!wire.includes('billedAmount') && !wire.includes('allowedAmount'));
});
