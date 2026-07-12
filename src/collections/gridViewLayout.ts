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
