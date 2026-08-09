/**
 * THE TICKER → MODEL PAYLOAD MAP. Pure, hermetically testable, and deliberately NOT inside the panel
 * component.
 *
 * Same reasoning as aiPayload.ts, which this file follows: the panel is a `'use client'` module that
 * reaches a `'use server'` action, so anything decided inside it is unreachable from every hermetic
 * test — and an untested field-mapping in this repo has already silently stopped reaching the model
 * once. The map lives here so `app/test/tickerAiPayload.test.ts` can hold it to the PHI boundary.
 *
 * ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE: **no policy identifier crosses.** The tape now renders
 * a readable 3-character alpha prefix (prefixLabel.ts), and `qualifyAi.ts`'s oldest stated boundary is
 * *"NO IDENTIFIERS, structurally: no member id, no prefix (not even the ≤3-char echo)"*. The strict
 * zod firewall has no field that could carry one — but the firewall protects against the SHAPE, and
 * this function is where a well-meaning edit would try to put a prefix into `facilityName` "so the
 * answer reads better". It must not. A tape card's `facilityName` is null, always, and the tests pin
 * that with the prefix present on the item.
 */
import type { QualifyPolicyTapeItem } from './board';
import type { QualifyFacilityTrend } from './contract';

/** The exact shape `QualifyAiInputSchema` accepts. Kept structural (not imported from src/) so this
 *  module stays client-safe; the server re-validates everything through the real schema anyway. */
export interface QualifyTickerAiInput {
  question: 'tape_move' | 'trend_move';
  payerName: string | null;
  payerScope: 'payer' | 'all' | 'none';
  policy: null;
  provenance: 'direct';
  windowDays: number;
  windowSufficient: boolean;
  facilities: [];
  amountsBlind: boolean;
  ticker: {
    kind: 'policy' | 'facility';
    facilityName: string | null;
    payer: string | null;
    careSetting: 'IP' | 'OP' | 'BOTH' | null;
    area: string | null;
    facilityCount: number;
    ratingNow: number | null;
    ratingThen: number | null;
    deltaPts: number | null;
    iqBand: '65' | '50' | '30' | '15' | '0' | null;
    distinctMembers: number;
    distinctPatients: number;
    lineCount: number;
    windowDays: number;
    deltaDays: number;
    points: number[];
  };
}

/**
 * One "Policies on the Move" card → the model input.
 *
 * `provenance: 'direct'` is the truthful value and not a default: a tape pair exists BECAUSE it has
 * its own paid claims in both snapshots. `payerScope: 'payer'` for the same reason — the pair's key
 * IS one billed-under label, so nothing here is a cross-label blend.
 *
 * `windowSufficient` is DERIVED, not asserted: the tape's own floor is QUALIFY_TAPE_MIN_MEMBERS (3),
 * far below the rating system's confident-sample floor of 10, so most cards are honestly thin and the
 * prompt's "directional, not confirmed" rule should fire for them. Hard-coding true here would have
 * switched that rule off for exactly the cards that need it.
 */
export function buildTapeAiInput(
  item: QualifyPolicyTapeItem,
  deltaDays: number,
  blind: boolean,
): QualifyTickerAiInput {
  return {
    question: 'tape_move',
    payerName: item.payer,
    payerScope: 'payer',
    policy: null,
    provenance: 'direct',
    windowDays: item.windowDays,
    windowSufficient: item.distinctMembers >= 10,
    facilities: [],
    amountsBlind: blind,
    ticker: {
      kind: 'policy',
      // ⚠ NEVER `item.prefix` / `item.echo` / `item.token` — see this module's header.
      facilityName: null,
      payer: item.payer,
      careSetting: item.careSetting,
      area: item.area,
      facilityCount: item.facilityCount,
      ratingNow: item.ratingNow,
      ratingThen: item.ratingThen,
      deltaPts: item.deltaPts,
      iqBand: item.bandNow,
      distinctMembers: item.distinctMembers,
      distinctPatients: 0, // a tape pair counts MEMBERS; patients is the facility strip's unit
      lineCount: item.lineCount,
      windowDays: item.windowDays,
      deltaDays,
      points: [],
    },
  };
}

/**
 * One "Facility Momentum" card → the model input.
 *
 * `payerScope: 'all'` and NOT 'payer', even though `dominantPayer` is populated: the trend query is
 * book-wide per facility, so the rating is a blend across every label billed there and the dominant
 * payer is merely the biggest contributor to it. Sending 'payer' would tell the model it is looking
 * at one payer's contract rate, which is the exact overclaim `payerScope` was added to prevent.
 *
 * `distinctPatients: 0` is honest rather than lazy — `QualifyFacilityTrend` carries `lineCount` and
 * no patient count (the delta gate counts patients inside SQL and never projects them), so there is
 * no number to send. The prompt reads 0 as "unknown sample" and hedges, which is correct.
 */
export function buildTrendAiInput(
  trend: QualifyFacilityTrend,
  windowDays: number,
  blind: boolean,
): QualifyTickerAiInput {
  const area = [trend.city, trend.state].filter(Boolean).join(', ');
  return {
    question: 'trend_move',
    payerName: trend.dominantPayer,
    payerScope: 'all',
    policy: null,
    provenance: 'direct',
    windowDays,
    // A facility card cannot rank without clearing the trend query's both-window patient gate, so its
    // sample is real — but the rating-system floor is about PATIENTS and we have none to check, so
    // the honest answer is "not established", which keeps the directional hedge on.
    windowSufficient: false,
    facilities: [],
    amountsBlind: blind,
    ticker: {
      kind: 'facility',
      facilityName: trend.name,
      payer: trend.dominantPayer,
      careSetting: trend.careSetting,
      area: area === '' ? null : area,
      facilityCount: 1,
      ratingNow: trend.currentRating,
      ratingThen: trend.priorRating,
      deltaPts: trend.deltaPts,
      // The tape stores an IQ band; the trend query does not compute one, and deriving it here would
      // put a second band derivation in the codebase. Null means "no band stated", not "band zero".
      iqBand: null,
      distinctMembers: 0,
      distinctPatients: 0,
      lineCount: trend.lineCount,
      windowDays,
      // A trend delta compares the window against the ADJACENT prior window of equal length, so the
      // delta horizon and the rating window are the same number here — unlike the tape, where a
      // 90-day rating is compared with the snapshot from 90 days earlier.
      deltaDays: windowDays,
      points: trend.points,
    },
  };
}
