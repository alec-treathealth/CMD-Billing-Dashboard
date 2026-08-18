/**
 * THE COLLECTIONS EMPLOYER SEGMENT — the pure decisions behind [All][Employer][Individual] and the
 * employer type-ahead beside it (2026-08-17).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * Two reasons, and the second is the load-bearing one:
 *
 *   1. The "which employer predicates go on the wire" decision was COPY-PASTED at three sites in
 *      cmd-explorer.tsx — the grid filter, the summary filter, and the cohort/refinement filter.
 *      Three copies of a two-line rule is three chances for them to drift, and a drift between the
 *      grid and the summary is the worst possible kind here: the numbers above the table would
 *      describe a different row set than the table, with nothing on screen saying so.
 *
 *   2. It is TESTABLE here and nowhere else. cmd-explorer.tsx transitively imports lib/actions.ts →
 *      lib/access.ts, which calls React `cache` at module scope and cannot be loaded by the test
 *      runner at all. Same constraint that put facilityPickerOptions.ts in this directory; same
 *      solution. PURE — no React, no server imports.
 *
 * ── THE SEGMENT IS A PARTITION; THE PICKER IS A NARROW ──────────────────────────────────────────
 * These are different questions and the UI used to conflate them:
 *
 *   · SEGMENT  — does this policy have a plan sponsor at all? `employer` = `employer_name is not
 *     null and <> ''`, `individual` = the exact complement. They partition the book: every row is in
 *     exactly one, and the two always sum to `all`. (The empty string is deliberate — mapRow coerces
 *     a blank CMD cell to null, but the 622k CSV-backfilled rows predate that path, so '' is a
 *     reachable state. See cmdExplorerQuery.ts.)
 *
 *   · PICKER   — which named employers? A narrow WITHIN whatever the segment left.
 *
 * Until 2026-08-17 the picker was mounted only while the segment was `employer`, so answering "show
 * me Tesla" required first answering a question the user had not been asked. It is now always
 * mounted and the narrow applies in `all` too.
 *
 * ⚠ INDIVIDUAL IS THE ONE CONTRADICTORY COMBINATION and is handled by CLEARING, not by silently
 * dropping the predicate. `individual` means "no plan sponsor" and a named employer IS a plan
 * sponsor, so the intersection is empty BY CONSTRUCTION — not empty as a data fact the user could
 * learn something from. A grid that just returned zero rows would look like an answer.
 */

import {
  expandEmployerKeys,
  type CanonicalEmployer,
} from '../../../src/collections/employerCanonical.js';

export type EmployerMode = 'all' | 'employer' | 'individual';

/** The employer-shaped fields of the explorer filter. Structural so all three call sites — which
 *  each build a differently-typed local filter object — can share one implementation. */
export interface EmployerFilterTarget {
  employerMode?: EmployerMode;
  employer_names?: string[];
}

/**
 * Write the employer predicates onto a filter being built. Mutates and returns `f` (every call site
 * is mid-construction of a local object literal, so mutation is the shape that fits).
 *
 * `all` emits NO `employerMode` key at all — an absent key and `'all'` mean the same thing to the
 * server, and omitting it keeps the wire payload byte-identical to what shipped before the segment
 * existed for the overwhelmingly common unfiltered case.
 */
export function applyEmployerFilter<T extends EmployerFilterTarget>(
  f: T,
  mode: EmployerMode,
  selection: readonly string[],
  vocabulary: readonly CanonicalEmployer[],
): T {
  if (mode !== 'all') f.employerMode = mode;
  if (mode !== 'individual' && selection.length > 0) {
    // ⚠ EXPAND, ALWAYS. `selection` holds CANONICAL KEYS ('TESLA'); the SQL predicate is
    // `employer_name = any(...)` against RAW spellings, and no row's employer_name is literally
    // 'TESLA' — they are 'TESLA INC', 'TESLA, INC.' and 'TESLA,INC.'. Sending the key unexpanded
    // would return an empty grid for every merged employer, which is worse than the bug this
    // canonical layer was built to fix.
    f.employer_names = expandEmployerKeys(selection, vocabulary);
  }
  return f;
}

/**
 * Should switching TO this segment discard the picked employers?
 *
 * Only Individual. It used to be every switch, which was correct while the picker was mounted only
 * in the Employer segment — a selection surviving a move to All was then invisible, and an invisible
 * filter is one the user cannot trust. Now that the picker is always on screen the selection is
 * always visible, so clearing on an All⇄Employer toggle would destroy work the user can see.
 */
export function clearsEmployerSelection(next: EmployerMode): boolean {
  return next === 'individual';
}

/**
 * The segment a pick should land in. Picking a named employer while sitting in Individual is
 * contradictory, so the pick moves the segment to Employer rather than producing an empty grid.
 * Everything else is left alone — this must never drag `all` to `employer`, because narrowing by
 * name inside "no restriction" is exactly the combination the 2026-08-17 change enables.
 */
export function modeAfterEmployerPick(current: EmployerMode): EmployerMode {
  return current === 'individual' ? 'employer' : current;
}

/** Individual makes a named-employer narrow meaningless, so the picker goes inert there — DISABLED,
 *  never unmounted (unmounting is the flex reflow the change removed; see the JSX note). */
export function employerPickerDisabled(mode: EmployerMode): boolean {
  return mode === 'individual';
}
