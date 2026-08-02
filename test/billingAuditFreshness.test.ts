/**
 * Hermetic tests for the billing-audit page-freshness helpers. No DB, no network, no PHI.
 *
 * The load-bearing case is the LEXICAL-VS-CHRONOLOGICAL one: an earlier draft compared the raw
 * `ingested_at` strings, which is only correct while the projection stays a fixed-width ISO-8601
 * Z value. These tests pin the numeric-comparison behaviour so that assumption cannot creep back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_AFTER_DAYS,
  freshnessDisplayDate,
  isPageStale,
  newestIngestOnPage,
} from '../app/lib/billing-audit/freshness.js';

const DAY = 86_400_000;

test('newestIngestOnPage: empty page and all-null timestamps yield null', () => {
  assert.equal(newestIngestOnPage([]), null);
  assert.equal(newestIngestOnPage([{ ingested_at: null }, { ingested_at: null }]), null);
});

test('newestIngestOnPage: picks the newest under the canonical ISO-Z projection', () => {
  const got = newestIngestOnPage([
    { ingested_at: '2026-08-01T06:53:30Z' },
    { ingested_at: '2026-08-02T02:44:17Z' },
    { ingested_at: '2026-06-29T11:00:00Z' },
  ]);
  assert.equal(got?.iso, '2026-08-02T02:44:17Z');
  assert.equal(got?.ms, Date.parse('2026-08-02T02:44:17Z'));
});

test('newestIngestOnPage: correct where LEXICAL ordering disagrees with chronological', () => {
  // THE case this module exists for. '2026-08-02T00:30:00+02:00' is the instant
  // 2026-08-01T22:30:00Z — genuinely EARLIER than the Z row below — but it sorts LATER as a
  // string because '2026-08-02' > '2026-08-01'. A lexical max therefore picks the wrong row.
  const rows = [
    { ingested_at: '2026-08-02T00:30:00+02:00' }, // == 2026-08-01T22:30Z, the OLDER instant
    { ingested_at: '2026-08-01T23:00:00Z' }, //      the genuinely newer instant
  ];
  const lexicalMax = rows.map((r) => r.ingested_at).reduce((a, b) => (b > a ? b : a));
  assert.equal(lexicalMax, '2026-08-02T00:30:00+02:00', 'lexical max is demonstrably wrong here');
  assert.ok(
    Date.parse('2026-08-02T00:30:00+02:00') < Date.parse('2026-08-01T23:00:00Z'),
    'and the lexical winner really is the older instant',
  );

  const got = newestIngestOnPage(rows);
  assert.equal(got?.iso, '2026-08-01T23:00:00Z', 'numeric comparison picks the real newest');
});

test("newestIngestOnPage: handles Postgres' bare timestamptz rendering", () => {
  // Space separator, variable fractional seconds, numeric +00 offset — what you get if the
  // projection ever drops the to_char() and returns the column directly.
  const got = newestIngestOnPage([
    { ingested_at: '2026-08-02 08:50:09+00' },
    { ingested_at: '2026-08-02 08:50:21.568+00' },
    { ingested_at: '2026-08-01 06:53:30.383656+00' },
  ]);
  assert.equal(got?.iso, '2026-08-02 08:50:21.568+00');
  assert.equal(got?.ms, Date.parse('2026-08-02 08:50:21.568+00'));
});

test('newestIngestOnPage: unparseable values are skipped, never allowed to win', () => {
  const got = newestIngestOnPage([
    { ingested_at: 'not-a-timestamp' },
    { ingested_at: '2026-08-02T02:44:17Z' },
    { ingested_at: 'zzzz-99-99' }, // sorts lexically ABOVE any real ISO string
  ]);
  assert.equal(got?.iso, '2026-08-02T02:44:17Z');
  assert.ok(!Number.isNaN(got!.ms));
});

test('newestIngestOnPage: a page of only unparseable values is null, not NaN', () => {
  assert.equal(newestIngestOnPage([{ ingested_at: 'garbage' }]), null);
});

test('isPageStale: false before the threshold, true after, pure in nowMs', () => {
  const f = { iso: '2026-08-02T00:00:00Z', ms: Date.parse('2026-08-02T00:00:00Z') };
  assert.equal(isPageStale(f, f.ms + 1 * DAY), false, '1 day is fresh');
  assert.equal(isPageStale(f, f.ms + STALE_AFTER_DAYS * DAY), false, 'exactly at threshold is not stale');
  assert.equal(isPageStale(f, f.ms + STALE_AFTER_DAYS * DAY + 1), true, 'past threshold is stale');
});

test('isPageStale: null freshness or pre-mount clock never reports stale', () => {
  const f = { iso: '2026-06-29T11:00:00Z', ms: Date.parse('2026-06-29T11:00:00Z') };
  assert.equal(isPageStale(null, Date.now()), false, 'no data is not evidence of staleness');
  assert.equal(isPageStale(f, null), false, 'server render must not claim staleness');
});

test('freshnessDisplayDate: UTC calendar date, independent of the source string format', () => {
  assert.equal(
    freshnessDisplayDate({ iso: '2026-08-02T02:44:17Z', ms: Date.parse('2026-08-02T02:44:17Z') }),
    '2026-08-02',
  );
  // Same instant, written with an offset — must still render the UTC day.
  const withOffset = '2026-08-02 08:50:21.568+00';
  assert.equal(
    freshnessDisplayDate({ iso: withOffset, ms: Date.parse(withOffset) }),
    '2026-08-02',
  );
  // An instant that falls on the previous UTC day when written with a positive offset.
  const early = '2026-08-02T00:30:00+02:00';
  assert.equal(freshnessDisplayDate({ iso: early, ms: Date.parse(early) }), '2026-08-01');
});
