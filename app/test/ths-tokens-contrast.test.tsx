/**
 * THE TOKEN LAYER'S INVARIANTS — the guard that makes the Smoke mock's weaker values
 * un-reintroducible (Phase 0, 2026-08-10).
 *
 * This file exists because of a specific near-miss. `docs/mockups/qualify-smoke.html` is the
 * ratified visual direction for Qualify, and the obvious way to "ship the design system" is to
 * paste its `:root` block into the app. That block reuses SEVEN live custom-property names with
 * different values (--space-1..6, --radius-md, --radius-lg), so pasting it silently rescales every
 * ths-* component in the app — no type error, no failing test, no build error. It also carries an
 * --color-intent-info of #5E8CC8, which measures 3.46:1 where the shipped #2D7393 measures 5.27:1.
 *
 * Nothing in the toolchain could have caught either one. A CSS custom property has no type, and a
 * contrast ratio is not something tsc or next build has an opinion about. So the assertions below
 * are the only mechanism standing between a future session and a silent regression, and each names
 * the specific mistake it is there to stop.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running. (Same footgun documented in policy-tape-render.test.tsx.)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TAPE_PALETTE, QUALIFY_PALETTE } from '../components/qualify/tokens';

const cssPath = new URL('../app/ths-v2.css', import.meta.url);
const css = readFileSync(cssPath, 'utf8');

/**
 * The EFFECTIVE value of a custom property — the LAST unconditional declaration in the file.
 *
 * ⚠ THIS READ THE FIRST MATCH UNTIL 2026-08-10, WHICH MADE THE PASTE TRIPWIRE VACUOUS (found in
 * adversarial review). CSS cascade takes the LAST declaration at equal specificity, so appending
 * the mock's `:root` block — the single most likely way someone "ports the mock" — would have
 * changed every rendered value while this test went on reading the original declarations above it
 * and passing. A guard against pasting a block that reads only the text above where the block lands
 * is not a guard.
 *
 * "Unconditional" excludes ONLY the two opt-in override blocks — `[data-density='comfortable']` and
 * `[data-contrast='high']`. It must NOT exclude every attribute selector: this system's base block
 * is itself `[data-ths='v2'] { … }`, so filtering on `[data-` at all would skip the base and find
 * nothing (caught while fixing the first-match bug — the over-broad filter failed 3 tests loudly,
 * which is the good failure mode).
 */
const OVERRIDE_SELECTORS = ["data-density", "data-contrast"];

function token(name: string): string {
  const pattern = new RegExp(`--${name}:\\s*([^;]+);`, 'g');
  let effective: string | null = null;
  for (const m of css.matchAll(pattern)) {
    // Which block is this declaration in? Look back to the nearest `{` and read the selector text
    // in front of it.
    const openAt = css.lastIndexOf('{', m.index);
    const selStart = Math.max(css.lastIndexOf('}', openAt), css.lastIndexOf('*/', openAt)) + 1;
    const selector = css.slice(selStart, openAt);
    if (OVERRIDE_SELECTORS.some((s) => selector.includes(s))) continue;
    effective = m[1]!.trim();
  }
  assert.ok(effective !== null, `--${name} is missing from ths-v2.css`);
  return effective;
}

/** WCAG 2.x relative luminance, then the 1.4.3 contrast ratio. Six-digit hex only. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// ── 1. The tape's colors are measured on the DARK surface, not on white ────────────────────────
//
// The failure this stops: reaching for RATING_HEX.ok (#2E8B6F) for an upward move on the tape.
// It is a plausible green with the right name and it renders at ~1.9:1 there — invisible, and
// invisible in a diff too.
test('tape movement colors clear AA on the inverse surface', () => {
  const inverse = TAPE_PALETTE.surfaceInverse;
  for (const [name, hex] of [
    ['up', TAPE_PALETTE.up],
    ['down', TAPE_PALETTE.down],
    ['onInverse', TAPE_PALETTE.onInverse],
  ] as const) {
    const ratio = contrast(hex, inverse);
    assert.ok(
      ratio >= 4.5,
      `TAPE_PALETTE.${name} (${hex}) is ${ratio.toFixed(2)}:1 on ${inverse} — below the 4.5:1 AA floor`,
    );
  }
});

// ── 2. The TS mirror has not drifted from the CSS ──────────────────────────────────────────────
//
// tokens.ts has always CLAIMED its hexes are identical to the stylesheet's; nothing enforced it.
// The mobile shell styles inline and reads only the TS side, so a drift here means the phone and
// the desktop render different palettes and neither looks broken.
test('TAPE_PALETTE mirrors the ths-v2.css custom properties exactly', () => {
  const pairs: Array<[string, string]> = [
    ['color-surface-inverse', TAPE_PALETTE.surfaceInverse],
    ['color-on-inverse', TAPE_PALETTE.onInverse],
    ['tape-up', TAPE_PALETTE.up],
    ['tape-down', TAPE_PALETTE.down],
  ];
  for (const [cssName, tsValue] of pairs) {
    assert.equal(
      token(cssName).toLowerCase(),
      tsValue.toLowerCase(),
      `--${cssName} in ths-v2.css and its TAPE_PALETTE mirror have drifted`,
    );
  }
});

// ── 3. The Smoke mock's :root has not been pasted over the live scale ──────────────────────────
//
// THE tripwire. If these fail, someone ported docs/mockups/qualify-smoke.html wholesale and every
// ths-* component in the app just changed size. The mock's values are named in each message so the
// failure explains itself rather than looking like an arbitrary constant that moved.
test('the live spacing and radius scale still holds against the mock values', () => {
  const held: Array<[string, string, string]> = [
    // token,     live value, the mock value that must NOT have replaced it
    ['space-1', '2.8px', '4px'],
    ['space-2', '5.6px', '8px'],
    ['space-3', '8.4px', '12px'],
    ['space-4', '11.2px', '16px'],
    ['space-6', '16.8px', '32px'],
    ['radius-md', '8px', '12px'],
    ['radius-lg', '14px', '24px'],
  ];
  for (const [name, live, mock] of held) {
    assert.equal(
      token(name),
      live,
      `--${name} is no longer ${live}. If it is now ${mock}, the qualify-smoke.html :root block was ` +
        `pasted in wholesale — it reuses these names with different values and rescales every ths-* ` +
        `component. Add new token names instead (see the Smoke primitives block in ths-v2.css).`,
    );
  }
});

// ── 4. The shipped `info` is the accessible one ────────────────────────────────────────────────
test('info stays the 5.27:1 blue, not the mock 3.46:1 blue', () => {
  assert.equal(
    QUALIFY_PALETTE.info.toUpperCase(),
    '#2D7393',
    'QUALIFY_PALETTE.info changed. The mock uses #5E8CC8, which is 3.46:1 on white and fails AA as text.',
  );
  assert.ok(contrast(QUALIFY_PALETTE.info, '#FFFFFF') >= 4.5);
  assert.ok(contrast(QUALIFY_PALETTE.info, QUALIFY_PALETTE.ground) >= 4.5);
});

// ── 5. The new primitives exist and are self-consistent ────────────────────────────────────────
test('Smoke primitives are present with the shapes the shell will consume', () => {
  assert.equal(token('radius-pill'), '999px');
  assert.equal(token('radius-xl'), '24px');
  // The hit-target floor is a WCAG 2.5.5 commitment, not a taste call — assert the number, not just
  // the token's presence.
  assert.ok(Number.parseInt(token('size-row'), 10) >= 44);
  assert.ok(Number.parseInt(token('size-control'), 10) >= Number.parseInt(token('size-row'), 10));
});
