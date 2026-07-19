/**
 * Qualify MOBILE bucket presentation (Prompt 4b) — PURE, client-safe, light-scheme, matching the
 * approved prototype (docs/mockups/qualify-swipe-list-light.html). Derives the bucket from
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

const STYLES: Record<RatingBucket, MobileBucketStyle> = {
  ok: { color: '#2E8B6F', tint: '#EAF3EE', label: 'Strong' },
  warn: { color: '#C9881E', tint: '#FBF1E0', label: 'Typical' },
  danger: { color: '#C0453B', tint: '#FBEAEA', label: 'Weak' },
  neutral: { color: '#6B7B79', tint: '#EFEDE7', label: '—' },
};

export function mobileBucketStyle(rating: number | null): MobileBucketStyle {
  return STYLES[ratingBucket(rating)];
}
