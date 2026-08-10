/**
 * THE SMOKE SHELL'S CHROME — LaneRail, ThisSearchZone, QualifyComposer, rendered.
 *
 * What must hold:
 *   1. THE LOCK STRIP echoes the prefix and NEVER a raw identifier — its input is `echo`
 *      (prefix-safe by construction) and `readAs` (a sentence ABOUT the identifier), and the test
 *      feeds it a poisoned readAs-adjacent world to prove nothing else leaks in.
 *   2. THE ZONE mirrors the stage honestly: empty → matched (counts) → hero (counts, NO DOLLARS —
 *      the mock's hero shows $1,059,000 and this one must not).
 *   3. THE COMPOSER is slots-only (no text input) and quiet before a snapshot exists.
 *   4. Start over is aria-disabled (not disabled) pre-resolution — the focus-drop rule.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LaneRail } from '../components/qualify/shell/lane-rail';
import { ThisSearchZone } from '../components/qualify/shell/board-zone';
import { QualifyComposer } from '../components/qualify/shell/composer';
import type { PayerGroup } from '../components/qualify/v3/resolution-flow';
import type { QualifyResolution } from '../lib/qualify/resolution';
import type { QualifySnapshot } from '../lib/qualify/contract';

const group = (over: Partial<PayerGroup> = {}): PayerGroup => ({
  payer: 'AETNA',
  names: new Set(['AETNA']),
  otherSpellings: ['AETNA HEALTH'],
  unmapped: false,
  memberCount: 12,
  planCount: 5,
  hasClaimEvidence: true,
  ...over,
});

/** Only the fields the zone reads — cast at the seam (the policy-tape tests' idiom). */
const RESOLUTION = { handle: { readAs: 'read as a 3-character member-ID prefix', echo: 'GGS' } } as unknown as QualifyResolution;

// ── 1. The lane rail ────────────────────────────────────────────────────────────────────────────
test('the lock strip states the guardrail with the echo, and Start over is aria-disabled pre-lane', () => {
  const empty = renderToStaticMarkup(
    <LaneRail echo="" readAs={null} hasResolution={false} onReset={() => {}} composer={null}>
      <p>flow</p>
    </LaneRail>,
  );
  assert.match(empty, /No lane yet/);
  assert.match(empty, /aria-disabled="true"/);
  // A REAL disabled attribute serializes as ` disabled=""`; `aria-disabled="true"` must not trip this.
  assert.doesNotMatch(empty, / disabled=""/, 'disabled drops keyboard focus — aria-disabled only');

  const locked = renderToStaticMarkup(
    <LaneRail echo="GGS" readAs="read as a 3-character member-ID prefix" hasResolution={true} onReset={() => {}} composer={null}>
      <p>flow</p>
    </LaneRail>,
  );
  assert.match(locked, /Locked to/);
  assert.match(locked, /GGS/);
  assert.match(locked, /nothing outside it/);
});

// ── 2. The zone's stage mirrors ─────────────────────────────────────────────────────────────────
test('the zone fills per stage and the hero carries counts, never dollars', () => {
  const empty = renderToStaticMarkup(
    <ThisSearchZone stage="identify" resolution={null} payerGroups={[]} payerPick={null} echo="">
      <p>ANSWER-SENTINEL</p>
    </ThisSearchZone>,
  );
  assert.match(empty, /NOTHING RESOLVED YET/);
  assert.match(empty, /the board fills in as you answer the rail/);
  assert.doesNotMatch(empty, /ANSWER-SENTINEL/, 'the answer children must not render before the answer stage');

  const matched = renderToStaticMarkup(
    <ThisSearchZone stage="payer" resolution={RESOLUTION} payerGroups={[group(), group({ payer: 'CIGNA', planCount: 2, memberCount: 3 })]} payerPick={null} echo="GGS">
      <p>answer</p>
    </ThisSearchZone>,
  );
  assert.match(matched, /GGS/);
  assert.match(matched, /2 carriers possible/);
  assert.match(matched, /7<\/b> plans on file/);

  const hero = renderToStaticMarkup(
    <ThisSearchZone stage="plan" resolution={RESOLUTION} payerGroups={[group()]} payerPick="AETNA" echo="GGS">
      <p>answer</p>
    </ThisSearchZone>,
  );
  assert.match(hero, /Resolved carrier/);
  assert.match(hero, /AETNA/);
  assert.match(hero, /matched via prefix GGS/);
  // THE assertion — the mock's hero carries $1,059,000; this surface must never mint a dollar.
  assert.doesNotMatch(hero, /\$/);

  const answered = renderToStaticMarkup(
    <ThisSearchZone stage="answer" resolution={RESOLUTION} payerGroups={[group()]} payerPick="AETNA" echo="GGS">
      <p data-testid="the-answer">answer content</p>
    </ThisSearchZone>,
  );
  assert.match(answered, /answer content/);
  assert.match(answered, /ANSWERED/);
});

// ── 3. The composer ─────────────────────────────────────────────────────────────────────────────
test('the composer is quiet without a snapshot and slots-only with one', () => {
  const quiet = renderToStaticMarkup(<QualifyComposer snapshot={null} onAsk={() => {}} />);
  assert.match(quiet, /lights up once a search resolves/);
  assert.match(quiet, /free text never reaches the model/);
  assert.doesNotMatch(quiet, /<input|<textarea/);

  const snapshot = {
    facilities: [
      {
        name: 'Nashville Mental Health',
        careSetting: 'IP',
        ratingV2: 60,
        iqBand: '50',
        pctAllowedOfBilled: 49,
        pctPaidOfAllowed: 82,
        pctPaidOfBilled: 40,
        distinctPatients: 12,
        lineCount: 300,
        medianDaysToPayment: 40,
        payerCount: 1,
        factors: [],
      },
    ],
  } as unknown as QualifySnapshot;
  const live = renderToStaticMarkup(<QualifyComposer snapshot={snapshot} onAsk={() => {}} />);
  assert.match(live, /<select/);
  assert.doesNotMatch(live, /<input|<textarea|contenteditable/i);
  assert.match(live, /free text never reaches the model/);
  // option VALUES are template ids / indices — never a free string a rep typed
  assert.match(live, /<option value="placement"/);
});
