/**
 * THE LANE'S FOUR STEPS — one derivation, three surfaces (Smoke shell, 2026-08-10).
 *
 * The mock's left rail (`docs/mockups/qualify-smoke.html`) states the same progress THREE times, and
 * each time in a different idiom:
 *   · `.stepper`  — a horizontal timeline: dot, connector, label, and the DECIDED VALUE beneath it
 *   · `.receipt`  — a numbered checklist that strikes through as each question is answered, n/4
 *   · `.feed`     — the running commentary ("Lane locked — answers now draw on Anthem BCC only")
 *
 * They must never disagree, and three components each deriving "is the carrier step done?" from
 * `stage` and `resolution` is how they would. `railStates` already exists for exactly this reason on
 * the stepper alone; this module widens that idea to carry the LABEL and the VALUE too, so the
 * checklist and the feed read the same four objects the stepper renders rather than re-deriving them.
 *
 * PURE, client-safe, no React and no server imports — relative imports so the hermetic render tests
 * load it under `tsx` without tsconfig path-alias resolution (the `tokens.ts` precedent).
 *
 * ── PHI ────────────────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE MAY CARRY THE TYPED IDENTIFIER. `meta` is rendered into the rail's markup, so every
 * branch below is restricted to values that are non-PHI by construction:
 *   · the identify step shows `handle.echo` — the ≤3-char prefix, which is what the lane is NAMED
 *     after and is already rendered by the lock strip two elements away. A full member ID has
 *     `echo === ''` by construction, and that case shows the WORD "Member ID", never the id and
 *     never a truncation of it. There is no branch that can put a member ID on screen.
 *   · carrier and plan show payer/employer labels — business entities, and the SAME two fields
 *     `FlowReceipt` already renders in this rail today. This module moves no field into a new
 *     channel: no URL, no log, no model prompt, no storage.
 *   · the answer step shows a rating and a verdict word — integers and an enum.
 *   · `revisit` carries a stage ENUM and one of two fixed strings ('Change', 'Pick a carrier'). It is
 *     static copy plus a target, never a value read off the resolution.
 */
import type { QualifyResolution } from './resolution';
import type { QualifyPolicyRating } from './policyRating';

/** The stage machine's four steps, in flow order. Mirrors `RAIL_SEGMENTS` in resolution-flow.tsx. */
export type LaneStepKey = 'identify' | 'payer' | 'plan' | 'answer';

/**
 * `skipped` is a first-class state and must never collapse into `done` — "done" claims the operator
 * answered a question, and a skipped step is one they were never asked (a sole carrier skips the
 * carrier question; a sole candidate skips both). The receipt is a record of DECISIONS, so a skipped
 * step renders struck-through-but-unclaimed rather than ticked.
 */
export type LaneStepState = 'pending' | 'current' | 'done' | 'skipped';

/** Where a step's revisit control goes back to, and the words on it. */
export interface LaneRevisit {
  /** The `went_back` target. NOT always this step's own key — see the skip case in `revisitFor`. */
  to: 'identify' | 'payer' | 'plan';
  label: string;
}

export interface LaneStep {
  key: LaneStepKey;
  /** The stepper's short label — "Carrier". */
  label: string;
  /** The checklist's full question — "Carrier — which is on the card?". */
  question: string;
  state: LaneStepState;
  /** The decided value, or null while the step is undecided. NON-PHI by construction (see header). */
  meta: string | null;
  /**
   * The revisit affordance, or null when there is nothing to go back to.
   *
   * ⚠ IT IS DERIVED HERE, WITH THE REST, AND THAT IS THE WHOLE POINT. Whether a step is revisitable
   * turns on `skipped` vs `soleCarrier`/`soleCandidate` — a distinction `state` COLLAPSES, because
   * both render as 'skipped'. The only other discriminator visible downstream is the `meta` STRING
   * ('All carriers' vs 'Only carrier on file'), and branching a control on display copy is how a
   * wording change silently removes a button. Deciding it here keeps one derivation.
   */
  revisit: LaneRevisit | null;
}

const STEP_TEXT: readonly { key: LaneStepKey; label: string; question: string }[] = [
  { key: 'identify', label: 'Identify', question: 'Identify — who are we looking at?' },
  { key: 'payer', label: 'Carrier', question: 'Carrier — which is on the card?' },
  { key: 'plan', label: 'Plan', question: 'Plan — which plan is it?' },
  { key: 'answer', label: 'Answer', question: 'Answer — do they pay us, where?' },
];

export interface LaneStepsInput {
  stage: LaneStepKey;
  resolution: QualifyResolution | null;
  /** Carrier clusters behind the identifier — the shell's memoized `payerGroupsOf` result. */
  carrierCount: number;
  /** The carrier the operator picked, or null (pre-pick, or a skip). */
  payerPick: string | null;
  /** True when the operator declined the carrier question — the all-payers scope. */
  skipped: boolean;
  /** The answer stage's policy rating, or null while the snapshot is absent or in flight. */
  policy: QualifyPolicyRating | null;
}

/**
 * THE ECHO, MASKED THE WAY THE MOCK MASKS IT — `GGS•••`.
 *
 * The trailing dots are not decoration: they say "there is more identifier than this, and it is not
 * being shown", which is the honest reading of a prefix search. Without them `GGS` reads as though
 * the whole identifier were three characters.
 *
 * ⚠ THIS IS NOT `maskedPatientEcho` AND MUST NOT BE SWAPPED FOR IT. That function masks a RAW TERM
 * (it takes the identifier and hides characters, and its floors exist because prefix and tail can
 * overlap). This one never sees a raw term at all — `handle.echo` is already the prefix the resolver
 * chose to expose. Feeding a raw term in here would leak it verbatim.
 */
export function laneEchoLabel(echo: string): string {
  return echo !== '' ? `${echo}•••` : 'Member ID';
}

/**
 * Derive all four steps. PURE — same inputs as `railStates`, plus the values, so the stepper, the
 * checklist and the feed cannot drift.
 *
 * The SKIP rules are `railStates`'s rules, deliberately restated here rather than imported:
 * `railStates` lives in a 'use client' component module, and this module is read by pure tests.
 * `qualify-lane-steps.test.tsx` pins the two together — it asserts this state vector equals
 * `railStates`'s across every stage and every sole-carrier/sole-candidate shape, so a skip rule
 * changed in one module and not the other fails loudly instead of letting the stepper and the
 * checklist disagree about which questions the operator was never asked.
 *
 * ⚠ THE PIN IS OVER THE SKIP RULES, NOT OVER EVERY STATE, and the difference is deliberate. This
 * module additionally knows whether the ANSWER ARRIVED (`policy`), which `railStates` cannot see —
 * it is never handed a snapshot. So the answer step completes here in a case where `railStates` still
 * reads 'current', and the pin holds because it exercises the no-answer-yet shape, which is exactly
 * the domain the two share. Do not "fix" a future pin failure by deleting that asymmetry.
 */
export function laneSteps(input: LaneStepsInput): LaneStep[] {
  const { stage, resolution, carrierCount, skipped } = input;
  const idx = STEP_TEXT.findIndex((s) => s.key === stage);
  const soleCandidate = resolution !== null && resolution.candidates.total <= 1;
  const soleCarrier = resolution !== null && carrierCount <= 1;

  return STEP_TEXT.map((seg, i) => {
    const state: LaneStepState =
      // ⚠ THE ANSWER STEP IS THE ONE STEP THAT CAN COMPLETE WHILE IT IS STILL THE CURRENT ONE, and
      // that is what lets the checklist reach 4/4 the way the mock shows it. Every other step is
      // settled by MOVING OFF it; there is nowhere to move after the answer, so "still the current
      // step" would otherwise mean "never finished" and the counter would top out at 3/4 forever.
      // The condition is the arrival of a rating, i.e. a snapshot came back — not merely that the
      // stage was reached, which is also true while the answer is still in flight.
      seg.key === 'answer' && i === idx && input.policy !== null
        ? 'done'
        : i === idx
          ? 'current'
          : i > idx
            ? 'pending'
            : seg.key === 'payer' && (soleCandidate || soleCarrier || skipped)
              ? 'skipped'
              : seg.key === 'plan' && (soleCandidate || skipped)
                ? 'skipped'
                : 'done';
    return {
      key: seg.key,
      label: seg.label,
      question: seg.question,
      state,
      meta: metaFor(seg.key, state, input),
      revisit: revisitFor(seg.key, state, skipped),
    };
  });
}

/**
 * The revisit control for a step, or null.
 *
 * ⚠ THESE ARE `FlowReceipt`'S GATES, RESTATED IN THE VOCABULARY OF `state` — not new rules. The chip
 * row this replaces in shell mode showed Change on three conditions, and each maps exactly:
 *
 *   · Search  — rendered whenever the receipt did (`resolution && stage !== 'identify'`)
 *               ⟺ `identify.state === 'done'`, since identify is the one step that is never skipped.
 *   · Carrier — `payerLabel !== null && payers.length > 1`
 *               ⟺ `payer.state === 'done'`, which already implies `!soleCarrier`, i.e. >1 carrier.
 *   · Plan    — `stage === 'answer' && candidates.total > 1`
 *               ⟺ `plan.state === 'done'`, which already implies `!soleCandidate`.
 *
 * So `done` is the whole rule for the three, and no count has to be re-read to know it.
 *
 * ⚠ ONLY AN OPERATOR'S SKIP EARNS AN ESCAPE HATCH. A step is 'skipped' for two unrelated reasons and
 * they must not be treated alike: the operator DECLINED the question (`skipped`), or it was never
 * askable — one carrier on file, one candidate. Offering the hatch on a sole-carrier lane would send
 * the operator back to a stage with a single chip and nothing to decide, which is precisely why the
 * chip row suppressed its Carrier entry on `payers.length > 1`.
 *
 * ⚠ THE HATCH SAYS "Pick a carrier" AND TARGETS `payer`, AND THE TWO MUST KEEP MATCHING. It said
 * "Pick a plan" — inherited verbatim from the chip row's Scope entry — while landing the operator on
 * the CARRIER stage. Retargeting it to `plan` to match the old words is the wrong repair, and the
 * reducer is what rules it out: `skipped` sets `payerPick = null` (flow-state.ts), and `went_back`'s
 * one conditional write KEEPS `payerPick` when the target is 'plan' (invariant h). So a 'plan' target
 * would arrive with no carrier chosen — and `StagePlan` does not read null as "none", it falls back
 * to `payers[0]` and renders the largest cluster's plans under that cluster's name. An operator who
 * declined to choose a carrier would be shown one anyway, with `skipped` flipped false so nothing on
 * screen reports the narrowing. That is the "arbitrary rather than general" failure SKIP_CARRIER_MAX
 * was ruled on. Targeting `payer` re-enters the funnel where the operator left it; only the label
 * was ever wrong.
 *
 * "Pick a carrier", not "re-pick": under a skip there was no first pick to redo.
 */
function revisitFor(key: LaneStepKey, state: LaneStepState, skipped: boolean): LaneRevisit | null {
  // Nothing follows the answer, so there is nowhere to go back to FROM it — and `onChange` has no
  // 'answer' target for the same reason.
  if (key === 'answer') return null;
  if (state === 'done') return { to: key, label: 'Change' };
  if (key === 'plan' && state === 'skipped' && skipped) return { to: 'payer', label: 'Pick a carrier' };
  return null;
}

/**
 * The value under a step, or null.
 *
 * A PENDING step is always null — that is the rule that keeps the stepper honest. It would be easy
 * to show the carrier the resolver *would* pick before the operator picks it, and it would be wrong:
 * the whole point of the lane is that the operator's choice is what narrows the answer, so a value
 * appearing before the choice presents a guess as a decision.
 */
function metaFor(key: LaneStepKey, state: LaneStepState, input: LaneStepsInput): string | null {
  const { resolution, carrierCount, payerPick, skipped, policy } = input;
  if (state === 'pending' || resolution === null) return null;
  switch (key) {
    case 'identify':
      // Available as soon as the lane opens — including while the identify step is still CURRENT,
      // because by then the identifier is what the resolver matched on, not a guess.
      return laneEchoLabel(resolution.handle.echo);
    case 'payer':
      if (skipped) return 'All carriers';
      if (state === 'skipped') return carrierCount === 1 ? 'Only carrier on file' : 'Not asked';
      return payerPick ?? (state === 'done' ? resolution.group.payerDisplayName : null);
    case 'plan':
      if (skipped) return 'All plans';
      if (state === 'skipped') return soleCandidateLabel(resolution);
      if (state === 'current') return null; // the question is open — nothing decided yet
      return resolution.group.employerLabel ?? 'No plan sponsor on file';
    case 'answer':
      // ⚠ THE RATING IS READ, NEVER RE-DERIVED. `derivePolicyRating` is the one place the book's
      // patient-weighted number is computed; recomputing a "headline" here would put a second number
      // beside the cards that could disagree with them. Null (in flight, or nothing rateable) shows
      // nothing rather than a zero — a rating of 0 is a real verdict ("Avoid") and must not be what
      // "still loading" looks like.
      if (policy === null || policy.rating === null) return null;
      return `${Math.round(policy.rating)} · ${policy.verdict.split(' · ')[0] ?? policy.verdict}`;
  }
}

/** The one-candidate case: the plan question was never asked because there was one answer. */
function soleCandidateLabel(resolution: QualifyResolution): string {
  return resolution.group.employerLabel ?? 'Only plan on file';
}

/**
 * THE EVENT FEED (mock `.feed`) — the rail's running commentary.
 *
 * Derived from the same steps rather than emitted as side effects, and that is the design decision
 * worth stating: an append-only log written by the flow's transitions would survive a "Start over"
 * and would double up when a step is revisited, because a reducer that appends has to remember what
 * it already appended. Deriving the list from the CURRENT state makes both cases free — going back
 * removes the lines that no longer hold, and resetting empties it, with no bookkeeping.
 */
export function laneFeed(steps: readonly LaneStep[], input: LaneStepsInput): string[] {
  const lines: string[] = [];
  const byKey = (k: LaneStepKey) => steps.find((s) => s.key === k) ?? null;
  const identify = byKey('identify');
  const payer = byKey('payer');
  const plan = byKey('plan');

  if (identify?.meta != null && input.resolution !== null) {
    const n = input.carrierCount;
    lines.push(
      `Matched ${identify.meta} — ${n} carrier${n === 1 ? '' : 's'} possible behind this search.`,
    );
  }
  if (payer?.state === 'done' && payer.meta !== null) {
    lines.push(`Lane locked — answers now draw on ${payer.meta} matches only.`);
  } else if (input.skipped) {
    lines.push('Carrier skipped — the ranking covers every carrier behind this search.');
  }
  if (plan?.state === 'done' && plan.meta !== null) {
    lines.push(`Plan picked: ${plan.meta}.`);
  }
  return lines;
}

/** `n/4` for the checklist head — how many questions this lane has actually settled. */
export function laneProgress(steps: readonly LaneStep[]): { settled: number; total: number } {
  return {
    settled: steps.filter((s) => s.state === 'done' || s.state === 'skipped').length,
    total: steps.length,
  };
}
