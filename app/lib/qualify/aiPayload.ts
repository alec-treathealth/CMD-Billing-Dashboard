/**
 * THE AI PAYLOAD BUILDER — the one seam between the snapshot on screen and the model's input.
 *
 * PURE and client-safe: no React, no `'use server'` import, relative imports only. It lived inside
 * `qualify-ai-panel.tsx` until 2026-08-08, which is a `'use client'` module importing the
 * `ai-actions` server chain — so it could not be imported by a hermetic test, and it never was.
 * The S1 review paid for that: deleting the `bedState` mapping left every suite and both typechecks
 * green, because the schema field is `.optional()`. The prompt would have gone on describing a field
 * the model never received. Extracted here so the mapping has a test seam; the panel imports it.
 *
 * WHAT THIS IS ALLOWED TO CARRY is decided by `QualifyAiInputSchema` (src/collections/qualifyAi.ts),
 * which the SERVER re-validates against — a strict, closed firewall with no dollar or identifier
 * field expressible in it. This builder is the client-side half; it may only ever narrow.
 */
import type { QualifyAiInput } from '../../../src/collections/qualifyAi';
import type { QualifySnapshot } from './contract';

export function buildQualifyAiInput(
  question: QualifyAiInput['question'],
  snap: QualifySnapshot,
  blind: boolean,
): QualifyAiInput {
  return {
    question,
    // Keep insurance and policy details out of the model payload. The scope is an
    // aggregate ranking dimension, not an identifier or policy field.
    payerScope: snap.resolved === null ? 'none' : snap.resolved.payerScope,
    provenance: snap.provenance,
    windowDays: snap.ladder?.chosenDays ?? 90,
    windowSufficient: snap.ladder?.sufficient ?? true,
    facilities: snap.facilities.slice(0, 10).map((f) => ({
      name: f.name,
      careSetting: f.careSetting,
      ratingV2: f.ratingV2,
      iqBand: f.iqBand,
      pctAllowedOfBilled: f.pctAllowedOfBilled,
      distinctPatients: f.distinctPatients,
      lineCount: f.lineCount,
      medianDaysToPayment: f.medianDaysToPayment,
      payerCount: f.payerCount,
      /* WHY THIS ARRAY IS IN THIS ORDER (2026-08-08). The slice is deliberately the first TEN in
       * array order, and that order is now availability-first — so without this field the model
       * reads a list that has been re-sorted for a reason it cannot see, and calls whatever leads it
       * "the top read". The prompt's ordering rule is only actionable if the state travels with it,
       * and because the schema field is `.optional()` (deliberately — a stale payload must degrade,
       * not hard-reject), NOTHING BUT A TEST HOLDS THIS LINE IN PLACE. See qualifyAiPayload.test.tsx.
       * Nothing else census-shaped is mapped: bed counts, UR dates and LOS averages stay out of the
       * payload, because the model's job here is to explain the read, not to re-derive the sort. */
      bedState: f.bedState,
      factors: f.factors.map((x) => ({
        key: x.key,
        label: x.label,
        weight: x.weight,
        score: x.score,
        available: x.available,
        direction: x.direction,
        detail: x.detail.slice(0, 300),
      })),
    })),
    amountsBlind: blind,
  };
}
