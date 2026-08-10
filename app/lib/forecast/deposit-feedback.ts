/**
 * WHAT A REFUSED MANUAL DEPOSIT TELLS THE OPERATOR.
 *
 * Extracted from `overview-kpis.tsx` (0098, 2026-08-10) for one concrete reason: it could not be
 * tested where it lived. That component transitively imports `app/lib/actions.ts` →
 * `app/lib/access.ts`, which calls React's `cache` at module scope, so any hermetic test that
 * imported the component died on load. A money-write's error copy is not something to leave
 * eyeball-verified — see `deposit-error-text.test.tsx`.
 *
 * PURE. No React, nothing server-only, relative imports — so it loads under `tsx` in the test.
 *
 * ── THE RULE THESE STRINGS FOLLOW ──────────────────────────────────────────────────────────────
 * Every code below is either "nothing happened, here is what to fix" or "already recorded, here is
 * where it is". Only `write_failed` may claim an unknown outcome, because it is the only one where
 * the outcome genuinely is unknown — an exception escaped after the write may or may not have
 * landed.
 *
 * That distinction is load-bearing rather than stylistic. "That may not have been saved, reopen
 * this panel to check" invites a retry, and the deposit path has no idempotency key: the conflict
 * key is (tenant, facility, day), so a retry is indistinguishable from a genuine second payment.
 * `bad_facility` and `bad_method` used to fall through to that wording despite being rejected
 * before anything was written — that is the defect this module's test now prevents from returning.
 *
 * ⚠ KNOWN DUPLICATION, DELIBERATELY LEFT: six of these codes also appear in `REASON` in
 * ./edit-feedback.ts, one (`bad_amount`) byte-identical. Folding them into one lookup is the right
 * end state and is NOT done here — the two surfaces need different nouns ("record payments" vs
 * "change future payments", "date received" vs "expected date"), and unifying them properly means
 * a `reasonText(code, overrides)` seam that is its own change. Kept as a follow-up rather than
 * half-done, but do not add a SEVENTH copy: extend one of these two.
 */

/** The one message that claims an unknown outcome. Exported so the test can assert on identity
 *  rather than re-typing the sentence and drifting from it. */
export const DEPOSIT_UNKNOWN_OUTCOME =
  'That may not have been saved. Reopen this panel to check before trying again.';

export function depositErrorText(code: string): string {
  switch (code) {
    case 'forbidden':
      return 'You do not have permission to record payments.';
    case 'pick_a_tenant_view':
      return 'Switch to the BXR or Indigo view first — a payment has to name one company’s book.';
    case 'facility_not_in_tenant':
      return 'That facility is not in this view’s book. Switch to the view that owns it.';
    case 'facility_retired':
      // ⚠ REACHABLE. `addManualDeposit` calls `facilityIsActiveForEntity` and returns this. A review
      // round asserted the branch was dead, citing a "NO LIVENESS GUARD HERE" comment in actions.ts
      // that does not exist. `deposit-error-text.test.tsx` pins the reachability so the claim cannot
      // come back from memory and get this deleted.
      return 'That facility’s account is closed, so no payment can arrive for it.';
    case 'bad_amount':
      return 'Enter an amount in dollars, up to two decimals — e.g. 4200 or 4200.50.';
    case 'bad_date':
      return 'Enter the date received as a calendar date.';
    // Both are rejected BEFORE anything is written, so the unknown-outcome wording was false in the
    // one direction that costs money: it sends the operator to check, and an operator who checks,
    // sees nothing, and re-keys has recorded the deposit twice.
    case 'bad_facility':
      return 'Pick a facility from the list.';
    case 'bad_method':
      return 'Choose EFT or Check.';
    // A live manual deposit already holds this facility-day (SQLSTATE DP001, migration 0098). The
    // money IS recorded and retrying fails identically, so this points at the row rather than
    // inviting the retry that used to produce a bare 23505.
    case 'deposit_exists':
      return 'A payment is already recorded for that facility on that date — it is in the list below. To change the amount, remove it and record the combined total.';
    default:
      return DEPOSIT_UNKNOWN_OUTCOME;
  }
}
