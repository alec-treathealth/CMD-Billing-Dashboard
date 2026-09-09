/**
 * Code Performance principal + shapers — the parts that would be a SECURITY or correctness bug if
 * they drifted: the tenant set derives from the entitlement and fails closed; a hint can never widen
 * scope; suppression survives shaping as a state; incomplete months are per tenant.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { AccessResult } from '../lib/access';
import {
  codePerfEntityId,
  codePerfPrincipalFromAccess,
  codePerfTenantsFromViews,
  resolveCodePerfTenant,
} from '../lib/code-performance/principal';
import { isoDate, monthStart, shapeDescriptions, shapeFacilityRow, shapeFreshness, shapeMonthRows, shapePayerRow, shapeSummary } from '../lib/code-performance/shape';
import { descriptionKey } from '../lib/code-performance/contract';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../lib/views';

const user = { id: 'u1', email: 'x@treathealth.ai' } as unknown as NonNullable<Extract<AccessResult, { ok: true }>['access']['user']>;
function access(role: 'super_admin' | 'admin' | 'user' | 'admissions_seat', views: Array<'consolidated' | 'bxr' | 'indigo'>, withUser = true): AccessResult {
  return {
    ok: true,
    access: {
      user: withUser ? user : null,
      role,
      entity: null,
      allowedViews: views,
      canRevealPhi: false,
      canManageUsers: false,
    },
  };
}

test('tenants derive from the entitlement in fixed order; consolidated contributes nothing', () => {
  assert.deepEqual(codePerfTenantsFromViews(['consolidated', 'bxr', 'indigo']), ['bxr', 'indigo']);
  assert.deepEqual(codePerfTenantsFromViews(['indigo', 'bxr']), ['bxr', 'indigo']);
  assert.deepEqual(codePerfTenantsFromViews(['indigo']), ['indigo']);
  assert.deepEqual(codePerfTenantsFromViews(['consolidated']), []);
  assert.deepEqual(codePerfTenantsFromViews([]), []);
});

test('a tenant hint never widens scope: clamped to the allowed set, else the first allowed, else null', () => {
  assert.equal(resolveCodePerfTenant('indigo', ['bxr', 'indigo']), 'indigo');
  assert.equal(resolveCodePerfTenant('indigo', ['bxr']), 'bxr', 'an entity user asking for the other tenant gets their own');
  assert.equal(resolveCodePerfTenant('consolidated', ['bxr', 'indigo']), 'bxr');
  assert.equal(resolveCodePerfTenant(undefined, ['indigo']), 'indigo');
  assert.equal(resolveCodePerfTenant({ toString: () => 'bxr' }, ['bxr']), 'bxr', 'non-strings fall to the default, never coerced');
  assert.equal(resolveCodePerfTenant('bxr', []), null);
});

test('principal fails closed: unauthenticated, unprovisioned, no-auth fallback, admissions_seat, no tenants', () => {
  assert.equal(codePerfPrincipalFromAccess({ ok: false, reason: 'unauthenticated' }), null);
  assert.equal(codePerfPrincipalFromAccess({ ok: false, reason: 'unprovisioned', user }), null);
  assert.equal(codePerfPrincipalFromAccess(access('super_admin', ['consolidated', 'bxr', 'indigo'], false)), null, 'no real principal → no tenant data');
  assert.equal(codePerfPrincipalFromAccess(access('admissions_seat', [])), null);
  assert.equal(codePerfPrincipalFromAccess(access('admin', ['consolidated'])), null, 'an entitlement with no tenant view yields nothing');
  const sa = codePerfPrincipalFromAccess(access('super_admin', ['consolidated', 'bxr', 'indigo']));
  assert.deepEqual(sa, { role: 'super_admin', tenants: ['bxr', 'indigo'], defaultTenant: 'bxr' });
  const ind = codePerfPrincipalFromAccess(access('user', ['indigo']));
  assert.deepEqual(ind, { role: 'user', tenants: ['indigo'], defaultTenant: 'indigo' });
});

test('tenant → entity id uses the canonical constants', () => {
  assert.equal(codePerfEntityId('bxr'), BXR_ENTITY_ID);
  assert.equal(codePerfEntityId('indigo'), INDIGO_ENTITY_ID);
});

test('isoDate: a local-midnight Date keeps its civil date regardless of process TZ; strings pass through', () => {
  assert.equal(isoDate(new Date(2026, 2, 12)), '2026-03-12');
  assert.equal(isoDate('2026-08-23'), '2026-08-23');
  assert.equal(isoDate('2026-08-23T00:00:00.000Z'), '2026-08-23');
  assert.equal(isoDate(null), null);
  assert.equal(isoDate('nope'), null);
  assert.equal(monthStart('2026-08-23'), '2026-08-01');
});

test('incomplete months are PER TENANT: cutoff is the month of that tenant\'s max(charge_date)', () => {
  const raws = [
    { month: '2026-06-01', charges: '10', billed: '100', collected: '50', allowed_rate: '25.0', allowed_coverage: '99.0', matured_share: '100.0' },
    { month: '2026-07-01', charges: '10', billed: '100', collected: '50', allowed_rate: '25.0', allowed_coverage: '99.0', matured_share: '80.0' },
    { month: '2026-08-01', charges: '10', billed: '100', collected: '50', allowed_rate: '25.0', allowed_coverage: '99.0', matured_share: '0.0' },
    { month: '2026-09-01', charges: '2', billed: '20', collected: '0', allowed_rate: null, allowed_coverage: '100.0', matured_share: '0.0' },
  ];
  const indigo = shapeMonthRows(raws, '2026-08-23');
  assert.deepEqual(indigo.map((m) => m.incomplete), [false, false, true, true], 'Indigo: Aug and Sep incomplete');
  const bxr = shapeMonthRows(raws, '2026-09-03');
  assert.deepEqual(bxr.map((m) => m.incomplete), [false, false, false, true], 'BXR: only Sep incomplete');
  assert.deepEqual(shapeMonthRows(raws, null).map((m) => m.incomplete), [true, true, true, true], 'no freshness → everything flagged');
  assert.equal(indigo[0]?.charges, 10);
  assert.equal(indigo[3]?.allowed_rate, null);
});

test('summary / payer / facility shapers coerce pg strings and apply the tenant ruling as a STATE', () => {
  const raw = {
    charges: '3352', billed: '13565725.00', collected: '2884981.82', allowed_coverage: '97.3', allowed_rate: '21.97',
    paid_of_allowed: '95.87', underpaid_dollars: '170307.97', days_p50: 30, days_p90: 96, pct_zero_paid: '3.3',
    write_off_rate: '75.91', patient_balance_rate: '1.02', matured_share: '88.0', pairings: '78', facilities: '28',
    payers: '78', no_procedure_code_charges: '5172', no_revenue_code_charges: '0',
  };
  const s = shapeSummary(raw, INDIGO_ENTITY_ID);
  assert.equal(s.billed, 13565725);
  assert.equal(s.pairings, 78);
  assert.deepEqual(s.write_off_rate, { state: 'available', value: 75.91 });
  assert.equal(s.patient_balance_rate.state, 'suppressed');
  const p = shapePayerRow({ ...raw, payer_raw: 'AETNA', share_of_billed: '36.0' }, BXR_ENTITY_ID);
  assert.equal(p.payer_raw, 'AETNA');
  assert.equal(p.share_of_billed, 36);
  assert.equal(p.write_off_rate.state, 'suppressed', 'BXR write-off is dropped at the payer grain too');
  assert.deepEqual(p.patient_balance_rate, { state: 'available', value: 1.02 });
  const f = shapeFacilityRow({ ...raw, facility: 'KNOX RECOVERY', rated: true }, BXR_ENTITY_ID);
  assert.equal(f.facility, 'KNOX RECOVERY');
  assert.equal(f.rated, true);
  assert.equal(shapeSummary(undefined, BXR_ENTITY_ID).charges, 0, 'an empty window shapes to zeros, not a crash');
});

test('freshness: lag in days from business_today − max(charge_date); future payments coerced', () => {
  const f = shapeFreshness({
    business_today: '2026-09-08', max_ingested_at: new Date('2026-09-05T00:32:07Z'), max_charge_date: '2026-08-23',
    max_payment_received: '2026-09-10', future_payment_charges: '114', charges_in_lookback: '103078',
  });
  assert.equal(f.chargeLagDays, 16);
  assert.equal(f.futurePaymentCharges, 114);
  assert.equal(f.maxPaymentReceived, '2026-09-10');
  assert.equal(f.maxIngestedAt, '2026-09-05T00:32:07.000Z');
  assert.equal(shapeFreshness(undefined).chargeLagDays, null);
});

test('descriptions: keyed procedure vs revenue per the 038 rule; needs_review defaults to true', () => {
  const map = shapeDescriptions([
    { code_type: 'HCPCS', code: 'H0018', short_label: 'BH short-term residential', long_description: 'x', prior_description: null, source_citation: null, provenance: 'alec-seed-2026-09-08', needs_review: true, description_conflict: false, tenant_override: false },
    { code_type: 'REV', code: '0905', short_label: 'IOP psych', long_description: null, prior_description: 'IOP', source_citation: 'Novitas — url', provenance: 'alec-seed-2026-09-08', needs_review: true, description_conflict: false, tenant_override: false },
    { code_type: 'OTHER', code: '—', short_label: 'No procedure code reported', long_description: null, prior_description: null, source_citation: null, provenance: 'alec-seed-2026-09-08', needs_review: true, description_conflict: false, tenant_override: false },
    { code_type: 'HCPCS', code: 'S9475', short_label: 'Ambulatory detox', long_description: null, prior_description: 'PHP per diem', source_citation: 'Ensora', provenance: 'alec-seed-2026-09-08', needs_review: true, description_conflict: true, tenant_override: false },
    { code_type: 'BOGUS', code: 'X', short_label: 'x', provenance: 'p' },
  ]);
  assert.equal(Object.keys(map).length, 4, 'an unknown code_type is dropped, not thrown');
  assert.equal(map[descriptionKey('procedure', 'H0018')]?.shortLabel, 'BH short-term residential');
  assert.equal(map[descriptionKey('revenue', '0905')]?.priorDescription, 'IOP');
  assert.equal(map[descriptionKey('procedure', '—')]?.shortLabel, 'No procedure code reported');
  assert.equal(map[descriptionKey('procedure', 'S9475')]?.descriptionConflict, true);
  assert.equal(map[descriptionKey('revenue', 'H0018')], undefined, 'a procedure code is not findable as a revenue code');
});

test('the actions file exports only async functions (a sync export would 500 every action on the page)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'lib', 'code-performance', 'actions.ts'), 'utf8');
  assert.ok(src.startsWith("'use server';"));
  const exportsFound = [...src.matchAll(/^export\s+(?!async function)(\w+)/gm)].map((m) => m[0]);
  assert.deepEqual(exportsFound, [], `non-async exports in a 'use server' file: ${exportsFound.join(', ')}`);
  assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie/, 'nothing on this surface persists client-side');
});
