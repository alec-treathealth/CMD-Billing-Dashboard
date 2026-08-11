/**
 * THE COLLECTIONS FACILITY PICKER'S LABELS — display-only disambiguation (2026-08-10).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `buildCmdFacilityOptionsQuery` is DISTINCT on the RAW CMD facility text, and the picker labels
 * each option with the CURATED dimension name. So a facility whose CMD export carries more than one
 * spelling produces two options that render byte-identically — same text, same IP/OP badge, nothing
 * to tell them apart.
 *
 * Live: `LONESTAR MENTAL HEALTH` (4,195 charge lines) and `LONESTAR MENTAL HEALTH LLC` (81) both
 * resolve to facility_code LSMH — one through the exact `facilities.facility_name` match, the other
 * through the `cmd_facility_aliases` crosswalk — so both label from the same dimension row. Typing
 * "mental" showed the same row twice, and picking the wrong one silently scoped the whole search to
 * 81 lines instead of 4,195, with a perfectly plausible number on screen.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
 * ⚠ THE GRAIN STAYS RAW. Collapsing to one option per `facility_code` with an `array_agg` of
 * variants — which is exactly what Qualify's `buildQualifyFacilityOptionsQuery` does — was proposed
 * and EXPLICITLY RULED OUT (Alec, 2026-08-10): *"Collections is a raw-grain payment search, not a
 * facility rollup."* The two options are SUPPOSED to be two options; only their labels were broken.
 *
 * So do not "finish the job" by touching `buildCmdFacilityOptionsQuery`, its GROUP BY,
 * `CmdFacilityOption`, or either filter-build site in cmd-explorer.tsx. A selection still carries
 * ONE raw facility text and `facility = any(...)` still matches exactly that spelling.
 *
 * ── WHY CONDITIONAL RATHER THAN ALWAYS ─────────────────────────────────────────────────────────
 * The raw text is appended ONLY to labels that collide. Measured against live data: 2 of 48 options
 * change; the other 46 keep their curated label byte-for-byte. An unconditional append would have
 * rewritten 11 of 48 — that many have a curated name differing from the raw text — to fix 2.
 *
 * Self-maintaining in both directions: a third spelling disambiguates itself, and if an alias change
 * ever removes the collision the labels revert to clean curated names with no code edit.
 *
 * A null `facility_name` can never trigger it. The display then IS the raw text, and the raw texts
 * are DISTINCT by construction (the query selects `distinct value`), so no option can ever render
 * `X · X`.
 *
 * ── THE TYPE-AHEAD ─────────────────────────────────────────────────────────────────────────────
 * `PickerOption.display` is both the label AND the haystack `pickerMatches` searches, so the
 * appended raw text stays findable rather than blocking a search. That is the one behaviour this
 * change could plausibly break and a "the labels differ" assertion would not catch, so
 * `collections-facility-picker-labels.test.tsx` drives the REAL `pickerMatches` over these options.
 *
 * `searchText` is deliberately NOT set here (Alec, 2026-08-10): making every raw CMD spelling
 * findable is a search-behaviour change, not a display fix, and belongs in its own change.
 *
 * PURE — no React, no server imports, relative import for the type only — so the test can load it
 * under `tsx`. It lives outside cmd-explorer.tsx because that component transitively imports
 * `lib/actions.ts` → `lib/access.ts`, which calls React `cache` at module scope and cannot be
 * imported by the test runner at all.
 */
import type { PickerOption } from '../../components/ui/multi-select-tag-picker';

/** The fields this derivation reads off `CmdFacilityOption` — kept structural so the test needs no
 *  server types and so a future column on the option cannot silently change the label. */
export interface FacilityLabelSource {
  facility: string;
  facility_name: string | null;
  care_setting: 'IP' | 'OP' | 'BOTH' | null;
}

/** The separator between a curated name and the raw CMD text it could not be told apart from. */
export const FACILITY_DISAMBIGUATOR = ' · ';

/**
 * Map the raw facility options to picker options, appending the raw CMD text to any label that
 * would otherwise be indistinguishable from another option's.
 *
 * `value` is untouched — it is the raw facility text the grid and summary filter on.
 */
export function facilityPickerOptionsFrom(options: readonly FacilityLabelSource[]): PickerOption[] {
  // How many options want each label. Counting first (rather than comparing pairwise inside the map)
  // keeps this linear and, more usefully, makes "is this label ambiguous?" one lookup at each site.
  const times = new Map<string, number>();
  for (const o of options) {
    const label = o.facility_name ?? o.facility;
    times.set(label, (times.get(label) ?? 0) + 1);
  }
  return options.map((o) => {
    const label = o.facility_name ?? o.facility;
    return {
      value: o.facility,
      display: (times.get(label) ?? 0) > 1 ? `${label}${FACILITY_DISAMBIGUATOR}${o.facility}` : label,
      badge: o.care_setting,
    };
  });
}
