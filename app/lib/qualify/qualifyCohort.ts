/**
 * Qualify cases-panel COHORT STATE — the single atomic object describing WHICH cases the drill shows, plus a
 * pure reducer that owns every transition. Colocated with the contract/core (the pure Qualify logic lives
 * here). No React, no async — unit-tested directly in the root suite.
 *
 * IDENTITY = (payer, facility, window) — NOTHING ELSE. Two prior fields are GONE:
 *   - the in-panel prefix + group narrows (ruling: the main top-bar search is the ONE identifier entry;
 *     the panel is a PURE display of the landed facility);
 *   - the keyset PAGER (page + cursors[]): the facility drill now returns the WHOLE (facility, payer, window)
 *     set in one shot (bounded, capped at QUALIFY_CASES_MAX), grouped by patient — there is no page to track.
 * The reducer's remaining job is the identity transitions + the cohortKey the async-landing guard compares
 * (a facility/window change under an in-flight fetch must be caught). CHANGE_WINDOW keeps the facility — a
 * window change is the same selection re-fetched, NOT a teleport back to rank-1.
 */
import type { QualifyWindowDays } from './contract';

/** The cases panel's full cohort identity. */
export interface QualifyCohort {
  /** Resolved payer label. null before the first resolve, or after an unresolved search. */
  payer: string | null;
  /** Selected facility key (raw rollup text = QualifyFacility.facilityKey). null = none selected. */
  facility: string | null;
  window: QualifyWindowDays;
}

export type QualifyCohortAction =
  /** A payer resolved (search / chip / on-load) — a brand-new cohort. `facility` is the auto-selected
   *  landing (Fix A) or rank-1, or null when the payer resolved with no facilities / unresolved. */
  | { type: 'RESOLVE_PAYER'; payer: string | null; facility: string | null; window: QualifyWindowDays }
  /** Facility drill within the SAME payer. Keeps payer + window. */
  | { type: 'SWITCH_FACILITY'; facility: string }
  /** Window change on the SAME payer + facility. Keeps facility (no rank-1 teleport). */
  | { type: 'CHANGE_WINDOW'; window: QualifyWindowDays };

/** The default cohort — nothing resolved yet, window at the product default (QUALIFY_WINDOW_OPTIONS[0]). */
export const INITIAL_COHORT: QualifyCohort = {
  payer: null,
  facility: null,
  window: 30,
};

/**
 * The cohort's FETCH IDENTITY — payer|facility|window. Stamp a cases fetch with this at issue; if it
 * no longer equals the current cohort's key when the response lands, the cohort changed under us and the
 * write is a stale wrong-cohort landing → discard it. The cohort analog of the genRef recency guard.
 * JSON-encoded (not a delimiter join) so a payer/facility label containing spaces or pipes can't forge a
 * key collision.
 */
export function cohortKey(c: QualifyCohort): string {
  return JSON.stringify([c.payer, c.facility, c.window]);
}

export function cohortReducer(state: QualifyCohort, action: QualifyCohortAction): QualifyCohort {
  switch (action.type) {
    case 'RESOLVE_PAYER':
      // New cohort: set payer/facility/window.
      return { ...state, payer: action.payer, facility: action.facility, window: action.window };
    case 'SWITCH_FACILITY':
      // Same payer, new facility: keep window.
      return { ...state, facility: action.facility };
    case 'CHANGE_WINDOW':
      // Same payer + facility: keep facility (no rank-1 teleport), set window.
      return { ...state, window: action.window };
    default:
      return state;
  }
}
