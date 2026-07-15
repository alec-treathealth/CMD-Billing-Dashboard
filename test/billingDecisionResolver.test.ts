/**
 * Hermetic tests for the facility-scoped decision resolver
 * (src/billingAudit/decisionResolver.ts). Everything here exercises the PURE core
 * (`resolveDecision`) with pre-fetched fixtures — no DB, no I/O.
 *
 * THE HEADLINE PROPERTY (Alec's hard blocker): resolution is scoped to the row's OWN
 * facility's carriers, so the CAMH "Anthem BCBS CALIFORNIA" vs Treat CA "Anthem of
 * CALIFORNIA" pair (both matching report payer "ANTHEM BLUE CROSS CALIFORNIA", both
 * precedence 90 in 0051) resolves to DIFFERENT carriers per facility and never mis-routes.
 *
 * The alias fixtures mirror 0051_payer_alias_seed.sql (same alias_text/kind/value/prec/id).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDecision, type DecisionRow } from '../src/billingAudit/decisionResolver.js';
import type { PayerAliasRow } from '../src/billingAudit/payerAlias.js';

// Subset of the 0051 seed used across these tests (ids/precedence as seeded).
const A_CAMH: PayerAliasRow = { id: 1, alias_text: 'Anthem BCBS CALIFORNIA', match_kind: 'exact', match_value: 'ANTHEM BLUE CROSS CALIFORNIA', precedence: 90 };
const A_TREATCA: PayerAliasRow = { id: 2, alias_text: 'Anthem of CALIFORNIA', match_kind: 'exact', match_value: 'ANTHEM BLUE CROSS CALIFORNIA', precedence: 90 };
const A_CIGNA: PayerAliasRow = { id: 6, alias_text: 'Cigna', match_kind: 'exact', match_value: 'CIGNA', precedence: 90 };
const A_CATCHALL: PayerAliasRow = { id: 11, alias_text: 'All other BCBS (Including Anthem)', match_kind: 'regex', match_value: '(BCBS|BLUE CROSS|BLUE ?CARD|BUECARD|ANTHEM|HIGHMARK|HORIZON)', precedence: 10 };
const TENANT_ALIASES: PayerAliasRow[] = [A_CAMH, A_TREATCA, A_CIGNA, A_CATCHALL];

let decId = 0;
function dec(partial: Partial<DecisionRow> & Pick<DecisionRow, 'facility_code' | 'carrier_text'>): DecisionRow {
  decId += 1;
  return {
    id: decId, alpha_prefix: null, loc: null, hcpcs: null, rev_code: null,
    rules_text: null, active: true, ...partial,
  };
}

// --- fail-closed branches --------------------------------------------------------------

test('unmapped_facility: NULL / blank facility_code never resolves', () => {
  for (const fc of [null, undefined, '', '   ']) {
    const r = resolveDecision({ facilityCode: fc, payerName: 'CIGNA', facilityCarriers: ['Cigna'], tenantAliases: TENANT_ALIASES, facilityDecisions: [] });
    assert.equal(r.status, 'unresolved');
    assert.equal(r.status === 'unresolved' && r.reason, 'unmapped_facility');
  }
});

test('no_facility_carriers: a facility with no active carriers fails closed', () => {
  const r = resolveDecision({ facilityCode: 'LAMH', payerName: 'CIGNA', facilityCarriers: [], tenantAliases: TENANT_ALIASES, facilityDecisions: [] });
  assert.equal(r.status === 'unresolved' && r.reason, 'no_facility_carriers');
});

test('no_payer_match: payer matches no alias among THIS facility carriers', () => {
  const r = resolveDecision({ facilityCode: 'CAMH', payerName: 'SELF PAY', facilityCarriers: ['Cigna'], tenantAliases: TENANT_ALIASES, facilityDecisions: [dec({ facility_code: 'CAMH', carrier_text: 'Cigna' })] });
  assert.equal(r.status === 'unresolved' && r.reason, 'no_payer_match');
});

test('no_decision_for_cohort: carrier matched but no decision row fits', () => {
  const r = resolveDecision({ facilityCode: 'CAMH', payerName: 'CIGNA', facilityCarriers: ['Cigna'], tenantAliases: TENANT_ALIASES, facilityDecisions: [] });
  assert.equal(r.status, 'unresolved');
  assert.equal(r.status === 'unresolved' && r.reason, 'no_decision_for_cohort');
  assert.equal(r.status === 'unresolved' && r.carrier, 'Cigna'); // carrier still reported for observability
});

// --- the headline: cross-facility isolation --------------------------------------------

test('CROSS-FACILITY ISOLATION: same payer resolves to different carriers per facility', () => {
  const payer = 'ANTHEM BLUE CROSS CALIFORNIA';
  const camh = resolveDecision({
    facilityCode: 'CAMH', payerName: payer,
    facilityCarriers: ['Anthem BCBS CALIFORNIA'], // CAMH's carrier only
    tenantAliases: TENANT_ALIASES, // includes Treat CA's alias too — must NOT win here
    facilityDecisions: [dec({ facility_code: 'CAMH', carrier_text: 'Anthem BCBS CALIFORNIA' })],
  });
  const treatca = resolveDecision({
    facilityCode: 'TREAT_CA', payerName: payer,
    facilityCarriers: ['Anthem of CALIFORNIA'], // Treat CA's carrier only
    tenantAliases: TENANT_ALIASES,
    facilityDecisions: [dec({ facility_code: 'TREAT_CA', carrier_text: 'Anthem of CALIFORNIA' })],
  });
  assert.equal(camh.status, 'resolved');
  assert.equal(treatca.status, 'resolved');
  assert.equal(camh.status === 'resolved' && camh.carrier, 'Anthem BCBS CALIFORNIA');
  assert.equal(treatca.status === 'resolved' && treatca.carrier, 'Anthem of CALIFORNIA');
  // Same tenant alias set, same payer — the ONLY thing that differs is the facility's
  // carrier scope, and it fully determines the carrier. No cross-facility bleed.
  assert.notEqual(
    camh.status === 'resolved' && camh.carrier,
    treatca.status === 'resolved' && treatca.carrier,
  );
});

test('scoping excludes an out-of-facility alias even when it would match the payer', () => {
  // CAMH sees ONLY its own carrier; Treat CA's alias (id 2), though in tenantAliases and a
  // payer match, is not a candidate because its alias_text is not a CAMH carrier.
  const r = resolveDecision({
    facilityCode: 'CAMH', payerName: 'ANTHEM BLUE CROSS CALIFORNIA',
    facilityCarriers: ['Anthem BCBS CALIFORNIA'],
    tenantAliases: TENANT_ALIASES,
    facilityDecisions: [dec({ facility_code: 'CAMH', carrier_text: 'Anthem BCBS CALIFORNIA' })],
  });
  assert.equal(r.status === 'resolved' && r.alias.id, 1); // never id 2
});

test('within a facility, precedence still governs (exact 90 beats catch-all 10)', () => {
  const r = resolveDecision({
    facilityCode: 'CAMH', payerName: 'ANTHEM BLUE CROSS CALIFORNIA',
    facilityCarriers: ['Anthem BCBS CALIFORNIA', 'All other BCBS (Including Anthem)'],
    tenantAliases: TENANT_ALIASES,
    facilityDecisions: [dec({ facility_code: 'CAMH', carrier_text: 'Anthem BCBS CALIFORNIA' })],
  });
  assert.equal(r.status === 'resolved' && r.carrier, 'Anthem BCBS CALIFORNIA');
});

// --- sub-cohort specificity ------------------------------------------------------------

test('sub-cohort: most specific applicable decision wins; falls back to catch-all', () => {
  const carrier = 'Cigna';
  const base = {
    facilityCode: 'CAMH', payerName: 'CIGNA',
    facilityCarriers: [carrier], tenantAliases: TENANT_ALIASES,
  };
  const decisions = [
    dec({ facility_code: 'CAMH', carrier_text: carrier }), // (null,null) catch-all
    dec({ facility_code: 'CAMH', carrier_text: carrier, alpha_prefix: 'ZGP' }), // (ZGP,null)
    dec({ facility_code: 'CAMH', carrier_text: carrier, loc: 'RTC' }), // (null,RTC)
    dec({ facility_code: 'CAMH', carrier_text: carrier, alpha_prefix: 'ZGP', loc: 'RTC' }), // (ZGP,RTC)
  ];
  // ZGP + RTC → the (ZGP,RTC) row (score 3).
  const both = resolveDecision({ ...base, facilityDecisions: decisions, alphaPrefix: 'ZGP', loc: 'RTC' });
  assert.equal(both.status, 'resolved');
  assert.equal(both.status === 'resolved' && both.decisions.length, 1);
  assert.equal(both.status === 'resolved' && both.decisions[0]!.alpha_prefix, 'ZGP');
  assert.equal(both.status === 'resolved' && both.decisions[0]!.loc, 'RTC');

  // ZGP + DTX → (ZGP,null) is the only applicable specific one (RTC rows excluded by loc).
  const zgpOnly = resolveDecision({ ...base, facilityDecisions: decisions, alphaPrefix: 'ZGP', loc: 'DTX' });
  assert.equal(zgpOnly.status === 'resolved' && zgpOnly.decisions.length, 1);
  assert.equal(zgpOnly.status === 'resolved' && zgpOnly.decisions[0]!.alpha_prefix, 'ZGP');
  assert.equal(zgpOnly.status === 'resolved' && zgpOnly.decisions[0]!.loc, null);

  // Unknown prefix + unknown loc → only the catch-all applies.
  const fallback = resolveDecision({ ...base, facilityDecisions: decisions, alphaPrefix: 'XXX', loc: 'DTX' });
  assert.equal(fallback.status === 'resolved' && fallback.decisions.length, 1);
  assert.equal(fallback.status === 'resolved' && fallback.decisions[0]!.alpha_prefix, null);
  assert.equal(fallback.status === 'resolved' && fallback.decisions[0]!.loc, null);

  // No cohort info at all → catch-all.
  const agnostic = resolveDecision({ ...base, facilityDecisions: decisions });
  assert.equal(agnostic.status === 'resolved' && agnostic.decisions[0]!.alpha_prefix, null);
});

test('resolved payload carries the winning alias + the matched decision rows', () => {
  const d = dec({ facility_code: 'CAMH', carrier_text: 'Cigna', hcpcs: 'H0018', rev_code: '0124' });
  const r = resolveDecision({
    facilityCode: 'CAMH', payerName: 'CIGNA', facilityCarriers: ['Cigna'],
    tenantAliases: TENANT_ALIASES, facilityDecisions: [d],
  });
  assert.equal(r.status, 'resolved');
  assert.equal(r.status === 'resolved' && r.facilityCode, 'CAMH');
  assert.equal(r.status === 'resolved' && r.alias.id, 6);
  assert.equal(r.status === 'resolved' && r.decisions[0]!.hcpcs, 'H0018');
});
