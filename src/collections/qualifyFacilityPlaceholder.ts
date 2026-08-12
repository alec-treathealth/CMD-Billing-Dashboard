/**
 * The rollup's "no facility at all" literal, for the SQL layer.
 *
 * CMD emits `facility = 'No Facility'` for charges that resolve to nowhere: interest lines (cpt INT
 * / INTRST) plus a residual unattributed trickle — 11,414 charges / $29,081,575.38 at charge grain,
 * measured in `supabase/migrations/0084_cmd_explorer_pull_facility.sql`.
 *
 * ── THE RULING THIS CONSTANT EXISTS TO EXPRESS (2026-08-12) ─────────────────────────────────────
 *
 * The placeholder is split by ROLE, not removed:
 *
 *   DENOMINATORS keep it. Money is not hidden and collections still reconcile — the book-wide KPI
 *   tile (`buildBookKpisQuery`) and the policy-tape rating-math grouping set
 *   (`buildRatingHistoryAggQuery`) both carry NF rows and must keep carrying them. Neither
 *   references this constant, and that absence is the enforcement.
 *
 *   ENTITY SURFACES suppress it. Anything that RANKS, PICKS, NAMES or hands a facility to the model
 *   is asserting a place, and there is no place here. Those sites reference this constant.
 *
 * This REVERSES the earlier "it keeps its own row everywhere" ruling on the entity half only. The
 * denominator half of that ruling is unchanged and is the reason this is a suppression at the
 * query's entity surfaces rather than a filter on the rollup — the rollup is untouched.
 *
 * ── WHY A CONSTANT AND NOT A SHARED PREDICATE ──────────────────────────────────────────────────
 *
 * Deliberately a bare LITERAL with no predicate logic attached. The obvious shared helper —
 * `cmdExplorerBaseConds` (cmdExplorerQuery.ts) — is disqualified twice over: it feeds
 * `buildBookKpisQuery`, which is a denominator that must stay inclusive, AND the Collections grid,
 * which keeps NF under the separate 2026-08-10 raw-grain payment-search ruling. Folding the
 * exclusion into it would silently change both. So the exclusion is applied PER SITE and only this
 * string is shared; a site opts in by naming it.
 *
 * Bind it as a `$n` PARAMETER, never interpolate it — it is a value, not an identifier
 * (CLAUDE.md: table/column names are fixed literals, values are bound).
 *
 * ── MIRROR ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `app/lib/qualify/contract.ts` exports the same string as `QUALIFY_NO_FACILITY` for the UI layer.
 * The two are separate on purpose: `app/` imports from `../src`, never the reverse, so the SQL layer
 * cannot reach the app constant. They must not drift — `test/qualifyNoFacility.test.ts` pins them.
 */
export const QUALIFY_NO_FACILITY_SQL = 'No Facility';
