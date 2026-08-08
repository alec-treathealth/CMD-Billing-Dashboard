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
 * `facilityCount` is the count of the facilities ACTUALLY ON SCREEN in the member ranking, passed in
 * rather than re-derived, so the visible line, the receipt and the aria announcement cannot print
 * three different numbers for one fact.
 *
 * ⚠ COPY IS UNRATIFIED (S2, flagged for Alec). Plain on purpose.
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
      return `One member matches this search — ${facilityCount} ${facilityCount === 1 ? 'facility' : 'facilities'} of history.`;
    case 'few':
      // "Continue" names the control that already exists (Skip = search across all of them). A
      // member-by-member pick is DESCOPED: raw member ids can never render, so picking one needs a
      // server-side per-response ordinal enumeration (the assembleClaims patientKey precedent) plus
      // a pick-by-ordinal predicate. Recorded as a follow-up; deliberately not built.
      return `${memberCount} members share this prefix. Continue to search across all of them, or refine the prefix.`;
    case 'many':
      return `A population — ${memberCount} members behind this prefix.`;
    // 'unknown' says nothing NEW — the rest of the screen is unchanged, which is the honest degrade.
    // 'none' says nothing either: there is no member history to describe, and the provenance banner
    // above the ranking already states that in its own words.
    default:
      return null;
  }
}
