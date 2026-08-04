/**
 * WHAT THE MATCH COUNT IS ALLOWED TO SAY — the settled-zero predicate.
 *
 * Three inputs, three genuinely different answers, and the surface must not blur them:
 *   loading  → "we have not asked yet / are still asking"
 *   error    → "we could not count"
 *   count 0  → "nothing matches"
 * The readout bar can afford to show a stale number with an "updating…" chip beside it, because the chip
 * says so. A CATEGORICAL SENTENCE cannot: "no charge lines match this search" is a claim, and a claim has
 * to wait for its answer.
 *
 * The bug this exists to prevent (Qodo review of PR #100, 2026-08-04): the compose effect deliberately
 * does NOT clear `summary` on a filter or window change — it keeps the previous result visible and marks
 * the readout updating. So mid-fetch `summary` holds the PRIOR search's count, and a predicate that only
 * checked `count === 0` kept asserting "no charge lines match" over a new search that had not been
 * answered yet. Worse on a window change: the banner's copy prints the window label, which updates
 * synchronously, so the old window's zero rendered under the new window's name. That is precisely the
 * defect this surface's honesty rules exist to stop — a statement about a population the screen is not
 * describing — reached through a loading state rather than through a scope mismatch.
 *
 * Pure, non-dollar, role-independent: a count and two flags.
 */
export interface QualifyMatchStateInput {
  /** A count fetch is in flight (including the debounce window before it starts). */
  loading: boolean;
  /** The count fetch FAILED. Distinct from zero: "could not count" and "nothing matches" send a rep in
   *  opposite directions. */
  error: boolean;
  /** The last count that landed, or null when none has. */
  count: number | null;
}

/**
 * True ONLY when zero is the actual, current answer — safe to state in prose. False while loading, on a
 * failure, before any count has landed, and for any positive count.
 */
export function settledNoMatches({ loading, error, count }: QualifyMatchStateInput): boolean {
  if (loading || error) return false;
  return count === 0;
}
