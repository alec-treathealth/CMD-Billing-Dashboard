/**
 * Qualify cases-panel COHORT STATE — the single atomic object describing WHICH cases the desktop tab shows,
 * plus a pure reducer that owns every transition. Colocated with the contract/core (the pure Qualify logic
 * lives here). No React, no async — unit-tested directly in the root suite.
 *
 * WHY a reducer. The cases panel's "reset to page 0 on any cohort change" rule was previously enforced by
 * remembering to call setPage(0)/setCursors([null]) in every handler — easy to forget, and impossible to
 * exercise in the static render harness. Folding payer/facility/window/prefix/page/cursors into ONE object
 * and routing every change through cohortReducer makes the reset STRUCTURAL: every action except
 * PAGE_NEXT/PAGE_PREV returns a fresh page:0 / cursors:[null], so a handler cannot forget. The persistence
 * rules live in one place too:
 *   - RESOLVE_PAYER is the ONLY action that clears the prefix (a brand-new cohort).
 *   - CHANGE_WINDOW keeps the facility AND the prefix — a window change is the same selection re-fetched for
 *     a new window, NOT a teleport back to rank-1.
 */
import type { QualifyWindowDays, QualifyCasesCursor } from './contract';

/** The cases panel's full cohort identity + the keyset cursor stack that walks it. */
export interface QualifyCohort {
  /** Resolved payer label. null before the first resolve, or after an unresolved search. */
  payer: string | null;
  /** Selected facility key (raw rollup text = QualifyFacility.facilityKey). null = none selected. */
  facility: string | null;
  window: QualifyWindowDays;
  /** APPLIED member-ID prefix narrow (STARTS-WITH). '' = no narrow. Cleared ONLY by RESOLVE_PAYER. */
  prefix: string;
  /** 0-based page index into the cursor stack. */
  page: number;
  /** cursors[p] = the keyset cursor that fetches page p; cursors[0] is always null (the first page). */
  cursors: (QualifyCasesCursor | null)[];
}

export type QualifyCohortAction =
  /** A payer resolved (search / chip / on-load) — a brand-new cohort. Clears the prefix. `facility` is the
   *  auto-selected rank-1, or null when the payer resolved with no facilities / the search was unresolved. */
  | { type: 'RESOLVE_PAYER'; payer: string | null; facility: string | null; window: QualifyWindowDays }
  /** Facility drill within the SAME payer. Keeps payer + window + prefix. */
  | { type: 'SWITCH_FACILITY'; facility: string }
  /** Window change on the SAME payer + facility. Keeps facility + prefix (no rank-1 teleport). */
  | { type: 'CHANGE_WINDOW'; window: QualifyWindowDays }
  /** Apply a new prefix narrow (explicit Enter). Keeps payer + facility + window. */
  | { type: 'CHANGE_PREFIX'; prefix: string }
  /** Pager forward: advance one page, pushing the cursor that fetches it. The only step that grows the stack. */
  | { type: 'PAGE_NEXT'; nextCursor: QualifyCasesCursor | null }
  /** Pager back: step back one page in the SAME stack (the target page's cursor is already stored). */
  | { type: 'PAGE_PREV' };

/** The default cohort — nothing resolved yet, window at the product default (QUALIFY_WINDOW_OPTIONS[0]). */
export const INITIAL_COHORT: QualifyCohort = {
  payer: null,
  facility: null,
  window: 30,
  prefix: '',
  page: 0,
  cursors: [null],
};

/** The structural invariant: ANY cohort-identity change returns to page 0 with a single-null cursor stack.
 *  Applied by every action except PAGE_NEXT/PAGE_PREV, so no handler can forget to reset the pager. A fresh
 *  array each call — no two cohorts ever share a cursors reference. */
function resetPaging(base: QualifyCohort): QualifyCohort {
  return { ...base, page: 0, cursors: [null] };
}

/**
 * The cohort's FETCH IDENTITY — payer|facility|window|prefix. Stamp a cases fetch with this at issue; if it
 * no longer equals the current cohort's key when the response lands, the cohort changed under us and the
 * write is a stale wrong-cohort landing → discard it. The cohort analog of the genRef recency guard. `page`
 * is deliberately EXCLUDED: page races are caught by genRef's monotonic bump, not by identity. JSON-encoded
 * (not a delimiter join) so a payer/facility label containing spaces or pipes can't forge a key collision.
 */
export function cohortKey(c: QualifyCohort): string {
  return JSON.stringify([c.payer, c.facility, c.window, c.prefix]);
}

export function cohortReducer(state: QualifyCohort, action: QualifyCohortAction): QualifyCohort {
  switch (action.type) {
    case 'RESOLVE_PAYER':
      // New cohort: set payer/facility/window, CLEAR the prefix (the only action that does), reset paging.
      return resetPaging({
        ...state,
        payer: action.payer,
        facility: action.facility,
        window: action.window,
        prefix: '',
      });
    case 'SWITCH_FACILITY':
      // Same payer, new facility: keep window + prefix, reset paging.
      return resetPaging({ ...state, facility: action.facility });
    case 'CHANGE_WINDOW':
      // Same payer + facility: keep facility + prefix (no rank-1 teleport), set window, reset paging.
      return resetPaging({ ...state, window: action.window });
    case 'CHANGE_PREFIX':
      // Same payer + facility + window: set the applied prefix, reset paging.
      return resetPaging({ ...state, prefix: action.prefix });
    case 'PAGE_NEXT': {
      // Forward one page; record the cursor that fetches it (= the prior page's nextCursor). Stack preserved.
      const page = state.page + 1;
      const cursors = state.cursors.slice();
      cursors[page] = action.nextCursor;
      return { ...state, page, cursors };
    }
    case 'PAGE_PREV':
      // Back one page; the target page's cursor is already in the stack. Never below page 0.
      return { ...state, page: Math.max(0, state.page - 1) };
    default:
      return state;
  }
}
