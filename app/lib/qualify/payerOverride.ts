/**
 * Qualify PAYER DRILL-DOWN state rule — pure, so the one invariant that matters is testable without
 * a DOM.
 *
 * THE INVARIANT: a payer drill-down belongs to the identifier it was chosen for, and to no other.
 *
 * The first implementation expressed that with an effect — `useEffect(() => setPayerOverride(null),
 * [singleIdentifier])` — and it did not hold. Effects run AFTER the commit, so on the render where
 * the identifier changes the snapshot-fetch effect in the SAME commit still closes over the previous
 * override and sends it. Declaring the reset effect first does not help: `setState` only schedules.
 *
 * That produced four failures, and only the first is obvious:
 *   1. the first fetch for a NEW patient was scoped to the PREVIOUS patient's payer — and the server
 *      honours an override that matches the new identifier's own spread, so a common carrier name
 *      like AETNA is not rejected, it is silently applied;
 *   2. a second, redundant fetch once the state settled;
 *   3. a DUPLICATE audit row — getQualifySnapshotCore calls recordAccess before any data load, so
 *      one user action wrote two SEARCH_QUALIFY_PHI entries into a compliance log;
 *   4. the auto-window ladder was discarded: `auto` is consumed synchronously from a ref, so the
 *      first fetch is the auto one and the second is not, and the first fetch's result loses the
 *      generation guard — setWindowSel never ran and the window stopped auto-widening.
 *
 * Pairing the payer WITH its identifier makes the stale state unrepresentable instead of
 * racing to clear it: the derivation below is evaluated during render, so the effective override is
 * already null on the very render the identifier changes. No reset effect, no extra render, and
 * therefore none of the four failures above.
 */

/** A payer drill-down and the identifier it was chosen for. Never store the payer alone. */
export interface QualifyPayerOverride {
  /** The `singleIdentifier` value in effect when the user picked this payer. */
  identifier: string;
  /** A plaintext primary_payer label (non-PHI). Still re-validated server-side against the
   *  identifier's own payer spread — this pairing is a UI lifetime rule, not an authorization. */
  payer: string;
}

/**
 * The override that actually applies to `identifier`, or null.
 *
 * Null whenever the stored override belongs to a different identifier, which is exactly the
 * search-transition case. A stale entry is left in state deliberately rather than cleared — it is
 * inert here, and clearing it would cost the extra render this function exists to avoid.
 */
export function effectivePayerOverride(
  stored: QualifyPayerOverride | null,
  identifier: string | null,
): string | null {
  if (stored === null || identifier === null || identifier === '') return null;
  return stored.identifier === identifier ? stored.payer : null;
}
