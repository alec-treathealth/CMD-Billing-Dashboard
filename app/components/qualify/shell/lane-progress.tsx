'use client';

/**
 * THE RAIL'S PROGRESS SURFACES — the mock's `.stepper`, `.receipt` and `.feed`
 * (`docs/mockups/qualify-smoke.html`), which the shell was missing.
 *
 * All three render from ONE array of `LaneStep`s (`lib/qualify/laneSteps.ts`). None of them derives
 * state or values itself, which is the point: the mock states the same progress three times, and the
 * only way three renderings of the same fact stay honest is if there is one fact.
 *
 * WHY THESE ARE NOT ONE COMPONENT. They occupy different places in the rail's scroll — the stepper is
 * pinned above the fold, the receipt and feed scroll with the flow — so they cannot share a wrapper.
 *
 * MOTION: no GSAP here. The stepper's fill and the receipt's tick are CSS transitions, which collapse
 * under the global `prefers-reduced-motion` reset in globals.css. The mock animates the feed lines in
 * with a stagger; that is deliberately dropped — a line that fades in AFTER the operator has moved on
 * arrives as a distraction next to the question they are now answering.
 *
 * PHI: every string rendered here arrives on a `LaneStep`, and `laneSteps.ts`'s header is the
 * argument for why none of them can carry the typed identifier. This file adds no data of its own.
 * The two values that do NOT ride a step — `LaneReceipt`'s `memberCount` and `scope` — are a
 * population count and a payer-scope label, the same two the chip row rendered in this rail before
 * the merge; neither is a member field and neither moves into a new channel.
 */
import type { LaneStep, LaneStepState } from '../../../lib/qualify/laneSteps';
import { laneProgress } from '../../../lib/qualify/laneSteps';
import { memberBucketOf } from '../../../lib/qualify/memberPreface';

/** Dot treatment per state. Shape carries the state alongside colour — `skipped` is a dashed ring and
 *  `current` a solid halo, so the four states stay distinguishable without relying on hue. */
const DOT: Record<LaneStepState, string> = {
  pending: 'border border-line bg-teal50 text-transparent',
  skipped: 'border border-dashed border-teal500 bg-teal200 text-teal700',
  current: 'bg-teal500 text-white ring-4 ring-teal500/20',
  done: 'bg-teal700 text-white',
};

/** The connector to the NEXT step — filled only once this step is settled. */
const CONNECTOR: Record<LaneStepState, string> = {
  pending: 'bg-line',
  skipped: 'bg-teal200',
  current: 'bg-gradient-to-r from-teal500 to-line',
  done: 'bg-teal700',
};

/** State as words, for the screen-reader. "Skipped" must be readable, never inferable from a hue. */
const SPOKEN: Record<LaneStepState, string> = {
  pending: 'not yet',
  skipped: 'skipped — not asked',
  current: 'current step',
  done: 'done',
};

/**
 * THE STEPPER (mock `.stepper`) — the four stages as a horizontal timeline, each carrying the value
 * it settled on.
 *
 * ⚠ THE VALUE LINE IS THE WHOLE POINT, and it is what the shipped `StepRail` lacked. Without it the
 * stepper is decoration — four labels that say what the flow's stages are called, which the operator
 * already knows. With it, the stepper is the answer to "what did I already tell it?", readable in one
 * glance from any stage, which is what makes going back safe.
 *
 * Not a control: the receipt below is the revisit affordance (its "Change" buttons), and two
 * different ways to jump between stages sitting one above the other is how they drift apart.
 */
export function LaneStepper({ steps }: { steps: readonly LaneStep[] }) {
  return (
    <ol role="list" className="flex list-none items-start gap-0 p-0" data-testid="qualify-lane-stepper">
      {steps.map((step, i) => (
        <li key={step.key} role="listitem" className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold leading-none transition-colors duration-200 ${DOT[step.state]}`}
            >
              {step.state === 'done' ? '✓' : step.state === 'skipped' ? '–' : ''}
            </span>
            {/* The connector belongs to the gap AFTER this dot, so the last step has none. */}
            {i < steps.length - 1 ? (
              <span aria-hidden className={`h-0.5 min-w-0 flex-1 rounded-full transition-colors duration-200 ${CONNECTOR[step.state]}`} />
            ) : null}
          </span>
          <span
            className={`truncate font-head text-[10px] font-bold uppercase tracking-[0.4px] ${
              step.state === 'current' ? 'text-ink900' : step.state === 'pending' ? 'text-ink400' : 'text-teal700'
            }`}
          >
            {step.label}
            <span className="sr-only"> — {SPOKEN[step.state]}</span>
          </span>
          {/* The settled value. `min-h` reserves the line so the stepper does not grow by a row the
              moment the first step resolves — a layout jump directly above the question the operator
              is reading. */}
          <span className="ths-num min-h-[14px] truncate text-[10.5px] leading-tight text-ink400">
            {step.meta ?? ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * THE RECEIPT (mock `.receipt`) — the four questions struck through as they are settled, each
 * revisitable, and THE ONLY receipt the shell renders.
 *
 * ⚠ THIS SUPERSEDES A RULING RECORDED HERE IN #194 AND THE CORRECTION IS THE POINT. That note said
 * `FlowReceipt` "STAYS" because the chip row is the REVISIT control and this is the RECORD, so "the
 * shell shows both, the way the mock does". The last clause was simply false: the mock's `.receipt`
 * (qualify-smoke.html:567-597) is `dot / txt / val` — no Change, no chip row anywhere in the rail. So
 * the shell was stating the same four decisions twice, once as a checklist and once as chips 40px
 * below, and the two had to be kept in agreement by hand. `FlowReceipt` is now gated OFF in shell
 * mode and this component carries everything it carried:
 *
 *   · the RECORD      — the four questions and their settled values (was always here)
 *   · the REVISIT     — `step.revisit`, the chip row's "Change" / "Pick a plan"
 *   · the MEMBER COUNT— the chip row's `· N members`, with the basis in its accessible name
 *   · the SCOPE       — the chip row's "All plans · all payers — your re-scope" on a skipped lane
 *
 * `FlowReceipt` is untouched and still ships: it is what the single-column (non-shell) layout
 * renders, and gating it off here changed none of its own code.
 *
 * PRESENTATIONAL, DELIBERATELY. Every branch below reads a value the parent handed down — it decides
 * nothing. `revisit` is derived in `laneSteps.ts` (where the operator-skip / structural-skip
 * distinction lives), and `memberCount` / `scope` arrive as plain props from the flow, which is what
 * keeps them OUT of the step derivation: they are facts about the lane, not about a step.
 *
 * `title` names the lane rather than restating the search, because the head is the one line that
 * stays visible while the list scrolls.
 */
export function LaneReceipt({
  steps,
  title,
  onChange,
  memberCount = null,
  scope = null,
}: {
  steps: readonly LaneStep[];
  title: string;
  /** The flow's `went_back` dispatch. Omitted (single-column, tests) renders a read-only record. */
  onChange?: (backTo: 'identify' | 'payer' | 'plan') => void;
  /** Members behind the search, or null. Rides the IDENTIFY row — it qualifies that decision. */
  memberCount?: number | null;
  /**
   * The all-payers scope, or null when the operator did not skip. The parent passes this ONLY on a
   * skipped lane, so a non-null value is itself the signal — this component never re-derives "was
   * the carrier question declined?" from a step state that collapses two different skips.
   */
  scope?: { payer: string | null; allPayers: boolean; byUser: boolean } | null;
}) {
  const { settled, total } = laneProgress(steps);
  const complete = settled >= total;
  /* HOW MANY PEOPLE THAT SEARCH ACTUALLY MATCHED — the count, carried over from the chip row.
   *
   * ⚠ THE GATE IS `memberBucketOf`, NOT A SECOND null/zero TERNARY, and that is inherited verbatim
   * from `FlowReceipt` along with the number. 'unknown' (the count was unavailable) and 'none' (it
   * ran and found nobody) are the two states that say nothing, and they live in memberPreface.ts so
   * every surface shares the SILENCE rule and not merely the words.
   *
   * ⚠ THE ACCESSIBLE NAME STATES THE BASIS, because the numeral cannot. `memberCount` is the
   * ladder's 365-day rung filtered on `payment_received` — "members with a PAID CLAIM in the last 12
   * months", never "members who exist". It deliberately does NOT reuse the preface's "behind this
   * search" clause: this sits on the row labelled Identify, so the clause is redundant, and the
   * receipt is not suppressed in flight while the preface is. */
  const memberBucket = memberBucketOf(memberCount);
  const memberChip =
    memberCount !== null && memberBucket !== 'unknown' && memberBucket !== 'none' ? (
      <span className="shrink-0 text-[11px] text-ink600">
        ·{' '}
        <span
          className="ths-num"
          aria-label={`${memberCount} member${memberCount === 1 ? '' : 's'} with a paid claim in the last 12 months`}
        >
          {memberCount.toLocaleString()}
        </span>{' '}
        member{memberCount === 1 ? '' : 's'}
      </span>
    ) : null;
  return (
    <section
      aria-label="Qualification receipt"
      data-testid="qualify-lane-receipt"
      className="rounded-xl border border-line bg-ground p-3.5 shadow-ths-sm"
    >
      <div className="mb-2.5 flex items-center gap-2.5">
        <span
          aria-hidden
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold leading-none ${
            complete ? 'bg-teal700 text-white' : 'border-2 border-teal200 border-t-teal500 motion-safe:animate-spin'
          }`}
        >
          {complete ? '✓' : ''}
        </span>
        <h3 className="min-w-0 flex-1 truncate font-head text-[13.5px] font-semibold tracking-tight text-ink900">
          {title}
        </h3>
        {/* The counter is the honesty check on the list: it counts SETTLED steps, which includes the
            skipped ones, so "4/4" never means "you answered four questions". */}
        <span className="ths-num shrink-0 font-mono text-[11.5px] text-ink600" aria-label={`${settled} of ${total} steps settled`}>
          {settled}/{total}
        </span>
      </div>
      <ol className="flex list-none flex-col p-0">
        {steps.map((step, i) => {
          // Bound once so the click handler narrows — and so the button's target can never drift
          // from the one the derivation chose.
          const revisit = step.revisit;
          /* THE SCOPE THE RANKING ACTUALLY USED, carried over from the chip row's Scope entry. The
           * derivation owns the words "All plans"; this appends only what it cannot know.
           * `byUser` is the operator's OWN re-scope that the core HONOURED — never a default, and
           * never a chip that was merely sent — so claiming it on anything else would be the exact
           * overclaim `scopeByUser` was introduced to remove. */
          const scopeSuffix =
            step.key === 'plan' && scope !== null
              ? `${scope.allPayers ? ' · all payers' : scope.payer !== null ? ` · ${scope.payer}` : ''}${
                  scope.byUser ? ' — your re-scope' : ''
                }`
              : '';
          return (
            <li key={step.key} className="relative flex min-h-[32px] items-center gap-2.5">
              {/* The spine between numbered dots. Absolutely positioned so it cannot push the row. */}
              {i < steps.length - 1 ? (
                <span aria-hidden className="absolute left-[9px] top-[25px] h-[calc(100%-18px)] w-0.5 bg-line" />
              ) : null}
              <span
                aria-hidden
                className={`z-[1] grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold leading-none transition-colors duration-200 ${
                  step.state === 'done'
                    ? 'bg-teal700 text-white'
                    : step.state === 'skipped'
                      ? 'border border-dashed border-teal500 bg-teal200 text-teal700'
                      : step.state === 'current'
                        ? 'border-[1.5px] border-teal500 bg-surface text-teal700'
                        : 'border-[1.5px] border-line bg-surface text-ink400'
                }`}
              >
                {step.state === 'done' ? '✓' : i + 1}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[12.5px] leading-tight ${
                  step.state === 'done' || step.state === 'skipped'
                    ? 'text-ink400 line-through decoration-line'
                    : 'text-ink900'
                }`}
              >
                {step.question}
                <span className="sr-only"> — {SPOKEN[step.state]}</span>
              </span>
              <span className="ths-num min-w-0 shrink truncate font-mono text-[11px] text-ink600">
                {step.meta ?? ''}
                {scopeSuffix}
              </span>
              {step.key === 'identify' ? memberChip : null}
              {/* The revisit control. Absent `onChange` this is a read-only record rather than a
                  dead button — the single-column layout and the derivation's own tests render it
                  that way. The accessible name carries the question, because four buttons all
                  reading "Change" are indistinguishable in a screen-reader's element list. */}
              {onChange !== undefined && revisit !== null ? (
                <button
                  type="button"
                  onClick={() => onChange(revisit.to)}
                  aria-label={`${revisit.label} — ${step.question}`}
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold text-teal700 transition-colors hover:bg-teal50"
                >
                  {revisit.label}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * THE EVENT FEED (mock `.feed`) — what the lane has established, in sentences.
 *
 * Renders nothing at all when empty rather than an empty bordered box: pre-search the rail should
 * read as one question, not as a set of vacant containers waiting to be filled.
 *
 * `aria-live="polite"` because these lines appear in response to the operator's own actions and are
 * the confirmation that the action landed — but `atomic={false}` so a new line is announced on its
 * own instead of re-reading the whole list on every stage move.
 */
export function LaneFeed({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul
      aria-live="polite"
      aria-atomic="false"
      className="flex list-none flex-col gap-1.5 p-0"
      data-testid="qualify-lane-feed"
    >
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-ink600">
          <span aria-hidden className="mt-[3px] text-[10px] text-teal500">
            ✓
          </span>
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  );
}
