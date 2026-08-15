/**
 * Qualify MOBILE bucket presentation (Prompt 4b) — PURE, client-safe, light-scheme. The tints below
 * originated in the light swipe-list prototype, which was DELETED 2026-07-28: the per-row swipe
 * gesture it demonstrated was reverted (see swipe-row.tsx — the row is a plain tappable card again),
 * so the mock no longer described shipped behaviour. The tints survived the revert. Derives the bucket from
 * `ratingBucket` (rating.ts — the ONE source of the 50/30 cutoffs, on the allowed%); this maps bucket →
 * the mobile tint / color / short label only. It does NOT re-derive the rating formula.
 *
 * These tints are the mobile-specific values from the prototype (light backgrounds behind the
 * facility icon), deliberately distinct from desktop's `.q-*-wash`. Relative imports so this and its
 * consumers load under tsx in the hermetic render test.
 */
import { ratingBucket, type RatingBucket } from '../../../lib/qualify/rating';

export type { RatingBucket };

export interface MobileBucketStyle {
  /** icon stroke + rating number/label text */
  color: string;
  /** light background tint behind the facility icon */
  tint: string;
  /** compact badge label (prototype uses the short form) */
  label: string;
}

/**
 * ⚠ THE `color` VALUES ARE DARKENED AGAINST THEIR OWN TINT (audit M4 / M5, 2026-08-14), NOT AGAINST
 * WHITE. Every one of these four bucket styles used to fail 4.5:1 on the tint it ships with — ok
 * 3.68, warn 2.67, danger 4.35, neutral 3.79 — and the tint is where they actually render (behind
 * the facility icon, in the KPI tiles). They also paint the VERDICT WORD at 12px on white
 * (swipe-row), which is small text. So both surfaces bind, and the darker of the two wins.
 * Mirrors tokens.ts RATING_HEX exactly; a drift test pins the pair.
 *
 * The rating NUMBER at 20px/700 qualified as large text and passed all along — the verdict word
 * beneath it did not, and the verdict word is the part a rep actually reads.
 */
const STYLES: Record<RatingBucket, MobileBucketStyle> = {
  ok: { color: '#287860', tint: '#EAF3EE', label: 'Strong' },
  warn: { color: '#936316', tint: '#FBF1E0', label: 'Typical' },
  danger: { color: '#B64138', tint: '#FBEAEA', label: 'Weak' },
  neutral: { color: '#5F6D6C', tint: '#EFEDE7', label: '—' },
};

export function mobileBucketStyle(rating: number | null): MobileBucketStyle {
  return STYLES[ratingBucket(rating)];
}

// ── Rating v2 (IQ bands) ─────────────────────────────────────────────────────────────────────────
// The billing team's own 65/50/30/15/0 census scale (ratingV2.ts). Hexes mirror tokens.ts
// IQ_BAND_HEX/WASH; the label is the verdict + the band the team already speaks.
import { IQ_BAND_LABELS, IQ_BAND_VERDICTS, type QualifyIqBand } from '../../../lib/qualify/ratingV2';

/** Same darkening as STYLES above and for the same reason; mirrors tokens.ts IQ_BAND_HEX exactly.
 *  Band 15 is #AD4F2A rather than the pure lightness-solve #C43B20 so it stays visually separable
 *  from band 0's red — see the tier-separation note in tokens.ts IQ_BAND_HEX. */
const IQ_STYLES: Record<QualifyIqBand, MobileBucketStyle> = {
  '65': { color: '#287860', tint: '#EAF3EE', label: `${IQ_BAND_VERDICTS['65']} ${IQ_BAND_LABELS['65']}` },
  '50': { color: '#197A72', tint: '#EAF4F2', label: `${IQ_BAND_VERDICTS['50']} ${IQ_BAND_LABELS['50']}` },
  '30': { color: '#936316', tint: '#FBF1E0', label: `${IQ_BAND_VERDICTS['30']} ${IQ_BAND_LABELS['30']}` },
  '15': { color: '#AD4F2A', tint: '#FCEDE8', label: `${IQ_BAND_VERDICTS['15']} ${IQ_BAND_LABELS['15']}` },
  '0': { color: '#B64138', tint: '#FBEAEA', label: `${IQ_BAND_VERDICTS['0']} ${IQ_BAND_LABELS['0']}` },
};

/** v2 style: IQ band when rated; the neutral v1 style when not. Mobile renders ONE scale — the
 *  band — with the v1 bucket style kept only as the unrated fallback. */
export function mobileIqStyle(band: QualifyIqBand | null): MobileBucketStyle {
  return band === null ? STYLES.neutral : IQ_STYLES[band];
}
