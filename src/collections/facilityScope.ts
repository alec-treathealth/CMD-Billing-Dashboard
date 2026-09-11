/**
 * FacilityScope — the `user` seat's facility entitlement, as a type that cannot be inverted.
 *
 * WHY THIS EXISTS AT ALL. The first cut of this feature modelled the entitlement as
 * `string[] | null`, with `null` meaning UNRESTRICTED and `[]` meaning DENY-ALL. That encoding is
 * correct and completely indefensible: `if (!codes)` is true for BOTH, `codes?.length` is falsy for
 * both, and either mistake silently hands a restricted user the entire tenant. Neither produces a
 * type error. It needed thirteen tests to defend a one-character slip — which is the signal that
 * the TYPE permitted the slip, not that the tests were missing.
 *
 * So the two states are now distinct shapes. There is no falsy scope, no empty-array-means-either,
 * and `scope.codes` does not exist on the unrestricted branch — reaching for it is a compile error
 * rather than a silent widening. The tests are kept, but they now assert behaviour the compiler
 * already guarantees, which is the right order of defences.
 *
 * THE ONE PLACE THE OLD ENCODING STILL EXISTS is `facilityScopeParam`, at the SQL boundary, because
 * a bind parameter genuinely is `text[] | null`. It is a single four-line function with the
 * conversion stated once, rather than the same conditional re-derived at every reader.
 */

/** UNRESTRICTED: no facility predicate is applied at all. super_admin / admin / admissions_seat. */
export interface UnrestrictedFacilityScope {
  readonly kind: 'unrestricted';
}

/**
 * SCOPED: visible facilities are exactly `codes`.
 *
 * ⚠ AN EMPTY `codes` IS DENY-ALL, NOT "no filter". It is reachable — a `user` provisioned with no
 * grants, or one whose grant read failed — and it must return zero rows on every surface. That is
 * the whole point of separating this from `unrestricted`.
 */
export interface ScopedFacilityScope {
  readonly kind: 'scoped';
  readonly codes: readonly string[];
}

export type FacilityScope = UnrestrictedFacilityScope | ScopedFacilityScope;

/** The unrestricted scope. A shared frozen value — there is nothing per-caller about it. */
export const UNRESTRICTED_FACILITIES: FacilityScope = Object.freeze({ kind: 'unrestricted' as const });

/**
 * A scope restricted to `codes`. Copies and de-duplicates, so a caller cannot widen an entitlement
 * after the fact by mutating the array it handed in.
 */
export function scopedFacilities(codes: readonly string[]): FacilityScope {
  return { kind: 'scoped', codes: Object.freeze([...new Set(codes)]) };
}

/**
 * The deny-everything scope — a `scoped` entitlement with no codes.
 *
 * Named rather than written inline at each fail-closed site, so "we could not establish who this
 * principal is" reads as a deliberate denial instead of an empty literal someone might later
 * "simplify" into the unrestricted branch.
 */
export const DENY_ALL_FACILITIES: FacilityScope = Object.freeze({
  kind: 'scoped' as const,
  codes: Object.freeze([]) as readonly string[],
});

/** True when this scope can never match a row. Reads better than `s.kind === 'scoped' && !s.codes.length`. */
export function deniesEverything(scope: FacilityScope): boolean {
  return scope.kind === 'scoped' && scope.codes.length === 0;
}

/**
 * THE SQL BOUNDARY — and the only sanctioned place `string[] | null` still appears.
 *
 * Every reader binds the result as a `text[]` parameter and guards it with
 * `($n::text[] is null or <col> = any($n::text[]))`:
 *   · `null`  → the predicate short-circuits, no narrowing (UNRESTRICTED)
 *   · `[]`    → `= any('{}')` is false for every row, so nothing matches (DENY-ALL)
 *   · `[...]` → narrows to those codes
 * One expression, no application-side branch, and the deny case falls out of SQL semantics rather
 * than out of a conditional somebody has to remember to write.
 *
 * `undefined` maps to `null` so a reader whose context omits the field is unrestricted — the
 * pre-0112 behaviour, which is what every non-`user` caller wants.
 */
export function facilityScopeParam(scope: FacilityScope | undefined): string[] | null {
  if (scope === undefined || scope.kind === 'unrestricted') return null;
  return [...scope.codes];
}

/**
 * Narrow a list of facility-bearing options to what a scope permits.
 *
 * Used for the explorer's facility dropdown, where the vocabulary is cached per TENANT and the
 * per-user narrowing therefore has to happen after the cached read. Generic and pure so the
 * deny-all direction is unit-testable without a session.
 *
 * ⚠ A NULL `facility_code` IS DROPPED under a scoped entitlement. That is the 'No Facility'
 * placeholder and any CMD spelling absent from both the dimension and the alias crosswalk. Keeping
 * it would advertise a filter that returns nothing anyway (the grid's entitlement predicate denies
 * those same rows, per R2), and dropping it fails safe for an unrecognised spelling.
 */
export function narrowByFacilityCode<T extends { facility_code: string | null }>(
  items: readonly T[],
  scope: FacilityScope,
): T[] {
  if (scope.kind === 'unrestricted') return [...items];
  const granted = new Set(scope.codes);
  return items.filter((i) => i.facility_code !== null && granted.has(i.facility_code));
}
