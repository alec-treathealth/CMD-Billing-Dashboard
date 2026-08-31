/**
 * The Collections grid's Facility cell — PURE presentational, no hooks, no effects, no '@/' aliases.
 *
 * Same contract as facility-resolution-leaves.tsx and for the same reason: it can be loaded and
 * asserted directly by the hermetic render suite under `renderToStaticMarkup`. It lives outside
 * cmd-explorer.tsx because that file is a 3,700-line `'use client'` island full of hooks, state and
 * effects — rendering it to a string to prove one cell is not possible, so the cell would have
 * shipped untested. Extracted 2026-08-30 with the 0086 resolution fallback.
 *
 * ── WHAT THIS CELL SAYS ────────────────────────────────────────────────────────────────────────
 * CMD emits `facility = 'No Facility'` for charges that resolve to no office — 11,446 charges /
 * $29.08M at charge grain (measured 2026-08-30). Migration 0086 attributes 5,382 of them. Until
 * this cell existed the grid showed the placeholder for all of them, including the ones a human had
 * personally assigned in the Facility Resolution workbench.
 *
 * NO NEW COLUMN (ruled 2026-08-30 — the grid is already at 12/17 columns and side-scrolls). The
 * resolved facility, its evidence class and the raw CMD value all live INSIDE this one cell.
 *
 * ── THE PART THAT IS NOT NEGOTIABLE ────────────────────────────────────────────────────────────
 * ⚠ AN INFERRED FACILITY MUST NEVER RENDER IDENTICALLY TO ONE CMD NAMED, AND COLOUR ALONE DOES NOT
 * ACHIEVE THAT. `member_inference`, `vob` and `tie_break` are conclusions drawn from OTHER rows
 * about the same member; presenting one the way a CMD-named facility is presented would pass our
 * inference off as the payer's own record. The split is carried on THREE independent channels —
 * border STYLE (solid vs dashed), colour, and the literal word "inferred" in the badge — so it
 * survives greyscale, a colour-blind reader and forced-colours mode. WCAG 1.4.1: never encode
 * meaning in colour alone.
 *
 * The shipped workbench STATUS cell gives EVERY resolved method the same teal pill and is
 * deliberately left alone by that ruling; the two surfaces disagree visually on purpose today, and
 * porting this split back there is a named follow-up.
 *
 * ── PHI ────────────────────────────────────────────────────────────────────────────────────────
 * Nothing here is PHI. A facility name/code and a method name are non-PHI dimensions; no member
 * token, no name, no identifier is read or rendered.
 */
import type { ReactNode } from 'react';
import {
  isResolutionMethod,
  resolutionClassOf,
} from '../../../src/collections/facilityResolutionQuery';
import { METHOD_LABELS } from '../collections/facility-resolution-leaves';

/** Exactly the three fields this cell reads — deliberately NOT the whole grid row, so the render
 *  suite can build a fixture without standing up a 17-column row. */
export interface FacilityCellRow {
  /** The RAW value CMD sent. Never overwritten by resolution — it is what `title` discloses. */
  facility: string | null;
  /** `collections.cmd_facility_resolution.facility_alias`, or null when 0086 did not attribute. */
  facility_resolved: string | null;
  /** The 0086 method behind `facility_resolved`. Null exactly when that is null. */
  facility_method: string | null;
}

/**
 * Render the Facility cell. Returns `fallback` unchanged for every row 0086 did not attribute —
 * which is almost the whole book (0086 covers the placeholder population only) AND every
 * placeholder charge it could not resolve, so those correctly keep showing 'No Facility'.
 *
 * `fallback` is passed in rather than derived so this component never has to know about grouped
 * mode, PHI masking, or the em-dash rules the grid's own cellText() owns.
 */
export function FacilityCell({
  row,
  fallback,
}: {
  row: FacilityCellRow;
  fallback: ReactNode;
}): ReactNode {
  const resolved = row.facility_resolved;
  const cls = resolutionClassOf(row.facility_method);
  if (resolved === null || cls === 'unresolved') return fallback;

  // Guarded narrowing — facility_method is plain text off the wire. An unrecognised value already
  // classified as 'unresolved' above and returned, so this is total in practice.
  const method = row.facility_method;
  const label = isResolutionMethod(method) ? METHOD_LABELS[method] : (method ?? '—');
  const exact = cls === 'exact';

  // The raw CMD value stays reachable. `title` covers hover; the sr-only span covers keyboard and
  // screen-reader users, for whom `title` is effectively invisible — this app makes WCAG claims it
  // has to keep, and "hover only" would not be one of them.
  const explain =
    `CMD sent “${row.facility ?? '—'}”. Attributed to ${resolved} by ${label}` +
    (exact ? ' — exact evidence.' : ' — inferred from this patient’s other charges.');

  return (
    <span className="inline-flex items-center gap-1.5" title={explain}>
      <span
        data-resolution={exact ? 'exact' : 'inferred'}
        className={
          'rounded-full px-2 py-0.5 text-xs font-medium ' +
          (exact
            ? 'border border-teal700/40 bg-teal50 text-teal900'
            : 'border border-dashed border-ink400 bg-surface text-ink600')
        }
      >
        {resolved}
      </span>
      <span className="text-xs text-ink400">{exact ? label : `${label} · inferred`}</span>
      <span className="sr-only">{explain}</span>
    </span>
  );
}
