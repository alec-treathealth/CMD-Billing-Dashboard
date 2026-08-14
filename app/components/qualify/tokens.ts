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

/**
 * Rating/confidence bucket → its solid status hex (matches globals.css `.q-*` `--q-c`).
 *
 * ⚠ DARKENED 2026-08-14 (audit C-5 / M4 / M5) AND THE BINDING SURFACE IS THE WASH, NOT WHITE.
 * These paint as SMALL TEXT (`.q-pct`/`.q-pctcell` at 12.5-13px, the mobile verdict word at 12px),
 * so 1.4.3 asks 4.5:1 — and they are painted on their OWN `--q-wash`/tint as often as on white,
 * which is a lighter background and therefore the tighter constraint. Solving only against white
 * would leave every `.q-heat` cell failing. Measured before → after, on wash / on white:
 *   ok      #2E8B6F → #287860   3.63 → 4.63   ·   4.17 → 5.32
 *   warn    #C9881E → #936316   2.67 → 4.64   ·   2.99 → 5.20   (the worst pair in the audit)
 *   danger  #C0453B → #B64138   4.25 → 4.64   ·   5.05 → 5.52
 *   neutral #6B7B79 → #5F6D6C   3.79 → 4.61   ·   4.44 → 5.40
 * Amber had to travel furthest and now reads bronze. It stays amber-FAMILY on purpose: it is the
 * estimate/reversal tell, the one a biller most needs to catch, so its hue (≈37°) still separates
 * it from band15's burnt orange (≈17°) and danger's red (≈4°).
 *
 * `--q-c` also paints NON-text (`.q-fac` border-left, `.q-bar > span`, `.q-dot`). Darkening only
 * raises those ratios, so 1.4.11 cannot regress here.
 */
export const RATING_HEX: Record<RatingBucket, string> = {
  ok: '#287860',
  warn: '#936316',
  danger: '#B64138',
  neutral: '#5F6D6C',
};

/** Rating bucket → its heat-wash hex (matches `--q-wash`); neutral washes to transparent. */
export const RATING_WASH: Record<RatingBucket, string> = {
  ok: '#E6F2EC',
  warn: '#FBF1DE',
  danger: '#FBE7E4',
  neutral: 'transparent',
};

/** IQ verdict band (rating v2 — the billing team's own 65/50/30/15/0 census scale) → solid hex +
 *  wash. Five bands, five visual tiers: the top two are both green-family (deep green vs brand
 *  teal) so an 82 never reads identical to a 52; 15 wears the coral warm accent; 0 is the true
 *  danger red. Mirrors `.q-band*` in globals.css — mobile styles inline from these. */
/**
 * ⚠ DARKENED 2026-08-14 alongside RATING_HEX, for the same reason and against the same binding
 * surface (each band's own wash). Before → after, on wash / on white:
 *   65 #2E8B6F → #287860   3.63 → 4.63  ·  4.17 → 5.32
 *   50 #1C8B82 → #197A72   3.70 → 4.60  ·  4.15 → 5.16
 *   30 #C9881E → #936316   2.67 → 4.64  ·  2.99 → 5.20
 *   15 #E2674F → #AD4F2A   2.93 → 4.69  ·  3.34 → 5.35
 *   0  #C0453B → #B64138   4.25 → 4.64  ·  5.05 → 5.52
 *
 * BAND 15 WAS NOT SOLVED FOR CONTRAST ALONE, and that is deliberate. Pure lightness-reduction on
 * #E2674F lands on #C43B20, which sits ~6° of hue from band 0's red — collapsing two of the five
 * tiers this scale exists to distinguish ("15 wears the coral warm accent; 0 is the true danger
 * red", below). #AD4F2A keeps ~13° of separation and still clears 4.5:1, so the ladder survives the
 * fix. If you retune these, re-check tier SEPARATION, not just the ratio.
 *
 * ⚠ `IQ_BAND_HEX['50']` IS NO LONGER `QUALIFY_PALETTE.teal500`, and that divergence is intended.
 * teal500 is a BRAND colour used for borders, rings and fills, where 1.4.11 asks only 3:1; band 50
 * is TEXT, where 1.4.3 asks 4.5:1. They were the same hex by coincidence of origin, not by rule.
 * Do not "resynchronise" them — that would silently re-break this band.
 */
export const IQ_BAND_HEX: Record<'65' | '50' | '30' | '15' | '0', string> = {
  '65': '#287860',
  '50': '#197A72',
  '30': '#936316',
  '15': '#AD4F2A',
  '0': '#B64138',
};
export const IQ_BAND_WASH: Record<'65' | '50' | '30' | '15' | '0', string> = {
  '65': '#E6F2EC',
  '50': '#EAF4F2',
  '30': '#FBF1DE',
  '15': '#FCEDE8',
  '0': '#FBE7E4',
};

/**
 * THE TAPE'S INVERSE SURFACE (Smoke Phase 0, 2026-08-10) — the JS mirror of the `--color-surface-
 * inverse` / `--tape-*` block in ths-v2.css, for the same reason every other hex here is mirrored:
 * a surface that styles inline cannot read a CSS custom property.
 *
 * CONSUMED BY `policy-tape.tsx`'s `DeltaText`, which is the only place these are painted today, plus
 * `ths-tokens-contrast.test.tsx`, which asserts both the AA ratios and that this object has not
 * drifted from the stylesheet. It briefly had NO production consumer at all — the tape kept a private
 * `TAPE_UP`/`TAPE_DOWN` pair with the same hexes — so the guard covered two copies and missed the
 * render site. If you add a third caller, add it here; if you ever find this unconsumed again, wire
 * it rather than deleting it, because the CSS side is what the desktop strip's `bg-teal900` paints.
 *
 * ⚠ THESE ARE NOT RATING_HEX AND MUST NOT BE SWAPPED FOR IT. Every other palette in this file is
 * measured against white or `ground`; these are measured against `#0E3A3A`. Running RATING_HEX.ok
 * (#2E8B6F) on the tape yields roughly 1.9:1 — invisible — and the mistake is not visible in a diff
 * because both are plausible greens named for the same idea. The direction of a move on a DARK strip
 * is a different token from the direction of a rating on a light card.
 */
export const TAPE_PALETTE = {
  surfaceInverse: '#0E3A3A',
  onInverse: '#FFFFFF', // 12.5:1 on surfaceInverse
  up: '#46C4B8', // 5.8:1 on surfaceInverse
  down: '#F0917C', // 5.4:1 on surfaceInverse
  /**
   * IQ BAND COLOURS FOR THE INVERSE SURFACE (audit C-4, 2026-08-14) — and this entry is the ⚠ above
   * happening for real. `policy-tape.tsx` painted `IQ_BAND_HEX` (light-surface colours) directly on
   * `bg-teal900` at 15px/600 — normal text, 4.5:1 required — and measured 2.99 / 3.01 / 4.17 / 3.73
   * / 2.47. Band 0, the "avoid this policy" signal, was the least legible thing on the strip at
   * 2.47:1. Exactly the mistake the warning block predicted, in the exact file it names.
   *
   * These are LIGHTENED rather than darkened because the surface is dark, which is the whole point
   * of the token split. Measured on #0E3A3A: 65 → 4.61, 50 → 4.64, 30 → 4.63, 15 → 4.60, 0 → 4.60,
   * against `up` 5.84 and `down` 5.37 as the proven precedent for what reads on this ground.
   *
   * NO CSS TWIN, unlike the four keys above: the tape paints these through a React `style` prop,
   * never a class, so there is nothing for a custom property to feed. The mirror test below asserts
   * the four that DO have twins; the contrast test asserts all of these.
   */
  band: {
    '65': '#3AB08C',
    '50': '#23B0A4',
    '30': '#D49020',
    '15': '#E7816D',
    '0': '#D88881',
  },
} as const;

/**
 * THE GLOBAL FOCUS-RING COLOUR (audit C-6, 2026-08-14). `globals.css` had NO `:focus-visible` rule
 * at all — verified, the only `focus` occurrence in that file was a comment — so every control that
 * set `outline: none` inline (both mobile text inputs, including the mobile app's PRIMARY SEARCH
 * FIELD) gave a keyboard user zero indication of focus.
 *
 * ONE colour has to work on both grounds this app paints on, which pins it to a narrow band: to
 * clear 3:1 (1.4.11, non-text) against BOTH `surface` #FFFFFF and `teal900` #0E3A3A, its relative
 * luminance must sit between 0.203 and 0.300. #2F9A90 measures 0.257 — 3.42:1 on white, 3.65:1 on
 * teal900. A darker teal fails the dark strip; a lighter one fails white. That is why this is its
 * own token and not `teal500` (4.15 on white but only 3.01 on teal900) or `TAPE_PALETTE.up` (5.84
 * on teal900 but 2.13 on white — invisible on every light surface in the app).
 */
export const FOCUS_RING_HEX = '#2F9A90';

/**
 * Staged-reveal per-item animation delay (ms), CAPPED so the total stagger stays bounded no matter how
 * many siblings render — the design-system's `min(i, 3) * 60ms` rule in one place. Pair with the
 * `animate-ths-reveal` utility (Tailwind) / inline `animationDelay`. Collapses under
 * prefers-reduced-motion via the global reset in globals.css.
 */
export function staggerDelayMs(index: number): number {
  return Math.min(Math.max(index, 0), 3) * 60;
}
