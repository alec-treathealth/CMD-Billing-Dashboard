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
    prefix: null,
    payer: 'AETNA US HEALTHCARE',
    careSetting: null,
    area: null,
    facilityCount: 0,
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

// ── the readable handle + the kind/place clause (2026-08-09) ─────────────────────────────────────

test('THE REPORTED BUG: a resolved prefix replaces the meaningless ⋯hex handle', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item({ prefix: 'GGS' })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, />GGS</);
  assert.doesNotMatch(html, /⋯/, 'the masked tail is the LAST fallback, not a companion');
});

test('a RECORDED echo outranks a DERIVED prefix — the operator sees what the system recorded', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item({ echo: 'ECH', prefix: 'GGS' })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, />ECH</);
  assert.doesNotMatch(html, />GGS</);
});

test('with neither, the masked tail still renders — the strip never shows a blank handle', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item({ echo: null, prefix: null })]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.match(html, /⋯ffff/);
});

test('the kind-and-place clause renders care setting AND area for a single-facility policy', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip
      items={[item({ careSetting: 'IP', area: 'Sacramento, CA', facilityCount: 1 })]}
      asOf="2026-08-08"
      deltaDays={90}
    />,
  );
  assert.match(html, /IP · Sacramento, CA/);
});

test('a MULTI-facility policy replaces the area with the count — one city is not the policy', () => {
  // The area is ONE facility's city (the dominant one). Printing it beside a policy treated in three
  // places states a fact about the facility as though it were a fact about the policy.
  const html = renderToStaticMarkup(
    <PolicyTapeStrip
      items={[item({ careSetting: 'OP', area: 'Sacramento, CA', facilityCount: 3 })]}
      asOf="2026-08-08"
      deltaDays={90}
    />,
  );
  assert.match(html, /OP · 3 facilities/);
  assert.doesNotMatch(html, /Sacramento/, 'the dominant city must not stand in for a spread policy');
});

test('no context at all renders NO clause — never an em-dash placeholder', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip
      items={[item({ careSetting: null, area: null, facilityCount: 0 })]}
      asOf="2026-08-08"
      deltaDays={90}
    />,
  );
  assert.doesNotMatch(html, /—|·\s*·/, 'a strip of dashes teaches the eye to skip the slot');
});

test('WITHOUT onExplain every card is inert — no button, no tab stop', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item()]} asOf="2026-08-08" deltaDays={90} />,
  );
  assert.doesNotMatch(html, /<button/, 'the shipped read-only strip must stay read-only');
});

test('WITH onExplain each card is a button carrying ONE accessible name for the whole card', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip
      items={[item({ prefix: 'GGS', careSetting: 'IP', area: 'Sacramento, CA', facilityCount: 1 })]}
      asOf="2026-08-08"
      deltaDays={90}
      onExplain={() => {}}
    />,
  );
  assert.match(html, /<button/);
  // The name must carry the policy, its numbers AND the movement — five adjacent spans read as five
  // unrelated fragments otherwise, with the delta detached from what moved.
  assert.match(html, /aria-label="GGS, AETNA US HEALTHCARE, IP · Sacramento, CA\. Rating 35, up 16 points over 90 days\. Explain this move\."/);
});

test('the PRESSED card is the one being explained, and only the real half advertises it', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip
      items={[item()]}
      asOf="2026-08-08"
      deltaDays={90}
      onExplain={() => {}}
      explainingKey={`${'f'.repeat(64)}-AETNA US HEALTHCARE`}
    />,
  );
  assert.match(html, /aria-pressed="true"/);
  assert.equal(html.split('aria-pressed').length - 1, 1, 'exactly one pressed claim reaches AT');
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

/**
 * THE MARQUEE WIRING, PINNED STRUCTURALLY — the one defect on this component that no content
 * assertion can see. `useMarquee` indexes `el.children` by ITEM position, so the element carrying the
 * ref must be the element whose direct children are the <li>s. It shipped with the ref on a wrapper
 * <div> around the <ul>: `el.children` was `[ul]`, `children[itemsPerSet - 1]` was undefined,
 * `isOverflowing` stayed false forever, and the tape never auto-scrolled. Every test above stayed
 * green through all of it.
 */
test('the marquee scroll container IS the list — its direct children are the items (useMarquee indexes el.children)', () => {
  const html = renderToStaticMarkup(
    <PolicyTapeStrip items={[item(), item({ payer: 'CIGNA' })]} asOf="2026-08-08" deltaDays={90} />,
  );
  // the q-marquee element is a <ul>, and an <li> is its FIRST child — no wrapper in between
  assert.match(
    html,
    /<ul[^>]*class="[^"]*\bq-marquee\b[^"]*"[^>]*>\s*<li/,
    'the ref element must be the <ul> and the items must be its direct children, or the marquee is inert',
  );
  // and nothing else on the page claims to be the scroll container
  assert.equal(html.split('q-marquee').length - 1, 1, 'exactly one marquee container');
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
