import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionsDaily,
  collectionsDailySql,
  collectionsKpis,
  collectionsKpisSql,
  type CollectionsQueryContext,
} from '../src/collections/daily.js';
import { businessDayIso, businessDayPlus, businessWindowBounds } from '../src/businessWindow.js';
import { BXR_ENTITY_ID } from '../src/tenants.js';
import type { ExecResult, QueryExecutor } from '../src/queries/types.js';

/** A valid single-tenant scope for the reader tests (bound as the trailing $n param). */
const SCOPE = [BXR_ENTITY_ID];

const DAILY_SQL =
  `with anchor as (select max(payment_date) as max_d from collections.daily_collections_resolved where business_entity_id = any($4::uuid[]) and ($5::date is null or payment_date <= $5::date)) ` +
  `select ` +
  `to_char(dc.payment_date, 'YYYY-MM-DD') as payment_date, ` +
  `dc.facility_code as facility_code, ` +
  `f.facility_name as facility_name, ` +
  `dc.business_entity_id as business_entity_id, ` +
  `dc.checks_amount as checks_amount, ` +
  `dc.eft_amount as eft_amount, ` +
  `dc.gross_amount as gross_amount ` +
  `from collections.daily_collections_resolved dc ` +
  `cross join anchor a ` +
  `left join collections.facilities f on f.facility_code = dc.facility_code ` +
  `where dc.business_entity_id = any($4::uuid[]) ` +
  `and (case when $1::date is null and $2::date is null ` +
  `then dc.payment_date >= date_trunc('month', a.max_d)::date ` +
  `and dc.payment_date < (date_trunc('month', a.max_d) + interval '1 month')::date ` +
  `else (($1::date is null or dc.payment_date >= $1::date) ` +
  `and ($2::date is null or dc.payment_date < $2::date)) end) ` +
  `and ($3::text is null or dc.facility_code = $3::text) ` +
  `and ($5::date is null or dc.payment_date <= $5::date) ` +
  `order by dc.payment_date desc, f.facility_name nulls last, dc.facility_code`;

const KPIS_SQL =
  `with anchor as (select coalesce($1::date, max(payment_date)) as d from collections.daily_collections_resolved where business_entity_id = any($2::uuid[]) and ($3::date is null or payment_date <= $3::date)) ` +
  `select ` +
  `to_char(a.d, 'YYYY-MM-DD') as as_of, ` +
  `dc.facility_code as facility_code, ` +
  `f.facility_name as facility_name, ` +
  `dc.business_entity_id as business_entity_id, ` +
  `coalesce(sum(dc.checks_amount) filter (where dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d), 0) as mtd_checks, ` +
  `coalesce(sum(dc.eft_amount) filter (where dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d), 0) as mtd_eft, ` +
  `coalesce(sum(dc.gross_amount) filter (where dc.payment_date >= date_trunc('month', a.d)::date and dc.payment_date <= a.d), 0) as mtd_gross, ` +
  `coalesce(sum(dc.checks_amount) filter (where dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d), 0) as ytd_checks, ` +
  `coalesce(sum(dc.eft_amount) filter (where dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d), 0) as ytd_eft, ` +
  `coalesce(sum(dc.gross_amount) filter (where dc.payment_date >= date_trunc('year', a.d)::date and dc.payment_date <= a.d), 0) as ytd_gross ` +
  `from collections.daily_collections_resolved dc ` +
  `cross join anchor a ` +
  `left join collections.facilities f on f.facility_code = dc.facility_code ` +
  `where dc.business_entity_id = any($2::uuid[]) ` +
  `group by a.d, dc.facility_code, f.facility_name, dc.business_entity_id ` +
  `order by ytd_gross desc`;

interface Capture {
  sql?: string;
  params?: readonly unknown[];
}

function fakeExecutor(rows: Record<string, unknown>[], cap: Capture): QueryExecutor {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<ExecResult<T>> {
      cap.sql = sql;
      cap.params = params;
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

/**
 * ⚠ THE INJECTED INSTANT IS 17:00 PACIFIC ON THE 13th, NOT MIDNIGHT ON THE 14th, AND EVERY BOUND
 * ASSERTION BELOW READS '2026-06-13' BECAUSE OF IT (#306, 2026-08-31).
 *
 * `2026-06-14T00:00:00Z` is 2026-06-13 17:00 PDT — i.e. this fixture sits exactly at the start of
 * the ~7-hour window in which UTC has rolled over and the ops calendar has not. Five assertions in
 * this file expected '2026-06-14' while futurePaymentBound derived a UTC civil date; they now read
 * '2026-06-13', which is what "today" means to the people using the product.
 *
 * The instant was DELIBERATELY LEFT AS IT WAS rather than re-chosen to a mid-day UTC one that would
 * have kept those five assertions untouched (ruled 2026-08-31). Re-picking the fixture would have
 * hidden the fix in the one place the existing suite already exercises it — this harness IS the
 * "18:00 Pacific" case the new tests at the bottom of this file assert explicitly.
 */
function ctx(executor: QueryExecutor, audit?: (l: string) => void): CollectionsQueryContext {
  return { executor, createdBy: 'test', entityIds: SCOPE, now: () => new Date('2026-06-14T00:00:00Z'), audit: audit ?? (() => {}) };
}

// --- SQL exactness + forbidden-table guards ---------------------------------

test('collectionsDailySql: exact + reads only daily_collections/facilities', () => {
  const sql = collectionsDailySql();
  assert.equal(sql, DAILY_SQL);
  assert.ok(!sql.includes('collections_raw'));
  assert.ok(!sql.includes('payment_lines'));
  assert.ok(!sql.includes('source_group_code'));
  assert.ok(sql.includes('$1::date') && sql.includes('$2::date') && sql.includes('$3::text') && sql.includes('$5::date'));
});

test('collectionsKpisSql: exact + reads only daily_collections/facilities', () => {
  const sql = collectionsKpisSql();
  assert.equal(sql, KPIS_SQL);
  assert.ok(!sql.includes('collections_raw'));
  assert.ok(!sql.includes('payment_lines'));
  assert.ok(!sql.includes('source_group_code'));
  assert.ok(sql.includes('$1::date') && sql.includes('$3::date'));
});

// --- collectionsDaily params --------------------------------------------------

test('daily: no args → [null, null, null, scope] (SQL CASE applies latest-month default)', async () => {
  const cap: Capture = {};
  await collectionsDaily({}, ctx(fakeExecutor([], cap)));
  assert.equal(cap.sql, DAILY_SQL);
  assert.deepEqual(cap.params, [null, null, null, SCOPE, '2026-06-13']);
});

test('daily: explicit window + facility are passed/trimmed as $1/$2/$3; scope as $4', async () => {
  const cap: Capture = {};
  await collectionsDaily({ facility_code: ' CAMH ', from: '2026-06-01', to: '2026-07-01' }, ctx(fakeExecutor([], cap)));
  assert.deepEqual(cap.params, ['2026-06-01', '2026-07-01', 'CAMH', SCOPE, '2026-06-13']);
});

test('daily/kpis: fail-closed — empty entityIds rejected before any query', async () => {
  const cap: Capture = {};
  const noScope = { executor: fakeExecutor([], cap), createdBy: 'test', entityIds: [], audit: () => {} };
  await assert.rejects(() => collectionsDaily({}, noScope), /entityIds required/);
  await assert.rejects(() => collectionsKpis({}, noScope), /entityIds required/);
  assert.equal(cap.sql, undefined, 'executor must not run without a tenant scope');
});

test('daily: malformed date rejected before any query', async () => {
  const cap: Capture = {};
  await assert.rejects(() => collectionsDaily({ from: '6/1/2026' }, ctx(fakeExecutor([], cap))), /invalid from date/);
  assert.equal(cap.sql, undefined);
});

test('daily: numeric (text) amounts parsed; echo + row_count correct; no PHI/group keys', async () => {
  const cap: Capture = {};
  const rows = [
    { payment_date: '2026-06-30', facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH', business_entity_id: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', checks_amount: '100.00', eft_amount: '0', gross_amount: '100.00' },
    { payment_date: '2026-06-29', facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH', business_entity_id: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', checks_amount: '5.50', eft_amount: '44.50', gross_amount: '50.00' },
  ];
  const res = await collectionsDaily({ facility_code: 'CAMH' }, ctx(fakeExecutor(rows, cap)));
  assert.equal(res.row_count, 2);
  assert.equal(res.facility_code, 'CAMH');
  assert.strictEqual(res.rows[0]!.gross_amount, 100);
  assert.strictEqual(res.rows[1]!.eft_amount, 44.5);
  assert.deepEqual(Object.keys(res.rows[0]!).sort(), [
    'business_entity_id', 'checks_amount', 'eft_amount', 'facility_code', 'facility_name', 'gross_amount', 'payment_date',
  ]);
  const s = JSON.stringify(res);
  for (const bad of ['source_group_code', 'patient', 'member_id', 'inpatient', 'outpatient']) {
    assert.ok(!s.toLowerCase().includes(bad), `must not include ${bad}`);
  }
});

// --- collectionsKpis MTD/YTD + checks/eft split ------------------------------

test('kpis: as_of param passthrough; overall = sum of by_facility; checks/eft split present', async () => {
  const cap: Capture = {};
  const rows = [
    { as_of: '2026-06-30', facility_code: 'CAMH', facility_name: 'CA MENTAL HEALTH', business_entity_id: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088',
      mtd_checks: '10', mtd_eft: '5', mtd_gross: '15', ytd_checks: '100', ytd_eft: '50', ytd_gross: '150' },
    { as_of: '2026-06-30', facility_code: 'DMH', facility_name: 'DALLAS MENTAL HEALTH LLC', business_entity_id: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088',
      mtd_checks: '2', mtd_eft: '3', mtd_gross: '5', ytd_checks: '20', ytd_eft: '30', ytd_gross: '50' },
  ];
  const k = await collectionsKpis({ as_of: '2026-06-30' }, ctx(fakeExecutor(rows, cap)));
  assert.deepEqual(cap.params, ['2026-06-30', SCOPE, '2026-06-13']);
  assert.equal(k.as_of, '2026-06-30');
  // MTD overall
  assert.strictEqual(k.mtd.checks, 12);
  assert.strictEqual(k.mtd.eft, 8);
  assert.strictEqual(k.mtd.gross, 20);
  // YTD overall
  assert.strictEqual(k.ytd.checks, 120);
  assert.strictEqual(k.ytd.eft, 80);
  assert.strictEqual(k.ytd.gross, 200);
  // checks + eft reconcile to gross in the fixture
  assert.strictEqual(k.ytd.checks + k.ytd.eft, k.ytd.gross);
  assert.deepEqual(Object.keys(k.by_facility[0]!).sort(), [
    'business_entity_id', 'facility_code', 'facility_name', 'mtd_checks', 'mtd_eft', 'mtd_gross', 'ytd_checks', 'ytd_eft', 'ytd_gross',
  ]);
});

test('kpis: overall totals are rounded to cents (no float artifacts)', async () => {
  // 0.1 + 0.2 is the canonical float trap; summed totals must round to 0.30.
  const rows = [
    { as_of: '2026-06-30', facility_code: 'A', facility_name: 'A',
      mtd_checks: '0.1', mtd_eft: '0', mtd_gross: '0.1', ytd_checks: '0.1', ytd_eft: '0', ytd_gross: '0.1' },
    { as_of: '2026-06-30', facility_code: 'B', facility_name: 'B',
      mtd_checks: '0.2', mtd_eft: '0', mtd_gross: '0.2', ytd_checks: '0.2', ytd_eft: '0', ytd_gross: '0.2' },
  ];
  const k = await collectionsKpis({}, ctx(fakeExecutor(rows, {})));
  assert.strictEqual(k.mtd.gross, 0.3);
  assert.strictEqual(k.mtd.checks, 0.3);
  assert.strictEqual(k.ytd.gross, 0.3);
});

test('kpis: per-facility money fields are rounded to cents', async () => {
  const rows = [
    { as_of: '2026-06-30', facility_code: 'A', facility_name: 'A',
      mtd_checks: '1.005', mtd_eft: '2.999', mtd_gross: '4.004',
      ytd_checks: '10.1', ytd_eft: '20.2', ytd_gross: '30.30000000000001' },
  ];
  const k = await collectionsKpis({}, ctx(fakeExecutor(rows, {})));
  const f = k.by_facility[0]!;
  assert.strictEqual(f.mtd_eft, 3.0);
  assert.strictEqual(f.mtd_gross, 4.0);
  assert.strictEqual(f.ytd_gross, 30.3);
});

test('daily: row money fields are rounded to cents', async () => {
  const rows = [
    { payment_date: '2026-06-30', facility_code: 'A', facility_name: 'A',
      checks_amount: 12.30000000000001, eft_amount: '0.1', gross_amount: 12.4 },
  ];
  const res = await collectionsDaily({}, ctx(fakeExecutor(rows, {})));
  assert.strictEqual(res.rows[0]!.checks_amount, 12.3);
  assert.strictEqual(res.rows[0]!.eft_amount, 0.1);
  assert.strictEqual(res.rows[0]!.gross_amount, 12.4);
});

test('kpis: empty data → as_of falls back to arg, zeros everywhere', async () => {
  const cap: Capture = {};
  const k = await collectionsKpis({ as_of: '2026-03-15' }, ctx(fakeExecutor([], cap)));
  assert.equal(k.as_of, '2026-03-15');
  assert.deepEqual(k.mtd, { checks: 0, eft: 0, gross: 0 });
  assert.deepEqual(k.ytd, { checks: 0, eft: 0, gross: 0 });
  assert.equal(k.by_facility.length, 0);
});

test('kpis: no IP/OP keys anywhere (deferred this slice)', async () => {
  const cap: Capture = {};
  const rows = [{ as_of: '2026-06-30', facility_code: 'CAMH', facility_name: 'X',
    mtd_checks: '1', mtd_eft: '1', mtd_gross: '2', ytd_checks: '1', ytd_eft: '1', ytd_gross: '2' }];
  const k = await collectionsKpis({}, ctx(fakeExecutor(rows, cap)));
  const keys = JSON.stringify(k).toLowerCase();
  for (const bad of ['inpatient', 'outpatient', 'ip_billing', 'billing_amt', 'source_group_code']) {
    assert.ok(!keys.includes(bad), `must not include ${bad}`);
  }
});

test('kpis + daily each emit exactly one non-PHI audit line', async () => {
  const dl: string[] = [];
  await collectionsDaily({}, ctx(fakeExecutor([], {}), (l) => dl.push(l)));
  assert.equal(dl.length, 1);
  assert.equal(JSON.parse(dl[0]!).event, 'collections_daily');

  const kl: string[] = [];
  await collectionsKpis({}, ctx(fakeExecutor([], {}), (l) => kl.push(l)));
  assert.equal(kl.length, 1);
  assert.equal(JSON.parse(kl[0]!).event, 'collections_kpis');
});

// --- Overview/Collections future-payment split -------------------------------
//
// Overview and the Collections tab read the SAME rows through
// daily_collections_resolved, so this read-time bound is the ONLY thing separating them.
// CMD carries forward-dated deposit dates and dropFuturePaymentRows now ingests them up
// to a horizon; Overview shows that money, Collections does not. If these fail, the two
// surfaces have silently converged.

test('collectionsDaily: defaults to EXCLUDING future payments (bound = business-today)', async () => {
  const cap: Capture = {};
  await collectionsDaily({}, ctx(fakeExecutor([], cap)));
  assert.equal(cap.params?.[4], '2026-06-13', 'omitting the flag must bound at the injected BUSINESS day');
});

test('collectionsDaily: include_future_payments passes a null bound (no upper limit)', async () => {
  const cap: Capture = {};
  await collectionsDaily({ include_future_payments: true }, ctx(fakeExecutor([], cap)));
  assert.equal(cap.params?.[4], null);
});

test('collectionsKpis: defaults to EXCLUDING future payments (anchor bounded at business-today)', async () => {
  const cap: Capture = {};
  await collectionsKpis({}, ctx(fakeExecutor([], cap)));
  assert.equal(cap.params?.[2], '2026-06-13');
});

test('collectionsKpis: include_future_payments lets the anchor reach the true max', async () => {
  const cap: Capture = {};
  await collectionsKpis({ include_future_payments: true }, ctx(fakeExecutor([], cap)));
  assert.equal(cap.params?.[2], null);
});

test('the future bound is derived from ctx.now, never the database clock', async () => {
  // Guards against a "fix" that swaps the param for SQL current_date, which would make the
  // boundary depend on the database session TimeZone and be untestable.
  const cap: Capture = {};
  const executor = fakeExecutor([], cap);
  await collectionsDaily({}, {
    executor,
    createdBy: 'test',
    entityIds: SCOPE,
    now: () => new Date('2027-01-31T23:00:00Z'),
    audit: () => {},
  });
  assert.equal(cap.params?.[4], '2027-01-31');
  assert.ok(!cap.sql?.includes('current_date'), 'must not reach for the DB clock');
});

// --- #306: THE BOUND IS THE BUSINESS DAY, NOT THE UTC DAY ---------------------
//
// futurePaymentBound derived `ctx.now().toISOString().slice(0, 10)` — a UTC civil date — while the
// explorer grid had already moved onto businessDayIso in PR #298. From ~17:00 Pacific until
// midnight the two halves of Collections therefore disagreed about what day it was, and the daily
// path's bound was the LATER one, so the surface whose whole job is to exclude forward-dated
// deposits was showing them. Measured live inside the band at 2026-08-30 23:47 Pacific: 10 Indigo
// facility-days / $86,211.60 dated 08-31.
//
// futurePaymentBound is private on purpose and stays that way — these assert through the captured
// $n, which is also what proves the clock is still injectable rather than read off the wall.

/** The bound futurePaymentBound produced, for an injected instant. */
async function boundAt(instant: string): Promise<unknown> {
  const cap: Capture = {};
  await collectionsDaily({}, {
    executor: fakeExecutor([], cap),
    createdBy: 'test',
    entityIds: SCOPE,
    now: () => new Date(instant),
    audit: () => {},
  });
  return cap.params?.[4];
}

test('#306: an 18:00 Pacific instant (UTC already tomorrow) bounds on the PACIFIC day', async () => {
  // 2026-06-14T01:00:00Z is 2026-06-13 18:00 PDT. This is THE bug, asserted directly: the old
  // derivation returned '2026-06-14' here, a day on which no deposit had yet been received in the
  // zone every user of this product works in.
  assert.equal(await boundAt('2026-06-14T01:00:00Z'), '2026-06-13');
});

test('#306: DST spring-forward — the offset is read at the instant, not assumed', async () => {
  // 2026-03-08 is the spring-forward date; the transition is at 02:00 local = 10:00 UTC.
  // 07:30Z precedes it, so PST (-8) is still in effect → 2026-03-07 23:30 local.
  // A hard-coded -7 would answer '2026-03-08'; a hard-coded -8 is right here and wrong below.
  assert.equal(await boundAt('2026-03-08T07:30:00Z'), '2026-03-07');
  // 10:30Z is after the transition — 03:30 PDT, same civil day.
  assert.equal(await boundAt('2026-03-08T10:30:00Z'), '2026-03-08');
});

test('#306: DST fall-back — the same instant-of-day resolves to the other side', async () => {
  // 2026-11-01 is the fall-back date; the transition is at 02:00 local = 09:00 UTC.
  // 07:30Z precedes it, so PDT (-7) still holds → 2026-11-01 00:30 local. A hard-coded -8 would
  // answer '2026-10-31'. Paired with the test above, this is what makes the offset DST-AWARE
  // rather than merely non-UTC: no single fixed offset satisfies both.
  assert.equal(await boundAt('2026-11-01T07:30:00Z'), '2026-11-01');
  assert.equal(await boundAt('2026-11-01T09:30:00Z'), '2026-11-01');
});

test('#306: the include_future_payments opt-out is untouched — null, never a date', async () => {
  // Overview's path returns BEFORE any date is derived, so no calendar change can reach it. Assert
  // that at an instant deep inside the disagreement band, where a leaked date would be visible.
  const cap: Capture = {};
  const inBand = {
    executor: fakeExecutor([], cap),
    createdBy: 'test',
    entityIds: SCOPE,
    now: () => new Date('2026-06-14T01:00:00Z'),
    audit: () => {},
  };
  await collectionsDaily({ include_future_payments: true }, inBand);
  assert.equal(cap.params?.[4], null, 'daily: the opt-out must stay an absent bound');
  await collectionsKpis({ include_future_payments: true }, inBand);
  assert.equal(cap.params?.[2], null, 'kpis: the opt-out must stay an absent bound');
});

test('#306: the daily bound and the explorer grid agree at EVERY hour of the day', async () => {
  // The invariant this issue exists to establish, as a loop rather than a spot check. The two
  // surfaces express the same last-included day differently — the daily path INCLUSIVE
  // (payment_date <= bound), the grid HALF-OPEN (payment_received < to) — so the link is that the
  // grid's `to` is the day after the daily bound.
  //
  // ⚠ THE CONVERSION IS DONE BY THE PRIMITIVE, NOT BY HAND. Re-deriving "+1 day" in the test would
  // make it pass against a broken helper as easily as a correct one. businessWindowBounds' `custom`
  // kind already converts an inclusive end date into a half-open upper bound, so feeding it the
  // daily bound and comparing to the grid's own `to` compares two primitive outputs.
  const dates = [
    '2026-06-13', // ordinary summer day (PDT)
    '2026-03-08', // spring forward — a 23-hour day
    '2026-11-01', // fall back — a 25-hour day
    '2026-12-31', // year boundary, PST
  ];
  let checks = 0;
  for (const d of dates) {
    for (let hour = 0; hour < 24; hour++) {
      const instant = new Date(`${d}T${String(hour).padStart(2, '0')}:00:00Z`);
      const bound = await boundAt(instant.toISOString());

      assert.equal(bound, businessDayIso(instant), `${d} ${hour}:00Z — bound must be the business day`);
      assert.equal(bound, businessDayPlus(0, instant), 'and businessDayPlus(0) must agree with it');

      const grid = businessWindowBounds({ kind: 'trailing', days: 30 }, instant);
      assert.equal(grid.to, businessDayPlus(1, instant), `${d} ${hour}:00Z — grid to = business-today + 1`);
      assert.equal(
        businessWindowBounds({ kind: 'custom', from: String(bound), to: String(bound) }, instant).to,
        grid.to,
        `${d} ${hour}:00Z — the daily bound as a half-open upper bound IS the grid's upper bound`,
      );
      checks++;
    }
  }
  assert.equal(checks, 96, 'four days x 24 hours must actually have been exercised');
});

test('#306: no UTC civil-date derivation survives in the daily reader', async () => {
  // The one-line regression that would silently restore the divergence. Source-level, because the
  // behavioural tests above pass for a caller that reads the wall clock too.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/collections/daily.ts', import.meta.url)), 'utf8');
  const bound = src.slice(src.indexOf('function futurePaymentBound'));
  assert.doesNotMatch(
    bound.slice(0, bound.indexOf('\n}')),
    /toISOString\(\)\s*\.slice/,
    'futurePaymentBound must resolve the day through businessDayIso, never a UTC civil date',
  );
  assert.match(src, /import \{ businessDayIso \} from '\.\.\/businessWindow\.js'/, 'and import the primitive');
});
