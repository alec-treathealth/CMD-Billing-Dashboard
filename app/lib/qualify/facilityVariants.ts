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
 *
 * ── S4 (2026-08-08): THE SET OPERATIONS THE v3 GRID NARROW IS MADE OF ───────────────────────────
 * Everything below the indexes turns a picker selection into a narrow over rows the ranking ALREADY
 * returned. It is a DISPLAY narrow and there is no SQL anywhere in this file — see flow-state.ts
 * invariant (m), and the measurement that decided it: 86.9% of members bill at exactly ONE facility
 * in 365 days, so the narrow's EMPTY state is the common render, and only a display narrow still
 * holds the un-narrowed list needed to say where the member DID bill.
 */
import { QUALIFY_NO_FACILITY } from './contract';

/** The shape this module needs from a picker option (a structural subset of QualifyFacilityOption). */
export interface FacilityVariantSource {
  value: string;
  variants: string[];
}

/**
 * The picker option as the v3 narrow needs it: the variant source plus the two display-only fields.
 * A structural subset of `QualifyFacilityOption` (src/collections/cmdExplorerQuery.ts) rather than
 * that type itself, for the same reason `FacilityVariantSource` is — this module is pure and must
 * not pull the query layer into the client bundle's type graph to describe four strings.
 */
export interface QualifyFacilityNarrowOption extends FacilityVariantSource {
  /** display_acronym, else facility_name, else the canonical raw text — what the picker filters on. */
  display: string;
  careSetting: 'IP' | 'OP' | 'BOTH' | null;
}

/** The rows this module's narrow needs from a ranked facility. */
export interface FacilityNarrowRow {
  /** RAW rollup facility text — the grain the indexes above are keyed by. */
  facilityKey: string;
  name: string;
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

/**
 * The RAW facility texts a picker selection covers — or **`null` when nothing is picked**.
 *
 * ⚠ NULL, NOT AN EMPTY SET, AND THAT IS THE CONTRACT. An empty Set filters everything OUT; it is the
 * `= any(ARRAY[])` mistake expressed in JS. The repo's standing rule is that an empty selection is NO
 * restriction (cmdExplorerQuery.ts:155-159), so "no narrow" needs a value the filter passes through
 * rather than a value that happens to match nothing.
 *
 * Built through `expandFacilitySelection`, so EITHER spelling of a multi-spelling facility covers
 * both — the 81-lines-vs-4,237 trap, in set form.
 */
export function facilityNarrowKeys(
  selection: readonly string[],
  options: readonly FacilityVariantSource[],
): ReadonlySet<string> | null {
  if (selection.length === 0) return null;
  return new Set(expandFacilitySelection(selection, indexFacilityVariants(options)));
}

/**
 * The rows that survive the facility narrow. `null` keys ⇒ the SAME array back, by reference.
 *
 * Identity matters: this feeds a `useMemo` chain on the answer stage, and a fresh-but-equal array on
 * the no-narrow path would invalidate every downstream memo on every render — the `NO_ANSWER_FILTERS`
 * lesson (flow-state.ts's referential bail-out note) one module over.
 *
 * Composition with the AREA narrow is the CALLER's: both are display narrows and they compose as AND,
 * which is the standard multiselect reading and the one the "Showing N of M" sentence describes.
 */
export function narrowByFacility<T extends { facilityKey: string }>(
  rows: readonly T[],
  keys: ReadonlySet<string> | null,
): readonly T[] {
  if (keys === null) return rows;
  return rows.filter((r) => keys.has(r.facilityKey));
}

/**
 * The facilities a narrow EXCLUDES, by name — the list the empty state names.
 *
 * TWO RULES, both of which a naive `.filter().map()` gets wrong:
 *  - DE-DUPLICATED BY NAME. Two raw spellings of one facility resolve to one `name`, so an un-deduped
 *    list reads "this member billed at LSMH and LSMH".
 *  - THE PLACEHOLDER IS NOT A PLACE. `No Facility` is a real bucket in the rollup and keeps its rank
 *    everywhere, but "this member billed at No Facility" asserts a place they were treated, which is
 *    the fabricated-place claim S3 suppressed the history annotation for. Callers must handle an
 *    EMPTY result rather than assuming there is always somewhere to name.
 */
export function facilitiesElsewhere(
  rows: readonly FacilityNarrowRow[],
  keys: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (keys.has(r.facilityKey) || r.facilityKey === QUALIFY_NO_FACILITY) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r.name);
  }
  return out;
}

/**
 * The options a user may PICK — every facility except the placeholder.
 *
 * `No Facility` ranks like any other text and must keep doing so (dropping the row would hide
 * $29,081,575.38 of charges, contract.ts `QUALIFY_NO_FACILITY`). What it may not be is an OPTION:
 * the question this narrow asks is "can I send this patient here", and there is no here.
 */
export function offerableFacilityOptions<T extends { value: string }>(options: readonly T[]): T[] {
  return options.filter((o) => o.value !== QUALIFY_NO_FACILITY);
}

/** The picked values as their picker labels. Any spelling resolves; an unknown value wears itself
 *  (the same "never expand to nothing" rule as the indexes above). */
export function facilityDisplayNames(
  selection: readonly string[],
  options: readonly QualifyFacilityNarrowOption[],
): string[] {
  const byValue = new Map<string, string>();
  for (const o of options) {
    for (const v of o.variants.length > 0 ? o.variants : [o.value]) byValue.set(v, o.display);
    if (!byValue.has(o.value)) byValue.set(o.value, o.display);
  }
  return selection.map((v) => byValue.get(v) ?? v);
}

/** `A` · `A and B` · `A, B and C`. English, because these names land mid-sentence in an empty state
 *  a human reads under time pressure — a ' · ' join is a list, and this is a clause. */
export function andList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/**
 * Which of the PICKED values the given rows actually cover — per pick, never once for the whole set.
 *
 * ⚠ THIS EXISTS BECAUSE A BOOLEAN LIED. The first build asked "does the member have history at ANY
 * picked facility", got `true`, and then rendered EVERY picked name as the subject of "This member HAS
 * billed at …". With picks `['LSMH','NASH']` against a footprint of LSMH alone, that sentence asserted
 * paid claims at a facility with zero rows — the fabricated-history class S3 suppressed the `No
 * Facility` annotation for, reachable through exactly the multi-select case that justified multi-select.
 *
 * Variant-aware like everything else here: the pick is a canonical value, the row carries a raw
 * spelling, and they are the same facility.
 */
export function picksWithRows(
  selection: readonly string[],
  options: readonly FacilityVariantSource[],
  rows: readonly { facilityKey: string }[],
): string[] {
  if (selection.length === 0 || rows.length === 0) return [];
  const present = new Set(rows.map((r) => r.facilityKey));
  const variants = indexFacilityVariants(options);
  return selection.filter((v) => (variants[v] ?? [v]).some((k) => present.has(k)));
}

/**
 * `1 facility` · `3 facilities`. ONE derivation, because four sentences on the answer stage count
 * facilities and the PRE-S4 area empty state already shipped "The 1 facilities behind this answer" —
 * a bug the three new arms would have inherited by copying the phrasing that had it.
 */
export function facilityCount(n: number): string {
  return `${n} facilit${n === 1 ? 'y' : 'ies'}`;
}
