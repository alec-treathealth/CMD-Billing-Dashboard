/**
 * Qualify RATING v2 — the five-factor weighted model (qualify-v2-build-plan §5), renormalized to the
 * factors that actually have data. PURE + CLIENT-SAFE: every input is a percentage, a count, a day
 * count, an enum, or a date string — NEVER a dollar amount — so an admissions_seat session
 * (server-stripped of all dollar fields) derives the IDENTICAL rating, band, and factor list. That is
 * the same invariant rating.ts v1 carries, extended to the multi-factor model; the wire-level tests
 * in test/qualifyCoreV2.test.ts prove it end-to-end.
 *
 * VERDICT SCALE — the billing team's own IQ bands (65%+ / 50%+ / 30%+ / 15%+ / 0%), adopted from the
 * monday census IQ column (verified ~38% populated, 2026-08-03) instead of inventing a second
 * Strong/Watch/Weak vocabulary. rating.ts v1's 50/30 buckets stay exported for surfaces not yet
 * migrated; every v2 surface renders the IQ band.
 *
 * FACTORS (weights sum 100; renormalized over the AVAILABLE set):
 *   coding          30  registry lifecycle × decision age (Phase A). UNAVAILABLE until the registry
 *                       is seeded (scoring every facility 0/30 for OUR unseeded table would punish
 *                       facilities for missing ops work); once seeded, a payer+facility with NO row
 *                       scores 0 — "the combo is unproven" is a real signal, and it says so.
 *   claims          25  the v1 value-first signal: dollar-weighted reliable allowed ÷ billed
 *                       (tier e2 excluded upstream). pctAllowed null → the WHOLE rating is null
 *                       (neutral) — confidence math must never manufacture a number where the money
 *                       evidence is absent.
 *   dataConfidence  20  sample × window-age × provenance, each multiplicative and each disclosed.
 *                       This replaces the hidden auto-window ladder as the honesty mechanism: an
 *                       auto-widened window is not free — it costs confidence, visibly.
 *   ttp             15  median days from service to payment over PAID lines (the rollup windows on
 *                       payment_received, so unpaid claims are structurally invisible here — the
 *                       detail string says so rather than pretending otherwise).
 *   authFit         10  avg length of stay vs avg authorized days (monday census aggregates,
 *                       Phase G). Overrun-only penalty: finishing under auth is fine.
 *
 * SUPPRESSION: below QUALIFY_RATING_MIN_PATIENTS distinct patients the rating is null regardless of
 * factor scores (sampleGate.ts is the single source of that floor) — a number built on 2 people is
 * noise wearing a color. Factors are still returned so the card can show "what we do have".
 */
import {
  QUALIFY_RATING_MIN_PATIENTS,
  QUALIFY_RATING_CONFIDENT_PATIENTS,
} from './sampleGate';

// ── IQ verdict bands ─────────────────────────────────────────────────────────────────────────────

/** The five IQ bands, strongest first. The key is the band's floor as a string. */
export type QualifyIqBand = '65' | '50' | '30' | '15' | '0';

export const IQ_BAND_ORDER: readonly QualifyIqBand[] = ['65', '50', '30', '15', '0'];

/** Band floor values (rating >= floor ⇒ that band, checked strongest-first). */
export const IQ_BAND_FLOORS: Record<QualifyIqBand, number> = { '65': 65, '50': 50, '30': 30, '15': 15, '0': 0 };

/** The team's own labels — rendered verbatim so the app and the census boards speak one scale. */
export const IQ_BAND_LABELS: Record<QualifyIqBand, string> = {
  '65': '65%+',
  '50': '50%+',
  '30': '30%+',
  '15': '15%+',
  '0': '0%',
};

/** Short verdict word paired with the band (the pill next to the numeral). */
export const IQ_BAND_VERDICTS: Record<QualifyIqBand, string> = {
  '65': 'Strong',
  '50': 'Solid',
  '30': 'Watch',
  '15': 'Weak',
  '0': 'Avoid',
};

/** Map a 0-100 rating to its IQ band; null rating → null (Not rated — render restraint, no color). */
export function iqBandOf(rating: number | null): QualifyIqBand | null {
  if (rating === null || Number.isNaN(rating)) return null;
  if (rating >= 65) return '65';
  if (rating >= 50) return '50';
  if (rating >= 30) return '30';
  if (rating >= 15) return '15';
  return '0';
}

// ── Provenance (Phase B) ─────────────────────────────────────────────────────────────────────────

/** What the rating's evidence is built ON — the §6 provenance tier. 'comparable_funding' replaces the
 *  plan's 'state+funding' rung: member_benefits_latest carries NO state column (verified 2026-08-03),
 *  so the honest fallback is the funding market alone, and the label says exactly that. */
export type QualifyProvenance = 'direct' | 'comparable_employer' | 'comparable_funding' | 'none';

export const PROVENANCE_LABELS: Record<QualifyProvenance, string> = {
  direct: "this policy's own claims",
  comparable_employer: 'estimated from members on the same employer plan',
  comparable_funding: 'estimated from the same funding market',
  none: 'no claims evidence',
};

// ── Coding lifecycle (Phase A — the Test Status enum, verbatim from the sheet) ───────────────────

export type CodingLifecycle =
  | 'CONFIRMED CODES'
  | 'FINALIZED CODES'
  | 'CONTINUE TESTS'
  | 'OPEN TEST'
  | 'UPCOMING TEST'
  | 'CLOSED'
  | 'DISCONTINUED'
  | 'DISCONTINUE - DID NOT WORK';

export const CODING_LIFECYCLES: readonly CodingLifecycle[] = [
  'CONFIRMED CODES',
  'FINALIZED CODES',
  'CONTINUE TESTS',
  'OPEN TEST',
  'UPCOMING TEST',
  'CLOSED',
  'DISCONTINUED',
  'DISCONTINUE - DID NOT WORK',
];

/** Lifecycle → base trust (before decision-age decay). CONFIRMED/FINALIZED are the team saying "this
 *  combo pays"; the test states grade down; the discontinued states say the combo actively failed. */
const LIFECYCLE_SCORE: Record<CodingLifecycle, number> = {
  'CONFIRMED CODES': 1,
  'FINALIZED CODES': 1,
  'CONTINUE TESTS': 0.6,
  'OPEN TEST': 0.45,
  'UPCOMING TEST': 0.25,
  CLOSED: 0.35,
  DISCONTINUED: 0.1,
  'DISCONTINUE - DID NOT WORK': 0.05,
};

/** Decision-age decay: full trust through AGE_FULL_DAYS, then linear down to AGE_FLOOR at
 *  AGE_STALE_DAYS (≈14 months — the plan's "a decision 14 months stale scores low"). */
const CODING_AGE_FULL_DAYS = 90;
const CODING_AGE_STALE_DAYS = 420;
const CODING_AGE_FLOOR = 0.4;

function codingAgeMultiplier(ageDays: number): number {
  // Non-finite (unknown / unparseable decision date) is treated as STALE, never fresh — an undated
  // decision must not outscore a dated one.
  if (!Number.isFinite(ageDays)) return CODING_AGE_FLOOR;
  if (ageDays <= CODING_AGE_FULL_DAYS) return 1;
  if (ageDays >= CODING_AGE_STALE_DAYS) return CODING_AGE_FLOOR;
  const span = CODING_AGE_STALE_DAYS - CODING_AGE_FULL_DAYS;
  return 1 - (1 - CODING_AGE_FLOOR) * ((ageDays - CODING_AGE_FULL_DAYS) / span);
}

// ── Factor machinery ─────────────────────────────────────────────────────────────────────────────

export type QualifyFactorKey = 'coding' | 'claims' | 'dataConfidence' | 'ttp' | 'authFit';

/** Nominal weights (sum 100). Renormalized over the available set at compute time. */
export const QUALIFY_FACTOR_WEIGHTS: Record<QualifyFactorKey, number> = {
  coding: 30,
  claims: 25,
  dataConfidence: 20,
  ttp: 15,
  authFit: 10,
};

export const QUALIFY_FACTOR_LABELS: Record<QualifyFactorKey, string> = {
  coding: 'Coding decision confidence',
  claims: 'Claims reliability',
  dataConfidence: 'Data confidence',
  ttp: 'Time to payment',
  authFit: 'Auth / LOS fit',
};

export type QualifyFactorDirection = 'pos' | 'neg' | 'neu';

/** One factor's reading — everything the card needs to show its work. NON-DOLLAR by construction:
 *  `detail` is generated below from counts/percentages/day-counts only. */
export interface QualifyFactorReading {
  key: QualifyFactorKey;
  label: string;
  /** Nominal weight (the §5 table value) — the weight BAR renders these; the rating math uses the
   *  renormalized share (weight ÷ availableWeight). */
  weight: number;
  /** 0..1 achieved score. Null only when available=false (excluded from the denominator). */
  score: number | null;
  available: boolean;
  direction: QualifyFactorDirection;
  detail: string;
}

/** TTP scoring bounds: ≤ FAST days scores 1.0, ≥ SLOW scores 0, linear between. Tunable. */
export const TTP_FAST_DAYS = 21;
export const TTP_SLOW_DAYS = 120;

/** Window-age multiplier for data confidence — how far back the window had to reach. A rating built
 *  on a year of history is disclosed as weaker evidence of CURRENT behavior than a 30-day read. */
export function windowAgeMultiplier(windowDays: number): number {
  if (!Number.isFinite(windowDays) || windowDays <= 30) return 1;
  if (windowDays <= 60) return 0.95;
  if (windowDays <= 90) return 0.9;
  if (windowDays <= 180) return 0.75;
  if (windowDays <= 270) return 0.65;
  return 0.55;
}

const PROVENANCE_MULT: Record<QualifyProvenance, number> = {
  direct: 1,
  comparable_employer: 0.7,
  comparable_funding: 0.45,
  none: 0,
};

/** Everything computeRatingV2 consumes. NO dollar fields exist on this type — that absence IS the
 *  blind-parity invariant, enforced structurally exactly like rating.ts v1's pctAllowed-only arg. */
export interface QualifyRatingV2Input {
  // claims reliability
  pctAllowed: number | null;
  lineCount: number;
  confirmedClaims: number;
  // sample / data confidence
  distinctPatients: number;
  windowDays: number;
  provenance: QualifyProvenance;
  // coding (Phase A)
  registrySeeded: boolean;
  codingLifecycle: CodingLifecycle | null;
  codingDecidedOn: string | null; // ISO date
  codingCodesLabel: string | null; // e.g. 'H0017 / 0158' — display only
  // time to payment (rollup-derived, paid lines only)
  medianDaysToPayment: number | null;
  // auth / LOS fit (monday census aggregates, Phase G)
  avgAuthDays: number | null;
  avgLosDays: number | null;
  /** Injectable clock for the coding-age decay (tests pin it). */
  now?: Date;
}

export interface QualifyRatingV2 {
  /** 0-100 over the available weights; null when suppressed (sample floor) or when the money
   *  evidence is absent (pctAllowed null). */
  rating: number | null;
  band: QualifyIqBand | null;
  factors: QualifyFactorReading[];
  /** Sum of the available factors' nominal weights (the renormalization denominator, e.g. 45/75/100).
   *  The card disclosure: "scored on N of 100 weighting". */
  availableWeight: number;
  /** True when distinctPatients < the sample floor — the honest-restraint card state. */
  insufficientSample: boolean;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function directionOf(score: number): QualifyFactorDirection {
  if (score >= 0.7) return 'pos';
  if (score < 0.4) return 'neg';
  return 'neu';
}

function daysBetween(fromIso: string, now: Date): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  if (Number.isNaN(from)) return Number.POSITIVE_INFINITY; // unparseable date → treat as fully stale
  return Math.max(0, Math.floor((now.getTime() - from) / 86_400_000));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Compute the five-factor rating. Deterministic, dollar-free, and total: every input combination
 * yields a well-formed result (nulls where honesty demands them, never NaN on the wire).
 */
export function computeRatingV2(input: QualifyRatingV2Input): QualifyRatingV2 {
  const now = input.now ?? new Date();
  const patients = Number.isFinite(input.distinctPatients) && input.distinctPatients > 0 ? Math.trunc(input.distinctPatients) : 0;
  const insufficientSample = patients < QUALIFY_RATING_MIN_PATIENTS;
  const factors: QualifyFactorReading[] = [];

  // — coding (30) ————————————————————————————————————————————————————————————
  if (!input.registrySeeded) {
    factors.push({
      key: 'coding',
      label: QUALIFY_FACTOR_LABELS.coding,
      weight: QUALIFY_FACTOR_WEIGHTS.coding,
      score: null,
      available: false,
      direction: 'neu',
      detail: 'Code decision registry not yet seeded — this factor joins the score once the billing team’s matrix is loaded.',
    });
  } else if (input.codingLifecycle === null) {
    factors.push({
      key: 'coding',
      label: QUALIFY_FACTOR_LABELS.coding,
      weight: QUALIFY_FACTOR_WEIGHTS.coding,
      score: 0,
      available: true,
      direction: 'neg',
      detail: 'No code decision on file for this payer at this facility — the billing combo is unproven.',
    });
  } else {
    const base = LIFECYCLE_SCORE[input.codingLifecycle] ?? 0;
    const ageDays = input.codingDecidedOn ? daysBetween(input.codingDecidedOn, now) : Number.POSITIVE_INFINITY;
    const aged = clamp01(base * codingAgeMultiplier(ageDays));
    const ageNote = Number.isFinite(ageDays) ? `decided ${ageDays}d ago` : 'decision date unknown';
    const codes = input.codingCodesLabel ? ` (${input.codingCodesLabel})` : '';
    factors.push({
      key: 'coding',
      label: QUALIFY_FACTOR_LABELS.coding,
      weight: QUALIFY_FACTOR_WEIGHTS.coding,
      score: aged,
      available: true,
      direction: directionOf(aged),
      detail: `${input.codingLifecycle}${codes} — ${ageNote}.`,
    });
  }

  // — claims reliability (25) ————————————————————————————————————————————————
  const pct = input.pctAllowed;
  const claimsScore = pct === null || Number.isNaN(pct) ? null : clamp01(pct / 100);
  factors.push({
    key: 'claims',
    label: QUALIFY_FACTOR_LABELS.claims,
    weight: QUALIFY_FACTOR_WEIGHTS.claims,
    score: claimsScore,
    available: claimsScore !== null,
    direction: claimsScore === null ? 'neu' : directionOf(claimsScore),
    detail:
      claimsScore === null
        ? 'No reliable allowed evidence in this window — nothing to rate the payer’s payment behavior on.'
        : `${round1(pct as number)}% of billed allowed across ${input.lineCount} line${input.lineCount === 1 ? '' : 's'} (${input.confirmedClaims} confirmed-tier).`,
  });

  // — data confidence (20) ———————————————————————————————————————————————————
  const sampleMult = patients >= QUALIFY_RATING_CONFIDENT_PATIENTS ? 1 : patients >= QUALIFY_RATING_MIN_PATIENTS ? 0.6 : 0.25;
  const ageMult = windowAgeMultiplier(input.windowDays);
  const provMult = PROVENANCE_MULT[input.provenance] ?? 0;
  const confScore = clamp01(sampleMult * ageMult * provMult);
  factors.push({
    key: 'dataConfidence',
    label: QUALIFY_FACTOR_LABELS.dataConfidence,
    weight: QUALIFY_FACTOR_WEIGHTS.dataConfidence,
    score: confScore,
    available: true,
    direction: directionOf(confScore),
    detail: `${patients} distinct patient${patients === 1 ? '' : 's'} · window reached ${Math.max(0, Math.trunc(input.windowDays))}d · ${PROVENANCE_LABELS[input.provenance] ?? PROVENANCE_LABELS.none}.`,
  });

  // — time to payment (15) ———————————————————————————————————————————————————
  const median = input.medianDaysToPayment;
  if (median === null || !Number.isFinite(median)) {
    factors.push({
      key: 'ttp',
      label: QUALIFY_FACTOR_LABELS.ttp,
      weight: QUALIFY_FACTOR_WEIGHTS.ttp,
      score: null,
      available: false,
      direction: 'neu',
      detail: 'No service-to-payment timing available for this slice.',
    });
  } else {
    const m = Math.max(0, median);
    const ttpScore = clamp01((TTP_SLOW_DAYS - m) / (TTP_SLOW_DAYS - TTP_FAST_DAYS));
    factors.push({
      key: 'ttp',
      label: QUALIFY_FACTOR_LABELS.ttp,
      weight: QUALIFY_FACTOR_WEIGHTS.ttp,
      score: ttpScore,
      available: true,
      direction: directionOf(ttpScore),
      detail: `Median ${Math.round(m)} days from service to payment — paid lines only; claims still unresolved are not visible on this axis.`,
    });
  }

  // — auth / LOS fit (10) ————————————————————————————————————————————————————
  const auth = input.avgAuthDays;
  const los = input.avgLosDays;
  if (auth === null || los === null || !Number.isFinite(auth) || !Number.isFinite(los) || auth <= 0) {
    factors.push({
      key: 'authFit',
      label: QUALIFY_FACTOR_LABELS.authFit,
      weight: QUALIFY_FACTOR_WEIGHTS.authFit,
      score: null,
      available: false,
      direction: 'neu',
      detail: 'No authorization / length-of-stay data for this facility.',
    });
  } else {
    const fit = los <= auth ? 1 : clamp01(1 - (los - auth) / auth);
    factors.push({
      key: 'authFit',
      label: QUALIFY_FACTOR_LABELS.authFit,
      weight: QUALIFY_FACTOR_WEIGHTS.authFit,
      score: fit,
      available: true,
      direction: directionOf(fit),
      detail: `Avg length of stay ${round1(los)}d vs ${round1(auth)}d authorized.`,
    });
  }

  const availableFactors = factors.filter((f) => f.available && f.score !== null);
  const availableWeight = availableFactors.reduce((s, f) => s + f.weight, 0);

  // Money evidence absent OR sample below the floor → no number, honestly.
  const suppressed = insufficientSample || claimsScore === null || availableWeight <= 0;
  const rating = suppressed
    ? null
    : Math.round((availableFactors.reduce((s, f) => s + f.weight * (f.score as number), 0) / availableWeight) * 100);

  return {
    rating,
    band: iqBandOf(rating),
    factors,
    availableWeight,
    insufficientSample,
  };
}
