/**
 * Facility spelling indexes for Qualify's picker — PURE, so the mapping that decides how wide a
 * facility search scopes is testable instead of buried in a component.
 *
 * WHY THIS EXISTS. One facility can carry several raw CMD facility texts (`LONESTAR MENTAL HEALTH`
 * with 4,156 charge lines and `LONESTAR MENTAL HEALTH LLC` with 81 are both LSMH). The picker shows
 * ONE option per facility, whose `value` is a canonical spelling and whose `variants` hold all of
 * them. Two lookups follow from that, and getting either wrong is silent:
 *
 *  - variant -> variants[]  expands a selection into the predicate. Miss it and the search scopes to
 *    one spelling: 81 lines where the facility has 4,237, with nothing on screen to say so.
 *  - variant -> canonical   normalizes a selection that did NOT come from the picker. A ticker-card
 *    click stores the trend row's RAW `facilityKey`, and a URL written before the de-duplication can
 *    carry any spelling. Storing a non-canonical value leaves a chip that matches no option.
 *
 * Both indexes are keyed by EVERY spelling, including the canonical one, so any value that can reach
 * `facilitySelection` resolves. Unknown values are the caller's problem to default (they fall back to
 * themselves), which keeps a facility that is genuinely absent from the vocabulary — the `No Facility`
 * bucket — working untouched.
 */

/** The shape this module needs from a picker option (a structural subset of QualifyFacilityOption). */
export interface FacilityVariantSource {
  value: string;
  variants: string[];
}

/**
 * ANY spelling -> every spelling of that facility. Keyed by all variants (see the module note).
 *
 * A later option wins a key collision, which cannot happen for well-formed input: a raw facility text
 * resolves to exactly one facility_code, so it appears in exactly one option's `variants`.
 */
export function indexFacilityVariants(options: readonly FacilityVariantSource[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const o of options) {
    const variants = o.variants.length > 0 ? o.variants : [o.value];
    for (const v of variants) out[v] = variants;
    // Defensive: an option whose `value` is somehow absent from its own variants still resolves.
    if (!(o.value in out)) out[o.value] = variants;
  }
  return out;
}

/** ANY spelling -> the canonical picker value for that facility. */
export function indexFacilityCanonical(options: readonly FacilityVariantSource[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of options) {
    const variants = o.variants.length > 0 ? o.variants : [o.value];
    for (const v of variants) out[v] = o.value;
    if (!(o.value in out)) out[o.value] = o.value;
  }
  return out;
}

/**
 * Expand the picker-grain selection into every raw facility text the predicate must match.
 * An unknown value expands to itself, so an unresolved bucket still filters on exactly what it is.
 */
export function expandFacilitySelection(
  selection: readonly string[],
  variants: Readonly<Record<string, string[]>>,
): string[] {
  return selection.flatMap((v) => variants[v] ?? [v]);
}

/** Normalize a selection value that may not have come from the picker. Unknown values pass through. */
export function canonicalFacilityValue(value: string, canonical: Readonly<Record<string, string>>): string {
  return canonical[value] ?? value;
}
