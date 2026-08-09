/**
 * Qualify BOARD (smoke-shell right pane) — the tape read core + the nightly cron's rating fold.
 *
 * THE PARITY CLAIM UNDER TEST: computePairPolicyRating (board.ts) must produce EXACTLY what the
 * interactive surface would — computeRatingV2 per facility with assembleFacilities' input mapping
 * (payer-scoped branch: provenance 'direct', payerKnown true, outcomes-beat-census under the
 * sample floor), folded through derivePolicyRating. The lockstep tests below build the SAME
 * QualifyRatingV2Input by hand and assert equality, so a mapping drift in board.ts fails here
 * before it ships a wrong number into collections.qualify_policy_rating_daily.
 *
 * ⚠️ .tsx on purpose: app/package.json collects `test/*.test.tsx` only — a .ts file here would
 * "pass" by never running (see forecast-edit-feedback.test.tsx's header).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computePairPolicyRating,
  getQualifyPolicyTapeCore,
  type QualifyPairRatingContext,
} from '../lib/qualify/board';
import { computeRatingV2 } from '../lib/qualify/ratingV2';
import { derivePolicyRating } from '../lib/qualify/policyRating';
import type { QualifyPolicyTapeRow, QualifyRatingHistoryFacilityAgg } from '../../src/collections/qualifyRatingHistory';

const NO_CONTEXT: QualifyPairRatingContext = {
  coding: { seeded: false, rows: [] },
  census: new Map(),
  outcomes: new Map(),
};

function agg(over: Partial<QualifyRatingHistoryFacilityAgg> = {}): QualifyRatingHistoryFacilityAgg {
  return {
    facility: 'TREAT MENTAL HEALTH CALIFORNIA',
    facilityCode: 'TREAT_CA',
    careSetting: 'OP',
    lineCount: 40,
    distinctPatients: 6,
    confirmedClaims: 32,
    pctAllowed: 55,
    medianDaysToPayment: 23,
    ...over,
  };
}

// ── computePairPolicyRating — lockstep with the interactive math ────────────────────────────────

test('a rateable pair scores exactly what computeRatingV2 + derivePolicyRating would', () => {
  const f = agg();
  const got = computePairPolicyRating('ANTHEM BLUE CROSS', [f], '2026-08-08', 90, NO_CONTEXT);

  // the same input assembleFacilities would build for the payer-scoped, no-context branch
  const expectV2 = computeRatingV2({
    pctAllowed: f.pctAllowed,
    lineCount: f.lineCount,
    confirmedClaims: f.confirmedClaims,
    distinctPatients: f.distinctPatients,
    windowDays: 90,
    provenance: 'direct',
    registrySeeded: false,
    payerKnown: true,
    payerScopeAll: false,
    payerCount: 1,
    codingLifecycle: null,
    codingDecidedOn: null,
    codingCodesLabel: null,
    medianDaysToPayment: f.medianDaysToPayment,
    avgAuthDays: null,
    avgLosDays: null,
    censusFamily: null,
    authSample: null,
    losSample: null,
    losBasis: null,
    losWindowDays: null,
    now: new Date('2026-08-08T12:00:00Z'),
  });
  const expected = derivePolicyRating([{ ratingV2: expectV2.rating, distinctPatients: f.distinctPatients }]);

  assert.equal(got.rating, expected.rating);
  assert.equal(got.band, expected.band);
  assert.equal(got.ratedFacilities, expected.ratedCount);
  assert.notEqual(got.rating, null); // and the fixture genuinely rates
});

test('the sample floor suppresses honestly: 2 patients → null rating, never 0', () => {
  const got = computePairPolicyRating('ANTHEM', [agg({ distinctPatients: 2 })], '2026-08-08', 90, NO_CONTEXT);
  assert.equal(got.rating, null);
  assert.equal(got.band, null);
  assert.equal(got.ratedFacilities, 0);
});

test('completed-stay outcomes beat the census snapshot only at/above the sample floor', () => {
  const census = new Map([
    [
      'TREAT_CA',
      { board_family: 'residential', avg_auth_days: 10, avg_los_days: 8, auth_sample: 5, los_sample: 5 },
    ],
  ]);
  const outcomesGood = new Map([
    ['TREAT_CA', { stays_sample: 4, auth_sample: 4, avg_los_days: 14, avg_auth_days: 10, window_days: 180 }],
  ]);
  const outcomesThin = new Map([
    ['TREAT_CA', { stays_sample: 2, auth_sample: 2, avg_los_days: 14, avg_auth_days: 10, window_days: 180 }],
  ]);
  const f = agg({ careSetting: 'IP' });

  const withOutcomes = computePairPolicyRating('ANTHEM', [f], '2026-08-08', 90, {
    ...NO_CONTEXT,
    census,
    outcomes: outcomesGood,
  });
  const withThinOutcomes = computePairPolicyRating('ANTHEM', [f], '2026-08-08', 90, {
    ...NO_CONTEXT,
    census,
    outcomes: outcomesThin,
  });

  // lockstep expectations for both branches
  const base = {
    pctAllowed: f.pctAllowed,
    lineCount: f.lineCount,
    confirmedClaims: f.confirmedClaims,
    distinctPatients: f.distinctPatients,
    windowDays: 90,
    provenance: 'direct' as const,
    registrySeeded: false,
    payerKnown: true,
    payerScopeAll: false,
    payerCount: 1,
    codingLifecycle: null,
    codingDecidedOn: null,
    codingCodesLabel: null,
    medianDaysToPayment: f.medianDaysToPayment,
    censusFamily: 'residential' as const,
    now: new Date('2026-08-08T12:00:00Z'),
  };
  const expectCompleted = computeRatingV2({
    ...base,
    avgAuthDays: 10,
    avgLosDays: 14,
    authSample: 4,
    losSample: 4,
    losBasis: 'completed',
    losWindowDays: 180,
  });
  const expectInProgress = computeRatingV2({
    ...base,
    avgAuthDays: 10,
    avgLosDays: 8,
    authSample: 5,
    losSample: 5,
    losBasis: 'in_progress',
    losWindowDays: null,
  });

  assert.equal(
    withOutcomes.rating,
    derivePolicyRating([{ ratingV2: expectCompleted.rating, distinctPatients: f.distinctPatients }]).rating,
  );
  assert.equal(
    withThinOutcomes.rating,
    derivePolicyRating([{ ratingV2: expectInProgress.rating, distinctPatients: f.distinctPatients }]).rating,
  );
});

test('the fold is patient-weighted across facilities (the derivePolicyRating contract)', () => {
  const strong = agg({ facility: 'STRONG', pctAllowed: 80, distinctPatients: 9 });
  const weak = agg({ facility: 'WEAK', pctAllowed: 10, distinctPatients: 3, confirmedClaims: 2 });
  const got = computePairPolicyRating('ANTHEM', [strong, weak], '2026-08-08', 90, NO_CONTEXT);
  assert.notEqual(got.rating, null);
  assert.equal(got.ratedFacilities, 2);
  // weighted toward the 9-patient facility: strictly above the unweighted mean of the two
  const each = [strong, weak].map(
    (f) =>
      computePairPolicyRating('ANTHEM', [f], '2026-08-08', 90, NO_CONTEXT).rating as number,
  );
  const unweightedMean = (each[0]! + each[1]!) / 2;
  assert.ok((got.rating as number) > unweightedMean);
});

// ── getQualifyPolicyTapeCore ─────────────────────────────────────────────────────────────────────

function tapeRow(over: Partial<QualifyPolicyTapeRow> = {}): QualifyPolicyTapeRow {
  return {
    member_id_prefix_bidx: 'f'.repeat(64),
    token_tail: 'ffffff',
    echo: null,
    primary_payer: 'ANTHEM BLUE CROSS',
    rating_now: 71,
    band_now: '65',
    rating_then: 66,
    delta_pts: 5,
    distinct_members: 6,
    line_count: 40,
    window_days: 90,
    as_of: '2026-08-08',
    ...over,
  };
}

const GATE_OK = async () => ({ ok: true }) as const;

test('gate failure throws (fail-closed) and never touches the loader', async () => {
  let loaded = false;
  await assert.rejects(
    getQualifyPolicyTapeCore({
      requirePrincipal: async () => ({ ok: false, error: 'Not authorized.' }),
      loadTape: async () => {
        loaded = true;
        return [];
      },
      deltaDays: 90,
    }),
    /Not authorized/,
  );
  assert.equal(loaded, false);
});

test('an absent history table reads as available:false — an honest empty lane, not an error', async () => {
  const res = await getQualifyPolicyTapeCore({
    requirePrincipal: GATE_OK,
    loadTape: async () => null,
    deltaDays: 90,
  });
  assert.deepEqual(res, { available: false, asOf: null, deltaDays: 90, items: [] });
});

test('an applied-but-empty table reads available:true with empty items — the documented limit', async () => {
  // "no snapshots yet" vs "no movers clear the gates" are deliberately indistinguishable
  // (QualifyPolicyTapeResult.available's doc, review 2026-08-08) — both render the same empty lane.
  const res = await getQualifyPolicyTapeCore({
    requirePrincipal: GATE_OK,
    loadTape: async () => [],
    deltaDays: 90,
  });
  assert.deepEqual(res, { available: true, asOf: null, deltaDays: 90, items: [] });
});

test('rows map to the contract; a corrupt stored band is recomputed from the number', async () => {
  const res = await getQualifyPolicyTapeCore({
    requirePrincipal: GATE_OK,
    loadTape: async () => [tapeRow(), tapeRow({ band_now: 'garbage', rating_now: 52, echo: 'GGS' })],
    deltaDays: 90,
  });
  assert.equal(res.available, true);
  assert.equal(res.asOf, '2026-08-08');
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0]?.bandNow, '65');
  assert.equal(res.items[1]?.bandNow, '50'); // recomputed via iqBandOf(52), not trusted text
  assert.equal(res.items[1]?.echo, 'GGS');
  assert.equal(res.items[0]?.tokenTail, 'ffffff');
});
