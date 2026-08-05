/**
 * Qualify v3 surface flag — OFF BY DEFAULT.
 *
 * v3 is additive. v2 stays fully reachable and is not modified: nothing in this run changes a v2
 * render path, a v2 query, or v2's `urlState` (whose `employer_norm` behaviour is grandfathered on
 * prod and deliberately out of scope). Flipping this flag MOUNTS the v3 flow; it does not unmount v2.
 *
 * WHY A SEPARATE FLAG rather than reusing `QUALIFY_MAINTENANCE`. That flag answers a different
 * question — "should this viewer see a refactor notice instead of the surface?" — and it is ON by
 * default. Overloading it would mean v3 becomes visible to whoever is on the bypass allowlist as a
 * side effect of an unrelated setting, which is how a dark launch stops being dark. The two compose:
 * a viewer must pass the maintenance gate AND have this flag on to reach v3.
 *
 * ENABLE: `QUALIFY_V3_FLOW=1` (also accepts "true" / "on"). Vercel requires a redeploy for an env
 * change to take effect. To revert entirely, unset it — no other behaviour is conditioned on it.
 */
export function qualifyV3FlowEnabled(): boolean {
  const v = (process.env.QUALIFY_V3_FLOW ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
