/**
 * Hermetic tests for the payer-alias resolver (src/billingAudit/payerAlias.ts) — the
 * tested contract 0051's precedence values rest on. The SEED fixture below MIRRORS
 * 0051_payer_alias_seed.sql EXACTLY (same alias_text / match_kind / match_value /
 * precedence, ids in insert order); if 0051 changes, this fixture must change with it.
 *
 * REQUIRED layering assertions (Alec, 2026-07-13, gate before 0051 applies):
 *  - ANTHEM BLUE CROSS CALIFORNIA resolves to the California-specific alias, NEVER the
 *    blues catch-all.
 *  - a bare BLUE CARD PROGRAM string resolves to 'Blue Cards', NEVER the catch-all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePayerAlias, aliasMatches, type PayerAliasRow } from '../src/billingAudit/payerAlias.js';

// Mirror of 0051's seed (HIGHEST precedence wins; exacts 90 / families 60,50 / catch-all 10).
const SEED: PayerAliasRow[] = [
  { id: 1,  alias_text: 'Anthem BCBS CALIFORNIA', match_kind: 'exact', match_value: 'ANTHEM BLUE CROSS CALIFORNIA', precedence: 90 },
  { id: 2,  alias_text: 'Anthem of CALIFORNIA',   match_kind: 'exact', match_value: 'ANTHEM BLUE CROSS CALIFORNIA', precedence: 90 },
  { id: 3,  alias_text: 'BCBS IL (Blue Card)',    match_kind: 'exact', match_value: 'BLUECARD PROGRAM OF IL', precedence: 90 },
  { id: 4,  alias_text: 'BCBS TX (Blue Card)',    match_kind: 'exact', match_value: 'BLUECARD PROGRAM OF TX', precedence: 90 },
  { id: 5,  alias_text: 'GEHA',                   match_kind: 'exact', match_value: 'GEHA', precedence: 90 },
  { id: 6,  alias_text: 'Cigna',                  match_kind: 'exact', match_value: 'CIGNA', precedence: 90 },
  { id: 7,  alias_text: 'UMR',                    match_kind: 'exact', match_value: 'UMR FKA UMR WAUSAU', precedence: 90 },
  { id: 8,  alias_text: 'Blue Cards',             match_kind: 'regex', match_value: '^(BLUE ?CARD|BUECARD)', precedence: 60 },
  { id: 9,  alias_text: 'Optum/UHC/UMR',          match_kind: 'regex', match_value: '^(OPTUM|UHC|UNITED|UMR)', precedence: 60 },
  { id: 10, alias_text: 'Anthem BCBS',            match_kind: 'regex', match_value: '^ANTHEM', precedence: 50 },
  { id: 11, alias_text: 'All other BCBS (Including Anthem)', match_kind: 'regex', match_value: '(BCBS|BLUE CROSS|BLUE ?CARD|BUECARD|ANTHEM|HIGHMARK|HORIZON)', precedence: 10 },
];

const CATCHALL = 'All other BCBS (Including Anthem)';

test('REQUIRED: ANTHEM BLUE CROSS CALIFORNIA → California-specific exact, never the catch-all', () => {
  const r = resolvePayerAlias('ANTHEM BLUE CROSS CALIFORNIA', SEED);
  assert.ok(r);
  assert.equal(r.precedence, 90);
  assert.match(r.alias_text, /CALIFORNIA/);
  assert.notEqual(r.alias_text, CATCHALL);
  // Deterministic tie-break: two prec-90 CA exacts share the match_value → lowest id wins.
  assert.equal(r.alias_text, 'Anthem BCBS CALIFORNIA');
});

test('REQUIRED: a bare BLUE CARD PROGRAM string → Blue Cards, never the catch-all', () => {
  for (const payer of ['BLUECARD PROGRAM OF MN', 'BLUE CARD PROGRAM OF WA', 'BUECARD PROGRAM OF SC']) {
    const r = resolvePayerAlias(payer, SEED);
    assert.ok(r, `no match for ${payer}`);
    assert.equal(r.alias_text, 'Blue Cards', `${payer} should resolve to Blue Cards, got ${r.alias_text}`);
    assert.notEqual(r.alias_text, CATCHALL);
  }
});

test('exact state Blue-Card beats the Blue Cards family (90 > 60)', () => {
  assert.equal(resolvePayerAlias('BLUECARD PROGRAM OF IL', SEED)?.alias_text, 'BCBS IL (Blue Card)');
  assert.equal(resolvePayerAlias('BLUECARD PROGRAM OF TX', SEED)?.alias_text, 'BCBS TX (Blue Card)');
});

test('generic Anthem (non-CA) → Anthem family (50), above the catch-all (10)', () => {
  for (const payer of ['ANTHEM BCBS VA', 'ANTHEM BLUE CROSS IN', 'ANTHEM BC OF GA']) {
    assert.equal(resolvePayerAlias(payer, SEED)?.alias_text, 'Anthem BCBS');
  }
});

test('catch-all is the FLOOR: names only the catch-all matches resolve to it', () => {
  for (const payer of ['HIGHMARK BCBS', 'HORIZON BCBS NJ', 'BCBS CA']) {
    assert.equal(resolvePayerAlias(payer, SEED)?.alias_text, CATCHALL, `${payer} should fall to catch-all`);
  }
});

test('exacts win: GEHA / CIGNA / UMR resolve to their exact alias, not any family/catch-all', () => {
  assert.equal(resolvePayerAlias('GEHA', SEED)?.alias_text, 'GEHA');
  assert.equal(resolvePayerAlias('CIGNA', SEED)?.alias_text, 'Cigna');
  assert.equal(resolvePayerAlias('UMR FKA UMR WAUSAU', SEED)?.alias_text, 'UMR');
});

test('Optum family matches Optum/UHC/United/UMR-prefixed names', () => {
  assert.equal(resolvePayerAlias('OPTUM BEHAVIORAL HEALTH', SEED)?.alias_text, 'Optum/UHC/UMR');
  assert.equal(resolvePayerAlias('OPTUM', SEED)?.alias_text, 'Optum/UHC/UMR');
});

test('no match → null (self-pay / unknown payers stay unattributed)', () => {
  assert.equal(resolvePayerAlias('SELF PAY', SEED), null);
  assert.equal(resolvePayerAlias('WESTERN GROWERS', SEED), null);
  assert.equal(resolvePayerAlias('', SEED), null);
  assert.equal(resolvePayerAlias(null, SEED), null);
});

test('resolution is case-insensitive (patterns authored upper, matched upper)', () => {
  assert.equal(resolvePayerAlias('anthem blue cross california', SEED)?.alias_text, 'Anthem BCBS CALIFORNIA');
  assert.equal(resolvePayerAlias('  cigna  ', SEED)?.alias_text, 'Cigna');
});

test('aliasMatches: like semantics + malformed regex fails closed', () => {
  assert.equal(aliasMatches({ id: 1, alias_text: 'x', match_kind: 'like', match_value: 'BCBS%', precedence: 1 }, 'BCBS OK'), true);
  assert.equal(aliasMatches({ id: 1, alias_text: 'x', match_kind: 'like', match_value: 'BCBS_', precedence: 1 }, 'BCBS OK'), false);
  assert.equal(aliasMatches({ id: 1, alias_text: 'x', match_kind: 'regex', match_value: '(', precedence: 1 }, 'ANYTHING'), false);
});
