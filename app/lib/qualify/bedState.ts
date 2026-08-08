/**
 * BED AVAILABILITY — the ONE derivation behind the sort tier, the v3 chip and the v2 `bedChip`.
 *
 * PURE and client-safe: no React, no server imports, relative imports only, so it loads under `tsx`
 * in the hermetic render tests and inside `core.ts` on the server alike.
 *
 * ── Why this is a function and not three copies of a ternary ─────────────────────────────────────
 *
 * `open_beds = 0` carries TWO opposite meanings in `collections.qualify_facility_census`, and the
 * codebase has already paid for conflating them once (PR #163). Ingest counts monday items whose
 * status label starts "Open Bed" (src/collections/qualifyCensus.ts:459). OUTPATIENT boards carry no
 * such labels at all, so every outpatient row is written `open_beds = 0` — a literal zero that means
 * "beds do not apply here", not "every bed is taken". Eleven of the twenty-three registered
 * facilities are outpatient. A naive `openBeds === 0 → full` marks all eleven at capacity; the
 * inverse defect (`openBeds > 0` as the render guard) silenced five genuinely FULL residential
 * houses, which is what #163 fixed.
 *
 * TWO things separate the zeroes, and neither is optional:
 *   · `bed_capacity` — the denominator. Curated per residential facility (FACILITY_BED_CAPACITY);
 *     deliberately absent for outpatient, so a null is "no beds" OR "residential not yet curated".
 *   · `board_family` — the authoritative statement, and the reason the tier is computed SERVER-side:
 *     it is on `QualifyCensusAggRow` and has never crossed the wire.
 *
 * The family is passed where it is known (core.ts) and omitted where it is not (the v2 chip, which
 * predates it) — with the family absent the denominator rule alone reproduces #163's exact three
 * states, so the older caller keeps its ratified behaviour byte for byte.
 */

/**
 * What we can honestly say about beds at this facility right now.
 *
 *   'open'           — a counted open bed. The rep can route someone today.
 *   'full'           — CONFIRMED full: a real denominator and zero of it free. The single most
 *                      actionable fact the card carries, and the only state that sinks a facility.
 *   'not_applicable' — an outpatient facility. Beds are not the unit of admission here.
 *   'unknown'        — no census row, or a residential row with no usable denominator. We know
 *                      nothing; say nothing, and never let it cost the facility a rank.
 */
export type QualifyBedState = 'open' | 'full' | 'not_applicable' | 'unknown';

/**
 * Derive the bed state from the census row's three fields. `boardFamily` is the raw
 * `qualify_facility_census.board_family` text (0078 constrains it to 'residential' | 'outpatient');
 * pass null/undefined when the caller genuinely does not have it.
 */
export function bedStateOf(
  openBeds: number | null,
  bedCapacity: number | null,
  boardFamily?: string | null,
): QualifyBedState {
  // NO CENSUS ROW comes first, because `board_family` is itself a census-row field: a null family
  // with a null count is "we have no row", never "we have a row about a facility with no family".
  if (openBeds === null) return 'unknown';
  // Beds do not apply, whatever the count says. Ordered ABOVE the count checks deliberately — the
  // family is a statement about the FACILITY, the count is an artefact of how the board is labelled.
  if (boardFamily === 'outpatient') return 'not_applicable';
  if (openBeds > 0) return 'open';
  // openBeds === 0 (or, defensively, negative). Only a usable denominator turns that into "full";
  // a zero capacity is an absent one — never divide by it, never claim full from it.
  return bedCapacity !== null && bedCapacity > 0 ? 'full' : 'unknown';
}

/**
 * THE AVAILABILITY SORT TIER — the head of the `assembleFacilities` comparator (core.ts).
 *
 * Tier 0 is everything the rep could act on: an open bed, a facility beds do not apply to, and —
 * critically — a facility we know nothing about. ABSENCE OF DATA MUST NOT PUNISH. The census cron
 * is hourly and fail-soft; if it lapses, every row falls to 'unknown', every row lands in tier 0,
 * and the book degrades to exactly today's rating order instead of silently reshuffling itself.
 *
 * Tier 1 is CONFIRMED FULL ONLY. Alec's ruling (2026-08-08): census SORTS, it never filters — a
 * full house stays visible and greyed, because the rep is keeping a map of where they could send
 * someone tomorrow as well as today.
 */
export function bedAvailabilityTier(state: QualifyBedState): 0 | 1 {
  return state === 'full' ? 1 : 0;
}
