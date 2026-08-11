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
import { LaneStepper, LaneReceipt, LaneFeed } from '../components/qualify/shell/lane-progress';
import type { LaneStep } from '../lib/qualify/laneSteps';

const STEPS: LaneStep[] = [
  { key: 'identify', label: 'Identify', question: 'Identify — who are we looking at?', state: 'done', meta: 'GGS•••' },
  { key: 'payer', label: 'Carrier', question: 'Carrier — which is on the card?', state: 'skipped', meta: 'Only carrier on file' },
  { key: 'plan', label: 'Plan', question: 'Plan — which plan is it?', state: 'current', meta: null },
  { key: 'answer', label: 'Answer', question: 'Answer — do they pay us, where?', state: 'pending', meta: null },
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
