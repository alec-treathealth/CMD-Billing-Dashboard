/**
 * Qualify CONFIDENCE (0059 trust signal, Phase 0) — the plain-language collapse of allowed_tier.
 *
 * Two duties:
 *  1. confidenceOf is TOTAL and fails toward 'unknown' — a tier this code has never seen must read
 *     "no allowed on file", never "confirmed".
 *  2. SQL PARITY: confidence.ts is the ONE canonical mapping, but buildFacilityRankingQuery's
 *     coverage counts mirror the buckets in SQL (SQL cannot import TS). This test derives the
 *     expected FILTER fragments FROM the exported tier sets — change either side alone and this
 *     names the drift.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confidenceOf,
  CONFIRMED_TIERS,
  ESTIMATE_TIERS,
  UNKNOWN_TIERS,
  CONFIDENCE_LEGEND,
} from '../app/lib/qualify/confidence.js';
import { buildFacilityRankingQuery, buildFacilityCasesQuery } from '../src/collections/qualifyQuery.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

const BOTH = [BXR_ENTITY_ID, INDIGO_ENTITY_ID];
/** The full 0059 taxonomy, verbatim from the migration's allowed_tier CASE. */
const ALL_TIERS = ['a', 'b', 'cd', 'e1', 'e2', 'none'];

test('confidenceOf: collapses all six 0059 tiers to the three states', () => {
  assert.equal(confidenceOf('a'), 'confirmed');
  assert.equal(confidenceOf('cd'), 'confirmed');
  assert.equal(confidenceOf('e1'), 'confirmed');
  assert.equal(confidenceOf('e2'), 'estimate');
  assert.equal(confidenceOf('b'), 'unknown');
  assert.equal(confidenceOf('none'), 'unknown');
});

test('confidenceOf: null / undefined / never-seen tiers fail toward unknown, never confirmed', () => {
  assert.equal(confidenceOf(null), 'unknown');
  assert.equal(confidenceOf(undefined), 'unknown');
  assert.equal(confidenceOf(''), 'unknown');
  assert.equal(confidenceOf('e3'), 'unknown'); // a future tier must not silently read as trustworthy
});

test('the tier buckets PARTITION the 0059 taxonomy exactly (no gap, no overlap)', () => {
  const union = [...CONFIRMED_TIERS, ...ESTIMATE_TIERS, ...UNKNOWN_TIERS];
  assert.deepEqual([...union].sort(), [...ALL_TIERS].sort(), 'every tier in exactly one bucket');
  assert.equal(new Set(union).size, union.length, 'no tier appears in two buckets');
  // And the function agrees with the sets it exports.
  for (const t of CONFIRMED_TIERS) assert.equal(confidenceOf(t), 'confirmed');
  for (const t of ESTIMATE_TIERS) assert.equal(confidenceOf(t), 'estimate');
  for (const t of UNKNOWN_TIERS) assert.equal(confidenceOf(t), 'unknown');
});

test('SQL parity: the ranking coverage FILTERs are derived-identical to the confidence buckets', () => {
  const { sql } = buildFacilityRankingQuery('AETNA', '2026-06-17', '2026-07-17', BOTH);
  // Build the expected fragments FROM the canonical sets — not hardcoded twice.
  const confirmedSql = `allowed_tier in (${CONFIRMED_TIERS.map((t) => `'${t}'`).join(',')})`;
  const estimateSql = `allowed_tier = '${ESTIMATE_TIERS[0]}'`;
  const unknownSql = `allowed_tier in (${UNKNOWN_TIERS.map((t) => `'${t}'`).join(',')})`;
  assert.ok(sql.includes(`count(*) filter (where ${confirmedSql})::int as confirmed_claims`), 'confirmed mirror');
  assert.ok(sql.includes(`count(*) filter (where ${estimateSql})::int as estimate_claims`), 'estimate mirror');
  assert.ok(sql.includes(`count(*) filter (where ${unknownSql})::int as unknown_claims`), 'unknown mirror');
  assert.equal(ESTIMATE_TIERS.length, 1, 'estimate is a single tier — the `=` SQL form depends on it');
});

test('the cases drill projects the RAW tier for the server-side collapse (never a per-surface mapping)', () => {
  const { sql } = buildFacilityCasesQuery(
    { primary_payers: ['AETNA'], facility: ['405 recovery'], from: '2026-06-17', to: '2026-07-17' },
    BOTH,
  );
  assert.match(sql, /pct_allowed, allowed_tier /, 'inner projects allowed_tier');
  assert.match(sql, /agg\.allowed_tier/, 'outer carries it through');
});

test('CONFIDENCE_LEGEND covers exactly the three states, with captions', () => {
  for (const k of ['confirmed', 'estimate', 'unknown'] as const) {
    assert.ok(CONFIDENCE_LEGEND.labels[k].length > 0);
    assert.ok(CONFIDENCE_LEGEND.captions[k].length > 0);
  }
  assert.equal(Object.keys(CONFIDENCE_LEGEND.labels).length, 3);
});
