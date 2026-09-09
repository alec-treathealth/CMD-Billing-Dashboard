/**
 * Hermetic tests for the AR Management age bands (src/billingAudit/arBuckets.ts). No DB, no PHI.
 *
 * The bands are the ones Alec asked for on 2026-09-09 (31–60d, 61–90d, 91–120d, 4–6mo, 6–9mo,
 * 9mo–1yr, 1–2yr) plus the two that make the set exhaustive over every non-negative age: the
 * not-yet-aged 0–30 band and the open-ended "over 2 years" tail. These tests pin every boundary
 * day so a later "tidy" of a bound cannot silently move a claim between tiles.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AR_BANDS, arBandCaseSql, bandForAgeDays, isArBandKey } from '../src/billingAudit/arBuckets.js';

test('AR_BANDS: nine bands, ascending, contiguous, exhaustive, last open-ended', () => {
  assert.equal(AR_BANDS.length, 9);
  assert.equal(AR_BANDS[0]!.minDays, 0);
  for (let i = 0; i < AR_BANDS.length - 1; i++) {
    const a = AR_BANDS[i]!;
    const b = AR_BANDS[i + 1]!;
    assert.ok(a.maxDays !== null, `band ${a.key} must be closed`);
    assert.equal(a.maxDays! + 1, b.minDays, `gap/overlap between ${a.key} and ${b.key}`);
  }
  assert.equal(AR_BANDS[AR_BANDS.length - 1]!.maxDays, null);
  assert.deepEqual(
    AR_BANDS.map((b) => b.key),
    ['0_30', '31_60', '61_90', '91_120', '4_6mo', '6_9mo', '9_12mo', '1_2yr', '2yr_plus'],
  );
  // Only the first band is "not yet aged".
  assert.deepEqual(AR_BANDS.map((b) => b.aged), [false, true, true, true, true, true, true, true, true]);
});

test('bandForAgeDays: every boundary lands where the spreadsheet expects it', () => {
  const expect: Array<[number, string]> = [
    [0, '0_30'], [30, '0_30'],
    [31, '31_60'], [60, '31_60'],
    [61, '61_90'], [90, '61_90'],
    [91, '91_120'], [120, '91_120'],
    [121, '4_6mo'], [180, '4_6mo'],
    [181, '6_9mo'], [270, '6_9mo'],
    [271, '9_12mo'], [365, '9_12mo'],
    [366, '1_2yr'], [730, '1_2yr'],
    [731, '2yr_plus'], [5000, '2yr_plus'],
  ];
  for (const [days, key] of expect) {
    assert.equal(bandForAgeDays(days)?.key, key, `day ${days}`);
  }
  // Fractional days floor (a whole-day age computed from a Date diff never fractions, but be total).
  assert.equal(bandForAgeDays(30.9)?.key, '0_30');
});

test('bandForAgeDays: unknown / negative ages are unbanded, never a throw', () => {
  assert.equal(bandForAgeDays(null), null);
  assert.equal(bandForAgeDays(undefined), null);
  assert.equal(bandForAgeDays(Number.NaN), null);
  assert.equal(bandForAgeDays(-1), null);
  assert.equal(bandForAgeDays(Number.POSITIVE_INFINITY), null);
});

test('isArBandKey: narrows exactly the nine keys', () => {
  for (const b of AR_BANDS) assert.ok(isArBandKey(b.key));
  assert.equal(isArBandKey('31-60'), false);
  assert.equal(isArBandKey(''), false);
  assert.equal(isArBandKey(31), false);
  assert.equal(isArBandKey(null), false);
});

test('arBandCaseSql: one WHEN per band, null-date guard, negative-age guard, fixed literals only', () => {
  const sql = arBandCaseSql('(cast($2 as date) - c.dos_from)', 'c.dos_from');
  assert.match(sql, /^case when c\.dos_from is null then null /);
  assert.match(sql, /< 0 then null/);
  // Eight closed bands + the open tail = 9 outcomes, each quoting its key literal.
  for (const b of AR_BANDS) assert.ok(sql.includes(`'${b.key}'`), `missing ${b.key}`);
  assert.equal((sql.match(/ when /g) ?? []).length, 2 + 8, 'two guards + eight bounded whens; the tail is the ELSE');
  assert.match(sql, /else '2yr_plus' end$/);
  // No bound parameters are minted inside the CASE — the caller owns $n numbering.
  assert.equal(/\$\d/.test(sql.replaceAll('$2', '')), false);
});
