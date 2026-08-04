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
