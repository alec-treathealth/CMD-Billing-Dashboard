/**
 * The COMPOSITION contract: businessWindowBounds().windowDays → windowAgeMultiplier().
 *
 * ── WHY THIS FILE IS APP-SIDE AND ITS SIBLING IS NOT ───────────────────────────────────────────
 * All the bounds arithmetic is proven in test/businessWindow.test.ts, against src/businessWindow.ts.
 * This half lives here by RULING (2026-08-30), not by necessity — a root test can import app/ and
 * several already do (test/qualifyRatingV2.test.ts imports this very module). The placement is
 * deliberate: the rating tiers are a Qualify concern, so a change to them should fail beside the
 * code that owns them.
 *
 * ── WHY IT ASSERTS A COMPOSITION AND NOT PINNED LITERALS ───────────────────────────────────────
 * Restating the tier table here (30 → 1, 60 → 0.95, …) would be a SECOND copy of it, and a copy
 * cannot catch the failure that matters: someone re-tiering ratingV2 while businessWindow keeps
 * emitting the old numbers, or the reverse. Both real functions are imported and run end to end, so
 * the assertion is "these two still agree", which stays true only while they actually do.
 *
 * ── THE BUG THIS DEFENDS AGAINST ───────────────────────────────────────────────────────────────
 * windowAgeMultiplier tiers at <= 30 / 60 / 90 / 180 / 270. Every one of those is an EDGE, so a
 * window that reports N+1 instead of N falls into the NEXT band down and silently cuts the
 * data-confidence factor. For a 90-day window: 91 lands in <= 180 and takes the multiplier from
 * 0.9 to 0.75 — a 17% cut to a rating factor, from an off-by-one nobody would see in the UI.
 * That is why windowDays is derived from the resolved BOUNDS rather than from the preset label.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessWindowBounds } from '../../src/businessWindow';
import { windowAgeMultiplier } from '../lib/qualify/ratingV2';

/** The instant every trailing case is anchored on — midday Pacific, so no boundary is in play here
 *  (the boundaries are the sibling file's job). */
const NOW = new Date('2026-08-30T19:00:00Z');

test('a trailing N lands ON its own tier edge, never one past it', () => {
  // Each pair is (the tier edge, the multiplier that edge is supposed to earn). Read from
  // app/lib/qualify/ratingV2.ts windowAgeMultiplier — but NOT trusted from there: the assertion
  // below calls the real function, so if the tiers move this fails rather than quietly agreeing.
  const edges: Array<[days: number, expected: number, nextBandDown: number]> = [
    [30, 1, 0.95],
    [60, 0.95, 0.9],
    [90, 0.9, 0.75],
    [180, 0.75, 0.65],
    [270, 0.65, 0.55],
  ];
  for (const [days, expected, nextBandDown] of edges) {
    const { windowDays } = businessWindowBounds({ kind: 'trailing', days }, NOW);
    assert.equal(windowDays, days, `a ${days}-day window must report ${days}, not ${days + 1}`);
    const mult = windowAgeMultiplier(windowDays);
    assert.equal(mult, expected, `${days}d must earn ${expected}`);
    assert.notEqual(mult, nextBandDown, `${days}d must NOT fall into the ${nextBandDown} band`);
    // State the off-by-one directly: this is what an inclusive-inclusive window would have done.
    assert.equal(
      windowAgeMultiplier(windowDays + 1),
      nextBandDown,
      `proof the edge is real: ${days + 1}d DOES fall to ${nextBandDown}`,
    );
  }
});

test('the other product presets keep the multiplier their band promises', () => {
  // 7/14 sit inside the top band, 365 past the bottom edge — none is an edge case, but a change
  // that broke windowDays for them would be just as wrong and is not covered above.
  for (const [days, expected] of [[7, 1], [14, 1], [365, 0.55]] as const) {
    const { windowDays } = businessWindowBounds({ kind: 'trailing', days }, NOW);
    assert.equal(windowDays, days);
    assert.equal(windowAgeMultiplier(windowDays), expected);
  }
});

test('the composition is stable across a UTC-midnight roll — the anchor cannot shift a tier', () => {
  // 19:00 PDT on 08-30: UTC is already 08-31. If the anchor slipped, `from` would move and
  // windowDays would still be 90 (both bounds shift together) — so this is really asserting that
  // the tier survives the case that broke the surfaces contract.ts:1071 documents.
  const early = businessWindowBounds({ kind: 'trailing', days: 90 }, new Date('2026-08-30T23:30:00Z'));
  const late = businessWindowBounds({ kind: 'trailing', days: 90 }, new Date('2026-08-31T02:00:00Z'));
  assert.equal(early.windowDays, 90);
  assert.equal(late.windowDays, 90);
  assert.equal(windowAgeMultiplier(early.windowDays), windowAgeMultiplier(late.windowDays));
  assert.equal(windowAgeMultiplier(late.windowDays), 0.9);
});

test('⚠ OPEN: a calendar month feeds a TRUE length, so the same selection straddles the <=30 edge', () => {
  // NOT a defect in this helper — ruled 2026-08-30 that a bounds primitive reports the truth and
  // does not round to protect a consumer. This test EXISTS TO MAKE THE CONSEQUENCE VISIBLE rather
  // than let it be discovered in a rating nobody can reproduce: "one month" scores as more
  // trustworthy in February than in March, purely because March is longer.
  //
  // Whether calendar windows should feed windowAgeMultiplier at all is an open Qualify decision,
  // to be made before any consumer rewiring. If that ruling exempts them, DELETE this test — do not
  // "fix" the day-counts to make it pass.
  const feb = businessWindowBounds({ kind: 'month', year: 2026, month: 2 });
  const mar = businessWindowBounds({ kind: 'month', year: 2026, month: 3 });
  assert.equal(feb.windowDays, 28);
  assert.equal(mar.windowDays, 31);
  assert.equal(windowAgeMultiplier(feb.windowDays), 1, 'February clears the <=30 edge');
  assert.equal(windowAgeMultiplier(mar.windowDays), 0.95, 'March does not — same selection, lower score');
  assert.notEqual(
    windowAgeMultiplier(feb.windowDays),
    windowAgeMultiplier(mar.windowDays),
    'the divergence is real and is the reason the follow-up exists',
  );
});
