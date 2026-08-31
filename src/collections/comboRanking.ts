/**
 * Pure scoring for the Collections drill-in's (CPT × Revenue-code) combination ranking and the
 * facility CPT/Rev confidence read (WP3, 2026-08-31). No I/O, no query, no JSX — callers feed it
 * aggregates the summary payload ALREADY carries; it never fetches.
 *
 * FORMULA 1 — combo ordering ("recent realized dollars, boosted for per-line earnings"):
 *   â = (n·a_obs + K·a_prior) / (n + K)      — shrunk allowed rate
 *   w = 0.5 ^ (age_days / 45)                — recency decay, half-life 45 days
 *   A = charged × â × w                      — recent realized dollars
 *   E = charged × â / n                      — realized dollars per line
 *   S = A^0.7 × E^0.3                        — the sort key, DESC
 *
 * K is 12, NOT Qualify's 25 — this shrinks over CHARGE LINES, not patients (typical combo n is
 * 14–32; Qualify's constant would flatten everything toward the prior). Do not import Qualify's K.
 *
 * age_days is today − the DOLLAR-WEIGHTED MEAN service date (weight = charged), never
 * max(service_date) — a max is moved by a single stray line. ⚠ The summary payload does not carry
 * any service-date aggregate today, so the UI holds w at 1.0 (pass ageDays: null); the decay is
 * implemented and tested here so wiring it is a payload change only, not a scoring change.
 *
 * a_prior is the tenant-wide allowed% for the same CPT, falling back to the same care setting.
 * Neither population is in the client payload either, so {@link perCptPriors} derives the nearest
 * honest stand-in: the dollar-weighted allowed rate pooled across the VISIBLE combos sharing the
 * CPT, falling back to the caller-supplied selection-wide rate. For a CPT with a single visible
 * combo the pooled prior collapses to its own observed rate (â = a_obs), which is exact shrinkage
 * behavior for "no other evidence about this CPT in view".
 *
 * FORMULA 2 — facility CPT/Rev confidence:
 *   p̂ = shrunk paid-of-allowed (same shrinkage shape as â, same K)
 *   C = Σ(charged_i × â_i × p̂_i) / Σ(charged_i)   per facility, and for the SETTING-MATCHED peer set
 *   Z = C_facility / C_peer  →  banded (Strong / Expected / Watch / Review); < 40 lines → no band.
 * Peer normalization is setting-matched (IP vs OP) — never score IP against OP. ⚠ The Collections
 * summary payload has NO per-facility ratio aggregates (by_facility is label/count/charge only), so
 * the UI badge is NOT wired yet — these functions are the ready seam for when that aggregate lands.
 */

/** Shrinks over charge lines — deliberately not Qualify's patient-count K=25. */
export const COMBO_SHRINKAGE_K = 12;
export const COMBO_RECENCY_HALF_LIFE_DAYS = 45;
/** Below this many lines in the window, a facility gets "Insufficient data" and NO band. */
export const CONFIDENCE_MIN_LINES = 40;

/** Ranked-by tooltip/caption copy — pinned here so UI and tests share one string. */
export const COMBO_RANKING_EXPLAINER =
  'Ranked by recent realized dollars, with a boost for combos that earn more per line.';

/**
 * â or p̂: (n·obs + K·prior) / (n + K). `obs` null (the SQL guards a meaningless denominator to
 * NULL) → the rate is unknowable, not zero — callers decide (comboScore scores it 0 so it sorts
 * last rather than inventing a rate).
 */
export function shrunkRate(n: number, obs: number, prior: number, k: number = COMBO_SHRINKAGE_K): number {
  if (!Number.isFinite(n) || n < 0) return prior;
  return (n * obs + k * prior) / (n + k);
}

/** w = 0.5^(ageDays/halfLife); null/undefined ageDays → 1 (no decay — the honest "no date data"). */
export function recencyWeight(
  ageDays: number | null | undefined,
  halfLifeDays: number = COMBO_RECENCY_HALF_LIFE_DAYS,
): number {
  if (ageDays === null || ageDays === undefined || !Number.isFinite(ageDays)) return 1;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

export interface ComboScoreInput {
  /** Charge lines in the combo. */
  n: number;
  /** Sum of charged dollars in the combo. */
  charged: number;
  /** Observed allowed ÷ charged (0..1), or null when the SQL nulled an invalid denominator. */
  aObs: number | null;
  /** Prior allowed rate (0..1) — see perCptPriors for the client-side derivation. */
  aPrior: number;
  /** today − dollar-weighted mean service date; null → w = 1 (no decay). */
  ageDays?: number | null;
}

export interface ComboScore {
  aHat: number;
  w: number;
  /** A = charged × â × w. */
  recentDollars: number;
  /** E = charged × â / n. */
  perLineDollars: number;
  /** S = A^0.7 × E^0.3 — the DESC sort key. 0 when unscorable (null a_obs, n or charged ≤ 0). */
  score: number;
}

export function comboScore(input: ComboScoreInput): ComboScore {
  const { n, charged, aObs, aPrior, ageDays } = input;
  const w = recencyWeight(ageDays);
  // Unscorable — a null observed rate means the denominator was invalid, so "realized dollars"
  // cannot be claimed; score 0 sorts it last (stably) instead of inventing a rate.
  if (aObs === null || !Number.isFinite(charged) || charged <= 0 || !Number.isFinite(n) || n <= 0) {
    return { aHat: aPrior, w, recentDollars: 0, perLineDollars: 0, score: 0 };
  }
  const aHat = shrunkRate(n, aObs, aPrior);
  const recentDollars = charged * aHat * w;
  const perLineDollars = (charged * aHat) / n;
  const score =
    recentDollars > 0 && perLineDollars > 0
      ? Math.pow(recentDollars, 0.7) * Math.pow(perLineDollars, 0.3)
      : 0;
  return { aHat, w, recentDollars, perLineDollars, score };
}

/** The minimal combo shape the ranking reads — structurally satisfied by CmdComboGroup. */
export interface RankableCombo {
  cpt: string | null;
  count: number;
  charge: number;
  /** 0–100 scale, as the summary payload ships it (dollar-weighted, SQL-guarded to null). */
  pct_allowed: number | null;
}

/**
 * Dollar-weighted allowed rate pooled per CPT across the visible combos (0..1) — the client-side
 * prior. CPTs with no scorable combo, and the null-CPT bucket, fall back to `fallbackRate`.
 */
export function perCptPriors(rows: readonly RankableCombo[], fallbackRate: number): Map<string, number> {
  const sums = new Map<string, { dollars: number; allowed: number }>();
  for (const r of rows) {
    if (r.cpt === null || r.pct_allowed === null || r.charge <= 0) continue;
    const s = sums.get(r.cpt) ?? { dollars: 0, allowed: 0 };
    s.dollars += r.charge;
    s.allowed += r.charge * (r.pct_allowed / 100);
    sums.set(r.cpt, s);
  }
  const priors = new Map<string, number>();
  for (const [cpt, s] of sums) priors.set(cpt, s.dollars > 0 ? s.allowed / s.dollars : fallbackRate);
  return priors;
}

/**
 * Rank the summary's combo buckets DESC by S — display order only; the rows themselves (and so
 * every drill value) are returned untouched. Stable: ties and unscorable rows keep the server's
 * (charge DESC) relative order. `fallbackPctAllowed` is the selection-wide %-allowed (0–100 or
 * null) used when a CPT has no pooled prior of its own.
 */
export function rankCombos<T extends RankableCombo>(
  rows: readonly T[],
  fallbackPctAllowed: number | null,
): { row: T; score: ComboScore }[] {
  const fallback = fallbackPctAllowed !== null ? fallbackPctAllowed / 100 : 0;
  const priors = perCptPriors(rows, fallback);
  const scored = rows.map((row, i) => ({
    row,
    i,
    score: comboScore({
      n: row.count,
      charged: row.charge,
      aObs: row.pct_allowed !== null ? row.pct_allowed / 100 : null,
      aPrior: row.cpt !== null ? (priors.get(row.cpt) ?? fallback) : fallback,
      // No service-date aggregate exists in the payload yet — w held at 1.0 (see module header).
      ageDays: null,
    }),
  }));
  scored.sort((a, b) => b.score.score - a.score.score || a.i - b.i);
  return scored.map(({ row, score }) => ({ row, score }));
}

// ── Formula 2 — facility CPT/Rev confidence (pure seam; UI badge not wired — see header) ─────────

export type ConfidenceBand = 'Strong' | 'Expected' | 'Watch' | 'Review';

export interface FacilityComboInput {
  charged: number;
  /** Shrunk allowed rate for this combo at this facility (0..1). */
  aHat: number;
  /** Shrunk paid-of-allowed for this combo at this facility (0..1). */
  pHat: number;
}

/** C = Σ(charged·â·p̂) / Σ(charged); null when there are no positive-charge inputs. */
export function confidenceComposite(inputs: readonly FacilityComboInput[]): number | null {
  let dollars = 0;
  let realized = 0;
  for (const x of inputs) {
    if (!Number.isFinite(x.charged) || x.charged <= 0) continue;
    dollars += x.charged;
    realized += x.charged * x.aHat * x.pHat;
  }
  return dollars > 0 ? realized / dollars : null;
}

export function confidenceBand(z: number): ConfidenceBand {
  if (z >= 1.15) return 'Strong';
  if (z >= 0.95) return 'Expected';
  if (z >= 0.8) return 'Watch';
  return 'Review';
}

/**
 * Z = C_facility / C_peer with the insufficiency gate. The CALLER guarantees `peer` is
 * setting-matched (IP vs OP) — never score IP against OP; this function cannot check that.
 * Returns band: null (no band shown) when lines < CONFIDENCE_MIN_LINES or either composite is
 * unavailable/zero.
 */
export function facilityConfidence(
  facility: readonly FacilityComboInput[],
  peer: readonly FacilityComboInput[],
  linesInWindow: number,
): { z: number | null; band: ConfidenceBand | null; insufficient: boolean } {
  if (linesInWindow < CONFIDENCE_MIN_LINES) return { z: null, band: null, insufficient: true };
  const cFacility = confidenceComposite(facility);
  const cPeer = confidenceComposite(peer);
  if (cFacility === null || cPeer === null || cPeer <= 0) {
    return { z: null, band: null, insufficient: true };
  }
  const z = cFacility / cPeer;
  return { z, band: confidenceBand(z), insufficient: false };
}
