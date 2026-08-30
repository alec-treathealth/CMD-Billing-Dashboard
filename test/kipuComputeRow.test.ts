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

test('A2: an evaluation counts on ATTENDANCE, not on documentation status (ruled 2026-08-27)', () => {
  // ⚠ INVERTED 2026-08-27. This asserted that a non-`Complete` evaluation contributed
  // nothing. Alec ruled documentation status is a CARE-TEAM signal about an unfinished
  // note and does not decide billability — the service was delivered either way.
  const c = client({ sessions: [T('2026-08-10', 1.0, { billable: false })] });
  const r = computeRow(c, WEEK, CFG);
  // The A10 point is the HOURS: 0 before the ruling, 1.0 after.
  assert.equal(r.days[0]?.hrs, 1.0);
  // The code is HRS, not T, and that is a DIFFERENT rule doing its job: this client is
  // IOP/3.0, one hour is under the per-day threshold, and A8 forbids IOP emitting a bare
  // T — so A3 shows the hours instead. Un-gating the status does not make the day billable.
  assert.deepEqual(r.days[0]?.codes, ['HRS']);
  assert.equal(r.billableDays, 0);
});

test('A2/A10 on an OP client: an un-Complete therapy hour bills its day outright', () => {
  // The clean isolation of the ruling — OP has no hours threshold, so the restored hour
  // turns straight into a billable T day.
  const c = client({
    loc: 'MH OP 2 Adult',
    auths: [auth({ loc: 'MH OP 2 Adult', freq: '2 Day' })],
    sessions: [T('2026-08-10', 1.0, { billable: false, status: 'Ready For Review' })],
  });
  const r = computeRow(c, WEEK, CFG);
  assert.equal(r.days[0]?.hrs, 1.0);
  assert.deepEqual(r.days[0]?.codes, ['T']);
  assert.equal(r.billableDays, 1);
});

test('A2: statusGatesBillable:true restores the pre-ruling evaluation behaviour', () => {
  const c = client({ sessions: [T('2026-08-10', 1.0, { billable: false })] });
  const r = computeRow(c, WEEK, CFG, withRules({ statusGatesBillable: true }));
  assert.equal(r.days[0]?.hrs, 0);
  assert.deepEqual(r.days[0]?.codes, []);
});

test('a non-Complete GROUP session DOES count — the engine agrees with the mock again', () => {
  // ⚠ INVERTED 2026-08-27, and this one closed a real divergence rather than opening one.
  // The mock always counted a present group row regardless of documentation status; the
  // extraction deviated and gated it. Alec ruled the MOCK was right, so a Ready-For-Review
  // group with 3 hours bills its day exactly as a Complete one does.
  const c = client({ sessions: [G('2026-08-10', 3.0, { billable: false, status: 'Ready For Review' })] });
  const r = computeRow(c, WEEK, CFG);
  assert.equal(r.days[0]?.hrs, 3.0);
  assert.deepEqual(r.days[0]?.codes, ['I']);
  assert.equal(r.billableDays, 1);
});

test('statusGatesBillable:true restores the pre-ruling GROUP behaviour', () => {
  const c = client({ sessions: [G('2026-08-10', 3.0, { billable: false, status: 'Ready For Review' })] });
  const r = computeRow(c, WEEK, CFG, withRules({ statusGatesBillable: true }));
  assert.equal(r.days[0]?.hrs, 0);
  assert.deepEqual(r.days[0]?.codes, []);
  assert.equal(r.billableDays, 0);
});

test('present=false still never counts, whatever the status rule says', () => {
  // The ruling moved the gate to `present` ALONE — it did not remove the gate.
  for (const rules of [undefined, withRules({ statusGatesBillable: true })]) {
    const c = client({ sessions: [G('2026-08-10', 3.0, { present: false, status: 'Complete' })] });
    const r = computeRow(c, WEEK, CFG, rules);
    assert.equal(r.days[0]?.hrs, 0);
    assert.equal(r.billableDays, 0);
  }
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

/**
 * ⚠ THE PARITY NUMBERS MOVED ON 2026-08-27, BY RULING, NOT BY DRIFT.
 *
 * The browser-verified baseline was 25 rows / 62 billable days / 204.4 h / 12 flagged /
 * 3 uncapped. Two rulings landed together:
 *
 *   A10 (status no longer gates billability) -> +1 row, +1 billable day, +8.2 hours.
 *       One client's only sessions that week were non-`Complete`, so they had no counted
 *       hours at all before and now appear in the grid.
 *   OP ladder (OP-N = N days on the OP track) -> uncapped LOCs 3 -> 1. Only the
 *       "no level of care in the export" sentinel is still uncapped, which is missing DATA.
 *
 * Flagged rose 12 -> 15 even though FEWER levels of care are ambiguous, because the hours
 * A10 restored push more clients over their cap or outside their auth window. That is the
 * two changes compounding, and it is the number to watch if either is ever revisited.
 *
 * The old baseline is still REACHABLE — see the test below — which is what makes this a
 * clean switch rather than a lost verification.
 */
test('fixture parity: the Aug 10 grid numbers reproduce headlessly under the ruled semantics', () => {
  const b = fixtureBuild();
  const rows = gridRows(b.clients, FIXTURE_WEEK, b.locCfg, withRules({ capResolution: 'current-ur-loc' }));
  assert.equal(rows.length, 26);
  assert.equal(
    rows.reduce((a, x) => a + x.row.billableDays, 0),
    63,
  );
  const hours = rows.reduce((a, x) => a + x.row.total, 0);
  assert.ok(Math.abs(hours - 212.6) < 0.05, `attended hours ${hours} != 212.6`);
  assert.equal(rows.filter((x) => x.row.flag).length, 15);
  // Only the no-level-of-care sentinel is left uncapped now.
  assert.equal(rows.filter((x) => x.row.cfg.ambiguous === true && x.row.capDays === 7).length, 1);
});

test('fixture parity: the pre-ruling browser-verified numbers are still reachable via statusGatesBillable', () => {
  // Isolates the A10 half. Turning the status gate back on reproduces 25 / 62 / 204.4
  // EXACTLY — proof the ruling is a switch over one predicate, not a rewrite of the engine.
  // (The uncapped count is not asserted here: the OP-ladder half is a config change and is
  // deliberately NOT reversible by this flag.)
  const b = fixtureBuild();
  const rows = gridRows(
    b.clients,
    FIXTURE_WEEK,
    b.locCfg,
    withRules({ capResolution: 'current-ur-loc', statusGatesBillable: true }),
  );
  assert.equal(rows.length, 25);
  assert.equal(
    rows.reduce((a, x) => a + x.row.billableDays, 0),
    62,
  );
  const hours = rows.reduce((a, x) => a + x.row.total, 0);
  assert.ok(Math.abs(hours - 204.4) < 0.05, `attended hours ${hours} != 204.4`);
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

/* ══════════════════ MH IOP 1/2/3 ARE ONE PROGRAM (ruled 2026-08-29) ══════════════════
 * The trailing numeral is the weekly billable-day cap and nothing else varies. These
 * tests pin BOTH halves of the ruling: that IOP 1/2 really do inherit IOP 3's semantics,
 * and — separately, below and in kipuBillingReport.test.ts — that the rule is scoped to
 * `MH IOP N` and cannot leak onto `MH OP N`.
 * ════════════════════════════════════════════════════════════════════════════════════ */

/** A client on `loc`, one covering auth on the same LOC, `n` days of 3.0h group. */
const iopClient = (loc: string, n: number): KipuClient =>
  client({
    loc,
    auths: [auth({ loc, freq: '' })],
    sessions: Array.from({ length: n }, (_, i) => G(isoDay(i), 3.0)),
  });
const isoDay = (i: number): string => `2026-08-1${i}`; // 2026-08-10 .. 2026-08-13 (Mon..Thu)

test('IOP 1/2/3 differ ONLY in capDays — same track, same minHours', () => {
  const one = LOC_CONFIG_BASE['MH IOP 1 Adult'];
  const two = LOC_CONFIG_BASE['MH IOP 2 Adult'];
  const three = LOC_CONFIG_BASE['MH IOP 3 Adult'];
  assert.ok(one && two && three, 'IOP 1/2/3 must all be configured');
  for (const e of [one, two, three]) {
    assert.equal(e.track, three.track);
    assert.equal(e.minHours, three.minHours);
    assert.equal(e.ambiguous, undefined, 'an enumerated entry is not ambiguous');
  }
  assert.deepEqual([one.capDays, two.capDays, three.capDays], [1, 2, 3]);
});

test('IOP 1/2/3 emit the SAME day code and hours — only the billable-day count is capped', () => {
  // Four qualifying 3.0h days under each level. The per-day verdict must be identical
  // (an `I` on every day, 12h attended); only how many of them BILL may differ.
  const rows = (['MH IOP 1 Adult', 'MH IOP 2 Adult', 'MH IOP 3 Adult'] as const).map((loc) =>
    computeRow(iopClient(loc, 4), WEEK, LOC_CONFIG_BASE),
  );
  for (const [idx, r] of rows.entries()) {
    const cap = idx + 1;
    assert.equal(r.total, 12, 'attended hours do not depend on the cap');
    // Every day QUALIFIES identically (3.0h of group on an IOP track). The cap decides
    // which of them BILL: the first `cap` days carry `I`, the rest are marked over-cap.
    const codes = r.days.slice(0, 4).map((d) => d.codes.join('+'));
    assert.deepEqual(
      codes,
      Array.from({ length: 4 }, (_, i) => (i < cap ? 'I' : 'N/B')),
      `cap ${cap}: first ${cap} day(s) bill as I, the remainder are over-cap N/B`,
    );
    // A8 — an IOP track never emits a bare G or T, at any cap.
    for (const d of r.days) assert.equal(d.codes.includes('G') || d.codes.includes('T'), false);
  }
  assert.deepEqual(rows.map((r) => r.billableDays), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.capDays), [1, 2, 3]);
});

test('an IOP day still needs the 3.0h minimum at cap 1 and cap 2 — the floor is inherited', () => {
  for (const loc of ['MH IOP 1 Adult', 'MH IOP 2 Adult'] as const) {
    const c = client({ loc, auths: [auth({ loc, freq: '' })], sessions: [G('2026-08-10', 1.5)] });
    const r = computeRow(c, WEEK, LOC_CONFIG_BASE);
    assert.equal(r.billableDays, 0, `${loc}: 1.5h is under the inherited 3.0h floor`);
    assert.deepEqual(r.days[0]?.codes, ['HRS'], `${loc}: under-threshold IOP shows hours, not a code`);
  }
});

/* ── CONSTRAINT 2: the rule is prefix-scoped to MH IOP N and must NOT reach MH OP N ── */

test('MH OP 4 Adult stays OUTPATIENT and picks up no IOP cap behaviour', () => {
  const e = LOC_CONFIG_BASE['MH OP 4 Adult'];
  assert.ok(e);
  // Kipu's own consider_as resolves this to outpatient (verified live 2026-08-29), and
  // #268 reclassified it IOP/4 -> OP/4. Adding IOP 1/2 must not drag it back.
  assert.equal(e.track, 'OP');
  assert.equal(e.minHours, 0, 'an OP level has NO per-day hours threshold');
  assert.equal(e.capDays, 4);

  // Behavioural proof, not just config: a single 1.0h therapy day BILLS under OP. Under
  // any IOP reading of "4" it would be 0 (below the 3.0h floor) and render as HRS.
  const c = client({
    loc: 'MH OP 4 Adult',
    auths: [auth({ loc: 'MH OP 4 Adult', freq: '' })],
    sessions: [T('2026-08-10', 1.0)],
  });
  const r = computeRow(c, WEEK, LOC_CONFIG_BASE);
  assert.equal(r.billableDays, 1, 'OP bills any attended G/T day');
  assert.deepEqual(r.days[0]?.codes, ['T']);
});

test('every MH OP N level is OP/0-minHours — none inherited the IOP floor', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const e = LOC_CONFIG_BASE[`MH OP ${n} Adult`];
    assert.ok(e, `MH OP ${n} Adult missing`);
    assert.equal(e.track, 'OP', `MH OP ${n} Adult must stay OP`);
    assert.equal(e.minHours, 0, `MH OP ${n} Adult must not inherit the IOP hours floor`);
    assert.equal(e.capDays, n);
  }
});
