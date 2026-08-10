/**
 * Qualify v3 surface flag — ON BY DEFAULT since 2026-08-06.
 *
 * The staged flow (docs/qualify-v3-search-pattern.md) is the rendered /qualify UI: Alec's directive
 * after the 2026-08-06 v2 screenshots ("simplify … resolve to a payer … pick an employer"). The flag
 * inverted from dark-launch to kill switch: `QUALIFY_V3_FLOW=0` (also "false" / "off") falls back to
 * the v2 tab, which remains fully reachable and unmodified. Vercel requires a redeploy for an env
 * change to take effect.
 *
 * WHY A SEPARATE FLAG rather than reusing `QUALIFY_MAINTENANCE`. That flag answers a different
 * question — "should this viewer see a refactor notice instead of the surface?" — and the two
 * compose: a viewer must pass the maintenance gate to reach either UI.
 */
export function qualifyV3FlowEnabled(): boolean {
  const v = (process.env.QUALIFY_V3_FLOW ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/**
 * The Smoke two-pane shell (2026-08-10) — the lane rail + board layout from
 * docs/mockups/qualify-smoke.html, wrapping the SAME v3 staged flow. A kill switch exactly like
 * QUALIFY_V3_FLOW above: ON by default, `QUALIFY_SMOKE_SHELL=0|false|off` falls back to the
 * single-column v3 layout, which remains fully reachable and unmodified. The two flags COMPOSE —
 * the shell only exists inside the v3 path, so turning v3 off turns the shell off with it.
 * Vercel requires a redeploy for an env change to take effect.
 */
export function qualifySmokeShellEnabled(): boolean {
  const v = (process.env.QUALIFY_SMOKE_SHELL ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}
