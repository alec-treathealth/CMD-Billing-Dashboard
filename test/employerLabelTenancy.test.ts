import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facilityCodesForEntity, OWNED_CMD_CUSTOMERS } from '../src/collections/cmdCustomers.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

/**
 * The Collections grid decides what a BLANK employer cell SAYS from the row's facility:
 *
 *   Indigo facility -> "No Employer Name in CMD"  (structurally empty at the source)
 *   BXR facility    -> "Individual"               (a real classification: no plan sponsor)
 *
 * The grid row does not carry business_entity_id, so facility is the ONLY tenant signal available
 * (one CMD customer == one facility). These tests pin the properties that labelling depends on. If
 * any of them breaks, the UI states something false about a patient's coverage — which is exactly
 * the class of error the "not yet populated" ruling exists to prevent.
 */

test('BXR and Indigo facility codes are DISJOINT — a facility can only mean one tenant', () => {
  const bxr = facilityCodesForEntity(BXR_ENTITY_ID);
  const indigo = facilityCodesForEntity(INDIGO_ENTITY_ID);
  assert.ok(bxr.length > 0, 'BXR roster must not be empty');
  assert.ok(indigo.length > 0, 'Indigo roster must not be empty');
  const overlap = bxr.filter((f) => indigo.includes(f));
  assert.deepEqual(overlap, [], 'an overlapping code would label one tenant with the other message');
});

test('facility codes are unique across the WHOLE owned roster, retired ones included', () => {
  // facilityCodesForEntity filters by tenant, so a duplicate ACROSS tenants would be invisible to
  // the disjointness test above if it also appeared twice within one. Retired facilities are
  // included deliberately: their historical rows are still in the table and still get labelled.
  const all = OWNED_CMD_CUSTOMERS.map((c) => c.facilityCode);
  assert.equal(new Set(all).size, all.length, 'duplicate facilityCode in the roster');
});

test('every owned customer belongs to BXR or Indigo — no third tenant can go unlabelled', () => {
  // A facility owned by neither would fall through to the BXR branch and be told "Individual",
  // asserting a fact about a book nobody has verified.
  for (const c of OWNED_CMD_CUSTOMERS) {
    assert.ok(
      c.businessEntityId === BXR_ENTITY_ID || c.businessEntityId === INDIGO_ENTITY_ID,
      `facility ${c.facilityCode} belongs to neither tenant`,
    );
  }
});

test('the two tenant ids are distinct and well-formed', () => {
  assert.notEqual(BXR_ENTITY_ID, INDIGO_ENTITY_ID);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.match(BXR_ENTITY_ID, uuid);
  assert.match(INDIGO_ENTITY_ID, uuid);
});
