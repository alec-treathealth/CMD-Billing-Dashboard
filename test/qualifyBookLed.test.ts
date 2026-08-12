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
  getQualifySnapshotByNameCore,
  getQualifySnapshotByPayerCore,
  type QualifyDeps,
} from '../app/lib/qualify/core.js';
import {
  memberBucketOf,
  memberHistoryChipFor,
  memberPrefaceFor,
  prefaceNamesFacilityCount,
} from '../app/lib/qualify/memberPreface.js';
import { requireQualifyPrincipalFromAccess } from '../app/lib/qualify/principal.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';
import { buildFacilityRankingQuery, type QualifyFacilityRow } from '../src/collections/qualifyQuery.js';
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

  /* ⚠ AND THE THIRD NOTHING: AN **ABSENT** FIELD (final review, 2026-08-08 — the fourth sighting of
   * the `undefined !== null` trap on this branch). `undefined === null` is false and every numeric
   * comparison against `undefined` is false too, so before the `?? null` coercion this fell all the
   * way through to `'many'` — a POPULATION classification from a payload carrying no count at all,
   * which rendered as "A population — undefined members have a paid claim…". Reachable from any
   * snapshot serialized before the field existed.
   *
   * PINNED WITH THE ABSENT-FIELD SHAPE, NEVER WITH A LITERAL `null`: `null` was always handled, so a
   * test that passes `null` proves nothing about the trap. This is the same guard `bookIsOnScreen`
   * carries (`?? null`, whose loss broke 40 renders) and `memberHistoryChipFor` carries (`== null`);
   * the coercion now lives in `memberBucketOf` alone and the other three delegate to it, so it can
   * no longer be half-applied — which is exactly how it came to be missing from one of three. */
  const absent = ({} as { memberCount?: number | null }).memberCount;
  assert.equal(memberBucketOf(absent), 'unknown', 'an absent count is UNCLASSIFIED, not a population');
  assert.equal(memberPrefaceFor(absent, 3), null, 'and so it says nothing, like every other unknown');
  assert.equal(prefaceNamesFacilityCount(absent), false);
  assert.equal(
    memberHistoryChipFor(absent, { lineCount: 210 }),
    'This search has 210 claim lines here in this window',
    'an unclassified search is never narrated as one person',
  );
});

test('memberPrefaceFor — one sentence per world, and EVERY number states its own basis', () => {
  /* ⚠ TWO WINDOWS IN ONE SENTENCE, BOTH NAMED (fix round 1). `memberCount` is always the 365-day
   * rung and is filtered on `payment_received`, so it means "members with a PAID CLAIM in the last
   * 12 months"; the facility count is the CHOSEN window. Joined by a bare em-dash — which is how
   * this first shipped — they made one mixed-basis claim, and the contradiction was REACHABLE: a
   * 30-day window on a member last paid 200 days ago read "One member matches this search — 0
   * facilities of history." beside an empty grid, both halves individually true and the sentence
   * false at both bases. The DESIGN is unchanged (the classifier must not move when a Range chip is
   * pressed); the copy now says what each number was counted over. */
  assert.equal(
    memberPrefaceFor(1, 1),
    'One member has a paid claim behind this search in the last 12 months — 1 facility of history in the window shown.',
  );
  assert.equal(
    memberPrefaceFor(1, 3),
    'One member has a paid claim behind this search in the last 12 months — 3 facilities of history in the window shown.',
  );
  // THE DEFECT'S OWN CASE, now coherent rather than contradictory: paid inside the year, nothing
  // inside the window on screen. Still English, never "0 facility".
  assert.equal(
    memberPrefaceFor(1, 0),
    'One member has a paid claim behind this search in the last 12 months — 0 facilities of history in the window shown.',
  );
  /* ⚠ THE 2-9 ARM NAMES NO CONTROL AND NO POSITION (final review, 2026-08-08). It said "Continue to
   * search across all of them" — "Continue" named the SKIP, which lives on the carrier and plan
   * stages and does NOT exist on the answer stage, the only stage this sentence renders on. A
   * positional replacement would be wrong too: `liveSentenceFor`'s skipped arm returns before every
   * stage check, so this sentence can be announced over the identify screen (the S3-M1 defect). */
  assert.equal(
    memberPrefaceFor(4, 9),
    '4 members have a paid claim behind this prefix in the last 12 months. This search covers all of them — refine the prefix to narrow it to one.',
  );
  assert.equal(
    memberPrefaceFor(31, 9),
    'A population — 31 members have a paid claim behind this prefix in the last 12 months.',
  );
  // Unknown says NOTHING NEW — the rest of the screen is unchanged, which is the honest degrade.
  assert.equal(memberPrefaceFor(null, 3), null);
  assert.equal(memberPrefaceFor(0, 0), null);
});

test('prefaceNamesFacilityCount — only the ONE-member arm carries a facility count of its own', () => {
  // The judge for whether the aria sentence REPLACES the resolution's own facility clause (a
  // collision) or merely prepends to it (an addition). Getting this wrong in the 2-9/10+ direction
  // leaves a screen-reader user with NO facility count while the grid visibly has one.
  assert.equal(prefaceNamesFacilityCount(1), true);
  assert.equal(prefaceNamesFacilityCount(4), false);
  assert.equal(prefaceNamesFacilityCount(31), false);
  assert.equal(prefaceNamesFacilityCount(0), false);
  assert.equal(prefaceNamesFacilityCount(null), false);
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

// ── S3 (2026-08-08) — THE INVERSION: history annotates the book, and breaks its ties ─────────────
//
// Alec's ruling: **the book ranks, member history annotates.** A ranking is a comparative claim and
// 58.8% of searches carry 1.14 facilities — ranking those is not thin, it is MALFORMED. But the
// member's own history is the most specific fact the rep holds (continuity, the facility knows them,
// prior-auth precedent), so it must stay visible: as a mark on the list that has statistical power,
// and as a WEAK tiebreak inside it.
//
// These pin the SERVER half — the join, the annotation's non-PHI shape, the tiebreak's exact
// footing, and the four paths that carry no annotation at all. The render half (which list LEADS)
// is pinned in app/test/qualifyV3Flow.test.tsx.

const annotationOf = (fs: readonly { name: string; memberHistory: unknown }[] | null) =>
  (fs ?? []).map((f) => [f.name, f.memberHistory] as const);

test('memberHistoryChipFor — a PERSON has been here before; a PREFIX of four people has not', () => {
  // ⚠ THE BUCKET DECIDES THE SENTENCE, and getting it wrong is a claim about people. At one member
  // "Seen here before" is personally true and is the fact that decides a placement. At 2-9 the same
  // lines belong to SEVERAL people, and the same words would tell a rep that one patient has a
  // relationship with a facility when what the data says is that some of four do.
  assert.equal(memberHistoryChipFor(1, { lineCount: 210 }), 'Seen here before — 210 claim lines in this window');
  assert.equal(memberHistoryChipFor(1, { lineCount: 1 }), 'Seen here before — 1 claim line in this window');
  assert.equal(memberHistoryChipFor(4, { lineCount: 210 }), 'This search has 210 claim lines here in this window');
  // An unclassified search must not be narrated as a person either — but the JOIN still happened, so
  // the lines are real and dropping them would hide evidence that is on the screen's own rows.
  assert.equal(memberHistoryChipFor(null, { lineCount: 9 }), 'This search has 9 claim lines here in this window');
  // ⚠ THE BASIS IS THE CHOSEN WINDOW, NEVER `memberCount`'s 12 MONTHS. These lines come from the
  // same rows the grid was ranked on; borrowing the classifier's basis would be S2's I1 defect again.
  assert.ok(!memberHistoryChipFor(1, { lineCount: 1 })!.includes('12 months'));
  // No annotation, no chip — the render site gets no second null rule of its own.
  assert.equal(memberHistoryChipFor(1, null), null);
});

test('S3 — the BOOK carries the member’s own lines, joined on the RAW rollup facility text', async () => {
  // The join key is `QualifyFacility.facilityKey` === the rollup's `facility` column, which BOTH
  // loads group by — same column, same window, same payer predicate — so an exact text match is
  // correct and no upper() normalisation belongs here. (FACILITY_DIM_JOINS' upper() exists to enrich
  // the DISPLAY name off collections.facilities; it never touches the grouping key.)
  const { deps: d } = recordingDeps([STRONG], [STRONG, WEAK]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.deepEqual(annotationOf(snap.bookFacilities), [
    ['STRONG HOUSE', { lineCount: 120, distinctPatients: 22 }],
    // The member never billed here, so the book row says nothing about them. NULL, not a zeroed
    // block: "0 lines" is a claim, "no history" is the absence of one.
    ['WEAK HOUSE', null],
  ]);
});

test('S3 — the MEMBER list is never annotated: every row there IS member history already', async () => {
  // The annotation answers "has this member been here" about a list that is NOT about this member.
  // On the member's own footprint it would be a tautology on every row, and a reader meeting it
  // there would reasonably conclude the ABSENT ones are facilities the member has not been to.
  const { deps: d } = recordingDeps([STRONG, WEAK], [STRONG, WEAK]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  for (const f of snap.facilities) assert.equal(f.memberHistory, null, `${f.name} carries no annotation`);
  assert.ok(snap.bookFacilities!.some((f) => f.memberHistory !== null), 'the book does — otherwise this is vacuous');
});

/** Two book rows identical in every rating input, so the ONLY thing between them is the annotation.
 *  `ZED` sorts alphabetically LAST, which is the pre-S3 tiebreak — so a test that passes because of
 *  the name would still fail here. */
const TIE_A: QualifyFacilityRow = { ...STRONG, facility: 'alpha house', facility_name: 'ALPHA HOUSE', facility_code: 'ALPH' };
const TIE_Z: QualifyFacilityRow = { ...STRONG, facility: 'zed house', facility_name: 'ZED HOUSE', facility_code: 'ZEDH' };

test('S3 tiebreak — at EQUAL footing the annotated facility wins, over the alphabetical fallback', async () => {
  // EQUAL FOOTING, DEFINED FROM THE COMPARATOR'S OWN TIERS: the same availability tier (S1) AND the
  // same `ratingV2` — including both-suppressed. That is the narrowest reading that is still a
  // reading, and it is what makes the tiebreak WEAK by construction.
  const { deps: d } = recordingDeps([TIE_Z], [TIE_A, TIE_Z]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.deepEqual(namesOf(snap.bookFacilities), ['ZED HOUSE', 'ALPHA HOUSE']);
  assert.equal(snap.bookFacilities![0]!.rank, 1, 'and `rank` is stamped after the sort, so the card agrees');
});

test('S3 tiebreak — history NEVER beats a better rating: it breaks ties, it does not win arguments', async () => {
  // ALPHA pays better (80% vs 62%). The member has been to ZED. The rating still leads, because the
  // whole reason the book ranks is that a comparative claim needs a comparison — and "we know them"
  // is not evidence about what the payer allows.
  const better: QualifyFacilityRow = { ...TIE_A, allowed: 80000, pct_allowed: 80 };
  const { deps: d } = recordingDeps([TIE_Z], [better, TIE_Z]);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.deepEqual(namesOf(snap.bookFacilities), ['ALPHA HOUSE', 'ZED HOUSE']);
  // ⚠ WITHOUT THIS THE TEST PASSES ON AN UNBUILT FEATURE. The pre-S3 order is already
  // ALPHA-then-ZED, so the assertion above is satisfied by an engine that has never heard of an
  // annotation. Naming the annotation makes the negative a negative ABOUT the tiebreak.
  assert.deepEqual(snap.bookFacilities!.find((f) => f.name === 'ZED HOUSE')!.memberHistory, {
    lineCount: 120,
    distinctPatients: 22,
  });
});

test('S3 tiebreak — history NEVER floats a FULL house above one that can admit today', async () => {
  // The availability tier is TIER 0 and stays there. A facility the rep cannot use is not an answer
  // to "where do I send them right now", however well the member knows it.
  const { deps: d } = recordingDeps([TIE_Z], [TIE_A, TIE_Z], {
    loadCensusAuth: async () => [
      census({ facility_code: 'ZEDH', open_beds: 0, bed_capacity: 12 }), // annotated AND full
      census({ facility_code: 'ALPH', open_beds: 4, bed_capacity: 20 }),
    ],
  });
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.deepEqual(namesOf(snap.bookFacilities), ['ALPHA HOUSE', 'ZED HOUSE']);
  assert.equal(snap.bookFacilities![1]!.bedState, 'full');
  // ⚠ NOT `notEqual(…, null)`. `undefined !== null` is TRUE, so that form is satisfied by a build
  // where the field does not exist at all — the same absent-vs-null trap that broke 40 renders when
  // `bookIsOnScreen` was first extracted with a bare `!== null`. State the block.
  assert.deepEqual(
    snap.bookFacilities![1]!.memberHistory,
    { lineCount: 120, distinctPatients: 22 },
    'the annotation is still THERE — it just did not win',
  );
});

test('S3 — the annotation survives the amounts strip: a count is not a dollar', async () => {
  const { deps: d } = recordingDeps([STRONG], [STRONG, WEAK], {}, SEAT);
  const snap = await getQualifySnapshotCore(d, PREFIX_IN);
  assert.equal(snap.viewerHasAmountsCapability, false);
  const strong = snap.bookFacilities!.find((f) => f.name === 'STRONG HOUSE')!;
  assert.equal(strong.billedAmount, null, 'dollars are gone');
  assert.deepEqual(strong.memberHistory, { lineCount: 120, distinctPatients: 22 }, 'the counts are not');
});

test('S3 — the four paths with no book carry no annotation either, and nothing throws', async () => {
  // IDENTIFIER-WIDE (the Skip): no book to annotate — the hard boundary S2 pinned.
  const { deps: wide } = recordingDeps([STRONG, WEAK], [STRONG, WEAK]);
  const skip = await getQualifySnapshotCore(wide, { ...PREFIX_IN, payerScope: 'all' });
  assert.equal(skip.bookFacilities, null);
  for (const f of skip.facilities) assert.equal(f.memberHistory, null);
  // BY-PAYER: `facilities` already IS the book, and no identifier was searched to annotate it with.
  const byPayer = await getQualifySnapshotByPayerCore(deps(), { payer: 'AETNA', window: { kind: 'trailing', days: 30 } });
  for (const f of byPayer.facilities) assert.equal(f.memberHistory, null);
});

// ── S3 fix round 1 (2026-08-08) ─────────────────────────────────────────────────────────────────

/** The literal CMD emits when a charge resolves to no facility at all — 11,414 charges /
 *  $29,081,575.38 at charge grain (supabase/migrations/0084_cmd_explorer_pull_facility.sql). It is a
 *  real bucket in the rollup, so it reaches the ranking like any other text. */
const NO_FACILITY: QualifyFacilityRow = {
  ...STRONG,
  facility: 'No Facility',
  facility_name: 'No Facility',
  facility_code: null,
};

test('S3 M3 — the “No Facility” bucket is never annotated: nobody was SEEN at a placeholder', async () => {
  /* ⚠ THIS TEST FEEDS ROWS THE SQL NO LONGER EMITS, ON PURPOSE — read the next paragraph before
   * "simplifying" it. Under the 2026-08-12 ruling buildFacilityRankingQuery EXCLUDES the placeholder,
   * so it cannot reach bookFacilities in production at all (asserted separately, below). These deps
   * inject the row directly, bypassing SQL, so this stays a live test of the JOIN's own invariant
   * rather than of the WHERE clause upstream of it — defence in depth, so the annotation cannot start
   * fabricating a place if that clause is ever loosened.
   *
   * S3 puts "Seen here before — N claim lines" on annotated rows, and that sentence asserts a PLACE
   * the member was treated. There is no such place here.
   *
   * SUPPRESSED AT THE JOIN, not at the chip, so the TIEBREAK goes with it: an annotation that
   * silently floated the placeholder above a real facility at equal footing would be the same
   * fabricated claim expressed as an ordering instead of as words. */
  const { deps: d } = recordingDeps([NO_FACILITY, STRONG], [NO_FACILITY, STRONG]);
  const book = await getQualifySnapshotCore(d, PREFIX_IN);
  const placeholder = book.bookFacilities!.find((f) => f.name === 'No Facility')!;
  assert.equal(placeholder.memberHistory, null, 'the placeholder carries no personal claim');
  // The positive control on the SAME render: a real facility the member billed still gets its mark,
  // so the absence above is a property of the placeholder and not of a broken join.
  assert.deepEqual(book.bookFacilities!.find((f) => f.name === 'STRONG HOUSE')!.memberHistory, {
    lineCount: 120,
    distinctPatients: 22,
  });
  // And it is NOT REACHABLE FROM SQL — the entity-surface half of the 2026-08-12 ruling.
  //
  // ⚠ THIS ASSERTION WAS REVERSED, DELIBERATELY. It used to read
  //   assert.ok(namesOf(book.bookFacilities).includes('No Facility'), 'the bucket keeps its place …')
  // which encoded the SUPERSEDED "keeps its own row everywhere" rule. The ruling now splits by role:
  // denominators keep the placeholder (buildBookKpisQuery and buildRatingHistoryAggQuery still carry
  // it, so no money is hidden) and entity surfaces suppress it. bookFacilities is an entity surface —
  // its rows are ranked, named and drilled into — so the ranking query excludes the placeholder and
  // it can no longer appear here. Asserting the OLD expectation would have stayed green forever on
  // injected fixtures while production had already stopped producing it.
  assert.match(
    buildFacilityRankingQuery('AETNA', '2026-05-11', '2026-08-10', [BXR_ENTITY_ID, INDIGO_ENTITY_ID]).sql,
    /and facility <> \$\d+/,
    'the ranking query excludes the placeholder, so it cannot reach bookFacilities from SQL',
  );
});

test('S3 M4 — the by-NAME path carries no annotation either (the test that used to claim four paths)', async () => {
  // The previous version of this claim exercised two of the four it named. The by-name core is
  // identifier-shaped and floorless like the direct path, so "does it annotate" is a real question
  // there rather than a formality — it does not, because it loads no book to annotate.
  const snap = await getQualifySnapshotByNameCore(deps(), {
    name: 'ACME BEHAVIORAL',
    window: { kind: 'trailing', days: 30 },
  });
  assert.equal(snap.bookFacilities, null, 'no book on the name path');
  for (const f of snap.facilities) assert.equal(f.memberHistory, null);
});
