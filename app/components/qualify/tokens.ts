/**
 * Qualify SHARED DESIGN TOKENS — the ONE place both surfaces (desktop qualify-tab + mobile PWA) read
 * brand + rating colors from, so a palette change is made ONCE, not twice (Phase 0 consolidation).
 * PURE, client-safe, no React, no server imports. Imports are RELATIVE (not `@/`) so this and its
 * consumers load under `tsx` in the hermetic render tests without tsconfig path-alias resolution.
 *
 * The desktop surface paints buckets through the `.q-<bucket>` classes in globals.css; the MOBILE
 * surface styles inline (no Tailwind classes reach the phone shell), so it reads these hexes directly.
 * Values are IDENTICAL to globals.css's `.q-*` scale and tailwind.config.ts's brand tokens — this
 * module is their JS-readable mirror, replacing the per-file `const TEAL900 = '#0E3A3A'` hard-codes.
 */
import type { RatingBucket } from '../../lib/qualify/rating';

/** TreatHealthOS brand palette (mirrors tailwind.config.ts brand tokens + globals.css). */
export const QUALIFY_PALETTE = {
  teal900: '#0E3A3A',
  teal700: '#135E5A',
  teal500: '#1C8B82',
  teal200: '#B7DAD5',
  teal50: '#EAF4F2',
  coral600: '#E2674F',
  coral400: '#F0917C',
  coral50: '#FCEDE8',
  ground: '#FBF8F4',
  surface: '#FFFFFF',
  ink900: '#1B2B2A',
  ink600: '#4A5C5A',
  ink400: '#63756E', // secondary/meta text — WCAG AA (≥4.5:1 on white); was #859794
  line: '#E4E9E6',
  info: '#2D7393',
} as const;

/** Rating/confidence bucket → its solid status hex (matches globals.css `.q-*` `--q-c`). */
export const RATING_HEX: Record<RatingBucket, string> = {
  ok: '#2E8B6F',
  warn: '#C9881E',
  danger: '#C0453B',
  neutral: '#6B7B79',
};

/** Rating bucket → its heat-wash hex (matches `--q-wash`); neutral washes to transparent. */
export const RATING_WASH: Record<RatingBucket, string> = {
  ok: '#E6F2EC',
  warn: '#FBF1DE',
  danger: '#FBE7E4',
  neutral: 'transparent',
};

/**
 * Staged-reveal per-item animation delay (ms), CAPPED so the total stagger stays bounded no matter how
 * many siblings render — the design-system's `min(i, 3) * 60ms` rule in one place. Pair with the
 * `animate-ths-reveal` utility (Tailwind) / inline `animationDelay`. Collapses under
 * prefers-reduced-motion via the global reset in globals.css.
 */
export function staggerDelayMs(index: number): number {
  return Math.min(Math.max(index, 0), 3) * 60;
}
