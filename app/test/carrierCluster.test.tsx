/**
 * Carrier clustering — the safety cases ARE the spec (carrierCluster.ts).
 *
 * The merge rules exist to collapse hand-typed VOB spellings ("13 tiles, all Anthem Blue Cross of
 * California", measured live 2026-08-06) WITHOUT ever merging two real payers. Every test here is
 * one of the ways that could go wrong.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  carrierTokens,
  clusterCarriers,
  editDistance,
  sameCarrier,
  buildTokenCanonicalizer,
  type ClusterableCarrier,
} from '../lib/qualify/carrierCluster';

const c = (name: string, members = 1, canonicalPayerId: string | null = null): ClusterableCarrier => ({
  name,
  members,
  canonicalPayerId,
});

const sets = (a: string, b: string): [Set<string>, Set<string>] => [
  new Set(carrierTokens(a)),
  new Set(carrierTokens(b)),
];

// ── The live case this exists for ────────────────────────────────────────────────────────────────

test('the measured 13-spelling Anthem prefix collapses to three tiles, not thirteen', () => {
  // Verbatim from the 2026-08-06 screenshot, including both CALIFORNIA typos.
  const clusters = clusterCarriers([
    c('Anthem Blue Cross of California', 151, 'pi_anthem_ca'),
    c('ANTHEM BCBS OF CALIFORNIA', 101),
    c('ANTHEM CA', 14),
    c('BCBS OF CA', 9),
    c('BCBS CALIFORNIA', 5),
    c('ANTHEM BLUE CROSS CA', 2),
    c('ANTHEM BC CA', 1),
    c('ANTHEM BC OF CALIFORNIA', 1),
    c('ANTHEM BLUE CROSS OF CA', 1),
    c('ANTHEM BLUE CROSS OF CALIFONIA', 1), // missing R
    c('ANTHEM BLUE CROSS OF CALIFRONIA', 1), // transposed RO
    c('BC CA', 1),
    c('BC OF CA', 1),
  ]);
  assert.equal(clusters.length, 3, `expected 3 clusters, got ${clusters.length}: ${clusters.map((x) => x.label).join(' | ')}`);
  const anthem = clusters[0];
  assert.ok(anthem, 'largest cluster exists');
  // The CONFIRMED spelling names the tile, and the crosswalk id rides along.
  assert.equal(anthem.label, 'Anthem Blue Cross of California');
  assert.equal(anthem.canonicalPayerId, 'pi_anthem_ca');
  assert.equal(anthem.members.length, 9, 'all nine Anthem spellings fold, typos included');
  assert.equal(anthem.otherSpellings.length, 8);
  // The anchorless families stay apart from Anthem AND from each other: without a company anchor,
  // CROSS vs SHIELD is the only distinguishing signal, so BCBS (cross+shield) ≠ BC (cross only).
  const others = clusters
    .map((x) => x.label)
    .filter((l) => l !== 'Anthem Blue Cross of California')
    .sort();
  assert.deepEqual(others, ['BC CA', 'BCBS OF CA']);
});

// ── The pairs that must NEVER merge ──────────────────────────────────────────────────────────────

test('Blue Cross of California and Blue Shield of California are different companies — never merged', () => {
  const [a, b] = sets('BLUE CROSS OF CALIFORNIA', 'BLUE SHIELD OF CALIFORNIA');
  assert.equal(sameCarrier(a, b), false);
  const clusters = clusterCarriers([c('BLUE CROSS OF CALIFORNIA', 10), c('BLUE SHIELD OF CALIFORNIA', 10)]);
  assert.equal(clusters.length, 2);
});

test('UMR and UHC are two characters apart and are different companies — never merged', () => {
  const [a, b] = sets('UMR', 'UHC');
  assert.equal(sameCarrier(a, b), false);
});

test('a stateless name never merges into a state-specific one', () => {
  // "Anthem Blue Cross" could be any state's plan; folding it into California would fabricate
  // geography the VOB never stated.
  const [a, b] = sets('ANTHEM BLUE CROSS', 'ANTHEM BLUE CROSS OF CALIFORNIA');
  assert.equal(sameCarrier(a, b), false);
});

test('same anchor, different state — never merged', () => {
  const [a, b] = sets('ANTHEM BLUE CROSS OF CALIFORNIA', 'ANTHEM BLUE CROSS OF NEVADA');
  assert.equal(sameCarrier(a, b), false);
});

test('THE CROSSWALK OUTRANKS TEXT: two confirmed-but-different payers never merge however alike', () => {
  // Hypothetical but structural: if the alias map ever rules two near-identical strings to be
  // different payers, the display layer must not overrule it.
  const clusters = clusterCarriers([
    c('ANTHEM BLUE CROSS OF CALIFORNIA', 10, 'pi_one'),
    c('ANTHEM BCBS OF CALIFORNIA', 9, 'pi_two'),
  ]);
  assert.equal(clusters.length, 2, 'the confirmed ids differ, so the tiles stay apart');
});

test('an unconfirmed spelling joins a confirmed cluster, and is counted as unconfirmed', () => {
  const clusters = clusterCarriers([
    c('Anthem Blue Cross of California', 151, 'pi_anthem_ca'),
    c('ANTHEM CA', 14),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.canonicalPayerId, 'pi_anthem_ca');
  assert.equal(clusters[0]?.unconfirmedMembers, 14, 'the hand-typed spelling is folded but labelled');
});

// ── The merges that must happen ──────────────────────────────────────────────────────────────────

test('anchored CROSS/SHIELD variance is manual-entry noise: Anthem BC == Anthem BCBS == Anthem', () => {
  const pairs: Array<[string, string]> = [
    ['ANTHEM BLUE CROSS OF CALIFORNIA', 'ANTHEM BCBS OF CALIFORNIA'],
    ['ANTHEM BLUE CROSS OF CALIFORNIA', 'ANTHEM CA'],
    ['ANTHEM BC CA', 'ANTHEM BCBS OF CALIFORNIA'],
  ];
  for (const [x, y] of pairs) {
    const [a, b] = sets(x, y);
    assert.equal(sameCarrier(a, b), true, `${x} should merge with ${y}`);
  }
});

test('state codes and state names agree; OF/INC/noise words never distinguish', () => {
  const [a, b] = sets('ANTHEM BLUE CROSS OF CA', 'Anthem Blue Cross California Inc');
  assert.equal(sameCarrier(a, b), true);
});

// ── Typo folding ─────────────────────────────────────────────────────────────────────────────────

test('editDistance counts an adjacent transposition as ONE edit', () => {
  assert.equal(editDistance('CALIFRONIA', 'CALIFORNIA', 2), 1, 'RO↔OR is one swap');
  assert.equal(editDistance('CALIFONIA', 'CALIFORNIA', 2), 1, 'a dropped letter is one edit');
});

test('typos fold toward the dominant spelling only, and short tokens are never fuzzy-matched', () => {
  const canon = buildTokenCanonicalizer([
    'ANTHEM BLUE CROSS OF CALIFORNIA',
    'ANTHEM BLUE CROSS OF CALIFORNIA',
    'ANTHEM BLUE CROSS OF CALIFONIA',
  ]);
  assert.equal(canon('CALIFONIA'), 'CALIFORNIA', 'the typo folds into the majority spelling');
  assert.equal(canon('CALIFORNIA'), 'CALIFORNIA', 'the majority spelling never moves');
  const short = buildTokenCanonicalizer(['UMR', 'UMR', 'UHC']);
  assert.equal(short('UHC'), 'UHC', 'below the length floor, one edit is a different company');
});

// ── Presentation contract ────────────────────────────────────────────────────────────────────────

test('clusters order by total members and never reshuffle members within', () => {
  const clusters = clusterCarriers([
    c('CIGNA', 4, 'pi_cigna'),
    c('Anthem Blue Cross of California', 151, 'pi_anthem_ca'),
    c('ANTHEM CA', 14),
  ]);
  assert.deepEqual(
    clusters.map((x) => x.label),
    ['Anthem Blue Cross of California', 'CIGNA'],
  );
  assert.deepEqual(
    clusters[0]?.members.map((m) => m.name),
    ['Anthem Blue Cross of California', 'ANTHEM CA'],
    'largest spelling first within a cluster',
  );
});
