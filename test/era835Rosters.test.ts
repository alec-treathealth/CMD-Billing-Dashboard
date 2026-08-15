/**
 * Roster partition guards for the two 835 ERA cron routes
 * (/api/cron/era-835 = BXR_CUSTOMERS, /api/cron/indigo-era-835 = INDIGO_CUSTOMERS).
 *
 * WHY THIS FILE EXISTS: splitting the 835 ingest into one route per tenant introduces a
 * failure mode that neither route can detect on its own, because each one only ever sees its
 * own roster. If a customerId appeared in BOTH rosters it would be pulled TWICE a day against
 * CMD's one-report-at-a-time partner slot — doubling load on an endpoint whose 30%/42%
 * failure episodes are still unexplained — and its rows would be written under two different
 * business_entity_ids, which the GUC-scoped RLS would happily accept because each write is
 * internally consistent. If a customerId appeared in NEITHER, its ERAs would silently never
 * be ingested and nothing would log a thing. Both are quiet, and both are caught here.
 *
 * These assert the PARTITION, not the counts: a legitimate onboarding or retirement changes
 * the numbers and must not fail a test, but it must never break disjointness or coverage.
 *
 * Non-PHI by construction — customer account numbers and facility codes are business
 * identifiers, never patient identifiers.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ALL_CMD_CUSTOMERS,
  BXR_CUSTOMERS,
  INDIGO_CUSTOMERS,
  OWNED_CMD_CUSTOMERS,
  RETIRED_CMD_CUSTOMERS,
} from '../src/collections/cmdCustomers.js';
import { BXR_ENTITY_ID, INDIGO_ENTITY_ID } from '../src/tenants.js';

const ids = (rows: readonly { customerId: string }[]): string[] => rows.map((c) => c.customerId);

test('the two era-835 rosters are disjoint — no customer is pulled by both routes', () => {
  const bxr = new Set(ids(BXR_CUSTOMERS));
  const overlap = ids(INDIGO_CUSTOMERS).filter((id) => bxr.has(id));
  assert.deepEqual(
    overlap,
    [],
    `customer(s) in BOTH era-835 rosters would be pulled twice daily and written under two tenants: ${overlap.join(', ')}`,
  );
});

test('the two era-835 rosters together cover every polled customer — no silent gap', () => {
  const covered = new Set([...ids(BXR_CUSTOMERS), ...ids(INDIGO_CUSTOMERS)]);
  const missing = ids(ALL_CMD_CUSTOMERS).filter((id) => !covered.has(id));
  assert.deepEqual(
    missing,
    [],
    `customer(s) in no era-835 roster would never have ERAs ingested, silently: ${missing.join(', ')}`,
  );
  // And nothing extra: the union must be exactly the polling roster, so a stray id cannot
  // smuggle a CMD call in via a roster the ingest loop believes is active.
  assert.equal(covered.size, ALL_CMD_CUSTOMERS.length);
});

test('no retired customer is in either era-835 roster — retirement must stop CMD calls', () => {
  const polled = new Set([...ids(BXR_CUSTOMERS), ...ids(INDIGO_CUSTOMERS)]);
  const stillPolled = ids(RETIRED_CMD_CUSTOMERS).filter((id) => polled.has(id));
  assert.deepEqual(
    stillPolled,
    [],
    `retired customer(s) still being polled for 835s: ${stillPolled.join(', ')}`,
  );
  // Retired rows stay OWNED (history, dimension rows and ownership guards depend on them) —
  // this is the liveness/ownership split in cmdCustomers.ts, asserted so a future edit that
  // "cleans up" retired rows by deleting them fails here instead of silently losing ownership.
  const owned = new Set(ids(OWNED_CMD_CUSTOMERS));
  for (const id of ids(RETIRED_CMD_CUSTOMERS)) assert.ok(owned.has(id), `retired ${id} lost ownership`);
});

test('every roster member carries its own tenant id — a route cannot mis-tag a write', () => {
  // insertEra835Transactions sets app.business_entity_id from customer.businessEntityId, so a
  // wrong id here writes correctly-shaped rows under the WRONG tenant and RLS cannot tell.
  for (const c of BXR_CUSTOMERS) {
    assert.equal(c.businessEntityId, BXR_ENTITY_ID, `${c.customerId} is in the BXR roster with a non-BXR entity id`);
  }
  for (const c of INDIGO_CUSTOMERS) {
    assert.equal(
      c.businessEntityId,
      INDIGO_ENTITY_ID,
      `${c.customerId} is in the Indigo roster with a non-Indigo entity id`,
    );
  }
});
