/**
 * WHAT THE SCREEN CALLS THE SCOPE IT IS SHOWING. One home, because three surfaces make the same
 * claim and three phrasings of one claim is how they drift apart.
 *
 * PURE — no I/O, no PHI, no server import. It lives here rather than beside either of its callers so
 * that both can have it: `resolution-flow.tsx` (the v3 answer stage) and `qualify-ai-panel.tsx` (the
 * explainer header). The panel imports a `'use server'` action chain, which makes it unimportable
 * from a hermetic test — so a scope claim that lived in that file could never be pinned. It is
 * pinned here instead (app/test/qualifyScopeClaim.test.tsx).
 *
 * Background: `QualifyResolved.payerName` went nullable on 2026-08-07 when the v3 Skip started
 * ranking an identifier's WHOLE claims footprint rather than its dominant billed-under label. See
 * `QualifyResolved` in ./contract for why that nullability is deliberate and load-bearing.
 */
import type { QualifySnapshot } from './contract';

/** The name for a ranking scoped to no single billed-under label. */
export const ALL_PAYERS_LABEL = 'All payers on file';

/**
 * What the AI explainer's header lines call the scope they are answering over.
 *
 * ⚠ THE OLD EXPRESSION WAS `resolved?.payerName ?? policy?.carrier ?? 'This search'`, AND THE MIDDLE
 * RUNG IS A TRAP NOW. With an all-payers ranking `payerName` is null, so the chain fell through to
 * the VOB CARRIER — labelling a ranking that spans every billed-under label with ONE carrier's name.
 * That is a narrower claim than the data supports, and an outright wrong one whenever the member
 * bills under carriers the VOB does not name. All-payers therefore gets its own branch ABOVE the
 * chain, never a rung inside it.
 *
 * `casing` exists only because one call site sits mid-sentence.
 */
export function aiScopeLabel(snap: QualifySnapshot, casing: 'upper' | 'lower' = 'upper'): string {
  if (snap.resolved?.payerScope === 'all') {
    return casing === 'upper' ? ALL_PAYERS_LABEL : ALL_PAYERS_LABEL.toLowerCase();
  }
  const named = snap.resolved?.payerName ?? snap.policy?.carrier ?? null;
  if (named !== null) return named;
  return casing === 'upper' ? 'This search' : 'this search';
}
