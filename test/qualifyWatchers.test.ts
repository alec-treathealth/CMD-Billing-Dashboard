/**
 * QUALIFY WATCHERS — the src half: query builders (parameterization + projection discipline) and
 * the pure folds (series, masks).
 *
 * The projection assertions are the PHI/dollar contract in executable form: the daily rating table
 * carries billed/allowed/paid columns, and the series builder must never select them — an
 * admissions_seat session reads the identical sparkline. A column added to that SELECT would pass
 * tsc and every render test; only this file would go red.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildRecentSearchListQuery,
  buildWatcherListQuery,
  buildWatcherSeriesQuery,
  foldWatcherSeries,
  MASKED_ECHO_MIN_HIDDEN,
  maskedPatientEcho,
  QUALIFY_RECENT_MAX,
  QUALIFY_WATCHER_MAX,
  recentSearchEcho,
  watcherSeriesKey,
  type QualifyWatcherSeriesRow,
} from '../src/collections/qualifyWatchers';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_0096 = join(REPO_ROOT, 'supabase/migrations/0096_qualify_watchers.sql');

// ── Builders ────────────────────────────────────────────────────────────────────────────────────
test('list queries are parameterized and user-scoped', () => {
  for (const q of [buildWatcherListQuery('u-1'), buildRecentSearchListQuery('u-1')]) {
    assert.match(q.sql, /app_user_id = \$1::uuid/);
    assert.equal(q.params[0], 'u-1');
    assert.doesNotMatch(q.sql, /u-1/, 'the user id must ride as a bound param, never in the SQL');
  }
});

test('buildWatcherListQuery takes exactly one bound param — the user id', () => {
  assert.deepEqual(buildWatcherListQuery('u-1').params, ['u-1']);
});

test('the series query projects ratings and dates — never the dollar columns beside them', () => {
  const q = buildWatcherSeriesQuery([{ token: 'a'.repeat(64), payer: 'AETNA' }]);
  assert.doesNotMatch(q.sql, /billed_amount|allowed_amount|paid_amount/);
  assert.doesNotMatch(q.sql, /select \*/i);
  // subjects travel as arrays — one round trip for the whole board
  assert.deepEqual(q.params[0], ['a'.repeat(64)]);
  assert.deepEqual(q.params[1], ['AETNA']);
});

test('payer-wide series rows weight by line_count, not a flat average', () => {
  const q = buildWatcherSeriesQuery([{ token: null, payer: 'AETNA' }]);
  assert.match(q.sql, /sum\(d\.rating \* d\.line_count\)/);
  assert.match(q.sql, /nullif\(sum\(d\.line_count\), 0\)/);
});

// ── Folds ───────────────────────────────────────────────────────────────────────────────────────
const row = (payer: string, date: string, rating: number | null, token: string | null = null): QualifyWatcherSeriesRow => ({
  member_id_prefix_bidx: token,
  primary_payer: payer,
  as_of_date: date,
  rating,
});

test('foldWatcherSeries groups by subject, keeps order, drops nulls, and reports the delta', () => {
  const folded = foldWatcherSeries([
    row('AETNA', '2026-05-01', 40),
    row('AETNA', '2026-05-02', null), // suppressed day — dropped, not zeroed
    row('AETNA', '2026-05-03', 52),
    row('CIGNA', '2026-05-01', 70, 'f'.repeat(64)),
  ]);
  const aetna = folded.get(watcherSeriesKey(null, 'AETNA'));
  assert.deepEqual(aetna?.points, [40, 52]);
  assert.equal(aetna?.ratingNow, 52);
  assert.equal(aetna?.deltaPts, 12);
  // one point = no trend claim
  const cigna = folded.get(watcherSeriesKey('f'.repeat(64), 'CIGNA'));
  assert.equal(cigna?.deltaPts, null);
});

// ── Masks — the compliance shapes, executable ───────────────────────────────────────────────────
test('maskedPatientEcho yields prefix + mask + last-four, and REFUSES unmaskable terms', () => {
  assert.equal(maskedPatientEcho('GGS00418841'), 'GGS •••• 8841');
  assert.equal(maskedPatientEcho('ggs-0041 8841'), 'GGS •••• 8841'); // normalization
  assert.equal(maskedPatientEcho('GGS1'), null);
  assert.equal(maskedPatientEcho(''), null);
  // a digit-led id drops to dots rather than echoing digits as an alpha prefix
  assert.equal(maskedPatientEcho('123456789A'), '••• •••• 789A');
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR (adversarial review, 2026-08-10). The first implementation
 * refused only terms under FIVE characters, but prefix(0..3) and tail(-4) OVERLAP below eight — so
 * `ABC1234` rendered as `ABC •••• 1234`: the entire identifier, in order, nothing hidden, and 13
 * chars wide so every column CHECK passed it. A "mask" that stores the id verbatim.
 *
 * The invariant is stated the way the compliance claim is stated — count what is HIDDEN — so it
 * cannot be satisfied by an overlap again.
 */
test('the echo always hides at least MASKED_ECHO_MIN_HIDDEN characters, at every length', () => {
  for (let len = 1; len <= 24; len++) {
    const term = 'ABCDEFGHIJKLMNOPQRSTUVWX'.slice(0, len);
    const echo = maskedPatientEcho(term);
    if (echo === null) continue; // refusal is always safe
    const revealed = echo.replace(/[•\s]/g, '');
    const hidden = len - revealed.length;
    assert.ok(
      hidden >= MASKED_ECHO_MIN_HIDDEN,
      `len ${len}: "${term}" -> "${echo}" hides only ${hidden} chars`,
    );
    // and no echo may ever contain the whole normalized term as a substring
    assert.ok(!echo.replace(/[•\s]/g, '').includes(term), `len ${len}: the echo reproduces the term`);
  }
});

test('the 5-7 char band is REFUSED outright — it cannot be masked at this width', () => {
  for (const term of ['ABC12', 'ABC123', 'ABC1234']) {
    assert.equal(maskedPatientEcho(term), null, `${term} must be refused, not masked`);
  }
  // 8 is the first maskable length, and it drops the prefix rather than overlapping
  assert.equal(maskedPatientEcho('ABC12345'), '••• •••• 2345');
});

test('the masked echo always fits the 0096 column bound (≤13 chars)', () => {
  for (const term of ['GGS00418841', '12345678', 'ABCDEFGHIJKLMNOP']) {
    const echo = maskedPatientEcho(term);
    assert.ok(echo === null || echo.length <= 13, `echo too wide for the column: ${echo}`);
  }
});

test('recentSearchEcho is the ≤3-char [A-Z0-9] facet or null — the CHECK constraint, pre-enforced', () => {
  assert.equal(recentSearchEcho('GGS00418841'), 'GGS');
  assert.equal(recentSearchEcho('w2'), 'W2');
  assert.equal(recentSearchEcho('---'), null);
  assert.equal(recentSearchEcho(''), null);
});

// ── Constant/definer agreement ──────────────────────────────────────────────────────────────────
// QUALIFY_WATCHER_MAX and QUALIFY_RECENT_MAX exist so a rep-facing surface can explain a refusal in
// the same terms the DB enforces it in — but the DB is the real source of truth (0096's
// `claims.save_qualify_watcher` / `claims.record_qualify_recent_search`), and a literal duplicated
// in two files can drift without either one erroring. These tests fail loudly the moment they do,
// which is the "at minimum" bar for a constant whose only other job is to look like a source of
// truth it is not.
test('QUALIFY_WATCHER_MAX matches the cap literal in 0096\'s save_qualify_watcher', () => {
  const sql = readFileSync(MIGRATION_0096, 'utf8');
  const match = sql.match(/>=\s*(\d+)\s+then\s+raise exception 'save_qualify_watcher: watcher limit reached/);
  assert.ok(match, 'could not find the watcher-cap raise in 0096 — did the definer change shape?');
  assert.equal(Number(match![1]), QUALIFY_WATCHER_MAX);
});

test('QUALIFY_RECENT_MAX matches the prune literal in 0096\'s record_qualify_recent_search', () => {
  const sql = readFileSync(MIGRATION_0096, 'utf8');
  const match = sql.match(/record_qualify_recent_search[\s\S]*?order by searched_at desc, id desc\s+limit\s+(\d+)/);
  assert.ok(match, 'could not find the recent-search prune LIMIT in 0096 — did the definer change shape?');
  assert.equal(Number(match![1]), QUALIFY_RECENT_MAX);
});

/**
 * buildRecentSearchListQuery's LIMIT rides as $2::int, bound to QUALIFY_RECENT_MAX — not
 * interpolated into the SQL text. A LIMIT is a value, and the standing rule (CLAUDE.md) is that
 * only table/column/GUC names are fixed string literals; every value is a bound param.
 *
 * This is written to actually FAIL if the LIMIT regresses to a bare inlined literal (the earlier,
 * corrected draft): the `doesNotMatch` below rejects any numeral after "limit" in the SQL text, and
 * the params assertion requires the second bound param to equal the constant. An interpolated
 * `limit 20` would fail the first; a query with only one param (or the wrong second value) would
 * fail the second. A test that built its "expected" string from the same constant the source uses —
 * so a hardcoded literal happened to produce a byte-identical string — would not have this property;
 * this one asserts the SHAPE (bound param, not text), not just the numeric value.
 */
test('the recent-search LIMIT is a bound param equal to QUALIFY_RECENT_MAX, never inlined', () => {
  const q = buildRecentSearchListQuery('u-1');
  assert.doesNotMatch(q.sql, /limit\s+\d/, 'the LIMIT must never be a numeral literal in the SQL text');
  assert.match(q.sql, /limit \$2::int/);
  assert.deepEqual(q.params, ['u-1', QUALIFY_RECENT_MAX]);
});
