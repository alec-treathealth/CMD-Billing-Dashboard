/**
 * THE COLLECTIONS EMPLOYER NARROW — how picked employers reach the wire.
 *
 * ── THE SEGMENT IS GONE (2026-08-18, Alec) ─────────────────────────────────────────────────────
 * This file used to model an [All][Employer][Individual] segmented control alongside the picker.
 * It was removed because it asked the user to answer a question they had already answered:
 *
 *   · picking a named employer already means "an employer-sponsored policy" — there is nothing for
 *     an `Employer` segment to add;
 *   · picking nothing already means "no restriction" — that is `All`;
 *   · `Individual` (rows with no plan sponsor) is legible in the Employer cell itself, so the
 *     segment made the user state a filter they could simply read.
 *
 * ⚠ REMOVING IT ALSO FIXED A REAL BUG, which is why this note is long. The segment's last teeth
 * were server-side, in `applyEmployerFilter` (app/lib/actions.ts): it gated the names on
 * `employerMode === 'employer'`. When the picker was made always-available on 2026-08-17, the client
 * began sending `employer_names` while sitting in `all` — and the server silently dropped them. The
 * chips rendered, the grid ignored them, and nothing errored. A client-side test could not catch it
 * because the client was correct; the gate was on the other side of the wire.
 *
 * The lesson worth keeping: when a filter is applied on BOTH sides of a Server Action, removing the
 * client's copy of a guard does not remove the guard.
 *
 * ── WHY THIS FILE STILL EXISTS ─────────────────────────────────────────────────────────────────
 * The expansion below is shared by three call sites in cmd-explorer.tsx — the grid filter, the
 * summary filter and the cohort/refinement filter. Three copies of it is three chances for them to
 * drift, and a drift between the grid and the summary is the worst kind here: the totals above the
 * table would describe a different row set than the table, with nothing on screen saying so.
 *
 * It is also testable HERE and nowhere else — cmd-explorer.tsx transitively imports lib/actions.ts →
 * lib/access.ts, which calls React `cache` at module scope and cannot be loaded by the test runner.
 * PURE: no React, no server imports.
 */
import {
  expandEmployerKeys,
  type CanonicalEmployer,
} from '../../../src/collections/employerCanonical.js';

/** The employer-shaped field of the explorer filter. Structural so all three call sites — which each
 *  build a differently-typed local filter object — can share one implementation. */
export interface EmployerFilterTarget {
  employer_names?: string[];
}

/**
 * Write the employer predicate onto a filter being built. Mutates and returns `f` (every call site
 * is mid-construction of a local object literal, so mutation is the shape that fits).
 *
 * An empty selection emits NO key at all, keeping the unfiltered payload — overwhelmingly the common
 * case — byte-identical to what shipped before the employer filter existed.
 */
export function applyEmployerFilter<T extends EmployerFilterTarget>(
  f: T,
  selection: readonly string[],
  vocabulary: readonly CanonicalEmployer[],
): T {
  if (selection.length > 0) {
    // ⚠ EXPAND, ALWAYS. `selection` holds CANONICAL KEYS ('TESLA'); the SQL predicate is
    // `employer_name = any(...)` against RAW spellings, and no row's employer_name is literally
    // 'TESLA' — they are 'TESLA INC', 'TESLA, INC.' and 'TESLA,INC.'. Sending the key unexpanded
    // would return an empty grid for every merged employer.
    f.employer_names = expandEmployerKeys(selection, vocabulary);
  }
  return f;
}
