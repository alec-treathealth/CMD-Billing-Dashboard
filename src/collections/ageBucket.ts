/**
 * AR age buckets — derived from a charge's service date, NOT parsed from a CMD column.
 *
 * Phase 0 (docs/veris-data-notes.md, 2026-07-28) established that the census feed does NOT carry the
 * pre-bucketed `Charge Fromdate Age` column, but DOES carry `Charge From Date` (ingested as
 * cmd_charge_census.charge_date). So we compute age in whole days as (asOf - charge_date) and bucket it
 * ourselves. This is exact/sortable, needs no CMD-side filter change, and drifts live with the calendar
 * (right for a worklist) rather than freezing at a snapshot instant.
 *
 * The 8 labels are CMD's verbatim closed set (so counts reconcile against the NASH/PCMH worklist sheets,
 * which use these strings). Boundaries: CMD labels "Less than 30" then "31 to 60", leaving day 30
 * ambiguous — we resolve it into bucket `a` (0..30 inclusive), then contiguous 30-day bands, `g` widening
 * to a full year, `h` open-ended. This boundary choice is documented so a reconciliation diff at exactly
 * 30/60/90… days is understood, not mistaken for a bug.
 *
 * Pure and dependency-free: unit-testable in isolation and importable client-side for labels. Lenient by
 * design (mirrors the census mapper, cmdCensus.ts): unknown/blank/unparseable/negative input → null,
 * never a throw — an unknown-age charge is dropped from a bucket, never from the worklist.
 */

export interface AgeBucket {
  /** Stable sort/group key, 'a'..'h' (matches the CMD label prefix). */
  readonly code: string;
  /** CMD-verbatim label — reconciles against the worklist spreadsheets. */
  readonly label: string;
  /** Inclusive lower bound in whole days. */
  readonly minDays: number;
  /** Inclusive upper bound in whole days; null = open-ended ('Over 1 year'). */
  readonly maxDays: number | null;
}

/** The closed set, ascending. Contiguous and exhaustive over all non-negative day counts. */
export const AGE_BUCKETS: readonly AgeBucket[] = [
  { code: 'a', label: 'a) Less than 30 days', minDays: 0, maxDays: 30 },
  { code: 'b', label: 'b) 31 to 60 days', minDays: 31, maxDays: 60 },
  { code: 'c', label: 'c) 61 to 90 days', minDays: 61, maxDays: 90 },
  { code: 'd', label: 'd) 91 to 120 days', minDays: 91, maxDays: 120 },
  { code: 'e', label: 'e) 121 to 150 days', minDays: 121, maxDays: 150 },
  { code: 'f', label: 'f) 151 to 180 days', minDays: 151, maxDays: 180 },
  { code: 'g', label: 'g) 181 to 365 days', minDays: 181, maxDays: 365 },
  { code: 'h', label: 'h) Over 1 year', minDays: 366, maxDays: null },
] as const;

const MS_PER_DAY = 86_400_000;

/**
 * Bucket a whole-day age. `null`/`undefined`/`NaN`/negative/non-integer-usable input → null.
 * A negative age (future service date — should not occur, but the feed is lenient) is unbucketed.
 */
export function bucketForAgeDays(days: number | null | undefined): AgeBucket | null {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return null;
  const d = Math.floor(days);
  for (const b of AGE_BUCKETS) {
    if (d >= b.minDays && (b.maxDays === null || d <= b.maxDays)) return b;
  }
  return null; // unreachable (h is open-ended), but keeps the function total.
}

/** Parse an ISO 'YYYY-MM-DD' at UTC midnight (avoids local-tz / DST drift). Anything else → null. */
function isoDateToUtcMs(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whole-day age between a charge's service date and an as-of date, both at UTC midnight.
 * @param chargeDate ISO 'YYYY-MM-DD' (cmd_charge_census.charge_date), or null.
 * @param asOf       ISO 'YYYY-MM-DD' or a Date. The caller supplies "today" — this module never reads a clock.
 * @returns whole days (asOf - chargeDate), or null if either date is absent/unparseable.
 */
export function ageDays(chargeDate: string | null | undefined, asOf: string | Date): number | null {
  if (chargeDate === null || chargeDate === undefined) return null;
  const chargeMs = isoDateToUtcMs(chargeDate.trim());
  if (chargeMs === null) return null;

  let asOfMs: number | null;
  if (asOf instanceof Date) {
    asOfMs = Number.isNaN(asOf.getTime()) ? null : Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  } else {
    asOfMs = isoDateToUtcMs(asOf.trim());
  }
  if (asOfMs === null) return null;

  return Math.floor((asOfMs - chargeMs) / MS_PER_DAY);
}

/** Convenience: charge service date + as-of → bucket (or null). */
export function ageBucketForCharge(chargeDate: string | null | undefined, asOf: string | Date): AgeBucket | null {
  return bucketForAgeDays(ageDays(chargeDate, asOf));
}
