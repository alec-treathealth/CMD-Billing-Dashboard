/**
 * Qualify BOARD — the pure contract + DI cores behind the smoke-shell dashboard's right pane
 * (design/qualify-smoke-shell; mock at docs/mockups/qualify-smoke.html).
 *
 * ⚠ DELIBERATELY SELF-CONTAINED: this module does NOT touch core.ts / actions.ts /
 * resolutionService.ts — the search rewrite owns those files, and the board must land without
 * colliding with it (the same isolation reasoning that put loaders.ts outside app/lib/server.ts).
 * It follows the movers/book-KPIs/trends conventions: gate-first, fail-closed, non-dollar
 * payloads, no audit for non-PHI aggregates.
 *
 * WHAT LIVES HERE:
 *   1. The tape contract (QualifyPolicyTapeItem/Result) — non-dollar by construction, so an
 *      admissions_seat receives identical bytes to a super_admin.
 *   2. computePairPolicyRating — the nightly cron's rating fold. A MIRROR of core.ts
 *      assembleFacilities' computeRatingV2 input assembly (provenance 'direct', payer-scoped,
 *      outcomes-beat-census under the sample floor) folded through derivePolicyRating, so the
 *      STORED nightly number is the number the interactive hero would show. If assembleFacilities'
 *      mapping changes, change this in the same diff — app/test/qualify-board.test.tsx pins the
 *      behaviors that matter.
 *   3. getQualifyPolicyTapeCore — the gate-only read core (DI, hermetically testable).
 *
 * SEAM STATUS (2026-08-08): the tape is LIVE-READY once mig 0093 is applied and the nightly cron
 * has run. Echo labels arrive when the search rewrite calls
 * collections.record_qualify_prefix_echo() at term-mint time — until then items carry echo:null
 * and the UI shows the token tail. Watchers and recent-searches are NOT here yet: watchers need
 * their own table + session; recents need an audit-policy decision (terms are unrecoverable from
 * claims.access_audit by design).
 */
import {
  computeRatingV2,
  iqBandOf,
  QUALIFY_AUTH_FIT_MIN_SAMPLE,
  type QualifyIqBand,
} from './ratingV2';
import { derivePolicyRating } from './policyRating';
import { lookupCodingDecision, codingCodesLabel, type CodingDecisionRow } from '../../../src/collections/codingRegistryQuery';
import type {
  QualifyRatingHistoryFacilityAgg,
  QualifyPolicyTapeRow,
} from '../../../src/collections/qualifyRatingHistory';

// ── Tape contract (what the new UI binds to) ─────────────────────────────────────────────────────

export interface QualifyPolicyTapeItem {
  /** The pair's identity — the keyed-HMAC prefix token (doctrine: not PHI, safe on this gated
   *  surface). Future lane-open actions key on it. */
  token: string;
  /** Last 6 hex chars — the masked display handle when no echo is on file ("⋯8841" idiom). */
  tokenTail: string;
  /** The operator-typed <=3-char prefix echo, when one is on file (0093 seam) — else null. */
  echo: string | null;
  payer: string;
  ratingNow: number;
  bandNow: QualifyIqBand | null;
  ratingThen: number;
  deltaPts: number;
  distinctMembers: number;
  lineCount: number;
  windowDays: number;
}

export interface QualifyPolicyTapeResult {
  /** False ⟺ mig 0093 is UNAPPLIED (the loader's absent-relation fail-soft) — the UI renders the
   *  tape lane empty-but-honest instead of 500ing. NOTE the deliberate limit (review 2026-08-08):
   *  an applied-but-empty table reads available:true with items:[] and asOf:null — "no snapshots
   *  yet" and "no pair clears the gates" are indistinguishable without a second query, and both
   *  render as the same empty lane. Do not branch UI copy on available for that distinction. */
  available: boolean;
  /** The snapshot date the tape reads ('YYYY-MM-DD') — yesterday's close in steady state. Null
   *  when unavailable OR when no item survived the gates. */
  asOf: string | null;
  /** Delta horizon in days (90 — Alec's ruling 2026-08-08). */
  deltaDays: number;
  items: QualifyPolicyTapeItem[];
}

// ── The nightly cron's rating fold (injected into src via app/lib/server.ts) ────────────────────

/** Facility-side context the fold needs — loaded ONCE per cron run by the binder (the same
 *  loaders the interactive factorContext uses), passed as plain maps so this stays pure. */
export interface QualifyPairRatingContext {
  coding: { seeded: boolean; rows: CodingDecisionRow[] };
  census: Map<
    string,
    {
      board_family: string | null;
      avg_auth_days: number | null;
      avg_los_days: number | null;
      auth_sample: number | null;
      los_sample: number | null;
    }
  >;
  outcomes: Map<
    string,
    {
      stays_sample: number;
      auth_sample: number;
      avg_los_days: number | null;
      avg_auth_days: number | null;
      window_days: number;
    }
  >;
}

/**
 * Rate one (payer, prefix) pair from its per-facility claim aggregates — computeRatingV2 per
 * facility (the assembleFacilities input mapping, payer-scoped branch), then the patient-weighted
 * derivePolicyRating fold. `asOf` is the clock: coding-age decay for a backfilled date is measured
 * from that date, not from tonight (noon UTC avoids any date-boundary ambiguity).
 */
export function computePairPolicyRating(
  payer: string,
  facilities: readonly QualifyRatingHistoryFacilityAgg[],
  asOf: string,
  windowDays: number,
  ctx: QualifyPairRatingContext,
): { rating: number | null; band: QualifyIqBand | null; ratedFacilities: number } {
  const now = new Date(`${asOf}T12:00:00Z`);
  const perFacility = facilities.map((f) => {
    const census = f.facilityCode ? ctx.census.get(f.facilityCode) ?? null : null;
    const outcome = f.facilityCode ? ctx.outcomes.get(f.facilityCode) ?? null : null;
    // Completed stays WIN when present with a usable sample — core.ts assembleFacilities' rule.
    const useOutcomes =
      outcome !== null &&
      outcome.avg_los_days !== null &&
      outcome.avg_auth_days !== null &&
      outcome.auth_sample >= QUALIFY_AUTH_FIT_MIN_SAMPLE &&
      outcome.stays_sample >= QUALIFY_AUTH_FIT_MIN_SAMPLE;
    const decision = ctx.coding.seeded
      ? lookupCodingDecision(ctx.coding.rows, payer, f.facilityCode, f.careSetting)
      : null;
    const v2 = computeRatingV2({
      pctAllowed: f.pctAllowed,
      lineCount: f.lineCount,
      confirmedClaims: f.confirmedClaims,
      distinctPatients: f.distinctPatients,
      windowDays,
      // An observed (payer, prefix) pair has its own claims — the 'direct' provenance branch.
      provenance: 'direct',
      registrySeeded: ctx.coding.seeded,
      payerKnown: true, // payer-scoped by construction (the pair's key IS the payer)
      payerScopeAll: false,
      payerCount: 1,
      codingLifecycle: decision ? (decision.lifecycle as import('./ratingV2').CodingLifecycle) : null,
      codingDecidedOn: decision?.decided_on ?? null,
      codingCodesLabel: decision ? codingCodesLabel(decision) : null,
      medianDaysToPayment: f.medianDaysToPayment,
      avgAuthDays: useOutcomes ? outcome!.avg_auth_days : (census?.avg_auth_days ?? null),
      avgLosDays: useOutcomes ? outcome!.avg_los_days : (census?.avg_los_days ?? null),
      censusFamily:
        census?.board_family === 'outpatient' || census?.board_family === 'residential'
          ? census.board_family
          : null,
      authSample: useOutcomes ? outcome!.auth_sample : (census?.auth_sample ?? null),
      losSample: useOutcomes ? outcome!.stays_sample : (census?.los_sample ?? null),
      losBasis: useOutcomes ? 'completed' : census?.avg_los_days != null ? 'in_progress' : null,
      losWindowDays: useOutcomes ? outcome!.window_days : null,
      now,
    });
    return { ratingV2: v2.rating, distinctPatients: f.distinctPatients };
  });

  const fold = derivePolicyRating(perFacility);
  return { rating: fold.rating, band: fold.band, ratedFacilities: fold.ratedCount };
}

// ── Read core (gate-only; DI for hermetic tests) ─────────────────────────────────────────────────

export interface QualifyBoardDeps {
  /** The Qualify principal gate — fail-closed, super_admin + admissions_seat only. */
  requirePrincipal: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Tape rows from the loader; null = the history table is absent/unapplied (fail-soft). */
  loadTape: () => Promise<QualifyPolicyTapeRow[] | null>;
  deltaDays: number;
}

const TAPE_BANDS: ReadonlySet<string> = new Set(['65', '50', '30', '15', '0']);

/** Gate → load → assemble. NO audit: same non-PHI-aggregate posture as movers/KPIs/trends. */
export async function getQualifyPolicyTapeCore(deps: QualifyBoardDeps): Promise<QualifyPolicyTapeResult> {
  const gate = await deps.requirePrincipal();
  if (!gate.ok) throw new Error(gate.error);

  const rows = await deps.loadTape();
  if (rows === null) return { available: false, asOf: null, deltaDays: deps.deltaDays, items: [] };

  const items: QualifyPolicyTapeItem[] = rows.map((r) => ({
    token: r.member_id_prefix_bidx,
    tokenTail: r.token_tail,
    echo: r.echo,
    payer: r.primary_payer,
    ratingNow: r.rating_now,
    // Recompute the band from the number rather than trusting stored text — the two cannot drift.
    bandNow: TAPE_BANDS.has(r.band_now ?? '') ? (r.band_now as QualifyIqBand) : iqBandOf(r.rating_now),
    ratingThen: r.rating_then,
    deltaPts: r.delta_pts,
    distinctMembers: r.distinct_members,
    lineCount: r.line_count,
    windowDays: r.window_days,
  }));

  return {
    available: true,
    asOf: rows[0]?.as_of ?? null,
    deltaDays: deps.deltaDays,
    items,
  };
}
