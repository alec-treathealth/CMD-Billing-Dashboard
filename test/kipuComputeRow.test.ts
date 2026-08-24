/**
 * Kipu weekly billable-days engine — hermetic tests.
 *
 * Table-driven over the typed row contract (no CSV involved), plus a fixture
 * parity block that locks the engine to the numbers browser-verified on the
 * real Aug 10 export (2026-08-20): 25 grid rows, 62 billable days, 204.4
 * attended hours, 12 rows flagged for review. The fixture is the PHI-free
 * derivation of that export with all dates shifted −364 days, so the real
 * 2026-08-10 week is the fixture's 2025-08-11 week.
 *
 * A13 note: DEFAULT rules resolve caps PER DAY from the authorization that
 * covers that day (ruling 2026-08-21). 'current-ur-loc' reproduces the mock's
 * whole-week resolution and is what the parity block uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { computeRow, gridRows } from '../src/kipu/computeRow.js';
import { assembleBundle, buildFromCsv } from '../src/kipu/billingReport.js';
import type { KipuAuth, KipuClient, KipuSession, LocConfigMap } from '../src/kipu/billingReport.js';
import { DEFAULT_RULES, LOC_CONFIG_BASE, withRules } from '../src/kipu/assumptions.js';

const WEEK = '2026-08-10'; // a Monday

const CFG: LocConfigMap = {
  'MH IOP 3 Adult': { track: 'IOP', capDays: 3, minHours: 3.0 },
  'MH OP 2 Adult': { track: 'OP', capDays: 2, minHours: 0 },
};

const auth = (o: Partial<KipuAuth> = {}): KipuAuth => ({
  no: 'A-1',
  start: '2026-08-01',
  end: '2026-08-31',
  freq: '3 Day (M/W/F)',
  loc: 'MH IOP 3 Adult',
  ...o,
});

const sess = (date: string, o: Partial<KipuSession> = {}): KipuSession => ({
  date,
  kind: 'group',
  topic: 'Process Group',
  provider: 'Prov A',
  start: '08:00 AM',
  end: '09:30 AM',
  hrs: 1.5,
  present: true,
  billable: true,
  status: 'Complete',
  srcId: '',
  ...o,
});

const G = (date: string, hrs = 3.0, o: Partial<KipuSession> = {}): KipuSession => sess(date, { hrs, ...o });
const T = (date: string, hrs = 1.0, o: Partial<KipuSession> = {}): KipuSession =>
  sess(date, { kind: 'therapy', topic: 'New Progress Note', hrs, ...o });
const B = (date: string, hrs = 2.0, o: Partial<KipuSession> = {}): KipuSession =>
  sess(date, { kind: 'bps', topic: 'Biopsychosocial Assessment', hrs, ...o });

const client = (o: Partial<KipuClient> = {}): KipuClient => ({
  id: 'c1',
  name: 'Fixture Person',
  mrn: '',
  admit: '2026-08-01',
  discharge: null,
  loc: 'MH IOP 3 Adult',
  payer: 'Acme Health',
  facility: 'Telehealth MH TX Group Sessions',
  labels: ['Telehealth MH TX Group Sessions'],
  auths: [auth()],
  sessions: [],
  warn: [],
  ...o,
});

/* ------------------------------ defaults lock ---------------------------- */

test('the ruled defaults: per-day A13 resolution and Complete-only A10', () => {
  assert.equal(DEFAULT_RULES.capResolution, 'per-day-auth');
  assert.deepEqual([...DEFAULT_RULES.billableStatuses], ['Complete']);
  assert.equal(DEFAULT_RULES.missedNeverBillable, true);
  assert.equal(DEFAULT_RULES.zeroHourNeverBillable, true);
  assert.equal(DEFAULT_RULES.requireBillableVariant, true);
});

/* ----------------------------- A1 / cap basics --------------------------- */

test('A1: over-cap IOP days resolve chronologically — first capDays win, the rest are N/B', () => {
  const c = client({ sessions: [G('2026-08-10'), G('2026-08-11'), G('2026-08-12'), G('2026-08-13')] });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(
    r.days.map((d) => d.codes),
    [['I'], ['I'], ['I'], ['N/B'], [], [], []],
  );
  assert.equal(r.billableDays, 3);
  assert.equal(r.iopDays, 3);
  assert.equal(r.flag, true);
});

test('A3: an IOP day below minHours shows HRS instead of a code', () => {
  const c = client({ sessions: [G('2026-08-10', 1.5)] });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[0]?.codes, ['HRS']);
  assert.equal(r.billableDays, 0);
  assert.equal(r.flag, true);
});

test('OP track emits G for group days and T for therapy days', () => {
  const c = client({
    loc: 'MH OP 2 Adult',
    auths: [auth({ loc: 'MH OP 2 Adult' })],
    sessions: [sess('2026-08-10'), T('2026-08-11')],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[0]?.codes, ['G']);
  assert.deepEqual(r.days[1]?.codes, ['T']);
  assert.equal(r.billableDays, 2);
});

test('OP: same-day group and therapy stack as G+T on one cap day', () => {
  const c = client({
    loc: 'MH OP 2 Adult',
    auths: [auth({ loc: 'MH OP 2 Adult' })],
    sessions: [sess('2026-08-10'), T('2026-08-10')],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[0]?.codes, ['G', 'T']);
  assert.equal(r.billableDays, 1);
});

test('OP over-cap days are N/B in chronological order, like IOP (A1)', () => {
  const c = client({
    loc: 'MH OP 2 Adult',
    auths: [auth({ loc: 'MH OP 2 Adult' })],
    sessions: [sess('2026-08-10'), sess('2026-08-11'), sess('2026-08-12')],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(
    r.days.slice(0, 3).map((d) => d.codes),
    [['G'], ['G'], ['N/B']],
  );
  assert.equal(r.billableDays, 2);
});

test('A8: the IOP track never emits a bare G or T — qualifying days become I', () => {
  const c = client({ sessions: [G('2026-08-10', 1.5), T('2026-08-10', 1.5)] });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[0]?.codes, ['I']); // 3.0 combined hours meet the threshold
});

/* --------------------------------- A7 BPS -------------------------------- */

test('A7: BPS stacks without consuming a cap day', () => {
  const c = client({
    sessions: [G('2026-08-10'), G('2026-08-11'), G('2026-08-12'), B('2026-08-13')],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(
    r.days.slice(0, 4).map((d) => d.codes),
    [['I'], ['I'], ['I'], ['BPS']],
  );
  assert.equal(r.billableDays, 4); // BPS rides free — no N/B anywhere
});

test('A7: a BPS on an over-cap day keeps the BPS and marks the day N/B', () => {
  const c = client({
    sessions: [G('2026-08-10'), G('2026-08-11'), G('2026-08-12'), G('2026-08-13'), B('2026-08-13', 1.0)],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[3]?.codes, ['BPS', 'N/B']);
  assert.equal(r.billableDays, 4); // the BPS day still counts as billable
});

/* ------------------------- what counts as attended ----------------------- */

test('A2: a non-billable evaluation contributes no hours and no code', () => {
  const c = client({ sessions: [T('2026-08-10', 1.0, { billable: false })] });
  const r = computeRow(c, WEEK, CFG);
  assert.equal(r.days[0]?.hrs, 0);
  assert.deepEqual(r.days[0]?.codes, []);
});

test('a non-Complete GROUP session does not count toward hours or codes (deviation from the mock, per A10)', () => {
  // The mock counted any present group row regardless of its billable flag, so a
  // Ready-For-Review group still produced hours and an I/G code. That leaks A10 at
  // the engine level. The extraction counts a session only when present AND billable.
  const c = client({ sessions: [G('2026-08-10', 3.0, { billable: false, status: 'Ready For Review' })] });
  const r = computeRow(c, WEEK, CFG);
  assert.equal(r.days[0]?.hrs, 0);
  assert.deepEqual(r.days[0]?.codes, []);
  assert.equal(r.billableDays, 0);
});

test('an absent group row (present=false) does not count', () => {
  const c = client({ sessions: [G('2026-08-10', 3.0, { present: false })] });
  const r = computeRow(c, WEEK, CFG);
  assert.equal(r.days[0]?.hrs, 0);
  assert.deepEqual(r.days[0]?.codes, []);
});

/* ------------------------- auth windows (A4 / A6) ------------------------ */

test('hours outside every auth window show HRS and measure days past the latest end (A6)', () => {
  const c = client({
    auths: [auth({ end: '2026-08-12' })],
    sessions: [G('2026-08-14')],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[4]?.codes, ['HRS']);
  assert.equal(r.maxPast, 2);
  assert.equal(r.flag, true);
});

test('A4: a "No Auth Required" authorization never expires — its end date is ignored', () => {
  const c = client({
    auths: [auth({ no: 'No Auth Required', end: '2026-08-12' })],
    sessions: [G('2026-08-14')],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[4]?.codes, ['I']);
  assert.equal(r.maxPast, 0);
});

/* ------------------------------- A5 discharge ---------------------------- */

test('A5: a discharge stacks D/C onto the day codes instead of overriding them', () => {
  const c = client({ discharge: '2026-08-10', sessions: [G('2026-08-10')] });
  const r = computeRow(c, WEEK, CFG);
  assert.deepEqual(r.days[0]?.codes, ['I', 'D/C']);
});

test('a discharge with no sessions still renders a D/C-only row in the grid', () => {
  const c = client({ discharge: '2026-08-12', sessions: [] });
  const rows = gridRows([c], WEEK, CFG);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.row.days[2]?.codes, ['D/C']);
});

test('a client with no activity and no discharge in the week is not a grid row', () => {
  const c = client({ sessions: [G('2026-07-01')] });
  assert.equal(gridRows([c], WEEK, CFG).length, 0);
});

/* ----------------------------- LOC config edge --------------------------- */

test('an unknown LOC falls back to an uncapped OP week (7 days, no threshold)', () => {
  const c = client({ loc: 'Mystery Level', auths: [auth({ loc: 'Mystery Level' })], sessions: [sess('2026-08-10')] });
  const r = computeRow(c, WEEK, {});
  assert.equal(r.capDays, 7);
  assert.deepEqual(r.days[0]?.codes, ['G']);
  assert.equal(r.flag, false);
});

test('an ambiguous LOC config flags the row for review', () => {
  const cfg: LocConfigMap = { 'MH OP 4 Adult': { track: 'IOP', capDays: 4, minHours: 3.0, ambiguous: true } };
  const c = client({ loc: 'MH OP 4 Adult', auths: [auth({ loc: 'MH OP 4 Adult' })], sessions: [G('2026-08-10')] });
  const r = computeRow(c, WEEK, cfg);
  assert.equal(r.flag, true);
});

test('weekly totals sum counted hours to two decimals', () => {
  const c = client({ sessions: [G('2026-08-10', 1.1), G('2026-08-11', 2.2)] });
  const r = computeRow(c, WEEK, CFG);
  assert.equal(r.total, 3.3);
});

/* ------------------------------- A13 modes ------------------------------- */

const multiLocClient = (): KipuClient =>
  client({
    loc: 'MH OP 2 Adult',
    auths: [
      auth({ no: 'A-IOP', start: '2026-08-10', end: '2026-08-12', loc: 'MH IOP 3 Adult' }),
      auth({ no: 'A-OP', start: '2026-08-13', end: '2026-08-31', freq: '', loc: 'MH OP 2 Adult' }),
    ],
    sessions: [G('2026-08-10'), G('2026-08-11'), G('2026-08-12'), sess('2026-08-13'), sess('2026-08-14')],
  });

test('A13 parity mode resolves the whole week from Current UR Loc, as the mock did', () => {
  const r = computeRow(multiLocClient(), WEEK, CFG, withRules({ capResolution: 'current-ur-loc' }));
  // OP 2 cap over five qualifying group days: first two kept, rest over cap.
  assert.deepEqual(
    r.days.slice(0, 5).map((d) => d.codes),
    [['G'], ['G'], ['N/B'], ['N/B'], ['N/B']],
  );
  assert.equal(r.billableDays, 2);
});

test('A13 default mode resolves each day from the auth covering it (ruling 2026-08-21)', () => {
  const r = computeRow(multiLocClient(), WEEK, CFG);
  // Mon–Wed are covered by the IOP-3 auth (3.0h days meet the IOP threshold, cap 3);
  // Thu–Fri are covered by the OP-2 auth (cap 2 within its own regime).
  assert.deepEqual(
    r.days.slice(0, 5).map((d) => d.codes),
    [['I'], ['I'], ['I'], ['G'], ['G']],
  );
  assert.equal(r.billableDays, 5);
  assert.equal(r.iopDays, 3);
  assert.equal(r.multiLoc, true);
  assert.equal(r.flag, true); // the ratified A13 flag survives the resolution change
});

test('A13: a single-LOC client computes identically in both modes', () => {
  const c = client({ sessions: [G('2026-08-10'), G('2026-08-11'), G('2026-08-12'), G('2026-08-13')] });
  const a = computeRow(c, WEEK, CFG);
  const b = computeRow(c, WEEK, CFG, withRules({ capResolution: 'current-ur-loc' }));
  assert.deepEqual(a, b);
});

/* --------------------- fixture parity (browser-verified) ----------------- */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/kipu-billing-report/', import.meta.url));
const FIXTURE_WEEK = '2025-08-11'; // the real 2026-08-10 week, shifted −364 days

function fixtureBuild() {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.csv'))
    .map((name) => ({ name, text: readFileSync(join(FIXTURE_DIR, name), 'utf8') }));
  return buildFromCsv(assembleBundle(files), LOC_CONFIG_BASE);
}

test('fixture parity: the browser-verified Aug 10 grid numbers reproduce headlessly', () => {
  const b = fixtureBuild();
  const rows = gridRows(b.clients, FIXTURE_WEEK, b.locCfg, withRules({ capResolution: 'current-ur-loc' }));
  assert.equal(rows.length, 25);
  assert.equal(
    rows.reduce((a, x) => a + x.row.billableDays, 0),
    62,
  );
  const hours = rows.reduce((a, x) => a + x.row.total, 0);
  assert.ok(Math.abs(hours - 204.4) < 0.05, `attended hours ${hours} != 204.4`);
  assert.equal(rows.filter((x) => x.row.flag).length, 12);
  assert.equal(rows.filter((x) => x.row.cfg.ambiguous === true && x.row.capDays === 7).length, 3);
});

test('fixture: per-day A13 resolution changes only clients whose auths span multiple LOCs', () => {
  const b = fixtureBuild();
  const parity = gridRows(b.clients, FIXTURE_WEEK, b.locCfg, withRules({ capResolution: 'current-ur-loc' }));
  const perDay = gridRows(b.clients, FIXTURE_WEEK, b.locCfg);
  const parityById = new Map(parity.map((x) => [x.client.id, x.row]));
  assert.equal(perDay.length, parity.length);
  for (const x of perDay) {
    const before = parityById.get(x.client.id);
    assert.ok(before);
    const isMultiLoc = x.client.warn.some((w) => /A13/.test(w));
    if (!isMultiLoc) {
      assert.deepEqual(
        x.row.days.map((d) => d.codes),
        before.days.map((d) => d.codes),
        `codes drifted for a single-LOC client ${x.client.id}`,
      );
      assert.equal(x.row.billableDays, before.billableDays);
    }
  }
});
