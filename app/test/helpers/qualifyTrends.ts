/**
 * The shared Heating-Up trend fixture.
 *
 * Promoted out of app/test/qualify-render.test.tsx (2026-08-06, F4) so the v3 flow's text-size floor
 * test can render a REAL <HeatingUpCards> as its ticker instead of `null`. One fixture, imported by
 * both files — two copies would drift, and the whole point of the F4 change is that the ticker's
 * markup is actually scanned rather than assumed.
 *
 * Branch coverage is deliberate; keep it if you edit this. Between the three rows:
 *   · careSetting  — 'IP', 'OP', and null (the no-pill branch)
 *   · city/state   — populated and null (the no-location branch)
 *   · deltaPts     — positive, negative, and null (the "NEW" badge branch)
 *   · points       — length 8, 6, and 1 (Spark's `points.length < 2` early return, both ways)
 */
import type { QualifyFacilityTrend } from '../../lib/qualify/contract';

export const TRENDS: QualifyFacilityTrend[] = [
  {
    facilityKey: 'summit ridge', name: 'SUMMIT RIDGE RECOVERY', city: 'Scottsdale', state: 'AZ',
    careSetting: 'IP', entity: 'BXR', dominantPayer: 'AETNA', lineCount: 210,
    currentRating: 68, priorRating: 62.9, deltaPts: 5.1, points: [61, 62, 64, 63, 66, 67, 68, 68],
  },
  {
    facilityKey: 'valley springs', name: 'VALLEY SPRINGS', city: 'Boise', state: 'ID',
    careSetting: 'OP', entity: 'Indigo', dominantPayer: 'CIGNA', lineCount: 96,
    currentRating: 22, priorRating: 26.5, deltaPts: -4.5, points: [27, 26, 25, 24, 23, 22],
  },
  {
    facilityKey: 'fresh face', name: 'FRESH FACE BH', city: null, state: null,
    careSetting: null, entity: null, dominantPayer: 'AETNA', lineCount: 12,
    currentRating: 55, priorRating: null, deltaPts: null, points: [55],
  },
];
