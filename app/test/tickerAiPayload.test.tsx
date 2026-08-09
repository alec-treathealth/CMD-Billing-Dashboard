/**
 * tickerAiPayload — what a ticker click sends the model.
 *
 * THE FIRST TEST IS THE REASON THIS FILE EXISTS. `qualifyAi.ts`'s oldest stated boundary is "NO
 * IDENTIFIERS, structurally: no member id, no prefix (not even the ≤3-char echo)", and as of
 * 2026-08-09 the tape RENDERS a readable alpha prefix. The strict zod firewall has no field that
 * could carry one, so a leak would have to arrive disguised inside an allowed string field —
 * `facilityName` being the obvious candidate for a well-meaning "make the answer read better" edit.
 * The payload is asserted here against an item that HAS a prefix, an echo and a token, so the
 * assertion cannot pass vacuously.
 *
 * The payload is validated for real against QualifyAiInputSchema too, so a shape drift between this
 * builder and the firewall fails here rather than at runtime as a silent `{ok:false, invalid}`.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTapeAiInput, buildTrendAiInput } from '../lib/qualify/tickerAiPayload';
import { QualifyAiInputSchema, isQualifyAiSufficient } from '../../src/collections/qualifyAi';
import type { QualifyPolicyTapeItem } from '../lib/qualify/board';
import type { QualifyFacilityTrend } from '../lib/qualify/contract';

const TOKEN = 'd'.repeat(64);

function tapeItem(over: Partial<QualifyPolicyTapeItem> = {}): QualifyPolicyTapeItem {
  return {
    token: TOKEN,
    tokenTail: TOKEN.slice(-6),
    echo: 'ECH',
    prefix: 'GGS',
    payer: 'AETNA US HEALTHCARE',
    careSetting: 'IP',
    area: 'Sacramento, CA',
    facilityCount: 1,
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

function trend(over: Partial<QualifyFacilityTrend> = {}): QualifyFacilityTrend {
  return {
    facilityKey: 'TREAT MENTAL HEALTH CALIFORNIA',
    name: 'TREAT MENTAL HEALTH CALIFORNIA',
    city: 'Sacramento',
    state: 'CA',
    careSetting: 'OP',
    entity: 'BXR',
    dominantPayer: 'ANTHEM BLUE CROSS',
    lineCount: 1414,
    currentRating: 34,
    priorRating: 28.8,
    deltaPts: 5.2,
    points: [30, 31, 29, 34],
    ...over,
  };
}

test('PHI BOUNDARY: no prefix, echo or token reaches the model — from an item carrying all three', () => {
  const item = tapeItem();
  const payload = buildTapeAiInput(item, 90, false);
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /GGS/, 'the derived alpha prefix must not cross');
  assert.doesNotMatch(json, /ECH/, 'nor the recorded echo — the boundary names it explicitly');
  assert.doesNotMatch(json, new RegExp(TOKEN), 'nor the blind-index token');
  assert.doesNotMatch(json, /dddddd/, 'nor its masked tail');
  assert.equal(payload.ticker.facilityName, null, 'a tape card names no facility and no policy');
});

test('the tape payload validates against the REAL firewall and clears the sufficiency gate', () => {
  const parsed = QualifyAiInputSchema.safeParse(buildTapeAiInput(tapeItem(), 90, false));
  assert.ok(parsed.success, `must satisfy the strict schema: ${parsed.success ? '' : parsed.error.message}`);
  assert.equal(isQualifyAiSufficient(parsed.data), true, 'a clicked card is enough to explain');
});

test('the tape payload carries the numbers the answer is about', () => {
  const p = buildTapeAiInput(tapeItem(), 90, false).ticker;
  assert.equal(p.kind, 'policy');
  assert.equal(p.payer, 'AETNA US HEALTHCARE');
  assert.equal(p.ratingNow, 35);
  assert.equal(p.ratingThen, 19);
  assert.equal(p.deltaPts, 16);
  assert.equal(p.iqBand, '30');
  assert.equal(p.distinctMembers, 8);
  assert.equal(p.careSetting, 'IP');
  assert.equal(p.area, 'Sacramento, CA');
  assert.equal(p.deltaDays, 90);
});

test('windowSufficient is DERIVED from the sample, not asserted — a thin pair keeps the hedge on', () => {
  // The tape's own floor is 3 members; the rating system's confident floor is 10. Most cards are
  // honestly thin, and hard-coding true here would switch off the prompt's "directional" rule for
  // exactly the cards that need it.
  assert.equal(buildTapeAiInput(tapeItem({ distinctMembers: 4 }), 90, false).windowSufficient, false);
  assert.equal(buildTapeAiInput(tapeItem({ distinctMembers: 10 }), 90, false).windowSufficient, true);
});

test('a FACILITY card sends its name (an allowlisted dimension) and scopes itself as a BLEND', () => {
  const payload = buildTrendAiInput(trend(), 90, false);
  assert.equal(payload.ticker.facilityName, 'TREAT MENTAL HEALTH CALIFORNIA');
  assert.equal(payload.ticker.area, 'Sacramento, CA');
  assert.deepEqual(payload.ticker.points, [30, 31, 29, 34], 'the sparkline the operator is looking at');
  // ⚠ 'all', NOT 'payer', even though dominantPayer is populated: the trend query is book-wide per
  // facility, so the rating blends every label billed there. 'payer' would tell the model it is
  // reading one payer's contract rate.
  assert.equal(payload.payerScope, 'all');
  assert.equal(payload.ticker.deltaDays, 90, 'a trend delta compares adjacent equal windows');
  const parsed = QualifyAiInputSchema.safeParse(payload);
  assert.ok(parsed.success, `must satisfy the strict schema: ${parsed.success ? '' : parsed.error.message}`);
});

test('an unmapped facility sends area null, never the string "null" or a half-built label', () => {
  const noState = buildTrendAiInput(trend({ city: 'Henrico', state: null }), 90, false);
  assert.equal(noState.ticker.area, 'Henrico', 'a city with no state is still a real place name');
  const neither = buildTrendAiInput(trend({ city: null, state: null }), 90, false);
  assert.equal(neither.ticker.area, null, 'and nothing at all is null, not an empty string');
});

test('a NEW facility (no prior window) sends nulls rather than a fabricated zero delta', () => {
  const p = buildTrendAiInput(trend({ priorRating: null, deltaPts: null }), 90, false).ticker;
  assert.equal(p.ratingThen, null);
  assert.equal(p.deltaPts, null);
});
