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
    loadVobFreshness: async () => '2026-08-02', // fresh (yesterday, inside 48h+day-grain slack)
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
      [180, 15, false],
      [365, 22, false],
    ].map(([d, p]) => [d, p, p >= 10]),
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
  const deps = v2deps(SUPER, { loadVobFreshness: async () => '2026-07-25' }); // 9 days stale
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
  const facCalls: Array<{ payer: string | null; market: unknown }> = [];
  const deps = v2deps(SUPER, {
    resolvePayer: async () => null,
    loadFacilities: async (payer, _f, _t, _e, market) => {
      facCalls.push({ payer, market });
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
