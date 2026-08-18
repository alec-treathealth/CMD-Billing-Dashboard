/**
 * Reconstruct a saved column view into a concrete { order, hidden } layout. Pure and
 * dependency-free (allOrder + phiKeys are injected) so it is unit-tested in isolation AND imported by
 * the Collections Explorer client without pulling any server/query code into the bundle.
 *
 * Tolerant of both saved-view storage formats:
 *   • NEW (migration 0047): `hidden` is an explicit array of the hidden column keys.
 *   • LEGACY (migration 0046): `hidden` is null; `columns` stored ONLY the visible columns in order,
 *     so any allowlisted key ABSENT from `columns` is treated as hidden — exactly 0046's
 *     "membership = visibility" semantics. This is what keeps pre-existing views loading unchanged.
 *
 * Additionally it: repairs a view saved before a column was added (allowlisted keys missing from the
 * view are appended in the canonical `allOrder`); drops unknown / non-allowlisted / duplicate keys;
 * strips `phiKeys` from the hidden set (PHI columns are locked-visible); and guarantees at least one
 * visible column (if every column would be hidden, none are).
 */
export function deriveGridLayout(
  view: { columns: readonly string[]; hidden: readonly string[] | null },
  allOrder: readonly string[],
  phiKeys: ReadonlySet<string>,
): { order: string[]; hidden: Set<string> } {
  const allowed = new Set(allOrder);
  const seen = new Set<string>();
  const knownCols: string[] = [];
  for (const c of view.columns) {
    if (allowed.has(c) && !seen.has(c)) {
      seen.add(c);
      knownCols.push(c);
    }
  }
  // A view with no recognizable columns is treated as "fall back to the default" — the full order,
  // everything visible — rather than deriving a hidden set from the (then all-)missing columns.
  if (knownCols.length === 0) return { order: [...allOrder], hidden: new Set<string>() };

  // Allowlisted columns the view didn't mention, appended in canonical order. For a LEGACY view these
  // are the previously-hidden columns; for any view they also backfill columns added since it was saved.
  const missing = allOrder.filter((k) => !seen.has(k));
  const order = [...knownCols, ...missing];

  const hiddenSource = view.hidden === null ? missing : view.hidden.filter((c) => allowed.has(c));
  const hidden = new Set<string>(hiddenSource.filter((k) => !phiKeys.has(k)));
  // A layout must keep at least one column visible; if everything ended up hidden, show everything.
  if (order.every((k) => hidden.has(k))) hidden.clear();

  return { order, hidden };
}

/**
 * The reserved view name that holds a user's LIVE column layout (2026-08-17).
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────────────────────────
 * Reported: *"We need to make the column setting sticky and savable for the user to save the view
 * that they want, which doesn't work at the moment."*
 *
 * The named-view machinery is NOT broken — verified 2026-08-17 against production: the
 * `save_grid_view` definer upserts correctly on (app_user_id, view_name), `claims_reader` holds
 * EXECUTE on all four definers and SELECT (never INSERT) on the table, RLS is on with two policies,
 * and the load path applies the caller's default view on both the seeded and the fetched mount.
 *
 * What was missing is STICKINESS. Reordering or hiding a column changed component state only, so a
 * reload discarded it unless the user opened the popover, typed a name, ticked "default" and saved.
 * The production table showed the shape of that failure exactly: ONE view ever saved, with
 * `created_at = updated_at` — the ritual was performed once and abandoned.
 *
 * So the live layout is now auto-saved under this reserved name after every change, and preferred
 * over the default view on load (it is by definition the most recent thing the user did). Named
 * views keep working unchanged and become what they should always have been: snapshots to switch
 * between, not the only way to keep your own columns.
 *
 * ── WHY A RESERVED ROW AND NOT BROWSER STORAGE ─────────────────────────────────────────────────
 * `localStorage` is the obvious implementation and is FORBIDDEN here: "Nothing app-state goes into
 * localStorage or cookies" (.claude/rules/nextjs-app.md). It would also make the layout per-device
 * rather than per-user, which is not what "sticky" means to someone using two machines.
 *
 * ⚠ HIDE IT FROM THE VIEW LIST. It is a real row in the same table, so any UI listing saved views
 * must filter it out — otherwise the user sees a view named `__auto__` they never created, and can
 * rename, delete or set-default it. Use `isAutoGridView`.
 */
export const AUTO_GRID_VIEW_NAME = '__auto__';

/** Is this the reserved auto-saved layout rather than a user's named view? */
export function isAutoGridView(name: string): boolean {
  return name === AUTO_GRID_VIEW_NAME;
}
