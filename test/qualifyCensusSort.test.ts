/**
 * S1 — CENSUS ON THE DEFAULT SURFACE: availability is the FIRST sort tier, and the census numbers
 * that cross the wire are gated to the same basis the rating scored on.
 *
 * Alec's ruling (2026-08-08, docs/qualify-v3-search-pattern.md): census SORTS, it never filters.
 * The rep is answering "where do I send them RIGHT NOW", and 6 of 12 residential facilities had
 * zero open beds at measurement time — so a confirmed-full house has to sink below every facility
 * that can physically take the patient, while staying visible and greyed.
 *
 * The trap this file exists to lock is the one #163 already paid for once: `open_beds = 0` is
 * written for OUTPATIENT boards too, where it means "beds do not apply" (those boards carry no
 * "Open Bed" status labels at all — src/collections/qualifyCensus.ts:459). A naive `openBeds === 0`
 * sink would bury all eleven outpatient facilities. The denominator, plus `board_family`, is what
 * separates the two zeroes, and both live SERVER-side.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getQualifySnapshotCore, type QualifyDeps } from '../app/lib/qualify/core.js';
import { bedStateOf, bedAvailabilityTier } from '../app/lib/qualify/bedState.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import type { QualifyFacilityRow } from '../src/collections/qualifyQuery.js';

const SUPER = () =>
  requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 's@t.ai', id: 's' }, role: 'super_admin' } });

const NOW = new Date('2026-08-08T12:00:00Z');
const IN = { query: 'AETMEMBER123', window: { kind: 'trailing', days: 30 } as const };

/** Two facilities whose RATING order is unambiguous and pinned by the fixtures: STRONG (62% over 22
 *  patients) outranks WEAK (40% over 22 patients) on ratingV2 with no census in play. Every test
 *  below moves ONLY the census rows, so any order change is attributable to the availability tier. */
const STRONG: QualifyFacilityRow = {
  facility: 'strong house',
  facility_name: 'STRONG HOUSE',
  facility_code: 'NASH',
  care_setting: 'IP',
  line_count: 120,
  distinct_patients: 22,
  confirmed_claims: 110,
  estimate_claims: 5,
  unknown_claims: 5,
  billed: 100000,
  allowed: 62000,
  pct_allowed: 62,
  median_days_to_payment: 41,
  entity_ids: [INDIGO_ENTITY_ID],
};
const WEAK: QualifyFacilityRow = {
  ...STRONG,
  facility: 'weak house',
  facility_name: 'WEAK HOUSE',
  facility_code: 'LSMH',
  allowed: 40000,
  pct_allowed: 40,
  entity_ids: [BXR_ENTITY_ID],
};

type CensusRow = Awaited<ReturnType<NonNullable<QualifyDeps['loadCensusAuth']>>>[number];

const census = (over: Partial<CensusRow> & { facility_code: string }): CensusRow => ({
  board_family: 'residential',
  avg_auth_days: null,
  avg_los_days: null,
  auth_sample: null,
  los_sample: null,
  next_ur_date: null,
  open_beds: null,
  bed_capacity: null,
  ...over,
});

function deps(over: Partial<QualifyDeps> = {}): QualifyDeps {
  return {
    requirePrincipal: async () => SUPER(),
    mintToken: () => 'HMAC_TOKEN',
    mintGroupToken: () => 'GROUP_TOKEN',
    mintNameToken: () => 'NAME_TOKEN',
    resolvePayer: async () => 'AETNA',
    loadFacilities: async () => [STRONG, WEAK],
    loadIdentifierLandingFacility: async () => 'strong house',
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
    loadCodingDecisions: async () => ({ seeded: false, rows: [] }),
    loadCensusAuth: async () => [],
    ...over,
  };
}

const namesOf = (fs: readonly { name: string }[]): string[] => fs.map((f) => f.name);

// ── The pure derivation (ONE truth table, shared by the sort key, the v3 chip and the v2 bedChip) ──

test('bedStateOf — the denominator and the board family separate the two zeroes', () => {
  // No census row at all. Absence of data must never be read as a fact about the facility.
  assert.equal(bedStateOf(null, 12, 'residential'), 'unknown');
  assert.equal(bedStateOf(null, null, null), 'unknown');
  // OUTPATIENT: open_beds is written 0 because the board carries no "Open Bed" labels — that is
  // "beds do not apply", not "full". This is the #163 defect class, encoded once.
  assert.equal(bedStateOf(0, null, 'outpatient'), 'not_applicable');
  assert.equal(bedStateOf(0, 40, 'outpatient'), 'not_applicable', 'the family wins over a stray denominator');
  // RESIDENTIAL with a real denominator: 0 open IS full, and it is the most actionable fact on the card.
  assert.equal(bedStateOf(0, 12, 'residential'), 'full');
  assert.equal(bedStateOf(0, 12, null), 'full', 'family-less callers (the v2 chip) keep the denominator rule');
  // A zero capacity is not a usable denominator — never divide by it, never claim full from it.
  assert.equal(bedStateOf(0, 0, 'residential'), 'unknown');
  assert.equal(bedStateOf(0, null, 'residential'), 'unknown', 'uncurated residential states nothing');
  // Open beds.
  assert.equal(bedStateOf(3, 12, 'residential'), 'open');
  assert.equal(bedStateOf(3, null, null), 'open');
});

test('bedAvailabilityTier — ONLY a confirmed-full house sinks; absence never punishes', () => {
  assert.equal(bedAvailabilityTier('full'), 1);
  assert.equal(bedAvailabilityTier('open'), 0);
  assert.equal(bedAvailabilityTier('not_applicable'), 0, 'outpatient is not a bed facility, not a full one');
  assert.equal(bedAvailabilityTier('unknown'), 0, 'a census outage degrades to today’s order, never a reshuffle');
});

// ── The sort, at the ONE layer every surface inherits (assembleFacilities) ───────────────────────

test('a CONFIRMED-FULL house sorts below a worse-paying house that can take the patient today', async () => {
  const snap = await getQualifySnapshotCore(
    deps({
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', open_beds: 0, bed_capacity: 12 }), // full
        census({ facility_code: 'LSMH', open_beds: 3, bed_capacity: 12 }), // open
      ],
    }),
    IN,
  );
  assert.deepEqual(namesOf(snap.facilities), ['WEAK HOUSE', 'STRONG HOUSE']);
  // rank is stamped AFTER the sort, so it reflects the sunk position — deliberately. Rank answers
  // "where do I send them right now", not "how good is the paying".
  assert.equal(snap.facilities[0]!.rank, 1);
  assert.equal(snap.facilities[1]!.rank, 2);
  // And the rating itself is untouched: availability sorts, it never bends the score.
  assert.ok(snap.facilities[1]!.ratingV2! > snap.facilities[0]!.ratingV2!);
  assert.equal(snap.facilities[1]!.bedState, 'full');
  assert.equal(snap.facilities[0]!.bedState, 'open');
});

test('an OUTPATIENT zero never sinks — the eleven outpatient facilities are not full', async () => {
  const snap = await getQualifySnapshotCore(
    deps({
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', board_family: 'outpatient', open_beds: 0, bed_capacity: null }),
        census({ facility_code: 'LSMH', open_beds: 3, bed_capacity: 12 }),
      ],
    }),
    IN,
  );
  assert.deepEqual(namesOf(snap.facilities), ['STRONG HOUSE', 'WEAK HOUSE'], 'rating order, unchanged');
  assert.equal(snap.facilities[0]!.bedState, 'not_applicable');
});

test('NO census row is neutral — a census outage degrades to the rating order, not a reshuffle', async () => {
  const snap = await getQualifySnapshotCore(deps({ loadCensusAuth: async () => [] }), IN);
  assert.deepEqual(namesOf(snap.facilities), ['STRONG HOUSE', 'WEAK HOUSE']);
  assert.equal(snap.facilities[0]!.bedState, 'unknown');
  assert.equal(snap.facilities[1]!.bedState, 'unknown');
});

test('WITHIN a tier nothing changes — two full houses still order by ratingV2', async () => {
  const snap = await getQualifySnapshotCore(
    deps({
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', open_beds: 0, bed_capacity: 12 }),
        census({ facility_code: 'LSMH', open_beds: 0, bed_capacity: 8 }),
      ],
    }),
    IN,
  );
  assert.deepEqual(namesOf(snap.facilities), ['STRONG HOUSE', 'WEAK HOUSE']);
  assert.equal(snap.facilities[0]!.bedState, 'full');
  assert.equal(snap.facilities[1]!.bedState, 'full');
});

// ── The wire: census numbers gated to the basis the rating actually scored on ────────────────────

test('avgAuthDays/avgLosDays cross the wire GATED — a 2-client average is withheld, not shipped', async () => {
  // The live footgun this closes: core.ts used to ship `census.avg_*` raw, with NO sample floor and
  // NO alignment to the basis the rating chose. FRCA's 373.5-day LOS over a los_sample of 2 reached
  // the client verbatim; nothing rendered it, so the trap was loaded rather than sprung.
  const thin = await getQualifySnapshotCore(
    deps({
      loadFacilities: async () => [STRONG],
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', avg_auth_days: 30, avg_los_days: 373.5, auth_sample: 2, los_sample: 2 }),
      ],
    }),
    IN,
  );
  assert.equal(thin.facilities[0]!.avgLosDays, null, 'below the sample floor the wire says nothing');
  assert.equal(thin.facilities[0]!.avgAuthDays, null);
  assert.equal(thin.facilities[0]!.authHeadroomDays, null);
});

test('the wire follows the SAME basis the rating scored on — completed stays, not the snapshot', async () => {
  const snap = await getQualifySnapshotCore(
    deps({
      loadFacilities: async () => [STRONG],
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', avg_auth_days: 30, avg_los_days: 20, auth_sample: 9, los_sample: 9 }),
      ],
      loadFacilityOutcomes: async () => [
        { facility_code: 'NASH', stays_sample: 142, auth_sample: 102, avg_los_days: 40.1, avg_auth_days: 36.35, window_days: 365 },
      ],
    }),
    IN,
  );
  assert.equal(snap.facilities[0]!.avgLosDays, 40.1, 'the completed-stay measurement, not the 20d snapshot');
  assert.equal(snap.facilities[0]!.avgAuthDays, 36.35);
  // Headroom is negative here: the completed stays OVERRUN the authorization. Shipped signed, so a
  // renderer can say "over auth" instead of silently dropping the worse half of the KPI.
  assert.equal(snap.facilities[0]!.authHeadroomDays, -3.8);
});

test('auth headroom — authorized days minus actual LOS, computed ONCE, server-side', async () => {
  // The KPI Alec called out: NASH 22.6 authorized vs 16.8 actual — ~6 authorized days routinely
  // unused. The client must never subtract two gated numbers itself; the answer ships computed.
  const snap = await getQualifySnapshotCore(
    deps({
      loadFacilities: async () => [STRONG],
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', avg_auth_days: 22.6, avg_los_days: 16.8, auth_sample: 9, los_sample: 9 }),
      ],
    }),
    IN,
  );
  assert.equal(snap.facilities[0]!.authHeadroomDays, 5.8);
});

test('auth headroom is NOT computed for outpatient — the same suppression the rating already applies', async () => {
  // Ruling 2026-08-05: outpatient boards do not maintain authorization or discharge dates, so LOS
  // there is an open-ended today-minus-admit. The rating suppresses authFit; headroom must too, or
  // the card renders a KPI the "Why this score" row directly beneath it refuses to score.
  const snap = await getQualifySnapshotCore(
    deps({
      loadFacilities: async () => [STRONG],
      loadCensusAuth: async () => [
        census({ facility_code: 'NASH', board_family: 'outpatient', avg_auth_days: 86, avg_los_days: 370, auth_sample: 9, los_sample: 9 }),
      ],
    }),
    IN,
  );
  assert.equal(snap.facilities[0]!.authHeadroomDays, null);
  assert.equal(snap.facilities[0]!.avgLosDays, null, 'and the raw 370-day outpatient LOS does not ship either');
});

// ── Least privilege: census is NON-PHI and NON-DOLLAR, so the strip must leave it alone ──────────

test('an admissions_seat sees the SAME bed state, headroom and order as a super_admin', () => {
  // A GUARD, not a behavioural claim — it was green the moment it was written, because
  // `stripSnapshotAmounts` is a denylist of two dollar fields and none of these are dollars. It is
  // here so that stays true: bed counts and day counts are facility facts, and the seat persona is
  // the one that most needs them (admissions_seat's ONLY surface is Qualify). A future session that
  // sweeps new fields into the strip "to be safe" would blind the exact operator this is built for.
  const seat = () =>
    requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'a@t.ai', id: 'a' }, role: 'admissions_seat' } });
  const census2 = [
    census({ facility_code: 'NASH', open_beds: 0, bed_capacity: 12, avg_auth_days: 22.6, avg_los_days: 16.8, auth_sample: 9, los_sample: 9 }),
    census({ facility_code: 'LSMH', open_beds: 3, bed_capacity: 12 }),
  ];
  return Promise.all([
    getQualifySnapshotCore(deps({ loadCensusAuth: async () => census2 }), IN),
    getQualifySnapshotCore(deps({ requirePrincipal: async () => seat(), loadCensusAuth: async () => census2 }), IN),
  ]).then(([sighted, blind]) => {
    const read = (s: typeof sighted) => s.facilities.map((f) => [f.name, f.bedState, f.authHeadroomDays, f.rank]);
    assert.deepEqual(read(blind), read(sighted));
    assert.deepEqual(read(blind), [
      ['WEAK HOUSE', 'open', null, 1],
      ['STRONG HOUSE', 'full', 5.8, 2],
    ]);
    // And the strip still does its job on the same objects.
    assert.equal(blind.facilities[0]!.billedAmount, null);
    assert.ok(sighted.facilities[0]!.billedAmount !== null);
  });
});
