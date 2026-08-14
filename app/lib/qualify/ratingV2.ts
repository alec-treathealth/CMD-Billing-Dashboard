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

/**
 * Minimum clients behind EACH auth-fit average before the factor is worth scoring. Mirrors
 * QUALIFY_LOS_MIN_SAMPLE in src/collections/qualifyCensus.ts and, through it, the lower tier of
 * sampleGate.ts (QUALIFY_RATING_MIN_PATIENTS = 3) — one vocabulary for "too few to score", not
 * three. Declared here rather than imported because ratingV2 is pure app-side contract code and
 * must not reach into the ingest package; the pairing is pinned by a test.
 */
export const QUALIFY_AUTH_FIT_MIN_SAMPLE = 3;

/**
 * How many days a completed-stays row may go unsynced before the factor calls it STALE in words.
 * The sync is DAILY, so anything past a week is an operational failure rather than jitter — measured
 * 2026-08-12, when it had been failing for 6 consecutive days against a source host that had gone
 * away, and 12 of 48 facilities were scoring on frozen rows with nothing on screen saying so.
 */
export const QUALIFY_OUTCOMES_FRESH_DAYS = 7;

/** Whole days between two ISO dates (UTC, date-only). Negative (a future stamp) reads as 0. */
function daysSinceIso(fromIso: string, todayIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(today)) return null;
  return Math.max(0, Math.floor((today - from) / 86_400_000));
}

/**
 * True when either side of the auth-fit ratio is built on too few clients. `undefined` means the
 * sample was never measured (a pre-0088 row, or a caller that does not supply it) — that must NOT
 * suppress, or every facility would lose the factor the moment the column was added and before the
 * first sync repopulated it.
 */
export function censusSampleBelowFloor(authSample?: number | null, losSample?: number | null): boolean {
  const known = (n?: number | null): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!known(authSample) && !known(losSample)) return false;
  const auth = known(authSample) ? authSample : Number.POSITIVE_INFINITY;
  const los = known(losSample) ? losSample : Number.POSITIVE_INFINITY;
  return Math.min(auth, los) < QUALIFY_AUTH_FIT_MIN_SAMPLE;
}

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
  /** False on the comparable-cohort path: no payer was resolved, and code decisions are
   *  payer-scoped — the factor is excluded (renormalized away) rather than scored 0 against a
   *  lookup that could never succeed. Default true. */
  payerKnown?: boolean;
  /**
   * IDENTIFIER-WIDE mode (the v3 Skip, 2026-08-07): `payerKnown` is false because the ranking spans
   * EVERY label the identifier bills under, not because none resolved. Only the WORDS differ — the
   * factor is excluded either way — but the words are the whole point. Excluding a 30-weight factor
   * renormalizes the other four, so the SAME facility scores differently under an all-payers ranking
   * than under a payer-scoped one. An operator who runs both and is told "no payer resolved" on a
   * screen that is visibly ranking several payers has been handed a contradiction; told the truth,
   * they have an explanation. Default false.
   */
  payerScopeAll?: boolean;
  /** Distinct billed-under labels behind THIS facility's rows — the blend's size. 1 under a
   *  payer-scoped read by construction. Only read when `payerScopeAll` is true; default 1. */
  payerCount?: number;
  codingLifecycle: CodingLifecycle | null;
  codingDecidedOn: string | null; // ISO date
  codingCodesLabel: string | null; // e.g. 'H0017 / 0158' — display only
  // time to payment (rollup-derived, paid lines only)
  medianDaysToPayment: number | null;
  // auth / LOS fit (monday census aggregates, Phase G)
  avgAuthDays: number | null;
  avgLosDays: number | null;
  /** Which monday census family fed the aggregates above, or null when the facility has no census
   *  row. OUTPATIENT SUPPRESSES THE AUTH/LOS FACTOR ENTIRELY — see the factor body for why. */
  censusFamily?: 'residential' | 'outpatient' | null;
  /** How many admitted clients each census average was computed over (0078 / 0088). The factor is a
   *  RATIO of the two, so BOTH need a floor — gating only the LOS side lets the same noise back in
   *  through the denominator. Measured: TREAT_TX carried ONE Total Auth Days value across 47
   *  admits. Absent (undefined) means "not measured", which does not suppress — a facility with no
   *  census row is handled by the null-input branch below. */
  authSample?: number | null;
  losSample?: number | null;
  /** WHICH measurement avgLosDays is. 'completed' = finished admissions with a real discharge date
   *  (collections.qualify_facility_outcomes); 'in_progress' = the monday census snapshot of
   *  currently-admitted clients, where LOS is today-minus-admit and therefore reads systematically
   *  low. Null/absent = unstated, and the detail simply omits the note rather than guessing. */
  losBasis?: 'completed' | 'in_progress' | null;
  /** Trailing window (days) the completed-stay averages were measured over — shown so the number is
   *  self-describing. Ignored unless losBasis is 'completed'. */
  losWindowDays?: number | null;
  /** The date the completed-stay averages were last SYNCED (audit 2026-08-12, P0-5). Ignored unless
   *  losBasis is 'completed'; null/absent omits the clause rather than guessing. See the basisNote
   *  below for why this is disclosed rather than used to suppress. */
  losAsOf?: string | null;
  /** "Today", for measuring that staleness. Defaults to `now` — injectable only so the two clocks in
   *  this function stay a single testable input. */
  losAsOfToday?: string | null;
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
/**
 * FACTORS DISAGREE — at least one live factor reads positive AND at least one reads negative.
 *
 * This is the case the scorecard earns its keep on, and the one a single blended numeral hides: a
 * facility with a strong allowed rate and a terrible claim-status mix rates mid-band, and "mid" is
 * exactly the wrong summary of it. The card badges it so the rep opens the reasoning instead of
 * reading the number and moving on.
 *
 * `available` matters: an unavailable factor is missing data, not a negative signal, so it can
 * neither create nor resolve a disagreement. Pure, non-dollar, shared by the card and the AI chip
 * logic so the two cannot drift on what "conflict" means.
 */
export function facilityFactorsDisagree(factors: readonly QualifyFactorReading[]): boolean {
  let pos = false;
  let neg = false;
  for (const f of factors) {
    if (!f.available) continue;
    if (f.direction === 'pos') pos = true;
    else if (f.direction === 'neg') neg = true;
    if (pos && neg) return true;
  }
  return false;
}

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
  } else if (input.payerKnown === false) {
    // Comparable-cohort (estimated) reads carry no resolved payer; a payer-scoped lookup can never
    // succeed, so exclude rather than uniformly dragging every estimate to 0/30 (review finding #13).
    //
    // IDENTIFIER-WIDE reads reach the same exclusion for the OPPOSITE reason — several payers, not
    // none — and say so, because excluding a 30-weight factor renormalizes the rest and this is the
    // only place that can explain why the same facility scores differently across the two scopes.
    factors.push({
      key: 'coding',
      label: QUALIFY_FACTOR_LABELS.coding,
      weight: QUALIFY_FACTOR_WEIGHTS.coding,
      score: null,
      available: false,
      direction: 'neu',
      detail: input.payerScopeAll
        ? 'Ranked across every payer this member bills under — code decisions are payer-scoped, so this factor is excluded rather than blended. Scoping to one label with the BILLED UNDER chips brings it back, and can move the score.'
        : 'No payer resolved for this estimated read — code decisions are payer-scoped, so this factor is excluded rather than guessed.',
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
  //
  // ⚠ THIS IS THE FACTOR THAT CARRIES THE BLENDED NUMBER, so it is the factor that must disclose the
  // blend (2026-08-07). `pctAllowed` under an identifier-wide ranking is dollar-weighted across EVERY
  // billed-under label behind the facility's rows — and this sentence lives inside "Why this score",
  // which is exactly where an operator goes to interrogate a percentage they do not trust. Saying
  // "62% of billed allowed" there, unqualified, presents a cross-label blend as one payer's payment
  // behaviour: the precise claim Alec's ruling forbids, in the precise place it does the most damage.
  // The COUNT rides in the sentence because a blend of two is a different thing from a blend of nine.
  const pct = input.pctAllowed;
  const claimsScore = pct === null || Number.isNaN(pct) ? null : clamp01(pct / 100);
  // THREE states, not two — see the derivation note in core.ts assembleFacilities. Zero is not "one";
  // reassuring the operator that "nothing is blended here" when the rows carry no label at all is a
  // claim about attribution that nothing supports.
  const blendLabels = Math.max(0, Math.trunc(input.payerCount ?? 1));
  const blendNote = !input.payerScopeAll
    ? ''
    : blendLabels > 1
      ? ` Blended across ${blendLabels} billed-under labels — this is what the member's claims allowed here, NOT one payer's rate; scope to one label to un-blend.`
      : blendLabels === 1
        ? ' Ranked across all payers; this facility billed the member under one label only, so nothing is blended here.'
        : ' Ranked across all payers, but these rows carry no billed-under label at all — there is nothing to attribute this percentage to.';
  factors.push({
    key: 'claims',
    label: QUALIFY_FACTOR_LABELS.claims,
    weight: QUALIFY_FACTOR_WEIGHTS.claims,
    score: claimsScore,
    available: claimsScore !== null,
    direction: claimsScore === null ? 'neu' : directionOf(claimsScore),
    detail:
      claimsScore === null
        ? // "the payer's" presumes a single payer, which an all-payers read does not have.
          `No reliable allowed evidence in this window — nothing to rate ${input.payerScopeAll ? 'payment behaviour' : 'the payer’s payment behavior'} on.`
        : `${round1(pct as number)}% of billed allowed across ${input.lineCount} line${input.lineCount === 1 ? '' : 's'} (${input.confirmedClaims} confirmed-tier).${blendNote}`,
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
  if (input.censusFamily === 'outpatient') {
    /* OUTPATIENT IS NOT SCORED ON AUTH/LOS. Ruling 2026-08-05, on measured evidence rather than
     * preference: on the outpatient census boards, `Total Auth Days` / `Next UR Date` are maintained
     * on 0-29% of CURRENTLY-admitted clients (median ~5%) (TREAT_CA 3 of 54, FRCA 2 of 7, TREAT_TX 2 of 47,
     * TELEHEALTH_MH 0 of 13), the few that carry one are stale rows whose ADM dates sit 8 months
     * behind the admitted median, and ZERO admitted clients on any of those boards carry a DC date —
     * so every outpatient LOS is an open-ended today-minus-admit that grows without bound.
     * Scoring that produced a full 10-point penalty (authFit 0) at FRCA, TREAT_CA and TREAT_TX off
     * two or three abandoned rows.
     * Outpatient enrolment is also not the same quantity as an authorized episode — a self-pay
     * client can stay enrolled with no payer involvement — so even with perfect data the comparison
     * needs its own definition. Until the boards maintain authorization and discharge dates, the
     * honest reading is "we do not measure this here", not a zero. The weight renormalizes over the
     * remaining factors, so an outpatient facility is not penalised for the suppression. */
    factors.push({
      key: 'authFit',
      label: QUALIFY_FACTOR_LABELS.authFit,
      weight: QUALIFY_FACTOR_WEIGHTS.authFit,
      score: null,
      available: false,
      direction: 'neu',
      detail:
        'Not scored for outpatient — authorization and discharge dates are not maintained on the outpatient census boards, so length of stay there is not a measure of authorized care.',
    });
  } else if (
    auth !== null &&
    los !== null &&
    Number.isFinite(auth) &&
    Number.isFinite(los) &&
    auth > 0 &&
    censusSampleBelowFloor(input.authSample, input.losSample)
  ) {
    /* TOO THIN TO SCORE. Both averages exist, but at least one is built on fewer than
     * QUALIFY_AUTH_FIT_MIN_SAMPLE clients. This branch is deliberately SEPARATE from the
     * missing-input branch below, and it is deliberately HERE rather than at write time: the sync
     * used to enforce the floor by storing avg_los_days = NULL, which collapsed "withheld as thin"
     * into "absent" and made the copy below assert there was no length-of-stay data about a
     * facility that had some. A scoring threshold belongs in the scoring layer, where the reason can
     * be stated. The table stores what it measured. */
    const n = Math.min(input.authSample ?? 0, input.losSample ?? 0);
    factors.push({
      key: 'authFit',
      label: QUALIFY_FACTOR_LABELS.authFit,
      weight: QUALIFY_FACTOR_WEIGHTS.authFit,
      score: null,
      available: false,
      direction: 'neu',
      detail: `Only ${n} client${n === 1 ? '' : 's'} on file for authorized days or length of stay — too few to score.`,
    });
  } else if (auth === null || los === null || !Number.isFinite(auth) || !Number.isFinite(los) || auth <= 0) {
    // NAME THE INPUT THAT IS ACTUALLY ABSENT. The old copy said "No authorization / length-of-stay
    // data" for every unavailable case, which was actively misleading for months: monday's API
    // returns "" for the LOS formula column, so avg_auth_days was populated (21.11 / 25.17 days on
    // the two instrumented facilities) while avg_los_days was NULL — auth data was fine and only
    // LOS was missing. A factor that misstates which half it lacks sends the operator to the wrong
    // board column.
    const authKnown = auth !== null && Number.isFinite(auth) && auth > 0;
    const losKnown = los !== null && Number.isFinite(los);
    const detail = authKnown
      ? 'Authorized days are on file, but no length-of-stay data for this facility yet.'
      : losKnown
        ? 'Length of stay is on file, but no authorized-days data for this facility yet.'
        : 'No authorization or length-of-stay data for this facility yet.';
    factors.push({
      key: 'authFit',
      label: QUALIFY_FACTOR_LABELS.authFit,
      weight: QUALIFY_FACTOR_WEIGHTS.authFit,
      score: null,
      available: false,
      direction: 'neu',
      detail,
    });
  } else {
    const fit = los <= auth ? 1 : clamp01(1 - (los - auth) / auth);
    /* THE BASIS IS PART OF THE READING, so it is stated rather than assumed.
     *
     * 'completed' means finished admissions with a real discharge date; 'in_progress' means a
     * snapshot of currently-admitted clients, where LOS is today-minus-admit and every stay is
     * unfinished. They are different quantities and they disagree materially — measured 2026-08-06
     * across the twelve residential facilities, the in-progress read put EVERY one below its
     * authorization (0.69-0.96), so the overrun penalty could never fire; on completed stays four
     * are at or over it (10026624 1.10, 10025950 1.05, PCMH 1.03, LSMH 1.00).
     *
     * An operator comparing two facilities has to know which measurement they are looking at, and a
     * facility scored on completed stays is not comparable to one scored on stays in progress. */
    /* STALENESS IS DISCLOSED, NOT SILENTLY SWAPPED (audit 2026-08-12, P0-5). When the outcomes sync
     * stops — it failed for 6 straight days against a source host that had gone away — the tempting
     * fix is to fall back to the census snapshot. That would trade a good-but-old measurement for a
     * known-biased current one (in-progress LOS reads systematically low; the overrun penalty could
     * never fire — measured 2026-08-06), and would do it invisibly, which is the exact defect being
     * fixed. The honest form is the same number with its age said out loud. Fresh rows stay quiet:
     * a daily sync's normal state needs no caption. */
    const asOfAge =
      input.losBasis === 'completed' && input.losAsOf
        ? daysSinceIso(input.losAsOf, input.losAsOfToday ?? now.toISOString().slice(0, 10))
        : null;
    const staleNote =
      asOfAge !== null && asOfAge > QUALIFY_OUTCOMES_FRESH_DAYS
        ? ` Last synced ${input.losAsOf} (${asOfAge}d ago) — the completed-stay feed is stale, so read this as history, not current behaviour.`
        : '';
    const basisNote =
      input.losBasis === 'completed'
        ? ` Completed stays${input.losWindowDays ? `, trailing ${input.losWindowDays}d` : ''}.${staleNote}`
        : input.losBasis === 'in_progress'
          ? ' Based on clients currently admitted, so stays are still running and this reads low.'
          : '';
    factors.push({
      key: 'authFit',
      label: QUALIFY_FACTOR_LABELS.authFit,
      weight: QUALIFY_FACTOR_WEIGHTS.authFit,
      score: fit,
      available: true,
      direction: directionOf(fit),
      detail: `Avg length of stay ${round1(los)}d vs ${round1(auth)}d authorized.${basisNote}`,
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
