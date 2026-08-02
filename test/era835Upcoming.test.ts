/**
 * ERA-confirmed upcoming payments — hermetic tests for the Overview tile's read.
 *
 * What these lock:
 *   1) the READ-PATH CONTRACT from migration 013: every SQL statement that sums
 *      payment_amount also computes count(*) FILTER (WHERE payment_amount IS NULL)
 *      over the same window — the tile cannot understate silently,
 *   2) tenancy: the read runs inside withTenant (BEGIN → transaction-local GUC →
 *      queries on the SAME client) AND carries the explicit business_entity_id = $1
 *      predicate,
 *   3) money math is EXACT integer cents, never floats (0.10 + 0.20 === 0.30),
 *   4) the Consolidated merge collapses identical (date, payer, method) groups across
 *      tenants without losing unquantified counts or the truncation flag,
 *   5) the "upcoming" cutoff is the civil day in the BUSINESS zone, passed as a bound
 *      param — not Postgres current_date, which is UTC on Vercel and therefore drops
 *      today's remits every evening from 17:00 PT onward.
 *
 * Fake pool only — no DB, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  businessTodayIso,
  centsFromNumericText,
  eraUpcomingPayments,
  fixed2FromCents,
  mergeEraUpcoming,
  type EraUpcomingGroup,
  type EraUpcomingSummary,
} from '../src/veris/era835Upcoming.js';

const BE = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

/** Minimal fake pool satisfying withTenant: BEGIN/set_config/read-back/COMMIT + our two
 *  SELECTs, recording every statement so tests can assert order and shape. */
function fakePool(fixtures: {
  totals: {
    remits: number;
    total: string;
    unquantified_remits: number;
    incoming_remits: number;
    zero_dollar_remits: number;
  };
  groups: EraUpcomingGroup[];
}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('current_setting')) return { rows: [{ v: params[0] ?? BE }] };
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.includes('group by')) return { rows: fixtures.groups };
      if (sql.includes('coalesce(sum(payment_amount), 0)')) return { rows: [fixtures.totals] };
      return { rows: [] }; // BEGIN / COMMIT / ROLLBACK
    },
    release: () => {},
  };
  // withTenant's read-back needs the GUC echoed; re-dispatch on the recorded value.
  client.query = (async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes('current_setting')) return { rows: [{ v: BE }] };
    if (sql.includes('set_config')) return { rows: [] };
    if (sql.includes('group by')) return { rows: fixtures.groups };
    if (sql.includes('coalesce(sum(payment_amount), 0)')) return { rows: [fixtures.totals] };
    return { rows: [] };
  }) as typeof client.query;
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, statements };
}

const G = (over: Partial<EraUpcomingGroup>): EraUpcomingGroup => ({
  payment_date: '2026-08-03',
  facility_code: 'CAMH',
  payer_name: 'ACME HEALTH PLAN',
  payment_method: 'ACH',
  remits: 1,
  amount: '100.00',
  unquantified_remits: 0,
  ...over,
});

test('eraUpcomingPayments: runs under withTenant with the explicit tenant predicate', async () => {
  const { pool, statements } = fakePool({
    totals: {
      remits: 2,
      total: '72986.79',
      unquantified_remits: 0,
      incoming_remits: 2,
      zero_dollar_remits: 0,
    },
    groups: [G({ remits: 2, amount: '72986.79' })],
  });
  const out = await eraUpcomingPayments(pool, BE, '2026-08-01');

  const sqls = statements.map((s) => s.sql);
  assert.ok(sqls[0]!.includes('BEGIN'), 'transaction first');
  assert.ok(sqls[1]!.includes('set_config'), 'transaction-local GUC second');
  const selects = statements.filter((s) => s.sql.includes('era_835_payment'));
  assert.equal(selects.length, 2, 'totals + groups');
  for (const s of selects) {
    assert.ok(s.sql.includes('business_entity_id = $1::uuid'), 'explicit tenant predicate');
    // The cutoff is a BOUND PARAM, never SQL-side current_date/now(): sargable on 013's
    // (business_entity_id, payment_date) index, and the DST math stays unit-testable.
    assert.ok(s.sql.includes('payment_date >= $2::date'), 'upcoming window is a bound date');
    assert.ok(!s.sql.includes('current_date'), 'never the UTC server day');
    assert.ok(!s.sql.includes('select *'), 'explicit allowlisted columns only');
    assert.deepEqual(s.params, [BE, '2026-08-01'], 'tenant + cutoff are the bound values');
    // THE READ-PATH CONTRACT: no sum without the NULL count over the same filters.
    assert.ok(
      s.sql.includes('filter (where payment_amount is null)'),
      'every money query must carry the unquantified count',
    );
  }
  assert.equal(out.total, '72986.79');
  assert.equal(out.remits, 2);
  assert.equal(out.unquantified_remits, 0);
  assert.ok(sqls.at(-1)!.includes('COMMIT'), 'committed');
  // Facility attribution is a property of the QUERY, not just the type: a breakdown that
  // does not group by facility_code silently blends facilities under one payer row.
  const groupsSql = selects.find((s) => s.sql.includes('group by'))!.sql;
  assert.ok(
    groupsSql.includes('group by payment_date, facility_code, payer_name, payment_method'),
    'breakdown groups by facility',
  );
  assert.ok(groupsSql.includes('facility_code asc'), 'and orders deterministically by it');
});

test('eraUpcomingPayments: truncation flag from the cap probe row, headline unaffected', async () => {
  const groups = Array.from({ length: 51 }, (_, i) =>
    G({ payment_date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, payer_name: `P${i}` }),
  );
  const { pool } = fakePool({
    totals: {
      remits: 200,
      total: '999.99',
      unquantified_remits: 3,
      incoming_remits: 188,
      zero_dollar_remits: 12,
    },
    groups,
  });
  const out = await eraUpcomingPayments(pool, BE, '2026-08-01');
  assert.equal(out.groups.length, 50, 'display list capped');
  assert.equal(out.groups_truncated, true);
  assert.equal(out.remits, 200, 'headline remits come from the UNCAPPED aggregate');
  assert.equal(out.unquantified_remits, 3);
  // THE CAP TRAP: the 51 fixture groups are all ACH, so a zero-dollar count derived from
  // the breakdown would read 0 — and a capped breakdown could never reach 12 anyway.
  // Both split counts must come from the aggregate, untouched by the cap.
  assert.equal(out.incoming_remits, 188, 'incoming from the UNCAPPED aggregate');
  assert.equal(out.zero_dollar_remits, 12, 'zero-dollar from the UNCAPPED aggregate');
  assert.equal(
    out.incoming_remits + out.zero_dollar_remits,
    out.remits,
    'the two counts partition the window exactly',
  );
});

test('TOTALS_SQL splits the remit count by BPR04 in ONE statement, over one window', async () => {
  const { pool, statements } = fakePool({
    totals: {
      remits: 38,
      total: '331481.42',
      unquantified_remits: 0,
      incoming_remits: 34,
      zero_dollar_remits: 4,
    },
    groups: [G({ remits: 38, amount: '331481.42' })],
  });
  const out = await eraUpcomingPayments(pool, BE, '2026-08-01');

  const totalsSql = statements.find((s) => s.sql.includes('coalesce(sum(payment_amount), 0)'))!.sql;
  // Both partitions live alongside the sum and the read-path NULL count — one statement,
  // one window, one set of filters. Splitting them across statements or across layers is
  // how a headline starts disagreeing with itself.
  assert.ok(
    totalsSql.includes("filter (where payment_method = 'NON')"),
    'zero-dollar count is a FILTER on the same aggregate',
  );
  assert.ok(
    totalsSql.includes("payment_method is distinct from 'NON'"),
    'incoming EXCLUDES NON — and IS DISTINCT FROM keeps a null method on the incoming side',
  );
  assert.ok(
    totalsSql.includes('filter (where payment_amount is null)'),
    'and the read-path contract count is still in the same statement',
  );
  assert.equal(totalsSql.includes('group by'), false, 'the headline aggregate is never grouped');

  assert.equal(out.incoming_remits, 34);
  assert.equal(out.zero_dollar_remits, 4);
  assert.equal(out.remits, 38, 'the blended grand total is still available');
});

test('businessTodayIso: the tile follows the Pacific ops day, not the UTC server day', () => {
  // 18:30 PT on 08-01 — THE CASE BROKEN BY current_date TODAY: UTC has already rolled to
  // 08-02, so a remit dated 08-01 (still today for everyone reading the tile) drops out.
  assert.equal(businessTodayIso(new Date('2026-08-01T23:30:00Z')), '2026-08-01');
  // 23:00 PT on 08-01 — one hour before the Pacific day ends, UTC is deep into 08-02.
  assert.equal(businessTodayIso(new Date('2026-08-02T06:00:00Z')), '2026-08-01');
  // The Pacific midnight boundary itself, from both sides of one second.
  assert.equal(businessTodayIso(new Date('2026-08-02T06:59:59Z')), '2026-08-01');
  assert.equal(businessTodayIso(new Date('2026-08-02T07:00:00Z')), '2026-08-02');
});

test('businessTodayIso: DST-aware in BOTH directions (a fixed offset would be wrong)', () => {
  // SPRING FORWARD 2026-03-08 (02:00 PST → 03:00 PDT at 10:00Z): offset -8 before, -7 after.
  assert.equal(businessTodayIso(new Date('2026-03-08T07:00:00Z')), '2026-03-07', '23:00 PST on 03-07');
  assert.equal(businessTodayIso(new Date('2026-03-08T08:00:00Z')), '2026-03-08', '00:00 PST — day rolls');
  assert.equal(
    businessTodayIso(new Date('2026-03-09T07:00:00Z')),
    '2026-03-09',
    '00:00 PDT — a hardcoded -8 would say 03-08',
  );
  // FALL BACK 2026-11-01 (02:00 PDT → 01:00 PST at 09:00Z).
  assert.equal(businessTodayIso(new Date('2026-11-01T06:30:00Z')), '2026-10-31', '23:30 PDT on 10-31');
  assert.equal(
    businessTodayIso(new Date('2026-11-02T07:30:00Z')),
    '2026-11-01',
    '23:30 PST — a hardcoded -7 would say 11-02',
  );
});

test('businessTodayIso: the default clock is real, and the shape is always ISO yyyy-mm-dd', () => {
  assert.match(businessTodayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

test('eraUpcomingPayments: BOTH statements get the SAME cutoff', async () => {
  // A per-statement default would let the headline aggregate and the breakdown straddle
  // midnight PT and disagree with each other — the total would not match its own rows.
  const { pool, statements } = fakePool({
    totals: {
      remits: 1,
      total: '1.00',
      unquantified_remits: 0,
      incoming_remits: 1,
      zero_dollar_remits: 0,
    },
    groups: [G({})],
  });
  await eraUpcomingPayments(pool, BE, '2026-03-07');
  const selects = statements.filter((s) => s.sql.includes('era_835_payment'));
  assert.equal(selects.length, 2, 'totals + groups');
  assert.deepEqual(
    selects.map((s) => s.params[1]),
    ['2026-03-07', '2026-03-07'],
    'one cutoff, both statements',
  );
});

test('centsFromNumericText / fixed2FromCents are exact and reject garbage', () => {
  assert.equal(centsFromNumericText('72986.79'), 7298679);
  assert.equal(centsFromNumericText('0'), 0);
  assert.equal(centsFromNumericText('-10.5'), -1050);
  assert.equal(centsFromNumericText('1.2'), 120);
  assert.equal(centsFromNumericText(null), null);
  assert.equal(centsFromNumericText('12,345.00'), null, 'formatted text is not numeric text');
  assert.equal(centsFromNumericText('1e5'), null, 'scientific notation rejected');
  assert.equal(fixed2FromCents(7298679), '72986.79');
  assert.equal(fixed2FromCents(-1050), '-10.50');
  assert.equal(fixed2FromCents(0), '0.00');
  // The float trap this exists to avoid: 0.10 + 0.20.
  assert.equal(
    fixed2FromCents(centsFromNumericText('0.10')! + centsFromNumericText('0.20')!),
    '0.30',
  );
});

const S = (over: Partial<EraUpcomingSummary>): EraUpcomingSummary => {
  const remits = over.remits ?? 0;
  const zeroDollar = over.zero_dollar_remits ?? 0;
  return {
    total: '0.00',
    remits,
    // Default the split so every fixture satisfies incoming + zero-dollar = remits unless
    // a test deliberately overrides it — a fixture that violates the invariant would let a
    // broken merge look correct.
    incoming_remits: remits - zeroDollar,
    zero_dollar_remits: zeroDollar,
    unquantified_remits: 0,
    groups: [],
    groups_truncated: false,
    ...over,
  };
};

test('mergeEraUpcoming: single part passes through untouched', () => {
  const one = S({ total: '10.00', remits: 1, groups: [G({})] });
  assert.equal(mergeEraUpcoming([one]), one);
});

test('mergeEraUpcoming: exact cents, group collapse, unquantified and truncation carry', () => {
  const bxr = S({
    total: '100.10',
    remits: 3,
    unquantified_remits: 1,
    groups: [
      G({ amount: '100.10', remits: 2 }),
      G({ payer_name: 'ZETA', amount: null, remits: 1, unquantified_remits: 1 }),
    ],
  });
  const indigo = S({
    total: '0.20',
    remits: 1,
    groups: [G({ amount: '0.20' })], // SAME (date, facility, payer, method) as bxr's first
    groups_truncated: true,
  });
  const merged = mergeEraUpcoming([bxr, indigo]);
  assert.equal(merged.total, '100.30', 'exact cents — a float path would say 100.30000000000001');
  assert.equal(merged.remits, 4);
  assert.equal(merged.unquantified_remits, 1);
  assert.equal(merged.groups_truncated, true, 'any truncated part taints the merge');
  assert.equal(
    merged.groups.length,
    2,
    'identical (date,facility,payer,method) collapsed across tenants',
  );
  const acme = merged.groups.find((g) => g.payer_name === 'ACME HEALTH PLAN')!;
  assert.equal(acme.amount, '100.30');
  assert.equal(acme.remits, 3);
  const zeta = merged.groups.find((g) => g.payer_name === 'ZETA')!;
  assert.equal(zeta.amount, null, 'an all-unquantified group stays null, never 0.00');
  assert.equal(zeta.unquantified_remits, 1);
});

test('mergeEraUpcoming: the incoming / zero-dollar split adds per tenant', () => {
  const bxr = S({ total: '331481.42', remits: 38, zero_dollar_remits: 4, groups: [G({})] });
  const indigo = S({
    total: '500.00',
    remits: 3,
    zero_dollar_remits: 1,
    groups: [G({ facility_code: '10026460', amount: '500.00' })],
  });
  const merged = mergeEraUpcoming([bxr, indigo]);
  assert.equal(merged.incoming_remits, 36, '34 + 2 incoming');
  assert.equal(merged.zero_dollar_remits, 5, '4 + 1 non-payments');
  assert.equal(merged.remits, 41);
  assert.equal(
    merged.incoming_remits + merged.zero_dollar_remits,
    merged.remits,
    'the partition survives the Consolidated merge',
  );
  // Both parts were capped-eligible; the counts must not be re-derived from merged.groups
  // (2 rows) which would report 2 incoming and 0 zero-dollar.
  assert.notEqual(merged.incoming_remits, merged.groups.length);
});

test('mergeEraUpcoming: facility_code is part of the key — two facilities never blend', () => {
  // Same date, same payer, same method, DIFFERENT facility. Before facility joined the
  // group key these collapsed into one row and the tile attributed both deposits to
  // whichever facility happened to be first — the exact bug the column exists to fix.
  const a = S({ total: '44625.00', remits: 1, groups: [G({ amount: '44625.00' })] });
  const b = S({
    total: '44730.00',
    remits: 1,
    groups: [G({ facility_code: 'PCMH', amount: '44730.00' })],
  });
  const merged = mergeEraUpcoming([a, b]);
  assert.equal(merged.groups.length, 2, 'CAMH and PCMH stay distinct rows');
  assert.deepEqual(
    merged.groups.map((g) => g.facility_code),
    ['CAMH', 'PCMH'],
    'and sort deterministically by facility within the date',
  );
  assert.equal(merged.groups[0]!.amount, '44625.00');
  assert.equal(merged.groups[1]!.amount, '44730.00');
  assert.equal(merged.total, '89355.00', 'headline still sums both');
});

test('mergeEraUpcoming: null-amount group merged with a quantified one keeps the money', () => {
  const a = S({ total: '5.00', remits: 1, groups: [G({ amount: '5.00' })] });
  const b = S({
    total: '0.00',
    remits: 1,
    unquantified_remits: 1,
    groups: [G({ amount: null, unquantified_remits: 1 })],
  });
  const merged = mergeEraUpcoming([a, b]);
  assert.equal(merged.groups.length, 1);
  assert.equal(merged.groups[0]!.amount, '5.00', 'null contributes nothing but erases nothing');
  assert.equal(merged.groups[0]!.unquantified_remits, 1, 'and the unquantified count survives');
});
