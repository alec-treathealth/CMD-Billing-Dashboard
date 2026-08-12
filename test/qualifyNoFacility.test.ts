/**
 * The 'No Facility' placeholder: SUPPRESSED on entity surfaces, PRESERVED in denominators.
 *
 * THE RULING (2026-08-12). The placeholder is CMD's literal for a charge that resolves nowhere —
 * 11,414 charges / $29,081,575.38 at charge grain. It used to "keep its own row everywhere", which
 * put it at #1 on the Qualify momentum ticker: a card naming a place no patient was ever treated at.
 * The ruling splits it by ROLE, reversing the old rule on the entity half only:
 *
 *   · DENOMINATORS KEEP IT — money is not hidden, collections still reconcile.
 *   · ENTITY SURFACES SUPPRESS IT — anything ranked, picked, named, or sent to the model.
 *
 * These tests pin BOTH halves. The denominator half matters more than the suppression half: it is
 * the one a future "just filter it everywhere" change would quietly break, and the resulting error
 * (understated book-wide percentages) would look like a data problem, not a code one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBookKpisQuery,
  buildFacilityRankingQuery,
  buildFacilityTrendQuery,
} from '../src/collections/qualifyQuery.js';
import {
  buildPolicyTapeContextQuery,
  buildRatingHistoryAggQuery,
} from '../src/collections/qualifyRatingHistory.js';
import { QUALIFY_NO_FACILITY_SQL } from '../src/collections/qualifyFacilityPlaceholder.js';
import { QUALIFY_NO_FACILITY } from '../app/lib/qualify/contract.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

const BOTH = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
const FROM = '2026-05-11';
const TO = '2026-08-10';

/** The exclusion, however it is spelled, as an anchored shape: `and facility <> $n`. */
const EXCLUDES_PLACEHOLDER = /and facility <> \$\d+/;

// ── The constant, and the app/src mirror ───────────────────────────────────────────────────────

test('the SQL-side constant is the exact CMD literal', () => {
  assert.equal(QUALIFY_NO_FACILITY_SQL, 'No Facility');
});

test('the src and app constants have not drifted', () => {
  // Two constants on purpose: `app/` imports from `../src`, never the reverse, so the SQL layer
  // cannot reach the UI one. That makes drift possible, so it is pinned here rather than assumed.
  assert.equal(QUALIFY_NO_FACILITY_SQL, QUALIFY_NO_FACILITY);
});

// ── A. Entity surfaces SUPPRESS ────────────────────────────────────────────────────────────────

test('A1 the momentum ticker excludes the placeholder, BOUND not interpolated', () => {
  const q = buildFacilityTrendQuery(FROM, TO, '2026-02-10', BOTH);
  assert.match(q.sql, EXCLUDES_PLACEHOLDER, 'the ticker must not be able to name the placeholder');
  assert.ok(
    q.params.includes(QUALIFY_NO_FACILITY_SQL),
    'the literal is a bound parameter — it is a value, not an identifier',
  );
  assert.doesNotMatch(q.sql, /'No Facility'/, 'never interpolated into the SQL text');
});

test('A2 the facility ranking excludes the placeholder', () => {
  const q = buildFacilityRankingQuery('AETNA', FROM, TO, BOTH);
  assert.match(q.sql, EXCLUDES_PLACEHOLDER);
  assert.ok(q.params.includes(QUALIFY_NO_FACILITY_SQL));
  assert.doesNotMatch(q.sql, /'No Facility'/);
});

test('A2 the exclusion survives the identifier-wide (payerless) mode', () => {
  // The Skip path passes payer=null with a token scope. A clause emitted only on the payer branch
  // would leave the placeholder rankable on exactly the flagship search path.
  const q = buildFacilityRankingQuery(null, FROM, TO, BOTH, {}, 'tok-abc', 'prefix');
  assert.match(q.sql, EXCLUDES_PLACEHOLDER);
});

test('A4 the policy-tape dominant-facility LABEL pick excludes the placeholder', () => {
  const q = buildPolicyTapeContextQuery(BOTH, ['tok1'], FROM, TO);
  assert.match(q.sql, EXCLUDES_PLACEHOLDER);
  assert.ok(q.params.includes(QUALIFY_NO_FACILITY_SQL));
});

// ── B. Denominators PRESERVE — the half most likely to be broken by a later "tidy-up" ──────────

test('B1 the book-wide KPI tile does NOT exclude the placeholder', () => {
  // Money is not hidden: this tile is the denominator the percentages are computed over. Adding the
  // exclusion here would silently restate every book-wide number.
  const q = buildBookKpisQuery({ from: FROM, to: TO }, BOTH);
  assert.doesNotMatch(q.sql, EXCLUDES_PLACEHOLDER, 'the KPI denominator must stay inclusive');
  assert.ok(!q.params.includes(QUALIFY_NO_FACILITY_SQL), 'and must not even bind the literal');
});

test('B2 the policy-tape RATING MATH does NOT exclude the placeholder', () => {
  // Its WHERE is shared by BOTH grouping sets — (token, payer, facility) and the pair-grain
  // (token, payer) — so an exclusion here would strip the placeholder from the rating DENOMINATOR,
  // not just from a label. That is why A4 lives in the separate context query instead.
  const q = buildRatingHistoryAggQuery(BOTH, FROM, TO);
  assert.doesNotMatch(q.sql, EXCLUDES_PLACEHOLDER, 'the rating denominator must stay inclusive');
  assert.ok(!q.params.includes(QUALIFY_NO_FACILITY_SQL));
  assert.match(q.sql, /grouping sets/, 'and the GROUPING SETS shape is untouched');
});

test('B2 keeps the placeholder in the pair-grain set specifically', () => {
  const q = buildRatingHistoryAggQuery(BOTH, FROM, TO);
  assert.match(
    q.sql,
    /\(\(member_id_prefix_bidx, primary_payer, facility\), \(member_id_prefix_bidx, primary_payer\)\)/,
    'both grouping sets present and unrestructured',
  );
});

// ── The mechanism: per-site, never a shared predicate ──────────────────────────────────────────

test('the exclusion is applied per-site, so a denominator can never inherit it', () => {
  // If anyone folds this into cmdExplorerBaseConds (the obvious shared helper), B1 inherits it —
  // that helper builds buildBookKpisQuery's entire WHERE — and so does the Collections grid, which
  // keeps the placeholder under a separate ruling. This asserts the asymmetry directly: same rollup,
  // same window, one excludes and one does not.
  const entity = buildFacilityRankingQuery('AETNA', FROM, TO, BOTH);
  const denominator = buildBookKpisQuery({ from: FROM, to: TO }, BOTH);
  assert.match(entity.sql, EXCLUDES_PLACEHOLDER);
  assert.doesNotMatch(denominator.sql, EXCLUDES_PLACEHOLDER);
});
