/**
 * AR Management age bands — the nine aging tiles the AR queue is organised by.
 *
 * WHY A SECOND BAND SET (not src/collections/ageBucket.ts): that module mirrors CMD's verbatim
 * `Charge Fromdate Age` labels (a) … h) so census counts reconcile against CMD exports. The AR
 * Management tab is organised the way the billing team actually works its spreadsheets — Alec's
 * 2026-09-09 request names 31–60d · 61–90d · 91–120d · 4–6mo · 6–9mo · 9mo–1yr · 1–2yr. Those are
 * different bands (CMD has no 6–9mo or 1–2yr), so this is a deliberate second vocabulary, not a
 * drift. The two extra bands (0–30, over 2 years) exist only so the set is EXHAUSTIVE: every open
 * charge lands somewhere, and the 2yr+ tail is where most of the book sits (CAMH alone had 2,897
 * open charges older than two years at recon).
 *
 * AGE AXIS: whole days from the claim's first date of service (`B_CHARGE.FROMDATE`, the same axis
 * CMD's "Charge Fromdate Age" uses) to the business day the page is rendered. Age is computed at
 * READ time (arQuery.ts) so the tiles drift live with the calendar instead of freezing at ingest.
 *
 * Pure and dependency-free: importable client-side for labels and unit-testable in isolation.
 * Lenient like ageBucket.ts — null / NaN / negative → null, never a throw.
 */

export type ArBandKey =
  | '0_30'
  | '31_60'
  | '61_90'
  | '91_120'
  | '4_6mo'
  | '6_9mo'
  | '9_12mo'
  | '1_2yr'
  | '2yr_plus';

export interface ArBand {
  /** Stable key — stored nowhere, used as the filter value and the SQL CASE literal. */
  readonly key: ArBandKey;
  /** Tile label. */
  readonly label: string;
  /** Compact pill label for the grid. */
  readonly short: string;
  /** Inclusive lower bound in whole days. */
  readonly minDays: number;
  /** Inclusive upper bound in whole days; null = open-ended tail. */
  readonly maxDays: number | null;
  /** False only for the not-yet-aged 0–30 band. */
  readonly aged: boolean;
}

/** Ascending, contiguous, exhaustive over every non-negative whole-day age. */
export const AR_BANDS: readonly ArBand[] = [
  { key: '0_30', label: '0–30 days', short: '0–30d', minDays: 0, maxDays: 30, aged: false },
  { key: '31_60', label: '31–60 days', short: '31–60d', minDays: 31, maxDays: 60, aged: true },
  { key: '61_90', label: '61–90 days', short: '61–90d', minDays: 61, maxDays: 90, aged: true },
  { key: '91_120', label: '91–120 days', short: '91–120d', minDays: 91, maxDays: 120, aged: true },
  { key: '4_6mo', label: '4–6 months', short: '4–6mo', minDays: 121, maxDays: 180, aged: true },
  { key: '6_9mo', label: '6–9 months', short: '6–9mo', minDays: 181, maxDays: 270, aged: true },
  { key: '9_12mo', label: '9 months–1 year', short: '9–12mo', minDays: 271, maxDays: 365, aged: true },
  { key: '1_2yr', label: '1–2 years', short: '1–2yr', minDays: 366, maxDays: 730, aged: true },
  { key: '2yr_plus', label: 'Over 2 years', short: '2yr+', minDays: 731, maxDays: null, aged: true },
] as const;

/**
 * The minimum age a claim must reach to appear on the AR queue. Ruled by Alec 2026-09-10: the
 * 0–30 day set "is not needed" — it is money that has not had time to be worked, and it was
 * 2,584 claims / $14.3M of noise at the top of a queue whose purpose is aged AR.
 *
 * ⚠ ENFORCED AT READ, NOT AT INGEST, and that is deliberate. The snapshot still records every
 * claim, so when one crosses 31 days it arrives on the queue WITH its accumulated status history
 * and follow-up notes. Filtering at ingest would make a claim appear on the day it ages in with no
 * history at all — precisely the moment a rep needs the context — and would need a backfill to
 * undo. `0_30` therefore stays in the taxonomy below so the band CASE remains total.
 */
export const AR_MIN_AGE_DAYS = 31;

/**
 * The bands the QUEUE displays — every band except `0_30`, which is filtered out before a row can
 * be classified into it. Distinct from AR_BANDS on purpose: AR_BANDS is the complete taxonomy the
 * SQL CASE must cover (a stray row must classify, never land as null), while this is the tile set.
 */
export const AR_QUEUE_BANDS: readonly ArBand[] = AR_BANDS.filter((b) => b.key !== '0_30');

const KEYS: ReadonlySet<string> = new Set(AR_BANDS.map((b) => b.key));

/** Narrow an untrusted value to a band key. */
export function isArBandKey(v: unknown): v is ArBandKey {
  return typeof v === 'string' && KEYS.has(v);
}

/** Look a band up by key. */
export function arBand(key: ArBandKey): ArBand {
  const b = AR_BANDS.find((x) => x.key === key);
  if (!b) throw new Error(`arBand: unknown key ${key}`); // unreachable for a typed key
  return b;
}

/**
 * Band a whole-day age. null / undefined / NaN / ±Infinity / negative → null (a future-dated or
 * unknown DOS is unbanded, never dropped from the queue — the tile row simply does not count it).
 */
export function bandForAgeDays(days: number | null | undefined): ArBand | null {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return null;
  const d = Math.floor(days);
  for (const b of AR_BANDS) {
    if (d >= b.minDays && (b.maxDays === null || d <= b.maxDays)) return b;
  }
  return null; // unreachable — the tail is open-ended — kept so the function is total.
}

/**
 * The band as a SQL CASE over a caller-supplied age expression, yielding the band KEY as a text
 * literal. `dateExpr` is the DOS column the age was derived from (null-guarded first). Fixed
 * literals only — the caller owns every `$n`; this function mints none.
 */
export function arBandCaseSql(ageDaysExpr: string, dateExpr: string): string {
  const whens = AR_BANDS.filter((b) => b.maxDays !== null)
    .map((b) => `when ${ageDaysExpr} <= ${b.maxDays} then '${b.key}'`)
    .join(' ');
  const tail = AR_BANDS[AR_BANDS.length - 1]!;
  return `case when ${dateExpr} is null then null when ${ageDaysExpr} < 0 then null ${whens} else '${tail.key}' end`;
}

/**
 * Inclusive whole-day bounds for a set of bands, for compiling a band filter into DOS-date
 * predicates the (business_entity_id, dos_from) index can serve. Returns one range per band;
 * the caller ORs them. `maxDays: null` means "no lower DOS bound".
 */
export function arBandDayRanges(keys: readonly ArBandKey[]): Array<{ minDays: number; maxDays: number | null }> {
  return AR_BANDS.filter((b) => keys.includes(b.key)).map((b) => ({ minDays: b.minDays, maxDays: b.maxDays }));
}
