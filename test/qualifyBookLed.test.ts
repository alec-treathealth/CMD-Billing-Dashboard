/**
 * S2 — THE PREFACE (memberCount) AND THE PAYER'S BOOK ON THE SNAPSHOT.
 *
 * Measured 2026-08-08 (.superpowers/sdd/qualify-search-tree.md, M1/M2): **58.8% of prefixes resolve
 * to exactly ONE member**, carrying 1.14 facilities of history, and 85.7% of prefixes can never
 * clear the 10-patient confidence floor at any window — so the auto-window ladder is inert 96% of
 * the time. Two consequences, both encoded here:
 *
 *   1. The engine must know whether it is looking at a PERSON or a POPULATION before it claims
 *      anything, and it must say so. That classification is ONE `count(distinct member_id_bidx)`
 *      the ladder query already computes and then threw away on every path except an auto prefix
 *      search. `memberCount` surfaces it for EVERY token kind.
 *   2. For the person case the useful ranking is the PAYER'S WHOLE BOOK, not one member's 1.14
 *      facilities — ranking those is not thin, it is malformed. `bookFacilities` carries it.
 *
 * S2 ships both as DATA plus a secondary section. The prominence flip (book first, member history
 * as annotation) is S3 and is deliberately NOT built here.
 *
 * THE SPLIT THIS FILE PINS: the ladder gate used to conflate two decisions — "should we COUNT the
 * members behind this token" and "should we CHOOSE the window from that count". The count is
 * universally useful and universally cheap (one already-parallel token-scoped scan, ~20ms at the
 * 365d worst case). The window choice is only meaningful for an auto prefix search. They are now
 * separate, and the tests below fail if they are ever re-conflated in either direction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getQualifySnapshotCore,
  getQualifySnapshotByPayerCore,
  type QualifyDeps,
} from '../app/lib/qualify/core.js';
import { memberBucketOf, memberPrefaceFor } from '../app/lib/qualify/memberPreface.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import type { QualifyFacilityRow } from '../src/collections/qualifyQuery.js';
import type { QualifyWindowRungsRow } from '../src/collections/qualifyPolicyQuery.js';

const SUPER = () =>
  requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 's@t.ai', id: 's' }, role: 'super_admin' } });
const SEAT = () =>
  requireQualifyPrincipalFromAccess({ ok: true, access: { user: { email: 'a@t.ai', id: 'a' }, role: 'admissions_seat' } });

const NOW = new Date('2026-08-08T12:00:00Z');

/** A 3-char alpha prefix — `sniffQualifyKind` reads this as `prefix`, the ladder's only kind. */
const PREFIX_IN = { query: 'W29', window: { kind: 'trailing', days: 30 } as const, auto: true };
/** A full member id — `sniffQualifyKind` reads this as `member_id`, the kind the ladder never ran for. */
const MEMBER_IN = { query: 'AETMEMBER123', window: { kind: 'trailing', days: 30 } as const, auto: true };

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
/** Below QUALIFY_MIN_LINES — the fluke the payer-wide FLOOR exists to drop. */
const FLUKE: QualifyFacilityRow = {
  ...STRONG,
  facility: 'one claim wonder',
  facility_name: 'ONE CLAIM WONDER',
  facility_code: 'FLUKE',
  line_count: 1,
  distinct_patients: 1,
  confirmed_claims: 1,
  estimate_claims: 0,
  unknown_claims: 0,
  pct_allowed: 100,
};

const RUNGS: QualifyWindowRungsRow = { p30: 2, p60: 4, p90: 11, p180: 15, p365: 22 };
/** The 58.8% shape: one member, and no window can ever reach the 10-patient floor. */
const RUNGS_ONE: QualifyWindowRungsRow = { p30: 1, p60: 1, p90: 1, p180: 1, p365: 1 };

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

/** Every `loadFacilities` call, so a test can tell the MEMBER-scoped load from the BOOK load: the
 *  book call is the one with no token and no kind (payer-wide, byte-for-byte the by-payer core's). */
interface FacCall {
  payer: string | null;
  from: string;
  to: string;
  token: string | null | undefined;
  kind: string | null | undefined;
}

function deps(
  over: Partial<QualifyDeps> = {},
  principal: () => ReturnType<typeof SUPER> = SUPER,
): QualifyDeps {
  return {
    requirePrincipal: async () => principal(),
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
    loadWindowRungs: async () => RUNGS,
    loadCodingDecisions: async () => ({ seeded: false, rows: [] }),
    loadCensusAuth: async () => [],
    ...over,
  };
}

/** Records every facility load and answers the MEMBER call and the BOOK call separately. */
function recordingDeps(
  member: QualifyFacilityRow[],
  book: QualifyFacilityRow[],
  over: Partial<QualifyDeps> = {},
  principal: () => ReturnType<typeof SUPER> = SUPER,
): { deps: QualifyDeps; calls: FacCall[] } {
  const calls: FacCall[] = [];
  const d = deps(
    {
      loadFacilities: async (payer, from, to, _ents, _market, token, kind) => {
        calls.push({ payer, from, to, token, kind });
        return token === undefined || token === null ? book : member;
      },
      ...over,
    },
    principal,
  );
  return { deps: d, calls };
}

const namesOf = (fs: readonly { name: string }[] | null): string[] => (fs ?? []).map((f) => f.name);

// ── (1) The classifier, pure ─────────────────────────────────────────────────────────────────────

test('memberBucketOf — a PERSON, a small set, a POPULATION, and two kinds of nothing', () => {
  // The measured shape: 58.8% land here, and the whole point of the preface is to say so.
  assert.equal(memberBucketOf(1), 'one');
  // 2-9 is 37.0% of prefixes. The 10-patient confidence floor is unreachable for every one of them.
  assert.equal(memberBucketOf(2), 'few');
  assert.equal(memberBucketOf(9), 'few');
  // 10+ is 4.2%, and is the ONLY bucket where the ladder can clear the floor and where a payer
  // blend is routine (3.3-3.7 payers measured).
  assert.equal(memberBucketOf(10), 'many');
  assert.equal(memberBucketOf(1_000), 'many');
  // ⚠ TWO DIFFERENT NOTHINGS, and collapsing them is the failure this split exists to prevent.
  // `null` = the count was not available (rungs loader absent, or it failed soft) — the engine does
  // not know which world it is in and must not guess. `0` = the count RAN and the answer is that no
  // member with claims sits behind this token, which is a fact the provenance banner already states.
  assert.equal(memberBucketOf(null), 'unknown');
  assert.equal(memberBucketOf(0), 'none');
  // Negative is unreachable from a count(distinct) but must not fall through to a claim.
  assert.equal(memberBucketOf(-1), 'none');
});

test('memberPrefaceFor — one sentence per world, and SILENCE when the world is unknown', () => {
  assert.equal(memberPrefaceFor(1, 1), 'One member matches this search — 1 facility of history.');
  assert.equal(memberPrefaceFor(1, 3), 'One member matches this search — 3 facilities of history.');
  // Zero facilities is a real state (the member's claims fell outside the window) and must still
  // read as English rather than "0 facility".
  assert.equal(memberPrefaceFor(1, 0), 'One member matches this search — 0 facilities of history.');
  assert.equal(
    memberPrefaceFor(4, 9),
    '4 members share this prefix. Continue to search across all of them, or refine the prefix.',
  );
  assert.equal(memberPrefaceFor(31, 9), 'A population — 31 members behind this prefix.');
  // Unknown says NOTHING NEW — the rest of the screen is unchanged, which is the honest degrade.
  assert.equal(memberPrefaceFor(null, 3), null);
  assert.equal(memberPrefaceFor(0, 0), null);
});

// ── (2) memberCount on the snapshot, for ALL token kinds ─────────────────────────────────────────

test('memberCount rides an auto PREFIX search — the count the ladder already made and threw away', async () => {
  const snap = await getQualifySnapshotCore(deps(), PREFIX_IN);
  assert.equal(snap.memberCount, 22, 'p365 IS the classifier — count(distinct member_id_bidx) at 365d');
  assert.equal(snap.ladder!.chosenDays, 90, 'window selection is untouched by this change');
});

test('memberCount rides an exact MEMBER-ID search — the kind that got nothing at all before', async () => {
  let rungCalls = 0;
  const snap = await getQualifySnapshotCore(
    deps({
      loadWindowRungs: async (_t, kind) => {
        rungCalls++;
        assert.equal(kind, 'member_id', 'the rungs SQL already switches to member_id_bidx for this kind');
        return RUNGS_ONE;
      },
    }),
    MEMBER_IN,
  );
  assert.equal(rungCalls, 1, 'the COUNT runs for every token kind');
  assert.equal(snap.memberCount, 1);
  // ⚠ THE WINDOW SELECTION STAYS GATED. A 10-patient floor is meaningless for an N-of-1 search, and
  // the pre-S2 behaviour (ladder null, the caller's window kept) must be byte-identical.
  assert.equal(snap.ladder, null, 'no ladder on a member-id search — the floor is meaningless at N-of-1');
  const spanDays = (Date.parse(snap.resolved!.windowEnd) - Date.parse(snap.resolved!.windowStart)) / 86_400_000;
  assert.equal(spanDays, 30, "the caller's window survives — the ladder never chose one");
});

test('memberCount rides a MANUAL window too — the count is about the identifier, not the window', async () => {
  // The preface answers "is this a person or a population". That is a fact about the token, so it
  // cannot vanish the moment an operator presses a Range chip — which is exactly what would happen
  // if the count stayed behind the `auto` gate.
  let rungCalls = 0;
  const snap = await getQualifySnapshotCore(
    deps({
      loadWindowRungs: async () => {
        rungCalls++;
        return RUNGS;
      },
    }),
    { query: 'W29', window: { kind: 'trailing', days: 30 } },
  );
  assert.equal(rungCalls, 1, 'the count runs');
  assert.equal(snap.memberCount, 22);
  assert.equal(snap.ladder, null, 'but a manual window still means NO ladder — the Range menu is the override');
  const spanDays = (Date.parse(snap.resolved!.windowEnd) - Date.parse(snap.resolved!.windowStart)) / 86_400_000;
  assert.equal(spanDays, 30);
});

test('a rungs failure leaves memberCount NULL, not 0 — the ladder fail-soft keeps its meaning', async () => {
  const snap = await getQualifySnapshotCore(
    deps({
      loadWindowRungs: async () => {
        throw new Error('boom');
      },
    }),
    PREFIX_IN,
  );
  assert.equal(snap.ladder, null);
  assert.equal(snap.memberCount, null, 'unavailable, NEVER zero — zero is a claim that nobody is behind the token');
  assert.ok(snap.resolved, 'and the search still resolves');
});

test('no rungs loader at all (the pre-v2 dep corpus) — memberCount null, nothing throws', async () => {
  const d = deps();
  delete d.loadWindowRungs;
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.equal(snap.memberCount, null);
  assert.equal(snap.ladder, null);
});

// ── (3) The payer's book on the snapshot ─────────────────────────────────────────────────────────

test('bookFacilities is a SECOND, payer-wide load — same window, no token, and it does not disturb the member list', async () => {
  const { deps: d, calls } = recordingDeps([STRONG], [STRONG, WEAK]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.equal(calls.length, 2, 'exactly two facility loads: the member ranking and the book');
  const member = calls.find((c) => c.token !== undefined && c.token !== null)!;
  const book = calls.find((c) => c.token === undefined || c.token === null)!;
  assert.ok(member, 'the member-scoped load still carries the token');
  assert.equal(book.payer, 'AETNA', 'the book is scoped to the SAME resolved payer');
  assert.equal(book.kind ?? null, null, 'no kind — token/kind omitted IS what makes it payer-wide');
  // THE SAME WINDOW as the member ranking (window2 — the ladder's choice), so the two lists are
  // comparable. A book on a different window would be a second, silent basis on one screen.
  assert.equal(book.from, member.from);
  assert.equal(book.to, member.to);
  assert.deepEqual(namesOf(snap.facilities), ['STRONG HOUSE'], 'the member ranking is unchanged');
  assert.deepEqual(namesOf(snap.bookFacilities), ['STRONG HOUSE', 'WEAK HOUSE']);
  // The hero, the counts and the AI payload all hang off `facilities` — the book must never move them.
  assert.equal(snap.resolved!.facilityCount, 1);
  assert.equal(snap.resolved!.totalCharges, 120);
});

test('the BOOK applies the payer-wide FLOOR; the member ranking still does not', async () => {
  // The floor drops "100% on one claim" flukes from a payer-wide ranking, exactly as the by-payer
  // core does. The identifier's own footprint keeps every facility it billed, however thin — that
  // asymmetry is pre-existing and deliberate, and the book must not inherit the floorless side.
  const { deps: d } = recordingDeps([STRONG, FLUKE], [STRONG, FLUKE]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.ok(namesOf(snap.facilities).includes('ONE CLAIM WONDER'), 'the identifier billed it — it is relevant');
  // ⚠ NOT `!includes(…)` ALONE. With `bookFacilities` null that assertion passes vacuously — it did,
  // at RED — which is the "reads as coverage without being any" failure this repo names by name.
  assert.deepEqual(namesOf(snap.bookFacilities), ['STRONG HOUSE'], 'the book drops the fluke, and IS a list');
});

test('the book rides the SAME availability tier — a full house sinks in both lists, or the screen contradicts itself', async () => {
  const { deps: d } = recordingDeps([STRONG, WEAK], [STRONG, WEAK], {
    // STRONG (62%) is confirmed full; WEAK (40%) can admit today.
    loadCensusAuth: async () => [
      census({ facility_code: 'NASH', open_beds: 0, bed_capacity: 12 }),
      census({ facility_code: 'LSMH', open_beds: 4, bed_capacity: 20 }),
    ],
  });
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.deepEqual(namesOf(snap.facilities), ['WEAK HOUSE', 'STRONG HOUSE'], 'S1 tier, member list');
  assert.deepEqual(namesOf(snap.bookFacilities), ['WEAK HOUSE', 'STRONG HOUSE'], 'and the book, for free');
  assert.equal(snap.bookFacilities![1]!.bedState, 'full', 'the chip copy reads the same server decision');
});

test('a payer-scoped book pins payerCount to 1 — the blend disclosure cannot fire on it', async () => {
  // `count(distinct primary_payer)` under a payer predicate is 1 by the equality, so a book card can
  // never claim a blend. Pinned because the ScoreCard's disclosure is scope-gated, and the book
  // section renders through the SAME component.
  const { deps: d } = recordingDeps([STRONG], [{ ...STRONG, payer_count: 1, sole_payer: 'AETNA' }]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.equal(snap.bookFacilities![0]!.payerCount, 1);
  assert.equal(snap.bookFacilities![0]!.solePayer, 'AETNA');
});

test('IDENTIFIER-WIDE (the Skip): bookFacilities is null and NOTHING tries to fetch it', async () => {
  // ⚠ THE HARD BOUNDARY. `buildFacilityRankingQuery` THROWS on (null payer, no market, no token) —
  // correctly: the all-payers whole book is the 206-713ms M5 query and is not a per-search load.
  const { deps: d, calls } = recordingDeps([STRONG, WEAK], [STRONG, WEAK]);
  const snap = await getQualifySnapshotCore(d, { ...PREFIX_IN, payerScope: 'all' });
  assert.equal(snap.resolved!.payerScope, 'all');
  assert.equal(snap.bookFacilities, null, 'null is the answer, not an empty list');
  assert.equal(calls.length, 1, 'ONE load — no second call was even attempted');
  assert.equal(calls[0]!.payer, null, 'and that one is the identifier-wide member ranking');
});

test('an admissions_seat gets the book with its DOLLARS STRIPPED — the choke point covers both lists', async () => {
  // R-AMOUNTS: `stripSnapshotAmounts` is the ONE place dollars are nulled, and it runs LAST. A new
  // facility array that skips it would hand an amounts-blind session a full billed/allowed set.
  const { deps: d } = recordingDeps([STRONG], [STRONG, WEAK], {}, SEAT);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.equal(snap.viewerHasAmountsCapability, false);
  for (const f of snap.facilities) assert.equal(f.billedAmount, null);
  for (const f of snap.bookFacilities!) {
    assert.equal(f.billedAmount, null, 'no billed dollars reach an amounts-blind seat');
    assert.equal(f.allowedAmount, null);
  }
  // The rating is dollar-free by construction, so the blind session still sees the same order.
  assert.deepEqual(namesOf(snap.bookFacilities), ['STRONG HOUSE', 'WEAK HOUSE']);
});

test('the by-payer path carries NO second book — `facilities` already IS the book there', async () => {
  const snap = await getQualifySnapshotByPayerCore(deps(), {
    payer: 'AETNA',
    window: { kind: 'trailing', days: 30 },
  });
  assert.equal(snap.bookFacilities, null, 'rendering the same list twice is not a second answer');
  assert.equal(snap.memberCount, null, 'and no identifier was searched, so there is no member count');
  assert.equal(snap.resolved!.identifierScoped, false);
});
