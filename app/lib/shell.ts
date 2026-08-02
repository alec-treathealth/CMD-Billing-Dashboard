/**
 * Shell mode seam — which chrome the app renders.
 *
 *   'bar'  — the shipped top-bar shell (logo + centered nav + right-hand controls).
 *   'rail' — the Material-3 navigation rail: a fixed left rail that expands on
 *            toggle, with a slimmed top bar that keeps ONLY the view switcher,
 *            tenant logo, and user avatar.
 *
 * This module is pure and side-effect-free — no React, no server imports, no DB —
 * so it is safe to import from Server Components, Client Components, and the
 * hermetic tests alike (mirrors the `views.ts` seam).
 *
 * PROTOTYPE POSTURE: 'bar' is the default, so production chrome is UNCHANGED
 * until someone opts in via the `SHELL_MODE` server env. Same idiom as the
 * QUALIFY_MAINTENANCE / CLAIMS_AUDIT_MAINTENANCE kill switches, including the same
 * caveat: changing it on Vercel requires a redeploy.
 *
 * Deliberately env-only — no `?shell=` param, no cookie, no localStorage:
 *   - The root layout cannot read searchParams in the App Router, and the shell
 *     restructures SERVER-rendered header markup, so a client-side URL override
 *     could only ever half-apply. A toggle that silently half-works is worse than
 *     one that needs a redeploy.
 *   - Browser storage is out per the standing rules (nothing app-state in
 *     localStorage or cookies).
 * `SHELL_MODE` is a plain server env var, NOT `NEXT_PUBLIC_*`.
 */

/** The two chrome layouts. */
export type ShellMode = 'bar' | 'rail';

/** Canonical default. Production stays on the shipped top bar until opted out. */
export const DEFAULT_SHELL_MODE: ShellMode = 'bar';

const SHELL_MODES: ReadonlySet<string> = new Set<ShellMode>(['bar', 'rail']);

/** Narrow an unknown value to a ShellMode. */
export function isShellMode(value: unknown): value is ShellMode {
  return typeof value === 'string' && SHELL_MODES.has(value);
}

/**
 * Parse the `SHELL_MODE` server env into a mode. Accepts the mode names plus the
 * truthy spellings the maintenance kill-switches already use, so `SHELL_MODE=1`
 * reads the way an operator expects. Anything unset or unrecognized → the default.
 */
export function resolveShellModeEnv(raw: string | undefined): ShellMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_SHELL_MODE;
  if (isShellMode(value)) return value;
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return 'rail';
  return DEFAULT_SHELL_MODE;
}

// ===========================================================================
// Rail geometry — Material 3 metrics, in px, in ONE place.
// ===========================================================================
//
// M3 specs the navigation rail at 80dp. The expanded rail overlays rather than
// pushes: expanding must not reflow the collections/claims grids underneath, so
// the content inset stays at the COLLAPSED width in both states.

/** Rail width at rest, and the left inset applied to page content. */
export const RAIL_COLLAPSED_PX = 80;

/** Rail width when expanded. Overlays the content; the inset does not change. */
export const RAIL_EXPANDED_PX = 232;

// ===========================================================================
// Full-page routes — the ONE list of routes that render their own chrome.
// ===========================================================================

/** Routes whose pages draw their own full-page chrome (Continuity auth screens). */
export const FULL_PAGE_ROUTES: ReadonlySet<string> = new Set([
  '/login',
  '/forgot-password',
  '/set-password',
]);

/**
 * True when the route owns its chrome, so the global header AND the rail must both
 * stay hidden. `/qualify/m` is the mobile PWA — a full-screen self-chrome surface —
 * matched by prefix so it never catches the desktop `/qualify`. A nullish pathname
 * (pre-hydration; `usePathname()` has returned `null` historically) is treated as
 * NOT full-page, preserving the shipped HeaderGate behaviour of rendering chrome by
 * default. `undefined` is accepted too so HeaderGate can rely on this ONE predicate
 * without an extra null guard drifting out of sync.
 */
export function isFullPageRoute(pathname: string | null | undefined): boolean {
  if (pathname == null) return false;
  return FULL_PAGE_ROUTES.has(pathname) || pathname.startsWith('/qualify/m');
}

/**
 * The rail is on the page iff SHELL_MODE=rail AND the route isn't drawing its own
 * chrome. ContentInset uses the same predicate to reserve the rail's footprint —
 * one helper so the rail's fixed panel and the page's left inset can never disagree
 * (e.g. no rail but still a phantom 80px gutter on /login, or vice versa).
 */
export function railActive(mode: ShellMode, pathname: string | null | undefined): boolean {
  return mode === 'rail' && !isFullPageRoute(pathname);
}
