/**
 * THE LANE'S FOUR STEPS — the derivation the stepper, the receipt checklist and the feed all read
 * (`lib/qualify/laneSteps.ts`, Smoke shell 2026-08-10).
 *
 * The file exists for two reasons, and the first is a promise made in prose elsewhere:
 *
 *  1. `laneSteps.ts` RESTATES `railStates`' skip rules rather than importing them (that function
 *     lives in a 'use client' component module). Its header says this file pins the two together.
 *     Section 1 below is that pin — without it the header is a claim nobody checks, and the stepper
 *     and the checklist could come to disagree about which questions were never asked.
 *  2. Every string in a `LaneStep.meta` is rendered into the rail's markup, so section 4 is a PHI
 *     assertion, not a formatting one.
 *
 * ⚠ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneSteps, laneFeed, laneProgress, laneEchoLabel } from '../lib/qualify/laneSteps';
import type { LaneStepsInput } from '../lib/qualify/laneSteps';
import { railStates } from '../components/qualify/v3/resolution-flow';
import type { QualifyResolution } from '../lib/qualify/resolution';
import type { PayerGroup } from '../components/qualify/v3/resolution-flow';

/** A resolution with N candidates behind it. Only the fields the derivation reads are populated. */
function resolutionWith(opts: { echo: string; candidates: number; payer?: string; employer?: string | null }) {
  return {
    handle: { kind: 'prefix', readAs: 'read as a 3-character member-ID prefix', echo: opts.echo },
    candidates: { total: opts.candidates },
    group: {
      payerDisplayName: opts.payer ?? 'ANTHEM BLUE CROSS OF CALIFORNIA',
      employerLabel: opts.employer === undefined ? 'GOOGLE LLC' : opts.employer,
    },
  } as unknown as QualifyResolution;
}

const groupsOf = (n: number): PayerGroup[] =>
  Array.from({ length: n }, (_, i) => ({ payer: `CARRIER ${i}` })) as unknown as PayerGroup[];

const baseInput = (over: Partial<LaneStepsInput> = {}): LaneStepsInput => ({
  stage: 'identify',
  resolution: resolutionWith({ echo: 'GGS', candidates: 40 }),
  carrierCount: 4,
  payerPick: null,
  skipped: false,
  policy: null,
  ...over,
});

const STAGES = ['identify', 'payer', 'plan', 'answer'] as const;

// ── 1. THE PIN — laneSteps' states equal railStates' states, for every stage and every shape ─────
//
// This is the assertion the laneSteps.ts header promises. If someone changes a skip rule in one
// module and not the other, this fails rather than shipping a stepper that ticks a step the
// checklist shows as never-asked.
test('laneSteps agrees with railStates about every stage and every skip', () => {
  const shapes = [
    { name: 'many carriers, many candidates', carriers: 4, candidates: 40 },
    { name: 'sole carrier', carriers: 1, candidates: 40 },
    { name: 'sole candidate', carriers: 4, candidates: 1 },
    { name: 'sole carrier AND sole candidate', carriers: 1, candidates: 1 },
  ];
  for (const shape of shapes) {
    for (const stage of STAGES) {
      const resolution = resolutionWith({ echo: 'GGS', candidates: shape.candidates });
      const groups = groupsOf(shape.carriers);
      const mine = laneSteps(baseInput({ stage, resolution, carrierCount: shape.carriers })).map((s) => s.state);
      const theirs = railStates(stage, resolution, groups);
      assert.deepEqual(
        mine,
        theirs,
        `${shape.name} @ ${stage}: laneSteps and railStates disagree — the stepper and the checklist ` +
          `would show different steps as skipped`,
      );
    }
  }
});

// ── 2. A pending step never carries a value ──────────────────────────────────────────────────────
//
// The rule that keeps the stepper from presenting a guess as a decision: the resolver knows which
// carrier dominates before the operator picks one, and showing it early would make the operator's
// choice look like a confirmation of something already decided.
test('steps after the current one carry no value', () => {
  const steps = laneSteps(baseInput({ stage: 'payer', payerPick: null }));
  const plan = steps.find((s) => s.key === 'plan');
  const answer = steps.find((s) => s.key === 'answer');
  assert.equal(plan?.state, 'pending');
  assert.equal(plan?.meta, null, 'the plan value must not appear before the plan question is asked');
  assert.equal(answer?.meta, null);
});

// ── 3. The values are the decisions ──────────────────────────────────────────────────────────────
test('each settled step names what was decided', () => {
  const steps = laneSteps(
    baseInput({
      stage: 'answer',
      payerPick: 'ANTHEM BLUE CROSS OF CALIFORNIA',
      policy: { rating: 71, band: '65', verdict: 'Strong · 65%+', ratedCount: 9, patients: 60, basis: 'x' },
    }),
  );
  const byKey = (k: string) => steps.find((s) => s.key === k)?.meta ?? null;
  assert.equal(byKey('identify'), 'GGS•••');
  assert.equal(byKey('payer'), 'ANTHEM BLUE CROSS OF CALIFORNIA');
  assert.equal(byKey('plan'), 'GOOGLE LLC');
  // The mock's "71 · Strong" — the verdict's band suffix ("· 65%+") is dropped for the rail's width.
  assert.equal(byKey('answer'), '71 · Strong');
});

test('an unrateable book shows no number rather than a zero', () => {
  // A rating of 0 is a REAL verdict ("Avoid"). If "still loading" rendered as 0 the rail would
  // report the worst possible answer while it was in fact reporting nothing.
  const steps = laneSteps(baseInput({ stage: 'answer', payerPick: 'X', policy: null }));
  assert.equal(steps.find((s) => s.key === 'answer')?.meta, null);
});

// ── 4. PHI — no branch can put an identifier on screen ───────────────────────────────────────────
test('a full member ID never reaches a step value', () => {
  // A full member-ID search carries echo === '' by construction. Every stage must render the WORD,
  // never the id and never a truncation of it.
  for (const stage of STAGES) {
    const steps = laneSteps(
      baseInput({
        stage,
        resolution: resolutionWith({ echo: '', candidates: 12 }),
        payerPick: 'AETNA',
        policy: { rating: 40, band: '30', verdict: 'Watch · 30%+', ratedCount: 2, patients: 9, basis: 'x' },
      }),
    );
    assert.equal(steps.find((s) => s.key === 'identify')?.meta, 'Member ID');
    for (const s of steps) {
      assert.doesNotMatch(String(s.meta ?? ''), /\d{6,}/, `${stage}/${s.key}: a long digit run reached a step value`);
    }
  }
});

test('laneEchoLabel masks a prefix and refuses to imply more than it has', () => {
  assert.equal(laneEchoLabel('GGS'), 'GGS•••');
  assert.equal(laneEchoLabel(''), 'Member ID');
});

// ── 5. The counter counts SETTLED, not ANSWERED ──────────────────────────────────────────────────
test('the n/4 counter includes skipped steps', () => {
  // A sole carrier and a sole candidate skip two questions. Reaching the answer stage WITH an answer
  // then means 4/4 settled while the operator answered only one — the counter must not claim
  // otherwise, which is why its accessible name says "settled" rather than "answered".
  const soleEverything = {
    stage: 'answer' as const,
    resolution: resolutionWith({ echo: 'GGS', candidates: 1 }),
    carrierCount: 1,
  };
  const answered = laneSteps(
    baseInput({
      ...soleEverything,
      policy: { rating: 71, band: '65', verdict: 'Strong · 65%+', ratedCount: 9, patients: 60, basis: 'x' },
    }),
  );
  const { settled, total } = laneProgress(answered);
  assert.equal(total, 4);
  assert.equal(settled, 4);
  assert.equal(answered.filter((s) => s.state === 'skipped').length, 2, 'both questions were skipped, not answered');
});

test('the counter does not reach 4/4 while the answer is still in flight', () => {
  // The distinction the mock's spinner-then-tick encodes: landing on the answer stage is not the
  // same event as the answer arriving. If both read 4/4 the checklist would announce a completed
  // qualification over an empty board.
  const inFlight = laneSteps(
    baseInput({ stage: 'answer', resolution: resolutionWith({ echo: 'GGS', candidates: 1 }), carrierCount: 1, policy: null }),
  );
  assert.equal(laneProgress(inFlight).settled, 3);
  assert.equal(inFlight.find((s) => s.key === 'answer')?.state, 'current');
});

// ── 6. The feed is DERIVED, so going back removes what no longer holds ───────────────────────────
//
// The reason it is derived rather than appended: an append-only log would keep the "Lane locked"
// line after the operator went back to change the carrier, and would double it when they re-picked.
test('the feed shrinks when the operator steps back', () => {
  const atAnswer = baseInput({ stage: 'answer', payerPick: 'ANTHEM BLUE CROSS OF CALIFORNIA' });
  const full = laneFeed(laneSteps(atAnswer), atAnswer);
  const atPayer = baseInput({ stage: 'payer', payerPick: null });
  const back = laneFeed(laneSteps(atPayer), atPayer);
  assert.ok(full.length > back.length, 'stepping back must retire the lines that no longer hold');
  assert.ok(full.some((l) => l.includes('Lane locked')));
  assert.ok(!back.some((l) => l.includes('Lane locked')), 'the lock line must not survive going back to the carrier question');
});

test('a skipped carrier says the ranking went wide, not that a carrier was chosen', () => {
  const input = baseInput({ stage: 'answer', skipped: true, payerPick: null });
  const lines = laneFeed(laneSteps(input), input);
  assert.ok(lines.some((l) => l.includes('every carrier')), 'the all-carriers scope must be stated');
  assert.ok(!lines.some((l) => l.includes('Lane locked')), 'nothing was locked — no carrier was picked');
});

test('the feed is empty before anything resolves', () => {
  const input = baseInput({ stage: 'identify', resolution: null });
  assert.deepEqual(laneFeed(laneSteps(input), input), []);
});

// ── 7. REVISIT — which steps offer a way back, and to where ──────────────────────────────────────
//
// `revisit` replaces the chip row's Change buttons in shell mode, so these pin that the replacement
// offers the SAME controls the chip row did. The rule is `state === 'done'` for the three ordinary
// steps; the interesting cases are the two that are not ordinary.
const revisitOf = (input: LaneStepsInput) =>
  Object.fromEntries(laneSteps(input).map((s) => [s.key, s.revisit]));

test('every settled step offers a way back to its own stage', () => {
  const r = revisitOf(baseInput({ stage: 'answer', payerPick: 'AETNA' }));
  assert.deepEqual(r.identify, { to: 'identify', label: 'Change' });
  assert.deepEqual(r.payer, { to: 'payer', label: 'Change' });
  assert.deepEqual(r.plan, { to: 'plan', label: 'Change' });
});

test('the answer step offers nothing — there is nowhere after it to come back from', () => {
  const r = revisitOf(
    baseInput({
      stage: 'answer',
      payerPick: 'AETNA',
      policy: { rating: 71, band: '65', verdict: 'Strong · 65%+', ratedCount: 9, patients: 60, basis: 'x' },
    }),
  );
  // Settled — 'done', not 'current' — and still no control, which is why `onChange` has no 'answer'.
  assert.equal(laneSteps(baseInput({ stage: 'answer', payerPick: 'A' })).at(-1)?.key, 'answer');
  assert.equal(r.answer, null);
});

test('the step you are ON offers no way back to itself', () => {
  const r = revisitOf(baseInput({ stage: 'payer' }));
  assert.equal(r.payer, null, 'a Change button on the open question is a control that does nothing');
  assert.equal(r.plan, null, 'and a pending step has nothing to change');
  assert.deepEqual(r.identify, { to: 'identify', label: 'Change' }, 'the settled one still does');
});

// ⚠ THE TWO SKIPS ARE DIFFERENT AND THIS IS THE PAIR THAT PROVES IT. Both render `state === 'skipped'`
// and the only other downstream discriminator is the `meta` display string, so if this distinction is
// ever lost it will be lost silently.
test('a STRUCTURAL skip offers no control — the question was never askable', () => {
  // One carrier on file and one candidate: the operator declined nothing, so sending them back to a
  // stage with a single chip would be a control with no decision behind it. The chip row suppressed
  // its Carrier entry on `payers.length > 1` for exactly this reason.
  const r = revisitOf(
    baseInput({
      stage: 'answer',
      resolution: resolutionWith({ echo: 'GGS', candidates: 1 }),
      carrierCount: 1,
      skipped: false,
    }),
  );
  assert.equal(r.payer, null, 'a sole-carrier lane must not offer "Pick a plan"');
  assert.equal(r.plan, null, 'nor a sole-candidate one');
});

test("an OPERATOR's skip offers the escape hatch, back to the carrier stage", () => {
  const r = revisitOf(baseInput({ stage: 'answer', skipped: true, payerPick: null }));
  // The label is the operator's GOAL and the target is the stage that gets them there: a plan is
  // picked within a carrier, so "Pick a plan" goes back to `payer`. This reproduces the chip row's
  // Scope entry exactly — same words, same target.
  assert.deepEqual(r.plan, { to: 'payer', label: 'Pick a plan' });
  assert.equal(r.payer, null, 'one escape hatch, not two — the chip row offered a single Scope entry');
  assert.deepEqual(r.identify, { to: 'identify', label: 'Change' }, 'the search is always revisitable');
});

test('a revisit target is always a real went_back stage, never the answer', () => {
  // `onChange` accepts 'identify' | 'payer' | 'plan'. A derivation that emitted 'answer' would
  // typecheck against `LaneRevisit` only if someone widened it, so this is the runtime backstop.
  for (const stage of STAGES) {
    for (const skipped of [false, true]) {
      for (const step of laneSteps(baseInput({ stage, skipped, payerPick: skipped ? null : 'AETNA' }))) {
        if (step.revisit === null) continue;
        assert.ok(
          ['identify', 'payer', 'plan'].includes(step.revisit.to),
          `${stage}/${step.key}: ${step.revisit.to} is not a went_back target`,
        );
      }
    }
  }
});

test('a revisit label is fixed copy and never carries a value', () => {
  // PHI, same argument as section 4: `revisit` reaches the markup. It must be one of two constants —
  // never the echo, the payer or the employer.
  for (const stage of STAGES) {
    for (const skipped of [false, true]) {
      const steps = laneSteps(
        baseInput({ stage, skipped, resolution: resolutionWith({ echo: '', candidates: 12 }), payerPick: 'AETNA' }),
      );
      for (const s of steps) {
        if (s.revisit === null) continue;
        assert.ok(['Change', 'Pick a plan'].includes(s.revisit.label), `${stage}/${s.key}: ${s.revisit.label}`);
      }
    }
  }
});
