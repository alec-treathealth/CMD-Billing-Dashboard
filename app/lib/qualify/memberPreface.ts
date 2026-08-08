/**
 * THE PREFACE — the engine says which world it is in before it claims anything.
 *
 * Measured 2026-08-08 (.superpowers/sdd/qualify-search-tree.md §M2): a member-ID prefix resolves to
 * exactly ONE member 58.8% of the time, to 2-9 members another 37.0%, and to 10+ only 4.2%. Those
 * are three genuinely different questions wearing one screen, and until S2 the surface answered all
 * three identically — with a "ranking" over an average of 1.14 facilities in the majority case.
 *
 * ONE `count(distinct member_id_bidx)` over the token classifies the search before anything renders.
 * The ladder query has always computed it (`p365`); it simply threw it away on every path except an
 * auto prefix search. `QualifySnapshot.memberCount` now carries it for every token kind, and these
 * two pure functions turn it into the one sentence the operator reads.
 *
 * PURE and client-safe: no React, no `'use server'` chain, relative imports only — the `bedState.ts`
 * precedent from S1, and for the same reason (the copy, the aria announcement and the receipt must
 * all read ONE derivation, or the visible and the spoken claim drift).
 *
 * NON-PHI: a count of members is a count. Nothing member-identifying is expressible here.
 */

/**
 * WHICH WORLD THIS SEARCH IS IN.
 *
 * ⚠ `unknown` AND `none` ARE DIFFERENT AND MUST STAY SO. `unknown` (a null count) means the engine
 * could not classify — the rungs loader is absent, or it failed soft, and the ladder's existing
 * fail-soft behaviour is unchanged. `none` (zero) means the count RAN and nobody with claims sits
 * behind this token, which is the comparable/VOB-provenance case the banner already describes.
 * Collapsing them would let a failed query render as a factual claim about a member.
 */
export type QualifyMemberBucket = 'unknown' | 'none' | 'one' | 'few' | 'many';

export function memberBucketOf(memberCount: number | null): QualifyMemberBucket {
  if (memberCount === null) return 'unknown';
  if (memberCount <= 0) return 'none';
  if (memberCount === 1) return 'one';
  // 2-9. The 10-patient confidence floor (QUALIFY_RATING_CONFIDENT_PATIENTS) is unreachable for
  // every prefix in this bucket at EVERY window — measured: 85.7% of prefixes have <=9 members in
  // total — so the auto-window ladder can only ever report that it had no choice.
  if (memberCount <= 9) return 'few';
  // 10+. The ONLY bucket where the ladder means anything and where a payer blend is routine
  // (3.3-3.7 payers measured), i.e. the only bucket the Simpson's disclosure was written for.
  return 'many';
}

/**
 * THE SENTENCE, or silence.
 *
 * ⚠ TWO NUMBERS, TWO WINDOWS, AND BOTH ARE NAMED (fix round 1, 2026-08-08). The two counts this
 * function joins are measured on DIFFERENT bases, and the first version of this copy hid that
 * behind an em-dash:
 *
 *   · `memberCount` is always the ladder's 365-day rung, and it is `count(distinct member_id_bidx)`
 *     filtered on `payment_received` — so it means "members with a PAID CLAIM in the last 12
 *     months", not "members who exist". It does not follow the chosen window ON PURPOSE: "is this a
 *     person or a population" is a fact about the identifier, and a classifier that moved when an
 *     operator pressed a Range chip would be telling them the answer depends on the window.
 *   · `facilityCount` is the facilities on screen in the CHOSEN window.
 *
 * Joined without labels those made one mixed-basis claim, and the contradiction was reachable, not
 * theoretical: a 30-day window on a member last paid 200 days ago rendered "One member matches this
 * search — 0 facilities of history." beside an empty grid. Each clause now carries its own window,
 * so the pair reads as what it is — paid inside the year, nothing inside the window shown.
 *
 * The DESIGN did not change and should not: fixing this in SQL (an unbounded count) would make the
 * classifier drift with the window and cost a second aggregate. The fix is copy that states its own
 * basis.
 *
 * `facilityCount` is passed in rather than re-derived, so the visible line, the receipt and the aria
 * announcement cannot print three different numbers for one fact.
 *
 * ⚠ COPY IS UNRATIFIED (flagged for Alec). Plain on purpose.
 *
 * "prefix" in the 2-9 and 10+ sentences is safe for every reachable input: an exact member-id token
 * counts `distinct member_id_bidx` where `member_id_bidx = token`, which is 0 or 1 by construction,
 * so only the `one` and `none` arms are reachable on that kind.
 */
export function memberPrefaceFor(memberCount: number | null, facilityCount: number): string | null {
  switch (memberBucketOf(memberCount)) {
    case 'one':
      // The 58.8% case. NOT "their top facility" — with 1.14 facilities of history a ranking is not
      // thin, it is malformed, so the sentence states the size of the evidence and nothing more.
      return (
        'One member has a paid claim behind this search in the last 12 months' +
        ` — ${facilityCount} ${facilityCount === 1 ? 'facility' : 'facilities'} of history in the window shown.`
      );
    case 'few':
      // "Continue" names the control that already exists (Skip = search across all of them). A
      // member-by-member pick is DESCOPED: raw member ids can never render, so picking one needs a
      // server-side per-response ordinal enumeration (the assembleClaims patientKey precedent) plus
      // a pick-by-ordinal predicate. Recorded as a follow-up; deliberately not built.
      return (
        `${memberCount} members have a paid claim behind this prefix in the last 12 months.` +
        ' Continue to search across all of them, or refine the prefix.'
      );
    case 'many':
      return `A population — ${memberCount} members have a paid claim behind this prefix in the last 12 months.`;
    // 'unknown' says nothing NEW — the rest of the screen is unchanged, which is the honest degrade.
    // 'none' says nothing either: there is no member history to describe, and the provenance banner
    // above the ranking already states that in its own words.
    default:
      return null;
  }
}

/**
 * DOES THE PREFACE ITSELF NAME A FACILITY COUNT?
 *
 * Only the one-member arm does. It exists so `liveSentenceFor` can decide whether the preface
 * COLLIDES with the resolution's own `distinctFacilities` clause (in which case the preface, whose
 * number is the one on screen, replaces it) or merely adds to it (in which case dropping the
 * existing clause would leave a screen-reader user with no facility count at all, while the sighted
 * reader has a grid full of them).
 *
 * A named predicate rather than an inline `=== 'one'` because it encodes WHY, and because the answer
 * changes the moment the 2-9 or 10+ copy grows a facility clause of its own.
 */
export function prefaceNamesFacilityCount(memberCount: number | null): boolean {
  return memberBucketOf(memberCount) === 'one';
}

/**
 * THE MARK ON A BOOK CARD — "has the searched identifier been here?" (S3, 2026-08-08).
 *
 * The other half of Alec's ruling: the book ranks, and this is the annotation. It lives beside the
 * bucket rather than in the render, because the SENTENCE depends on the bucket and getting that
 * wrong is a claim about people:
 *
 *   · ONE member — "Seen here before" is exactly, personally true, and it is the fact that decides
 *     placements (continuity, the facility knows them, prior-auth precedent).
 *   · 2-9 (and any other bucket where the book still renders, secondary) — the same join, but the
 *     lines belong to SEVERAL DIFFERENT PEOPLE. "Seen here before" would tell a rep one patient has
 *     a relationship with a facility when what the data says is that some of four do. So the copy
 *     talks about the SEARCH instead of about a person.
 *
 * ⚠ EVERY COUNT NAMES ITS BASIS, the discipline S2's preface fix established. These lines are the
 * CHOSEN window (they come from the same rows the grid was ranked on), so the string says "in this
 * window" — never the 12-month basis `memberCount` carries.
 *
 * ⚠ COPY IS UNRATIFIED (flagged for Alec).
 *
 * Null when there is no annotation, so the render site has no second null rule of its own.
 */
export function memberHistoryChipFor(
  memberCount: number | null,
  /** `undefined` is accepted and treated as "no annotation" — see the coercion note in the body. */
  history: { lineCount: number } | null | undefined,
): string | null {
  /* ⚠ `== null`, NOT `=== null`, AND FOR THE SAME REASON `bookIsOnScreen` CARRIES `?? null`. The
   * contract declares `memberHistory` required, but any snapshot serialized before the field existed
   * carries it ABSENT — and `undefined === null` is false, so a strict check would fall through and
   * read `.lineCount` off nothing. The absent-vs-null distinction has now bitten this surface twice;
   * this is the boundary guard, not a widening of the contract. */
  if (history == null) return null;
  const lines = `${history.lineCount.toLocaleString('en-US')} claim line${history.lineCount === 1 ? '' : 's'}`;
  // 'unknown' and 'none' fall to the impersonal arm: an unclassified search must not be narrated as
  // a person, and a zero count cannot be — but the JOIN still happened, so the lines are real and
  // saying nothing about them would drop evidence that is on the screen's own rows.
  return memberBucketOf(memberCount) === 'one'
    ? `Seen here before — ${lines} in this window`
    : `This search has ${lines} here in this window`;
}
