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
import {
  TAPE_PALETTE,
  QUALIFY_PALETTE,
  RATING_HEX,
  RATING_WASH,
  IQ_BAND_HEX,
  IQ_BAND_WASH,
  FOCUS_RING_HEX,
} from '../components/qualify/tokens';
import { mobileBucketStyle, mobileIqStyle } from '../components/qualify/m/colors';
import { IQ_BAND_ORDER } from '../lib/qualify/ratingV2';
import type { RatingBucket } from '../lib/qualify/rating';

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
//
// These six names have NO consumer yet, on purpose — they are a token vocabulary the shell's
// components adopt as they land, written down once so they cannot each invent their own number.
// Asserting them here is what stops "unused" from quietly becoming "wrong", and it is why the CSS
// block carries a do-not-delete note: an unconsumed custom property looks exactly like dead code.
test('Smoke primitives are present with the shapes the shell will consume', () => {
  assert.equal(token('radius-pill'), '999px');
  assert.equal(token('radius-xl'), '24px');
  // The hit-target floor is a WCAG 2.5.5 commitment, not a taste call — assert the number, not just
  // the token's presence.
  assert.ok(Number.parseInt(token('size-row'), 10) >= 44);
  assert.ok(Number.parseInt(token('size-control'), 10) >= Number.parseInt(token('size-row'), 10));
});

// ── 6. THE GUARD REACHES THE RENDER SITE ───────────────────────────────────────────────────────
//
// Everything above pinned copy 1 (ths-v2.css) against copy 2 (TAPE_PALETTE) while a THIRD copy —
// a private `const TAPE_UP`/`TAPE_DOWN` pair inside policy-tape.tsx, with the same hexes — did the
// actual painting and was covered by nothing. A contrast guard that protects two values nobody
// renders is theatre. The tape now reads the token, and this test says so, because "wire it up" is
// a state that reverts silently: re-inlining the hexes would leave every assertion above green.
const TAPE_SRC = readFileSync(new URL('../components/qualify/policy-tape.tsx', import.meta.url), 'utf8');

test('policy-tape paints from TAPE_PALETTE, not from a private copy of the same hexes', () => {
  assert.match(TAPE_SRC, /import \{ TAPE_PALETTE \} from '\.\/tokens';/);
  assert.match(TAPE_SRC, /TAPE_PALETTE\.up/, 'the up colour comes from the token');
  assert.match(TAPE_SRC, /TAPE_PALETTE\.down/, 'and so does the down colour');
  // ⚠ THIS ASSERTION INVERTED ON 2026-08-14 (audit C-4), and the inversion is the fix. It used to
  // REQUIRE `import { IQ_BAND_HEX, TAPE_PALETTE }` — i.e. the guard against inlined hexes was
  // simultaneously pinning the import of the light-surface palette that the rating numeral was
  // wrongly painted with, on the dark strip, at 2.47-4.17:1. A test can hold a bug in place; this
  // one did. The band numeral now paints from TAPE_PALETTE.band and IQ_BAND_HEX must not come back
  // into this file at all.
  assert.match(TAPE_SRC, /TAPE_PALETTE\.band\[band\]/, 'the rating numeral uses the INVERSE-surface band set');
  assert.doesNotMatch(
    TAPE_SRC,
    /style=\{\{ color: IQ_BAND_HEX/,
    'IQ_BAND_HEX is measured on WHITE — painting it on the tape is the exact mistake tokens.ts warns about',
  );
  // The private pair must not come back — it is the copy the guard could not see. ANCHORED TO THE
  // LINE START: a top-level `const` sits at column 0, while the file's own docblock names the
  // deleted constants so the history stays readable. An unanchored needle would fail on the prose
  // and teach the next session to delete the explanation instead of keeping the fix.
  assert.doesNotMatch(TAPE_SRC, /^const TAPE_UP\b/m, 'no local up hex');
  assert.doesNotMatch(TAPE_SRC, /^const TAPE_DOWN\b/m, 'no local down hex');
  assert.doesNotMatch(TAPE_SRC, /#46[Cc]4[Bb]8|#[Ff]0917[Cc]/, 'nor either hex inlined by value');
});

// The strip's ground is the Tailwind class `bg-teal900`, NOT an inline TAPE_PALETTE.surfaceInverse
// — so every ratio asserted in section 1 is only true if those two are the same colour. They are
// declared in three unrelated files, which is exactly the drift this file exists to catch.
test('the surface the tape actually paints on is the one the ratios were measured against', () => {
  assert.equal(
    QUALIFY_PALETTE.teal900.toUpperCase(),
    TAPE_PALETTE.surfaceInverse.toUpperCase(),
    'policy-tape renders on bg-teal900; if that is not surfaceInverse, section 1 measures a colour ' +
      'nothing displays and the tape could ship at any contrast at all',
  );
});

// ── 8. THE BUCKET / BAND TEXT SCALE CLEARS AA ON EVERY SURFACE IT PAINTS ────────────────────────
//
// Added 2026-08-14 for the Wave 3 a11y audit (C-5, M4, M5), and the shape of these assertions is
// the finding. The audit measured every one of these pairs FAILING, and the reason the failure
// survived so long is that the obvious check — "is this colour readable on white?" — is the wrong
// check. Each of these hexes is painted on its OWN light WASH at least as often as on white
// (`.q-heat .q-pctcell`, the mobile tint behind the facility icon, the KPI tiles), and a wash is a
// lighter ground than white, so it is always the tighter constraint. Verifying against white alone
// is how `warn` shipped at 2.67:1 while looking fine in a designer's swatch.
//
// All of it is SMALL text — `.q-pctcell` at 13px, the mobile verdict word at 12px, the tile numbers
// at 20px/600 — so the bar is 4.5:1, not the 3:1 large-text allowance.
const AA_TEXT = 4.5;

function assertPair(fg: string, bg: string, what: string) {
  const ratio = contrast(fg, bg);
  assert.ok(
    ratio >= AA_TEXT,
    `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 — below the ${AA_TEXT}:1 AA floor for text this size`,
  );
}

test('desktop bucket colours clear AA on white AND on their own heat wash', () => {
  for (const bucket of ['ok', 'warn', 'danger', 'neutral'] as RatingBucket[]) {
    const fg = RATING_HEX[bucket];
    assertPair(fg, QUALIFY_PALETTE.surface, `RATING_HEX.${bucket} on surface`);
    const wash = RATING_WASH[bucket];
    // neutral washes to `transparent`, i.e. it renders on whatever is behind it — always the card.
    if (wash !== 'transparent') assertPair(fg, wash, `RATING_HEX.${bucket} on its wash`);
  }
});

test('IQ band colours clear AA on white AND on their own band wash', () => {
  for (const band of IQ_BAND_ORDER) {
    assertPair(IQ_BAND_HEX[band], QUALIFY_PALETTE.surface, `IQ_BAND_HEX['${band}'] on surface`);
    assertPair(IQ_BAND_HEX[band], IQ_BAND_WASH[band], `IQ_BAND_HEX['${band}'] on its wash`);
  }
});

test('the MOBILE bucket + band styles clear AA on their own tint (the surface they actually paint on)', () => {
  // Mobile styles inline and cannot read a CSS custom property, so it keeps its own copy of the
  // scale — which is exactly why it drifted out of compliance independently and needs its own
  // assertions rather than inheriting the desktop ones.
  for (const bucket of ['ok', 'warn', 'danger', 'neutral'] as RatingBucket[]) {
    const s = mobileBucketStyle(bucket === 'ok' ? 100 : bucket === 'warn' ? 40 : bucket === 'danger' ? 10 : null);
    assertPair(s.color, s.tint, `mobile bucket ${bucket} on its tint`);
    assertPair(s.color, QUALIFY_PALETTE.surface, `mobile bucket ${bucket} on white`);
  }
  for (const band of IQ_BAND_ORDER) {
    const s = mobileIqStyle(band);
    assertPair(s.color, s.tint, `mobile band ${band} on its tint`);
    assertPair(s.color, QUALIFY_PALETTE.surface, `mobile band ${band} on white`);
  }
});

test('the mobile scale has not drifted from the desktop tokens it mirrors', () => {
  // The whole reason mobile fails independently: two copies of one palette. Pin them together so a
  // future contrast fix on one side cannot silently leave the phone behind.
  for (const band of IQ_BAND_ORDER) {
    assert.equal(
      mobileIqStyle(band).color.toUpperCase(),
      IQ_BAND_HEX[band].toUpperCase(),
      `m/colors.ts IQ_STYLES['${band}'] and tokens.ts IQ_BAND_HEX['${band}'] have drifted`,
    );
  }
});

// ── 9. THE TAPE'S BAND NUMERAL — the C-4 finding, pinned ───────────────────────────────────────
//
// policy-tape.tsx painted IQ_BAND_HEX on #0E3A3A and measured 2.99 / 3.01 / 4.17 / 3.73 / 2.47.
// Band 0 — "Avoid", the strongest warning the scale can give — was the LEAST legible number on the
// strip. Section 1 above already guards the movement colours; this guards the numeral, which is the
// value an operator actually reads off the tape.
test('tape band numerals clear AA on the inverse surface', () => {
  for (const band of IQ_BAND_ORDER) {
    assertPair(TAPE_PALETTE.band[band], TAPE_PALETTE.surfaceInverse, `TAPE_PALETTE.band['${band}'] on the tape`);
  }
});

test('the tape band set is DISTINCT from the light-surface set it is so easily confused with', () => {
  // Not a contrast assertion — an anti-drift one. The two objects are named for the same five
  // bands and differ only in the surface they were measured against, which is precisely why
  // someone "tidied" one into the other once already (see the ⚠ block in tokens.ts).
  for (const band of IQ_BAND_ORDER) {
    assert.notEqual(
      TAPE_PALETTE.band[band].toUpperCase(),
      IQ_BAND_HEX[band].toUpperCase(),
      `TAPE_PALETTE.band['${band}'] equals IQ_BAND_HEX['${band}'] — the light-surface value cannot be ` +
        `correct on #0E3A3A, so this is the two palettes having been merged`,
    );
  }
});

// ── 10. THE GLOBAL FOCUS RING WORKS ON BOTH GROUNDS ────────────────────────────────────────────
//
// One ring colour serves a light app and a dark strip. It is a NON-text indicator, so the bar is
// 3:1 (SC 1.4.11), but it must clear that on BOTH grounds — which pins its luminance into a narrow
// window and is why it is its own token rather than a reuse of teal500 (3.01 on teal900) or
// TAPE_PALETTE.up (2.13 on white).
test('the global focus ring clears 3:1 on both the light surface and the dark tape', () => {
  const AA_NON_TEXT = 3;
  for (const [name, bg] of [
    ['surface', QUALIFY_PALETTE.surface],
    ['ground', QUALIFY_PALETTE.ground],
    ['teal900', TAPE_PALETTE.surfaceInverse],
  ] as const) {
    const ratio = contrast(FOCUS_RING_HEX, bg);
    assert.ok(
      ratio >= AA_NON_TEXT,
      `FOCUS_RING_HEX ${FOCUS_RING_HEX} is ${ratio.toFixed(2)}:1 on ${name} (${bg}) — below the 3:1 floor`,
    );
  }
});

test('globals.css actually declares the :focus-visible fallback, with the token colour', () => {
  // The reason this is a source assertion and not a render one: the defect was the ABSENCE of a
  // rule. Nothing about a missing stylesheet rule is observable from a component test, which is
  // why an app with zero focus styling passed every suite it had for months.
  const globals = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const rule = /:focus-visible\s*\{[^}]*outline:[^;]*#2f9a90/i;
  assert.match(
    globals,
    rule,
    'globals.css has no :focus-visible fallback painting FOCUS_RING_HEX — every inline `outline: none` ' +
      'control is invisible to a keyboard user again (SC 2.4.7)',
  );
  assert.equal(FOCUS_RING_HEX.toUpperCase(), '#2F9A90', 'the token and the stylesheet must agree');
});
