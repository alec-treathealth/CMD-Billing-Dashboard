/**
 * Rating v2 — the five-factor renormalized model (qualify-v2-build-plan §5). Pins the exact numeric
 * behavior the scorecard renders: renormalization over available factors, the coding factor's
 * seeded/unseeded split, IQ band edges, lifecycle × age decay, TTP bounds, auth-fit overrun penalty,
 * the sample-floor suppression, and the structural no-dollar invariant (admissions_seat parity).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  computeRatingV2,
  iqBandOf,
  windowAgeMultiplier,
  IQ_BAND_LABELS,
  QUALIFY_FACTOR_WEIGHTS,
  type QualifyRatingV2Input,
} from '../app/lib/qualify/ratingV2';

/** A healthy direct-evidence baseline; tests override the fields they exercise. */
function baseInput(over: Partial<QualifyRatingV2Input> = {}): QualifyRatingV2Input {
  return {
    pctAllowed: 68,
    lineCount: 186,
    confirmedClaims: 170,
    distinctPatients: 31,
    windowDays: 30,
    provenance: 'direct',
    registrySeeded: false,
    codingLifecycle: null,
    codingDecidedOn: null,
    codingCodesLabel: null,
    medianDaysToPayment: null,
    avgAuthDays: null,
    avgLosDays: null,
    now: new Date('2026-08-03T12:00:00Z'),
    ...over,
  };
}

const factor = (r: ReturnType<typeof computeRatingV2>, key: string) => {
  const f = r.factors.find((x) => x.key === key);
  assert.ok(f, `factor ${key} present`);
  return f!;
};

test('unseeded registry: coding excluded, renormalizes to 45, rating 82 → 65%+ band', () => {
  const r = computeRatingV2(baseInput());
  assert.equal(factor(r, 'coding').available, false);
  assert.equal(r.availableWeight, 45); // claims 25 + dataConfidence 20
  assert.equal(r.rating, 82); // (25·0.68 + 20·1.0) / 45 = 0.8222…
  assert.equal(r.band, '65');
  assert.equal(r.insufficientSample, false);
});

test('seeded registry, NO row on file: coding scores 0 and drags — rating 49 → 30%+ band', () => {
  const r = computeRatingV2(baseInput({ registrySeeded: true }));
  const coding = factor(r, 'coding');
  assert.equal(coding.available, true);
  assert.equal(coding.score, 0);
  assert.equal(coding.direction, 'neg');
  assert.match(coding.detail, /unproven/i);
  assert.equal(r.availableWeight, 75);
  assert.equal(r.rating, 49); // (30·0 + 25·0.68 + 20·1.0) / 75 = 0.4933…
  assert.equal(r.band, '30');
});

test('seeded + fresh CONFIRMED CODES: coding 1.0 — rating 89 → 65%+ band, codes label surfaces', () => {
  const r = computeRatingV2(
    baseInput({
      registrySeeded: true,
      codingLifecycle: 'CONFIRMED CODES',
      codingDecidedOn: '2026-07-04', // 30 days before injected now
      codingCodesLabel: 'H0017 / 0158',
    }),
  );
  const coding = factor(r, 'coding');
  assert.equal(coding.score, 1);
  assert.match(coding.detail, /H0017 \/ 0158/);
  assert.match(coding.detail, /decided 30d ago/);
  assert.equal(r.rating, 89); // (30 + 17 + 20) / 75
  assert.equal(r.band, '65');
});

test('thin comparable evidence: sample .6 × age .55 × employer .7 — rating 33 → 30%+ band', () => {
  const r = computeRatingV2(
    baseInput({ pctAllowed: 41, distinctPatients: 5, windowDays: 365, provenance: 'comparable_employer' }),
  );
  const conf = factor(r, 'dataConfidence');
  assert.ok(Math.abs((conf.score as number) - 0.231) < 1e-9, `conf score ${conf.score}`);
  assert.match(conf.detail, /same employer plan/);
  assert.equal(r.rating, 33); // (25·0.41 + 20·0.231) / 45 = 0.33044…
  assert.equal(r.band, '30');
});

test('sample floor: 2 patients → rating null, band null, insufficientSample, factors still listed', () => {
  const r = computeRatingV2(baseInput({ distinctPatients: 2 }));
  assert.equal(r.rating, null);
  assert.equal(r.band, null);
  assert.equal(r.insufficientSample, true);
  assert.equal(r.factors.length, 5);
});

test('no money evidence (pctAllowed null) → rating null even with other factors present', () => {
  const r = computeRatingV2(baseInput({ pctAllowed: null, registrySeeded: true, codingLifecycle: 'CONFIRMED CODES', codingDecidedOn: '2026-07-04' }));
  assert.equal(r.rating, null);
  assert.equal(r.band, null);
  assert.equal(r.insufficientSample, false);
  assert.match(factor(r, 'claims').detail, /No reliable allowed evidence/);
});

test('TTP joins the score: median 38d ≈ 0.828, full-stack rating 88', () => {
  const r = computeRatingV2(
    baseInput({
      registrySeeded: true,
      codingLifecycle: 'CONFIRMED CODES',
      codingDecidedOn: '2026-07-04',
      medianDaysToPayment: 38,
    }),
  );
  const ttp = factor(r, 'ttp');
  assert.ok(Math.abs((ttp.score as number) - (120 - 38) / 99) < 1e-9);
  assert.match(ttp.detail, /paid lines only/i);
  assert.equal(r.availableWeight, 90);
  assert.equal(r.rating, 88);
});

test('auth fit: under-auth is 1.0; overrun penalizes proportionally', () => {
  const ok = computeRatingV2(baseInput({ avgAuthDays: 18, avgLosDays: 17 }));
  assert.equal(factor(ok, 'authFit').score, 1);
  const over = computeRatingV2(baseInput({ avgAuthDays: 18, avgLosDays: 24 }));
  assert.ok(Math.abs((factor(over, 'authFit').score as number) - (1 - 6 / 18)) < 1e-9);
  const slight = computeRatingV2(baseInput({ avgAuthDays: 18, avgLosDays: 21 }));
  assert.ok(Math.abs((factor(slight, 'authFit').score as number) - (1 - 3 / 18)) < 1e-9);
  // auth 0 / null → unavailable, never a divide-by-zero
  assert.equal(factor(computeRatingV2(baseInput({ avgAuthDays: 0, avgLosDays: 10 })), 'authFit').available, false);
});

test('auth fit: OUTPATIENT is never scored, even with both inputs present', () => {
  // Ruling 2026-08-05. The outpatient boards maintain auth/UR on 4-6% of current clients and never
  // set a DC date, so LOS there is an open-ended today-minus-admit — measured 370 days at FRCA
  // against 86 authorized, which scored a full 10-point penalty off two abandoned rows.
  const op = computeRatingV2(baseInput({ avgAuthDays: 86, avgLosDays: 370, censusFamily: 'outpatient' }));
  const f = factor(op, 'authFit');
  assert.equal(f.available, false, 'outpatient is suppressed regardless of the numbers');
  assert.equal(f.score, null);
  assert.match(f.detail, /not scored for outpatient/i);
  // Suppression must not PENALISE: the weight renormalizes away rather than scoring zero.
  assert.ok(!op.factors.some((x) => x.key === 'authFit' && x.score === 0));

  // The identical numbers on a RESIDENTIAL facility still score (and still penalise the overrun).
  const res = computeRatingV2(baseInput({ avgAuthDays: 86, avgLosDays: 370, censusFamily: 'residential' }));
  assert.equal(factor(res, 'authFit').available, true);
  assert.equal(factor(res, 'authFit').score, 0, 'a 4x overrun on a bed is still a real overrun');

  // No census row at all → the ordinary unavailable path, not the outpatient copy.
  const none = computeRatingV2(baseInput({ avgAuthDays: 20, avgLosDays: 18, censusFamily: null }));
  assert.equal(factor(none, 'authFit').available, true, 'a null family is residential-or-unknown, not suppressed');
});

test('auth fit: the unavailable copy names WHICH input is missing', () => {
  // It said "No authorization / length-of-stay data" for every case, which was wrong for months:
  // auth was populated and only LOS was missing.
  const noLos = factor(computeRatingV2(baseInput({ avgAuthDays: 21, avgLosDays: null })), 'authFit');
  assert.match(noLos.detail, /authorized days are on file/i);
  const noAuth = factor(computeRatingV2(baseInput({ avgAuthDays: null, avgLosDays: 17 })), 'authFit');
  assert.match(noAuth.detail, /length of stay is on file/i);
  const neither = factor(computeRatingV2(baseInput({ avgAuthDays: null, avgLosDays: null })), 'authFit');
  assert.match(neither.detail, /no authorization or length-of-stay data/i);
});

test('coding decay: 420d-old CONFIRMED decays to 0.4; fresh DID-NOT-WORK scores 0.05; undated → stale floor', () => {
  const stale = computeRatingV2(
    baseInput({ registrySeeded: true, codingLifecycle: 'CONFIRMED CODES', codingDecidedOn: '2025-06-09' }), // 420d
  );
  assert.ok(Math.abs((factor(stale, 'coding').score as number) - 0.4) < 1e-9);
  const failed = computeRatingV2(
    baseInput({ registrySeeded: true, codingLifecycle: 'DISCONTINUE - DID NOT WORK', codingDecidedOn: '2026-08-01' }),
  );
  assert.ok(Math.abs((factor(failed, 'coding').score as number) - 0.05) < 1e-9);
  const undated = computeRatingV2(baseInput({ registrySeeded: true, codingLifecycle: 'CONFIRMED CODES', codingDecidedOn: null }));
  assert.ok(Math.abs((factor(undated, 'coding').score as number) - 0.4) < 1e-9);
  assert.match(factor(undated, 'coding').detail, /decision date unknown/);
});

test('IQ band edges: 65/50/30/15 floors, integers only, null passes through', () => {
  assert.equal(iqBandOf(65), '65');
  assert.equal(iqBandOf(64), '50');
  assert.equal(iqBandOf(50), '50');
  assert.equal(iqBandOf(49), '30');
  assert.equal(iqBandOf(30), '30');
  assert.equal(iqBandOf(29), '15');
  assert.equal(iqBandOf(15), '15');
  assert.equal(iqBandOf(14), '0');
  assert.equal(iqBandOf(0), '0');
  assert.equal(iqBandOf(null), null);
  assert.equal(IQ_BAND_LABELS['65'], '65%+');
});

test('window-age multiplier steps match the disclosed ladder', () => {
  assert.equal(windowAgeMultiplier(30), 1);
  assert.equal(windowAgeMultiplier(60), 0.95);
  assert.equal(windowAgeMultiplier(90), 0.9);
  assert.equal(windowAgeMultiplier(180), 0.75);
  assert.equal(windowAgeMultiplier(270), 0.65);
  assert.equal(windowAgeMultiplier(365), 0.55);
});

test('weights sum to 100 and the wire payload carries zero dollar signs (blind parity)', () => {
  const sum = Object.values(QUALIFY_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
  const full = computeRatingV2(
    baseInput({
      registrySeeded: true,
      codingLifecycle: 'CONTINUE TESTS',
      codingDecidedOn: '2026-06-01',
      codingCodesLabel: 'NO HCPCS / 1001',
      medianDaysToPayment: 74,
      avgAuthDays: 18,
      avgLosDays: 21,
    }),
  );
  assert.ok(!JSON.stringify(full).includes('$'), 'no dollar sign anywhere in the rating payload');
  assert.equal(full.availableWeight, 100);
});

test('pctAllowed above 100 clamps to a 1.0 claims score, never inflates', () => {
  const r = computeRatingV2(baseInput({ pctAllowed: 130 }));
  assert.equal(factor(r, 'claims').score, 1);
});

// ── P0-5 (audit 2026-08-12): a completed-stay average DATES ITSELF ───────────────────────────────
// The outcomes sync ran dead for 6 consecutive days against a source host that had gone away, and
// 12 of 48 facilities kept scoring on frozen rows while the card said "Completed stays, trailing
// 365d" with no as-of. The fix DISCLOSES rather than suppresses — falling back to the census
// snapshot would swap a good-but-old measurement for a known-biased current one (in-progress LOS
// reads systematically low), invisibly, which is the same defect. These pin both halves.

const COMPLETED = {
  avgAuthDays: 20,
  avgLosDays: 18,
  authSample: 8,
  losSample: 8,
  losBasis: 'completed' as const,
  losWindowDays: 365,
  losAsOfToday: '2026-08-12',
};

test('P0-5: a FRESH completed-stay row says nothing extra — a daily sync working is not news', () => {
  const r = computeRatingV2(baseInput({ ...COMPLETED, losAsOf: '2026-08-11' }));
  const detail = factor(r, 'authFit').detail;
  assert.match(detail, /Completed stays, trailing 365d\./);
  assert.ok(!/stale/i.test(detail), 'no staleness caption inside the freshness budget');
});

test('P0-5: a STALE completed-stay row states its age and says to read it as history', () => {
  // 2026-08-06 → 2026-08-12 is 6 days: still inside the 7-day budget, so still quiet.
  const sixDays = computeRatingV2(baseInput({ ...COMPLETED, losAsOf: '2026-08-06' }));
  assert.ok(!/stale/i.test(factor(sixDays, 'authFit').detail), '6d is jitter, not an outage');

  // 8 days is past the budget for a DAILY sync — that is an operational failure and it says so.
  const eightDays = computeRatingV2(baseInput({ ...COMPLETED, losAsOf: '2026-08-04' }));
  const detail = factor(eightDays, 'authFit').detail;
  assert.match(detail, /Last synced 2026-08-04 \(8d ago\)/, 'names the date AND the age');
  assert.match(detail, /stale/i);
  assert.match(detail, /history, not current behaviour/, 'tells the reader what to do with it');
});

test('P0-5: staleness NEVER changes the score — it is a disclosure, not a suppression', () => {
  const fresh = computeRatingV2(baseInput({ ...COMPLETED, losAsOf: '2026-08-11' }));
  const stale = computeRatingV2(baseInput({ ...COMPLETED, losAsOf: '2026-01-01' }));
  assert.equal(stale.rating, fresh.rating, 'same numbers in, same rating out');
  assert.equal(factor(stale, 'authFit').score, factor(fresh, 'authFit').score);
  assert.equal(factor(stale, 'authFit').available, true, 'the factor is not withheld over an ops failure');
});

test('P0-5: an absent as-of omits the clause rather than guessing, and in_progress is unaffected', () => {
  const noAsOf = computeRatingV2(baseInput({ ...COMPLETED, losAsOf: null }));
  assert.match(factor(noAsOf, 'authFit').detail, /Completed stays, trailing 365d\./);
  assert.ok(!/Last synced/.test(factor(noAsOf, 'authFit').detail));

  // The in-progress basis has its own caption and must not grow a sync date it does not have.
  const inProgress = computeRatingV2(
    baseInput({ avgAuthDays: 20, avgLosDays: 18, authSample: 8, losSample: 8, losBasis: 'in_progress', losAsOf: '2026-01-01', losAsOfToday: '2026-08-12' }),
  );
  assert.match(factor(inProgress, 'authFit').detail, /currently admitted/);
  assert.ok(!/Last synced/.test(factor(inProgress, 'authFit').detail));
});
