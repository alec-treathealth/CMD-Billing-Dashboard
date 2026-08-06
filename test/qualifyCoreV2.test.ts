/**
 * Qualify core — v2 orchestration (qualify-v2-build-plan Phases 0/B/E + the §5 factor wiring).
 * Exercises the OPTIONAL deps seams the pre-v2 corpus never provides: the auto-window ladder, the
 * policy card, provenance fallbacks, VOB staleness, the coding seam, and the admissions_seat strip
 * over the new dollar-bearing policy strings (wire-level).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getQualifySnapshotCore, type QualifyDeps } from '../app/lib/qualify/core.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
import { facilityFactorsDisagree } from '../app/lib/qualify/ratingV2.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import type { QualifyFacilityRow } from '../src/collections/qualifyQuery.js';
import type { QualifyPolicyRow, QualifyWindowRungsRow } from '../src/collections/qualifyPolicyQuery.js';

const SUPER = () =>
  requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 's@t.ai', id: 's' }, role: 'super_admin' } });
const SEAT = () =>
  requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'a@t.ai', id: 'a' }, role: 'admissions_seat' } });

const NOW = new Date('2026-08-03T12:00:00Z');

const FAC: QualifyFacilityRow[] = [
  {
    facility: '405 recovery',
    facility_name: '405 RECOVERY',
    facility_code: '10026460',
    care_setting: 'OP',
    line_count: 120,
    distinct_patients: 22,
    confirmed_claims: 110,
    estimate_claims: 5,
    unknown_claims: 5,
    billed: 999999.99,
    allowed: 888888.88,
    pct_allowed: 62,
    median_days_to_payment: 41,
    entity_ids: [INDIGO_ENTITY_ID],
  },
];

const POLICY: QualifyPolicyRow = {
  member_count: 14,
  carrier: 'AETNA',
  employer_name: 'Vanderbilt Univ. Medical Center',
  employer_norm: 'VANDERBILT',
  // >1 on both: this fixture's 14 members span several employers and carriers, which is the LIVE
  // shape (member-weighted, 80.5% of searches are multi-employer) rather than the convenient one.
  employer_count: 3,
  carrier_count: 2,
  funding: 'Self-Funded',
  policy_type: 'PPO',
  plan_type: 'OPEN ACCESS',
  group_on_file: true,
  vob_fresh_as_of: '2026-08-02',
  deductible: '$1,500',
  deductible_met: '$1,500 met',
  oop_max: '$6,000',
  oop_met: '$2,250',
};

const RUNGS_THIN: QualifyWindowRungsRow = { p30: 2, p60: 4, p90: 11, p180: 15, p365: 22 };

function v2deps(principal: () => ReturnType<typeof SUPER>, over: Partial<QualifyDeps> = {}): QualifyDeps {
  return {
    requirePrincipal: async () => principal(),
    mintToken: () => 'HMAC_TOKEN',
    mintGroupToken: () => 'GROUP_TOKEN',
    mintNameToken: () => 'NAME_TOKEN',
    resolvePayer: async () => 'AETNA',
    loadFacilities: async () => FAC,
    loadIdentifierLandingFacility: async () => '405 recovery',
    loadFacilityCases: async () => [],
    loadMatchSummary: async () => null,
    loadMatchClientCount: async () => 0,
    loadClaimPrefixToken: async () => null,
    loadPatientCohort: async () => null,
    loadMovers: async () => [],
    loadBookKpis: async () => null,
    loadFacilityTrends: async () => [],
    recordAccess: async () => 'audit-id',
    revealRow: async () => null,
    revealRows: async () => [],
    now: () => NOW,
    loadPolicy: async () => POLICY,
    loadVobFreshness: async () => '2026-08-02T06:00:00Z', // fresh — 30h old, inside the 48h bar
    loadWindowRungs: async () => RUNGS_THIN,
    loadCodingDecisions: async () => ({ seeded: false, rows: [] }),
    loadCensusAuth: async () => [],
    ...over,
  };
}

const AUTO_IN = { query: 'W29', window: { kind: 'trailing', days: 30 } as const, auto: true };

test('auto-window: the ladder stops at the FIRST sufficient rung (90d) and the snapshot windows on it', async () => {
  const calls: string[] = [];
  const deps = v2deps(SUPER, {
    loadFacilities: async (_p, from, to) => {
      calls.push(`${from}..${to}`);
      return FAC;
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.ok(snap.ladder, 'ladder rides the snapshot');
  assert.equal(snap.ladder!.chosenDays, 90); // p90 = 11 >= 10, first sufficient
  assert.equal(snap.ladder!.sufficient, true);
  assert.deepEqual(
    snap.ladder!.rungs.map((r) => [r.days, r.distinctPatients, r.sufficient]),
    [
      [30, 2, false],
      [60, 4, false],
      [90, 11, true],
      [180, 15, true],
      [365, 22, true],
    ],
  );
  // The RESOLVED window spans exactly the chosen 90 days.
  const spanDays = (Date.parse(snap.resolved!.windowEnd) - Date.parse(snap.resolved!.windowStart)) / 86_400_000;
  assert.equal(spanDays, 90);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.startsWith(snap.resolved!.windowStart));
});

test('auto-window: NO rung reaches the floor → widest window, sufficient:false — disclosed, never silent', async () => {
  const deps = v2deps(SUPER, { loadWindowRungs: async () => ({ p30: 1, p60: 1, p90: 2, p180: 2, p365: 4 }) });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.ladder!.chosenDays, 365);
  assert.equal(snap.ladder!.sufficient, false);
});

test('auto-window: a rungs failure degrades to the caller window (ladder null), never blocks the search', async () => {
  const deps = v2deps(SUPER, {
    loadWindowRungs: async () => {
      throw new Error('boom');
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.ladder, null);
  assert.ok(snap.resolved, 'search still resolves');
});

test('manual window (auto absent): rungs never run, ladder null', async () => {
  let rungCalls = 0;
  const deps = v2deps(SUPER, {
    loadWindowRungs: async () => {
      rungCalls++;
      return RUNGS_THIN;
    },
  });
  const snap = await getQualifySnapshotCore(deps, { query: 'W29', window: { kind: 'trailing', days: 30 } });
  assert.equal(rungCalls, 0);
  assert.equal(snap.ladder, null);
});

test('policy card: on-file fields attach; network is NULL today (Phase D extraction gap, by design)', async () => {
  const snap = await getQualifySnapshotCore(v2deps(SUPER), AUTO_IN);
  assert.ok(snap.policy?.found);
  assert.equal(snap.policy!.carrier, 'AETNA');
  assert.equal(snap.policy!.employerName, 'Vanderbilt Univ. Medical Center');
  assert.equal(snap.policy!.funding, 'Self-Funded');
  assert.equal(snap.policy!.policyType, 'PPO');
  assert.equal(snap.policy!.groupOnFile, true);
  assert.equal(snap.policy!.network, null);
  assert.equal(snap.policy!.vobFreshAsOf, '2026-08-02');
  assert.equal(snap.policy!.vobStale, false);
  assert.equal(snap.provenance, 'direct');
});

test('Phase 0 staleness: a stale GLOBAL feed flags the card even when the policy has its own dates', async () => {
  const deps = v2deps(SUPER, { loadVobFreshness: async () => '2026-07-25T00:00:00Z' }); // 9 days stale
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.policy!.vobStale, true);
});

test('admissions_seat: policy benefit strings are STRIPPED; factors/ratings identical to the full view (wire parity)', async () => {
  const seatSnap = await getQualifySnapshotCore(v2deps(SEAT), AUTO_IN);
  const superSnap = await getQualifySnapshotCore(v2deps(SUPER), AUTO_IN);
  // Dollar-bearing policy strings are gone for the seat…
  assert.equal(seatSnap.policy!.deductible, null);
  assert.equal(seatSnap.policy!.oopMax, null);
  const wire = JSON.stringify(seatSnap);
  assert.ok(!wire.includes('1,500') && !wire.includes('6,000') && !wire.includes('$'), 'zero dollar strings on the seat wire');
  // …while the rating work is IDENTICAL (blind parity — the invariant, end to end).
  assert.deepEqual(seatSnap.facilities[0]!.factors, superSnap.facilities[0]!.factors);
  assert.equal(seatSnap.facilities[0]!.ratingV2, superSnap.facilities[0]!.ratingV2);
  assert.equal(seatSnap.facilities[0]!.iqBand, superSnap.facilities[0]!.iqBand);
  assert.equal(seatSnap.facilities[0]!.medianDaysToPayment, 41); // day counts survive the strip
});

test('comparable_employer: no own claims → cohort ranking (payer NULL + employer market), resolved stays null', async () => {
  const facCalls: Array<{ payer: string | null; market: unknown; from: string; to: string }> = [];
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadFacilities: async (payer, from, to, _e, market) => {
      facCalls.push({ payer, market, from, to });
      return FAC;
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.resolved, null);
  assert.equal(snap.provenance, 'comparable_employer');
  assert.ok(snap.policy?.found);
  assert.equal(snap.facilities.length, 1);
  assert.equal(facCalls.length, 1);
  assert.equal(facCalls[0]!.payer, null);
  assert.deepEqual(facCalls[0]!.market, { employers: ['VANDERBILT'] });
  // Finding #6: the cohort ranking is CLAMPED to 90 days (never the ladder's 365d worst case —
  // measured 17.3s unclamped vs ~0.32s clamped on prod), and the clamp is disclosed in the factors.
  const span = (Date.parse(facCalls[0]!.to) - Date.parse(facCalls[0]!.from)) / 86_400_000;
  assert.equal(span, 90);
  const conf = snap.facilities[0]!.factors.find((f) => f.key === 'dataConfidence')!;
  assert.match(conf.detail, /window reached 90d/);
  // Cross-check the scope arrays still ride: both tenants pinned.
  assert.ok([BXR_ENTITY_ID, INDIGO_ENTITY_ID].every(Boolean));
});

test('comparable_funding: employer unknown → funding-market fallback, honestly labeled', async () => {
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadPolicy: async () => ({ ...POLICY, employer_norm: null }),
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.provenance, 'comparable_funding');
});

test('no cohort at all: policy found, no employer/funding → provenance none, plain VOB shape', async () => {
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadPolicy: async () => ({ ...POLICY, employer_norm: null, funding: null }),
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.resolved, null);
  assert.equal(snap.facilities.length, 0);
  assert.equal(snap.provenance, 'none');
  assert.ok(snap.policy?.found, 'the policy card still tells the rep what IS on file');
});

test('never-seen identifier with NO VOB row: policy found:false, no comparables attempted', async () => {
  let facCalls = 0;
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadPolicy: async () => ({ ...POLICY, member_count: 0, employer_norm: null, funding: null }),
    loadFacilities: async () => {
      facCalls++;
      return FAC;
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.policy!.found, false);
  assert.equal(snap.facilities.length, 0);
  assert.equal(facCalls, 0, 'no cohort fetch without a policy to derive it from');
});

test('TTP factor rides the ranking row: median 41d lands in the facility factors', async () => {
  const snap = await getQualifySnapshotCore(v2deps(SUPER), AUTO_IN);
  const ttp = snap.facilities[0]!.factors.find((f) => f.key === 'ttp');
  assert.ok(ttp && ttp.available);
  assert.match(ttp!.detail, /Median 41 days/);
});


test('auto-window: an exact MEMBER-ID search skips the ladder (N-of-1 — a 10-patient floor is meaningless)', async () => {
  let rungCalls = 0;
  const deps = v2deps(SUPER, {
    loadWindowRungs: async () => {
      rungCalls++;
      return RUNGS_THIN;
    },
  });
  const snap = await getQualifySnapshotCore(deps, { query: 'AETMEMBER123', window: { kind: 'trailing', days: 30 }, auto: true });
  assert.equal(rungCalls, 0);
  assert.equal(snap.ladder, null);
  assert.ok(snap.resolved);
});

test('comparable read: the coding factor is EXCLUDED (payer unknown), never a uniform 0/30 drag (finding #13)', async () => {
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadCodingDecisions: async () => ({ seeded: true, rows: [] }),
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.provenance, 'comparable_employer');
  const coding = snap.facilities[0]!.factors.find((f) => f.key === 'coding')!;
  assert.equal(coding.available, false);
  assert.match(coding.detail, /payer-scoped/);
  // Renormalized over claims + confidence (+ ttp from the fixture's median): coding's 30 is absent.
  assert.ok(snap.facilities[0]!.availableWeight <= 60);
});

test('vobStale boundary: the 48h bar applies EXACTLY — a 49h-old feed flags, a 47h-old one does not', async () => {
  // PR #73 review pin. Under the old day-grain + 24h-slack math a 49h-old timestamp read as fresh
  // (bare date → midnight → 60h, still under the 72h effective bar). Timestamp precision fixes it.
  const stale = v2deps(SUPER, { loadVobFreshness: async () => '2026-08-01T11:00:00Z' }); // NOW − 49h
  const fresh = v2deps(SUPER, { loadVobFreshness: async () => '2026-08-01T13:00:00Z' }); // NOW − 47h
  const s1 = await getQualifySnapshotCore(stale, AUTO_IN);
  const s2 = await getQualifySnapshotCore(fresh, AUTO_IN);
  assert.equal(s1.policy!.vobStale, true);
  assert.equal(s2.policy!.vobStale, false);
});

// ── "Factors disagree" (2026-08-04): the case a single blended numeral hides ─────────────────────

test('facilityFactorsDisagree: a live positive AND a live negative is a conflict', () => {
  const F = (direction: 'pos' | 'neg' | 'neu', available = true) =>
    ({ key: 'claims', label: 'x', weight: 25, score: 0.5, available, direction, detail: 'd' }) as const;
  assert.equal(facilityFactorsDisagree([F('pos'), F('neg')]), true);
  assert.equal(facilityFactorsDisagree([F('neg'), F('pos')]), true, 'order-independent');
  assert.equal(facilityFactorsDisagree([F('pos'), F('pos')]), false);
  assert.equal(facilityFactorsDisagree([F('neg'), F('neg')]), false);
  assert.equal(facilityFactorsDisagree([F('pos'), F('neu'), F('neu')]), false, 'neutral is not negative');
  assert.equal(facilityFactorsDisagree([]), false);
  // UNAVAILABLE is missing data, not a signal: it can neither create nor resolve a disagreement.
  assert.equal(facilityFactorsDisagree([F('pos'), F('neg', false)]), false);
  assert.equal(facilityFactorsDisagree([F('pos', false), F('neg')]), false);
});

// ── The SPREAD widening (2026-08-06). buildQualifyPolicySpreadQuery / buildResolvePayerSpreadQuery
// exist because a single mode() was standing in for a population: member-weighted, 80.5% of searches
// land on a multi-employer prefix, 80.6% on a multi-payer one. These pin what the CORE does with
// that — most of all the PHI boundary, which is the one thing here that must never regress.

test('comparable cohort ranks over EVERY employer on the prefix, not just the modal one', async () => {
  const facCalls: Array<{ market: unknown }> = [];
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadPolicySpread: async () => [
      { dim: 'employer' as const, value: 'VANDERBILT', members: 20 },
      { dim: 'employer' as const, value: 'HCA', members: 18 },
      { dim: 'employer' as const, value: 'KROGER', members: 8 },
      { dim: 'carrier' as const, value: 'AETNA', members: 30 },
    ],
    loadFacilities: async (_p, _f, _t, _e, market) => {
      facCalls.push({ market });
      return FAC;
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.provenance, 'comparable_employer');
  // The narrowing this replaces was `{ employers: ['VANDERBILT'] }` — the modal one alone, which
  // excluded 26 of this prefix's 46 members from the cohort it claimed to rank over.
  assert.deepEqual(facCalls[0]!.market, { employers: ['VANDERBILT', 'HCA', 'KROGER'] });
});

test('PHI BOUNDARY: employer values from the spread NEVER reach the snapshot — only their count', async () => {
  const deps = v2deps(SUPER, {
    loadPolicySpread: async () => [
      { dim: 'employer' as const, value: 'VANDERBILT', members: 20 },
      { dim: 'employer' as const, value: 'SECRET_EMPLOYER_CO', members: 18 },
      { dim: 'carrier' as const, value: 'AETNA', members: 30 },
      { dim: 'carrier' as const, value: 'CIGNA', members: 16 },
    ],
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  // employer_name is a PHI column (app/lib/phi.ts); the spread's employer values are its join key and
  // must stay server-side. Serialize the WHOLE snapshot so this catches a leak anywhere in it, not
  // just on the field we happened to think of.
  const wire = JSON.stringify(snap);
  assert.ok(!wire.includes('SECRET_EMPLOYER_CO'), 'no employer value from the spread crosses the wire');
  assert.ok(!wire.includes('VANDERBILT'), 'not even the modal one — employer_norm was never wire-side');
  // Carriers are NOT PHI and already shipped singular, so those DO cross as the drill-down set.
  assert.deepEqual(snap.policy?.carriers, [
    { value: 'AETNA', members: 30 },
    { value: 'CIGNA', members: 16 },
  ]);
  // The counts come from the one-row aggregate, never from the capped spread's length.
  assert.equal(snap.policy?.employerCount, 3);
  assert.equal(snap.policy?.carrierCount, 2);
});

test('payerOptions[0] IS the resolved payer — the widening never contradicts the narrow resolve', async () => {
  const deps = v2deps(SUPER, {
    resolvePayer: async () => 'AETNA',
    loadPayerSpread: async () => [
      { primary_payer: 'AETNA', lines: 120, patients: 9, last_payment: '2026-07-30' },
      { primary_payer: 'CIGNA', lines: 44, patients: 4, last_payment: '2026-06-02' },
    ],
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.resolved?.payerName, 'AETNA');
  assert.equal(snap.payerOptions[0]!.payer, 'AETNA');
  assert.equal(snap.payerOptions.length, 2);
  assert.equal(snap.payerOptions[1]!.payer, 'CIGNA');
  assert.equal(snap.payerOptions[1]!.patients, 4);
});

test('payerOptions carries no dollars — a blind seat and a sighted one see the SAME options', async () => {
  const spread = async () => [
    { primary_payer: 'AETNA', lines: 120, patients: 9, last_payment: '2026-07-30' },
    { primary_payer: 'CIGNA', lines: 44, patients: 4, last_payment: '2026-06-02' },
  ];
  const seat = await getQualifySnapshotCore(v2deps(SEAT, { loadPayerSpread: spread }), AUTO_IN);
  const sup = await getQualifySnapshotCore(v2deps(SUPER, { loadPayerSpread: spread }), AUTO_IN);
  assert.deepEqual(seat.payerOptions, sup.payerOptions);
  assert.equal(seat.viewerHasAmountsCapability, false);
});

test('both spreads fail SOFT — a widening outage degrades to the old behaviour, never a dead search', async () => {
  const deps = v2deps(SUPER, {
    loadPayerSpread: async () => {
      throw new Error('boom');
    },
    loadPolicySpread: async () => {
      throw new Error('boom');
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.ok(snap.resolved, 'the search still resolves');
  assert.deepEqual(snap.payerOptions, []);
  assert.deepEqual(snap.policy?.carriers, []);
  // The COUNTS survive: they ride the one-row policy aggregate, which is a different query.
  assert.equal(snap.policy?.employerCount, 3);
});

test('comparable path falls back to the modal employer when the spread is unavailable', async () => {
  const facCalls: Array<{ market: unknown }> = [];
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadPolicySpread: async () => {
      throw new Error('boom');
    },
    loadFacilities: async (_p, _f, _t, _e, market) => {
      facCalls.push({ market });
      return FAC;
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  // Losing the spread must not lose comparable provenance entirely — that would be a worse
  // regression than the narrowing it replaced.
  assert.equal(snap.provenance, 'comparable_employer');
  assert.deepEqual(facCalls[0]!.market, { employers: ['VANDERBILT'] });
});

// ── The payer drill-down (2026-08-06). Measured: 80.6% of member-weighted searches land on a
// multi-payer prefix and the top payer is a MINORITY in 15.7%, so the default resolve — right ~84%
// of the time — needs an escape hatch that does NOT abandon the identifier narrow.

const SPREAD = async () => [
  { primary_payer: 'AETNA', lines: 120, patients: 9, last_payment: '2026-07-30' },
  { primary_payer: 'CIGNA', lines: 44, patients: 4, last_payment: '2026-06-02' },
];

test('payer override scopes to the chosen payer while KEEPING the identifier narrow', async () => {
  const calls: Array<{ payer: string | null; token: string | null | undefined }> = [];
  const deps = v2deps(SUPER, {
    loadPayerSpread: SPREAD,
    loadFacilities: async (payer, _f, _t, _e, _m, token) => {
      calls.push({ payer, token });
      return FAC;
    },
  });
  const snap = await getQualifySnapshotCore(deps, { ...AUTO_IN, payerOverride: 'CIGNA' });
  assert.equal(snap.resolved?.payerName, 'CIGNA', 'the drill-down payer is the resolved one');
  assert.equal(snap.payerOverridden, true, 'and the snapshot says the USER chose it');
  assert.equal(calls[0]!.payer, 'CIGNA');
  // The distinction from the resolve-by-payer path: the token still scopes the ranking, so this is
  // "this patient under CIGNA", not "CIGNA's whole book".
  assert.equal(calls[0]!.token, 'HMAC_TOKEN');
  assert.equal(snap.resolved?.identifierScoped, true);
});

test('an override naming a payer the identifier NEVER billed is REJECTED, not honoured', async () => {
  const deps = v2deps(SUPER, { loadPayerSpread: SPREAD });
  const snap = await getQualifySnapshotCore(deps, { ...AUTO_IN, payerOverride: 'UNITED HEALTHCARE' });
  // Falls back to the dominant payer rather than producing a confidently-empty result labelled as
  // resolved evidence. A hand-edited value must not be able to manufacture that claim.
  assert.equal(snap.resolved?.payerName, 'AETNA');
  assert.equal(snap.payerOverridden, false, 'a REJECTED override must never render as honoured');
});

test('override is exact-match and whitespace-trimmed; empty/blank falls through to the resolve', async () => {
  const deps = v2deps(SUPER, { loadPayerSpread: SPREAD });
  const trimmed = await getQualifySnapshotCore(deps, { ...AUTO_IN, payerOverride: '  CIGNA  ' });
  assert.equal(trimmed.resolved?.payerName, 'CIGNA', 'surrounding whitespace does not defeat the match');
  for (const v of ['', '   ', null, undefined]) {
    const snap = await getQualifySnapshotCore(deps, { ...AUTO_IN, payerOverride: v });
    assert.equal(snap.resolved?.payerName, 'AETNA', `blank override (${JSON.stringify(v)}) uses the resolve`);
    assert.equal(snap.payerOverridden, false);
  }
  // Case differences are NOT coerced — primary_payer is matched exactly everywhere else in core.
  const wrongCase = await getQualifySnapshotCore(deps, { ...AUTO_IN, payerOverride: 'cigna' });
  assert.equal(wrongCase.resolved?.payerName, 'AETNA');
  assert.equal(wrongCase.payerOverridden, false);
});

test('override cannot survive a spread outage — no evidence means no authorization', async () => {
  const deps = v2deps(SUPER, {
    loadPayerSpread: async () => {
      throw new Error('boom');
    },
  });
  const snap = await getQualifySnapshotCore(deps, { ...AUTO_IN, payerOverride: 'CIGNA' });
  // The spread IS the authorization set. Losing it must fail CLOSED to the dominant payer, never
  // fall open to "trust the client".
  assert.equal(snap.resolved?.payerName, 'AETNA');
  assert.equal(snap.payerOverridden, false);
});

// ── COMPLETED-STAY auth/LOS (0091). The census snapshot measures clients still admitted, so its LOS
// is today-minus-admit and the overrun penalty could never fire: measured 2026-08-06 all twelve
// residential facilities read 0.69-0.96. On completed stays four are at or over 1.0. These pin that
// the better measurement wins, that it is DISCLOSED, and that losing it degrades rather than breaks.

const OUTCOME = {
  facility_code: '10026460',
  stays_sample: 142,
  auth_sample: 102,
  avg_los_days: 40.1,
  avg_auth_days: 36.35,
  window_days: 365,
};

function authFitOf(snap: Awaited<ReturnType<typeof getQualifySnapshotCore>>) {
  return snap.facilities[0]!.factors.find((f) => f.key === 'authFit')!;
}

test('completed stays OUTRANK the in-progress snapshot, and the overrun now actually scores', async () => {
  const deps = v2deps(SUPER, {
    // The snapshot would say 20d vs 30d authorized — comfortably within, score 1, no penalty.
    loadCensusAuth: async () => [
      { facility_code: '10026460', board_family: 'residential', avg_auth_days: 30, avg_los_days: 20,
        auth_sample: 9, los_sample: 9, next_ur_date: null, open_beds: null, bed_capacity: null },
    ],
    loadFacilityOutcomes: async () => [OUTCOME],
  });
  const f = authFitOf(await getQualifySnapshotCore(deps, AUTO_IN));
  assert.equal(f.available, true);
  assert.ok(f.detail.includes('40.1d') && f.detail.includes('36.4d'), 'the COMPLETED averages are shown');
  assert.ok(!f.detail.includes('20d'), 'the in-progress numbers are not');
  assert.ok(f.score !== null && f.score < 1, 'and an overrun finally costs something');
  // Two facilities scored on different measurements are not comparable — say which one this is.
  assert.ok(f.detail.includes('Completed stays'), 'the basis is disclosed');
  assert.ok(f.detail.includes('365'), 'along with the window it was measured over');
});

test('with NO outcomes row the snapshot is used, and the card admits stays are still running', async () => {
  const deps = v2deps(SUPER, {
    loadCensusAuth: async () => [
      { facility_code: '10026460', board_family: 'residential', avg_auth_days: 30, avg_los_days: 20,
        auth_sample: 9, los_sample: 9, next_ur_date: null, open_beds: null, bed_capacity: null },
    ],
    loadFacilityOutcomes: async () => [],
  });
  const f = authFitOf(await getQualifySnapshotCore(deps, AUTO_IN));
  assert.equal(f.available, true);
  assert.ok(f.detail.includes('20d') && f.detail.includes('30d'), 'the snapshot numbers');
  assert.ok(f.detail.includes('currently admitted'), 'and the caveat that they read low');
});

test('a THIN outcomes row does not displace the snapshot — better measurement, not fewer clients', async () => {
  const deps = v2deps(SUPER, {
    loadCensusAuth: async () => [
      { facility_code: '10026460', board_family: 'residential', avg_auth_days: 30, avg_los_days: 20,
        auth_sample: 9, los_sample: 9, next_ur_date: null, open_beds: null, bed_capacity: null },
    ],
    // 2 completed stays: below QUALIFY_AUTH_FIT_MIN_SAMPLE. Swapping a 9-client snapshot for a
    // 2-stay average would trade one bias for a worse one.
    loadFacilityOutcomes: async () => [{ ...OUTCOME, stays_sample: 2, auth_sample: 2 }],
  });
  const f = authFitOf(await getQualifySnapshotCore(deps, AUTO_IN));
  assert.ok(f.detail.includes('20d'), 'the snapshot still scores it');
  assert.ok(!f.detail.includes('Completed stays'));
});

test('an outcomes outage degrades to the snapshot — never a dead ranking', async () => {
  const deps = v2deps(SUPER, {
    loadCensusAuth: async () => [
      { facility_code: '10026460', board_family: 'residential', avg_auth_days: 30, avg_los_days: 20,
        auth_sample: 9, los_sample: 9, next_ur_date: null, open_beds: null, bed_capacity: null },
    ],
    loadFacilityOutcomes: async () => {
      throw new Error('boom');
    },
  });
  const snap = await getQualifySnapshotCore(deps, AUTO_IN);
  assert.equal(snap.facilities.length, 1, 'the ranking survives');
  assert.equal(authFitOf(snap).available, true, 'and auth-fit falls back rather than vanishing');
});

test('outpatient suppression still wins over an outcomes row — the ruling is not bypassed', async () => {
  const deps = v2deps(SUPER, {
    loadCensusAuth: async () => [
      { facility_code: '10026460', board_family: 'outpatient', avg_auth_days: 30, avg_los_days: 20,
        auth_sample: 9, los_sample: 9, next_ur_date: null, open_beds: null, bed_capacity: null },
    ],
    loadFacilityOutcomes: async () => [OUTCOME],
  });
  const f = authFitOf(await getQualifySnapshotCore(deps, AUTO_IN));
  assert.equal(f.available, false, 'outpatient is not scored on auth/LOS regardless of source');
  assert.ok(f.detail.includes('Not scored for outpatient'));
});
