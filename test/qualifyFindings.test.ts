/**
 * ANCHORED FINDINGS + SEARCH TRACE (CCR-Agent port, 2026-08-06) — the pure derivations.
 *
 * Both are functions of a snapshot the client already holds: no server change, no contract change.
 * These pin the two properties that matter — a finding cites evidence from ITS OWN snapshot, and
 * neither derivation ever emits a dollar (they must be byte-identical for an admissions_seat).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deriveFacilityFindings } from '../app/lib/qualify/findings.js';
import { deriveSearchTrace } from '../app/lib/qualify/searchTrace.js';
import { QUALIFY_TENANT_SCOPE, type QualifyFacility, type QualifySnapshot } from '../app/lib/qualify/contract.js';
import { QUALIFY_FACILITY_V2_NULLS } from './helpers/qualifyV2Fixture.js';

const NEG = { key: 'ttp' as const, label: 'Time to payment', weight: 15, score: 0.2, available: true, direction: 'neg' as const, detail: 'Median 130 days on paid lines.' };
const POS = { key: 'claims' as const, label: 'Claims reliability', weight: 25, score: 0.8, available: true, direction: 'pos' as const, detail: '80% of billed allowed.' };
const GAP = { key: 'coding' as const, label: 'Coding decision confidence', weight: 30, score: null, available: false, direction: 'neu' as const, detail: 'Registry not seeded yet.' };

function fac(over: Partial<QualifyFacility> = {}): QualifyFacility {
  return {
    ...QUALIFY_FACILITY_V2_NULLS,
    rank: 1, name: 'ALPHA', facilityKey: 'alpha', city: null, state: null,
    pctAllowedOfBilled: 62, rating: 62, streakSignal: null, billedAmount: null, allowedAmount: null,
    lineCount: 120, distinctPatients: 14, confirmedClaims: 110, estimateClaims: 5, unknownClaims: 5,
    careSetting: null, entity: 'BXR', ratingV2: 63, iqBand: '50',
    factors: [POS, NEG, GAP], availableWeight: 40,
    ...over,
  } as QualifyFacility;
}

function snap(over: Partial<QualifySnapshot> = {}): QualifySnapshot {
  return {
    resolved: null, facilities: [], identifierLandingFacility: null,
    viewerHasAmountsCapability: true, tenantScope: QUALIFY_TENANT_SCOPE,
    policy: null, ladder: null, provenance: 'direct', payerOptions: [], payerOverridden: false,
    ...over,
  };
}

test('a measured NEGATIVE becomes a watch finding anchored to its factor, with cited evidence', () => {
  const f = fac();
  const out = deriveFacilityFindings(f, snap({ facilities: [f] }));
  const watch = out.find((x) => x.severity === 'watch')!;
  assert.equal(watch.factorKey, 'ttp', 'anchored to the factor it is about — not a loose panel item');
  assert.equal(watch.rationale, NEG.detail, 'the server sentence rides VERBATIM, never paraphrased');
  const labels = watch.evidence.map((e) => e.label);
  assert.ok(labels.includes('Weight') && labels.includes('Sample'));
  assert.ok(watch.evidence.some((e) => e.value.includes('14 distinct patients')));
});

test('a POSITIVE factor produces nothing — findings are not a restatement of the factor list', () => {
  const f = fac({ factors: [POS] });
  assert.deepEqual(deriveFacilityFindings(f, snap({ facilities: [f] })), []);
});

test('an UNMEASURED factor is stated as a gap, naming what the absence costs the score', () => {
  const f = fac({ factors: [GAP] });
  const gap = deriveFacilityFindings(f, snap({ facilities: [f] }))[0]!;
  assert.equal(gap.severity, 'gap');
  // The renormalization is the whole point: the headline describes LESS than the reader assumes.
  assert.ok(gap.evidence.some((e) => e.value.includes('30 points renormalized away')));
  assert.ok(gap.evidence.some((e) => e.value.includes('40 of 100')));
});

test('measured negatives sort ABOVE gaps — actionable outranks unobservable', () => {
  const f = fac();
  const out = deriveFacilityFindings(f, snap({ facilities: [f] }));
  assert.equal(out[0]!.severity, 'watch');
  assert.equal(out[1]!.severity, 'gap');
});

test('evidence cites THIS snapshot — a comparable cohort and a widened window both say so', () => {
  const f = fac();
  const s = snap({
    facilities: [f],
    provenance: 'comparable_employer',
    ladder: { rungs: [{ days: 90, distinctPatients: 11, sufficient: true }], chosenDays: 90, sufficient: true },
  });
  const watch = deriveFacilityFindings(f, s).find((x) => x.severity === 'watch')!;
  assert.ok(watch.evidence.some((e) => e.value.includes('90d')), 'the window the ladder chose');
  assert.ok(watch.evidence.some((e) => e.value.includes('same employer plan')), 'and that it is an estimate');
});

test('a thin sample is called thin, and a below-floor one is called that', () => {
  const thin = fac({ distinctPatients: 5 });
  assert.ok(deriveFacilityFindings(thin, snap({ facilities: [thin] }))[0]!.evidence.some((e) => e.value.includes('thin')));
  const floor = fac({ distinctPatients: 2 });
  assert.ok(deriveFacilityFindings(floor, snap({ facilities: [floor] }))[0]!.evidence.some((e) => e.value.includes('below the floor')));
});

test('NEITHER derivation ever emits a dollar — blind and sighted sessions see the same text', () => {
  const f = fac();
  const s = snap({
    facilities: [f], provenance: 'comparable_funding',
    ladder: { rungs: [{ days: 365, distinctPatients: 4, sufficient: false }], chosenDays: 365, sufficient: false },
    policy: { found: true, memberCount: 46, carrier: 'AETNA', employerName: 'ACME', employerCount: 7, carrierCount: 3,
      carriers: [], funding: 'Self-Funded', policyType: 'PPO', planType: null, groupOnFile: true, network: null,
      vobFreshAsOf: '2026-08-01', vobStale: true, deductible: '$1,500', deductibleMet: null, oopMax: '$6,000', oopMet: null },
    payerOptions: [{ payer: 'AETNA', lines: 100, patients: 9, lastPayment: '2026-07-30' },
                   { payer: 'CIGNA', lines: 300, patients: 12, lastPayment: '2026-06-01' }],
    resolved: { payerName: 'AETNA', payerScope: 'payer', matchedOn: 'prefix', matchedValue: 'W20', totalCharges: 120,
                facilityCount: 1, windowStart: '2026-05-01', windowEnd: '2026-08-01', identifierScoped: true },
  });
  const text = JSON.stringify([deriveFacilityFindings(f, s), deriveSearchTrace(s)]);
  // The policy card carries deductible/OOP strings; neither derivation may pick them up.
  assert.ok(!text.includes('$'), 'zero dollar signs');
  assert.ok(!text.includes('1,500') && !text.includes('6,000'));
});

// ── the trace ────────────────────────────────────────────────────────────────────────────────

test('trace narrates the DECISIONS: spread, widened window, minority payer, estimated cohort', () => {
  const f = fac();
  const lines = deriveSearchTrace(snap({
    facilities: [f], provenance: 'comparable_employer',
    ladder: { rungs: [{ days: 90, distinctPatients: 11, sufficient: true }], chosenDays: 90, sufficient: true },
    policy: { found: true, memberCount: 46, carrier: 'AETNA', employerName: 'ACME', employerCount: 7, carrierCount: 3,
      carriers: [], funding: null, policyType: null, planType: null, groupOnFile: false, network: null,
      vobFreshAsOf: '2026-08-01', vobStale: false, deductible: null, deductibleMet: null, oopMax: null, oopMet: null },
    payerOptions: [{ payer: 'AETNA', lines: 100, patients: 9, lastPayment: null },
                   { payer: 'CIGNA', lines: 300, patients: 12, lastPayment: null }],
    resolved: { payerName: 'AETNA', payerScope: 'payer', matchedOn: 'prefix', matchedValue: 'W20', totalCharges: 120,
                facilityCount: 1, windowStart: '2026-05-01', windowEnd: '2026-08-01', identifierScoped: true },
  }));
  const all = lines.map((l) => l.text).join(' | ');
  assert.match(all, /46 verified members/);
  assert.match(all, /Not one plan — 3 carriers and 7 employers/);
  assert.match(all, /Widened to 90d/);
  assert.match(all, /2 payers on file/);            // AETNA is 100 of 400 lines => minority
  assert.ok(lines.some((l) => l.tone === 'flag' && /25% of claim lines/.test(l.text)));
  assert.match(all, /comparable cohort/);
});

test('trace stays quiet about what did not happen — an unambiguous search narrates less', () => {
  const f = fac();
  const lines = deriveSearchTrace(snap({
    facilities: [f],
    ladder: { rungs: [{ days: 30, distinctPatients: 12, sufficient: true }], chosenDays: 30, sufficient: true },
    payerOptions: [{ payer: 'AETNA', lines: 100, patients: 9, lastPayment: null }],
  }));
  const all = lines.map((l) => l.text).join(' | ');
  assert.match(all, /30d was already enough/);
  assert.ok(!/payers on file/.test(all), 'one payer is not a decision worth narrating');
  assert.ok(!/Not one plan/.test(all));
  assert.ok(!/comparable cohort/.test(all));
});

test('trace says so when even the widest window never reached a confident sample', () => {
  const lines = deriveSearchTrace(snap({
    ladder: { rungs: [{ days: 365, distinctPatients: 4, sufficient: false }], chosenDays: 365, sufficient: false },
  }));
  assert.match(lines.map((l) => l.text).join(' '), /never reached a confident sample/);
});

test('a user drill-down is narrated as THEIR choice, not as the resolve', () => {
  const lines = deriveSearchTrace(snap({
    payerOverridden: true,
    payerOptions: [{ payer: 'AETNA', lines: 100, patients: 9, lastPayment: null },
                   { payer: 'CIGNA', lines: 300, patients: 12, lastPayment: null }],
    resolved: { payerName: 'CIGNA', payerScope: 'payer', matchedOn: 'prefix', matchedValue: 'W20', totalCharges: 1,
                facilityCount: 0, windowStart: '2026-05-01', windowEnd: '2026-08-01', identifierScoped: true },
  }));
  assert.match(lines.map((l) => l.text).join(' '), /your selection/);
});

// An IDENTIFIER-WIDE ranking (the v3 Skip, 2026-08-07) gets its own line rather than a variant of the
// payer-scoped one. "Ranked under X (25% of claim lines)" is a scope CLAIM, and after the skip both
// halves are false: there is no single X, and the ranking covers 100% of the lines, not one label's
// share. The old expression would have printed "ranked under undefined" from a null payerName.
test('trace: an all-payers ranking says so, and never names a label or a share', () => {
  const lines = deriveSearchTrace(snap({
    payerOptions: [{ payer: 'AETNA', lines: 100, patients: 9, lastPayment: null },
                   { payer: 'CIGNA', lines: 300, patients: 12, lastPayment: null }],
    resolved: { payerName: null, payerScope: 'all', matchedOn: 'prefix', matchedValue: 'W20', totalCharges: 400,
                facilityCount: 4, windowStart: '2026-05-01', windowEnd: '2026-08-01', identifierScoped: true },
  }));
  const all = lines.map((l) => l.text).join(' | ');
  assert.match(all, /Ranked across all 2 payers on file/);
  assert.ok(!/ranked under/i.test(all), 'no single label is named');
  assert.ok(!/% of claim lines/.test(all), 'a dominant-share figure is meaningless here');
  assert.ok(!/undefined|null/.test(all), 'a null payerName must never reach the copy');
});

test('an empty snapshot narrates NOTHING rather than announcing it found nothing', () => {
  assert.deepEqual(deriveSearchTrace(snap()), []);
});
