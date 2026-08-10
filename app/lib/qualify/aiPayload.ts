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
import type { QualifyChipSlots } from './chipTemplates';

export function buildQualifyAiInput(
  question: QualifyAiInput['question'],
  snap: QualifySnapshot,
  blind: boolean,
  /** The template's slot values (Smoke Phase 2). OPTIONAL so every pre-Phase-2 caller — the ticker
   *  path, the auto-run suggestion — keeps compiling and simply sends no slots. A chip with no
   *  slots and a chip whose slots are all null are the same request, deliberately. */
  slots: QualifyChipSlots | null = null,
): QualifyAiInput {
  return {
    question,
    // Sent only when at least one slot is filled: `slots: null` and an all-null object mean the same
    // thing to the prompt builder, and the smaller payload is the one that cannot confuse a reader
    // of the audit row about whether the rep chose anything.
    slots:
      slots && Object.values(slots).some((v) => v !== null)
        ? {
            facility: slots.facility,
            comparator: slots.comparator,
            metric: slots.metric,
            horizonDays: slots.horizonDays,
            careSetting: slots.careSetting,
          }
        : null,
    // The scope, stated to the model rather than left to be inferred from a null payerName — after
    // the identifier-wide Skip that null means "several labels", not "none". See QualifyAiInput.
    payerName: snap.resolved?.payerName ?? null,
    payerScope: snap.resolved === null ? 'none' : snap.resolved.payerScope,
    policy: snap.policy?.found
      ? {
          carrier: snap.policy.carrier,
          funding: snap.policy.funding,
          policyType: snap.policy.policyType,
          planType: snap.policy.planType,
          network: snap.policy.network,
          memberCount: snap.policy.memberCount,
          vobStale: snap.policy.vobStale,
        }
      : null,
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
