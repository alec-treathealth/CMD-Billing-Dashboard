'use server';

/**
 * Qualify BOARD Server Actions — the read edge for the smoke-shell dashboard's right pane.
 *
 * ⚠ 'use server' RULES (test/useServerExports.test.ts enforces): ONLY async functions may be
 * exported from this file — a non-function export registers as a Server Action and 500s EVERY
 * action on the page, unlogged (the v3FlowState.ts incident). Types and the DI core live in
 * ./board (a plain module); this file is the thin binder, exactly like actions.ts is for core.ts.
 *
 * Deliberately SEPARATE from actions.ts: the search rewrite owns that file's future, and the board
 * must land without touching it (see board.ts's header). Same conventions apply — gate-first
 * (requireQualifyPrincipal, fail-closed), non-dollar payload, the optional-panel
 * `{ ok:true } | { ok:false }` fail-closed union so a board failure degrades to an empty lane and
 * never takes the page down.
 *
 * PHI: nothing PHI-shaped crosses here — tape items are (token, echo, payer label, ratings,
 * counts). No audit, matching the movers/KPIs/trends gate-only posture for non-PHI aggregates.
 */
import { requireQualifyPrincipal } from './gate';
import { loadQualifyPolicyTape } from './loaders';
import { getQualifyPolicyTapeCore, type QualifyPolicyTapeResult } from './board';
import { QUALIFY_TAPE_DELTA_DAYS } from '../../../src/collections/qualifyRatingHistory';

export type QualifyPolicyTapeActionResult = { ok: true; tape: QualifyPolicyTapeResult } | { ok: false };

/**
 * The trending-policies tape: top movers by |90d rating delta| across the book, latest nightly
 * snapshot (yesterday's close) vs 90 days earlier. `tape.available:false` (inside ok:true) means
 * mig 0093 is UNAPPLIED; an applied-but-not-yet-snapshotted table reads available:true with empty
 * items (see QualifyPolicyTapeResult.available). `{ ok:false }` means the read itself failed.
 */
export async function getQualifyPolicyTape(): Promise<QualifyPolicyTapeActionResult> {
  try {
    const tape = await getQualifyPolicyTapeCore({
      requirePrincipal: requireQualifyPrincipal,
      loadTape: loadQualifyPolicyTape,
      deltaDays: QUALIFY_TAPE_DELTA_DAYS,
    });
    return { ok: true, tape };
  } catch (err) {
    // Fail-closed and generic — the cause (gate denial or DB error) is server-side only.
    console.error('qualify board tape failed:', err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}
