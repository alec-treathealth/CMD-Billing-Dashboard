/**
 * PolicyTapeStrip — RENDERED-HTML tests. Renders the real component and asserts on real markup.
 *
 * What must hold, and why each is here rather than assumed:
 *   1) NO DOLLARS reach the DOM — the tape's read never projects them, and an `admissions_seat`
 *      must receive identical bytes to a super_admin.
 *   2) NO RAW TOKEN reaches the DOM — the handle is the ≤3-char echo, else a masked tail. A full
 *      64-char blind index in the markup would be a needless identity surface.
 *   3) MOVEMENT CARRIES WORDS, not hue alone (the a11y rule the v3 flow is held to).
 *   4) ONE set renders under static markup — effects never run, so `isOverflowing` stays false and
 *      the marquee duplicate must be absent. A duplicated set here would mean every policy is
 *      announced twice to AT.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PolicyTapeStrip, PolicyTapeSkeleton } from '../components/qualify/policy-tape';
import type { QualifyPolicyTapeItem } from '../lib/qualify/board';

const TOKEN = 'f'.repeat(64);

function item(over: Partial<QualifyPolicyTapeItem> = {}): QualifyPolicyTapeItem {
  return {
    token: TOKEN,
    tokenTail: TOKEN.slice(-6),
    echo: null,
    payer: 'AETNA US HEALTHCARE',
    ratingNow: 35,
    bandNow: '30',
    ratingThen: 19,
    deltaPts: 16,
    distinctMembers: 8,
    lineCount: 315,
    windowDays: 90,
    ...over,
  };
}

test('an empty tape renders nothing at all — no empty bar occupying space', () => {
  const html = renderToStaticMarkup(<PolicyTapeStrip items={[]} asOf={null} deltaDays={90} />);
  assert.equal(html, '');
});

test('the strip renders the payer, rating and a WORDED delta', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item()]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, /AETNA US HEALTHCARE/);
  assert.match(html, />35</);
  // movement is readable without colour vision: arrow + signed number + unit
  assert.match(html, /▲ \+16 pts/);
  assert.match(html, /90-day rating change/);
  assert.match(html, /as of 2026-08-08/);
});

test('a NEGATIVE delta is worded too, not just recoloured', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item({ deltaPts: -11, ratingNow: 39 })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, /▼ -11 pts/);
});

test('NO dollar figure reaches the DOM (admissions_seat parity)', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item(), item({ payer: 'CIGNA', deltaPts: -3 })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.doesNotMatch(html, /\$/);
  assert.doesNotMatch(html, /billed|allowed|paid/i);
});

test('the RAW token never reaches the DOM — masked tail when there is no echo', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item()]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.doesNotMatch(html, new RegExp(TOKEN));
  // a short masked handle instead
  assert.match(html, /⋯ffff/);
});

test('a recorded echo is shown in place of the tail', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item({ echo: 'GGS' })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, />GGS</);
  assert.doesNotMatch(html, /⋯/);
});

test('under static markup exactly ONE set renders — no marquee duplicate for AT to repeat', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item({ payer: 'UNIQUEPAYER' })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.equal(html.split('UNIQUEPAYER').length - 1, 1);
});

test('the scope is STATED, so the strip cannot be read as a search result', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item(), item({ payer: 'CIGNA' })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, /Across the book/);
  assert.match(html, /2 policies with enough\s+history to compare/);
});

test('the skeleton matches the real header so the swap is not a layout shift', () => {
  const skel = renderToStaticMarkup(<PolicyTapeSkeleton />);
  const real = renderToStaticMarkup(
    <PolicyTapeStrip items={[item()]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(skel, /Policies on the Move/);
  assert.match(real, /Policies on the Move/);
  assert.match(skel, /aria-hidden/);
});
