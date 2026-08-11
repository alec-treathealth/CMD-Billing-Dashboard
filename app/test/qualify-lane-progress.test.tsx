/**
 * THE RAIL'S PROGRESS SURFACES, RENDERED — the mock's `.stepper`, `.receipt` and `.feed`
 * (`components/qualify/shell/lane-progress.tsx`, Smoke shell 2026-08-10).
 *
 * `qualify-lane-steps.test.tsx` covers the DERIVATION. This file covers what reaches the markup,
 * which is a different risk: a correct step list rendered through a component that drops the value
 * line, or ticks a skipped step, looks fine to the derivation's tests and wrong on screen.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement } from 'react';
import type { ReactNode } from 'react';
import { LaneStepper, LaneReceipt, LaneFeed } from '../components/qualify/shell/lane-progress';
import type { LaneStep } from '../lib/qualify/laneSteps';

// A sole-carrier lane: identify settled, the carrier question STRUCTURALLY skipped (never askable,
// so no escape hatch), the plan question open. `revisit` is what `laneSteps` really emits for this
// shape — see `qualify-lane-steps.test.tsx` § 7, which pins the derivation itself.
const STEPS: LaneStep[] = [
  { key: 'identify', label: 'Identify', question: 'Identify — who are we looking at?', state: 'done', meta: 'GGS•••', revisit: { to: 'identify', label: 'Change' } },
  { key: 'payer', label: 'Carrier', question: 'Carrier — which is on the card?', state: 'skipped', meta: 'Only carrier on file', revisit: null },
  { key: 'plan', label: 'Plan', question: 'Plan — which plan is it?', state: 'current', meta: null, revisit: null },
  { key: 'answer', label: 'Answer', question: 'Answer — do they pay us, where?', state: 'pending', meta: null, revisit: null },
];

// ── 1. The stepper carries the VALUES, which is the whole reason it replaced StepRail ────────────
test('the stepper renders each label and each settled value', () => {
  const html = renderToStaticMarkup(<LaneStepper steps={STEPS} />);
  for (const label of ['Identify', 'Carrier', 'Plan', 'Answer']) assert.match(html, new RegExp(label));
  assert.match(html, /GGS•••/, 'the identify value must be on the stepper — without it this is decoration');
  assert.match(html, /Only carrier on file/);
});

test('the stepper says "skipped" in words, not only in colour', () => {
  const html = renderToStaticMarkup(<LaneStepper steps={STEPS} />);
  assert.match(html, /skipped — not asked/, 'a screen reader must hear the state; hue is not a state');
  assert.match(html, /current step/);
});

// ── 2. The checklist ────────────────────────────────────────────────────────────────────────────
test('the checklist strikes through settled questions and leaves the open one plain', () => {
  const html = renderToStaticMarkup(<LaneReceipt steps={STEPS} title="Qualifying prefix GGS" />);
  assert.match(html, /Qualifying prefix GGS/);
  // Two settled steps (one done, one skipped) → 2/4.
  assert.match(html, /2\/4/);
  assert.match(html, /2 of 4 steps settled/, 'the accessible name says SETTLED, never "answered"');
  assert.match(html, /line-through/, 'settled questions read as struck through');
  for (const q of ['who are we looking at', 'which is on the card', 'which plan is it', 'do they pay us']) {
    assert.match(html, new RegExp(q));
  }
});

test('a skipped step is never ticked', () => {
  // "Done" claims the operator answered a question. The skipped carrier step was never asked, so it
  // must not wear the same ✓ the answered one does — it carries the dashed treatment and its number.
  const html = renderToStaticMarkup(<LaneReceipt steps={STEPS} title="t" />);
  assert.match(html, /border-dashed/, 'the skipped step keeps its own treatment');
  // Exactly one ✓ in the list body: the single `done` step. (The head shows none — 2/4 is not complete.)
  assert.equal((html.match(/✓/g) ?? []).length, 1, 'one tick for one answered question');
});

test('the checklist head ticks only when every step is settled', () => {
  const all = STEPS.map((s) => ({ ...s, state: 'done' as const }));
  const html = renderToStaticMarkup(<LaneReceipt steps={all} title="t" />);
  assert.match(html, /4\/4/);
  assert.doesNotMatch(html, /animate-spin/, 'a completed receipt must not keep spinning');
  const partial = renderToStaticMarkup(<LaneReceipt steps={STEPS} title="t" />);
  assert.match(partial, /animate-spin/, 'an unfinished receipt shows it is still working');
});

// ── 3. The feed ─────────────────────────────────────────────────────────────────────────────────
test('the feed renders nothing at all when there is nothing to say', () => {
  // Not an empty bordered box: pre-search the rail should read as one question, not as vacant
  // containers waiting to be filled.
  assert.equal(renderToStaticMarkup(<LaneFeed lines={[]} />), '');
});

test('the feed announces politely and non-atomically', () => {
  const html = renderToStaticMarkup(<LaneFeed lines={['Lane locked — answers now draw on AETNA matches only.']} />);
  assert.match(html, /aria-live="polite"/);
  // atomic=false so a new line is announced alone rather than re-reading the whole list on every move.
  assert.match(html, /aria-atomic="false"/);
  assert.match(html, /Lane locked/);
});

// ── 4. THE GATING — the fallback layout must keep the bare StepRail ──────────────────────────────
//
// Rendering `ResolutionStages` here would need its whole props bag; the risk being guarded is
// narrower than that and lives in two lines of source: that the two branches still exist, and that
// the shell is what turns the new one on. If someone deletes the fallback branch, the QUALIFY_V3_FLOW
// kill switch silently starts rendering a layout nobody tested.
const FLOW_SRC = readFileSync(new URL('../components/qualify/v3/resolution-flow.tsx', import.meta.url), 'utf8');
const CLIENT_SRC = readFileSync(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url), 'utf8');

test('the rail progression is shell-only and the single-column fallback keeps StepRail', () => {
  assert.match(FLOW_SRC, /props\.showLaneReceipt === true \?/, 'the new surfaces stay behind their own flag');
  assert.match(
    FLOW_SRC,
    /<StepRail stage=\{props\.stage\}/,
    'the fallback branch must still render the bare rail — it is what QUALIFY_V3_FLOW=off ships',
  );
  assert.match(CLIENT_SRC, /showLaneReceipt=\{shellMode\}/, 'and the shell is what turns it on');
});

test('the flag is separate from answerInline', () => {
  // Both are true exactly when the shell is on, so one bit would work today and would silently mean
  // "the shell" rather than what each controls. Keep them two decisions.
  assert.match(CLIENT_SRC, /answerInline=\{!shellMode\}/);
  assert.doesNotMatch(FLOW_SRC, /showLaneReceipt \?\?\s*props\.answerInline/, 'never derive one flag from the other');
});

// ── 5. THE MERGE — the receipt now carries the chip row's controls and facts ─────────────────────
//
// `FlowReceipt` is gated off in shell mode (pinned in qualifyV3Flow.test.tsx), so anything it used to
// contribute to the rail has to arrive here or it is simply gone. These cover the three things that
// moved: the Change controls, the member count, and the skipped lane's scope.

/**
 * Walk a rendered element tree and collect every `<button>` with its handler.
 *
 * ⚠ WHY NOT `renderToStaticMarkup` + a click. That helper emits HTML, which carries no handlers, and
 * this suite has no jsdom (a deliberate constraint — `node:test` only, no new test-runner deps). The
 * element tree is therefore the only place a click can actually be exercised, and "the button exists"
 * is a weaker claim than "the button dispatches the right stage" — the target is the part that can
 * silently be wrong.
 */
function buttonsIn(node: ReactNode): { label: string; onClick: () => void }[] {
  const out: { label: string; onClick: () => void }[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child as ReactNode);
      return;
    }
    if (!isValidElement(n)) return;
    const p = n.props as { children?: ReactNode; onClick?: () => void };
    if (n.type === 'button' && typeof p.onClick === 'function') {
      out.push({ label: String(p.children), onClick: p.onClick });
    }
    walk(p.children);
  };
  walk(node);
  return out;
}

const SETTLED: LaneStep[] = [
  { key: 'identify', label: 'Identify', question: 'Identify — who are we looking at?', state: 'done', meta: 'GGS•••', revisit: { to: 'identify', label: 'Change' } },
  { key: 'payer', label: 'Carrier', question: 'Carrier — which is on the card?', state: 'done', meta: 'AETNA', revisit: { to: 'payer', label: 'Change' } },
  { key: 'plan', label: 'Plan', question: 'Plan — which plan is it?', state: 'done', meta: 'GOOGLE LLC', revisit: { to: 'plan', label: 'Change' } },
  { key: 'answer', label: 'Answer', question: 'Answer — do they pay us, where?', state: 'current', meta: null, revisit: null },
];

test('each settled row offers Change, and it dispatches that row’s own stage', () => {
  const sent: string[] = [];
  const buttons = buttonsIn(LaneReceipt({ steps: SETTLED, title: 't', onChange: (to) => sent.push(to) }));
  assert.equal(buttons.length, 3, 'three settled steps, three controls — the answer step offers none');
  for (const b of buttons) b.onClick();
  assert.deepEqual(sent, ['identify', 'payer', 'plan'], 'in order, each to its own stage');
});

test('a structurally skipped row offers no control at all', () => {
  // STEPS is a sole-carrier lane. The operator declined nothing, so there is no question to go back
  // to — the only control is the search itself.
  const buttons = buttonsIn(LaneReceipt({ steps: STEPS, title: 't', onChange: () => {} }));
  assert.deepEqual(buttons.map((b) => b.label), ['Change'], 'only the search is revisitable here');
});

test('an operator’s skip offers "Pick a carrier", and it goes back to the carrier stage', () => {
  const skippedSteps: LaneStep[] = [
    { ...STEPS[0]! },
    { key: 'payer', label: 'Carrier', question: 'Carrier — which is on the card?', state: 'skipped', meta: 'All carriers', revisit: null },
    { key: 'plan', label: 'Plan', question: 'Plan — which plan is it?', state: 'skipped', meta: 'All plans', revisit: { to: 'payer', label: 'Pick a carrier' } },
    { ...STEPS[3]! },
  ];
  const sent: string[] = [];
  const buttons = buttonsIn(LaneReceipt({ steps: skippedSteps, title: 't', onChange: (to) => sent.push(to) }));
  const hatch = buttons.find((b) => b.label === 'Pick a carrier');
  assert.ok(hatch !== undefined, 'a declined carrier question must keep a way back into choosing');
  hatch.onClick();
  // The words and the destination agree. They did not always: the label read "Pick a plan" over a
  // button that lands on the carrier stage — see the pair pin in qualify-lane-steps.test.tsx § 7.
  assert.deepEqual(sent, ['payer'], 'and the button reaches the stage its label names');
});

test('without onChange the receipt is a read-only record, not a row of dead buttons', () => {
  // The derivation still emits `revisit`; the component simply has nowhere to send it.
  const html = renderToStaticMarkup(<LaneReceipt steps={SETTLED} title="t" />);
  assert.ok(!html.includes('<button'), 'no control may render when there is no handler behind it');
  assert.match(html, /AETNA/, 'the record itself is unaffected');
});

// ── 6. The member count — the chip row’s number, with its basis ─────────────────────────────────
test('the member count rides the identify row and states its basis', () => {
  const html = renderToStaticMarkup(<LaneReceipt steps={SETTLED} title="t" memberCount={1234} />);
  assert.match(html, /1,234/, 'the count is grouped, as the chip row rendered it');
  // The numeral cannot say what it counts; the accessible name must.
  assert.match(html, /1234 members with a paid claim in the last 12 months/);
});

test('the count is silent when it is unknown or zero, never rendered as "0 members"', () => {
  // The two states memberPreface calls 'unknown' and 'none'. A failed query must not render as a
  // factual claim about a member, and "0 members" over a populated board is exactly that.
  for (const count of [null, 0]) {
    const html = renderToStaticMarkup(<LaneReceipt steps={SETTLED} title="t" memberCount={count} />);
    assert.ok(!html.includes('member'), `memberCount=${String(count)} must render nothing`);
  }
  assert.match(
    renderToStaticMarkup(<LaneReceipt steps={SETTLED} title="t" memberCount={1} />),
    /1 member with a paid claim/,
    'singular is not pluralised',
  );
});

// ── 7. The scope — the chip row’s Scope entry, on the plan row ──────────────────────────────────
test('a skipped lane names the scope the ranking actually used', () => {
  const skippedSteps: LaneStep[] = [
    { ...STEPS[0]! },
    { key: 'payer', label: 'Carrier', question: 'Carrier — which is on the card?', state: 'skipped', meta: 'All carriers', revisit: null },
    { key: 'plan', label: 'Plan', question: 'Plan — which plan is it?', state: 'skipped', meta: 'All plans', revisit: null },
    { ...STEPS[3]! },
  ];
  const wide = renderToStaticMarkup(
    <LaneReceipt steps={skippedSteps} title="t" scope={{ payer: null, allPayers: true, byUser: true }} />,
  );
  assert.match(wide, /All plans · all payers — your re-scope/, 'the chip row’s exact Scope wording');

  // A named payer instead of the wide axis, and NOT the operator's own re-scope: `scopeByUser` means
  // the core HONOURED a chip the operator sent, so claiming it on a default would be an overclaim.
  const narrow = renderToStaticMarkup(
    <LaneReceipt steps={skippedSteps} title="t" scope={{ payer: 'AETNA', allPayers: false, byUser: false }} />,
  );
  assert.match(narrow, /All plans · AETNA/);
  assert.ok(!narrow.includes('your re-scope'), 'a default scope is not the operator’s re-scope');
});

test('an unskipped lane renders no scope detail at all', () => {
  // The parent passes `scope` only on a skipped lane, so null IS the signal — the component never
  // re-derives "was the carrier question declined?" from a state that collapses two kinds of skip.
  const html = renderToStaticMarkup(<LaneReceipt steps={SETTLED} title="t" scope={null} />);
  assert.ok(!html.includes('all payers'), 'nothing was skipped, so there is no wider scope to report');
  assert.match(html, /GOOGLE LLC/, 'the plan row still shows the plan that was picked');
});
