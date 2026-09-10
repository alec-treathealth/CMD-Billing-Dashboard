/**
 * AR Management leaves — string-render contract tests (no jsdom). Pins: the patient mask never shows
 * a partial name; the age ramp is one fixed nine-step set; chips carry their semantic labels; money
 * and age formatting are deterministic; and NO meaning-bearing text in the AR components drops below
 * the 12px floor (design-system rule, machine-enforced here for this surface).
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArStatusChip, BAND_COLOR, BandPill, DenialPills, PatientMask, WorkChip, ageText, bandLabel, clp02Label, dateRange, money, moneyCompact, moneyWhole, relativeTime, shortDate,
} from '../components/billing-audit/ar/ar-leaves';
import { AR_BANDS } from '../../src/billingAudit/arBuckets';

test('money / moneyCompact / moneyWhole / ageText are deterministic and total', () => {
  assert.equal(money('1326.02'), '$1,326.02');
  assert.equal(money(0), '$0.00');
  assert.equal(money(null), '—');
  assert.equal(money('abc'), '—');
  assert.equal(moneyCompact('5779991.10'), '$5.78M');
  assert.equal(moneyCompact('52464876.48'), '$52.5M');
  assert.equal(moneyCompact('412000'), '$412K');
  assert.equal(moneyCompact('980'), '$980');
  assert.equal(moneyWhole('52464876.48'), '$52,464,876');
  assert.equal(ageText(0), '0d');
  assert.equal(ageText(365), '365d');
  assert.equal(ageText(730), '2.0y');
  assert.equal(ageText(null), '—');
  assert.equal(ageText(-3), '—');
});

test('date helpers: shortDate / dateRange / relativeTime', () => {
  assert.equal(shortDate('2026-03-01'), 'Mar 1, 2026');
  assert.equal(shortDate('2026-03-01T12:00:00Z'), 'Mar 1, 2026');
  assert.equal(shortDate(null), '—');
  assert.equal(dateRange('2026-03-01', '2026-03-05'), 'Mar 1 – Mar 5, 2026');
  assert.equal(dateRange('2025-12-30', '2026-01-02'), 'Dec 30, 2025 – Jan 2, 2026');
  assert.equal(dateRange('2026-03-01', '2026-03-01'), 'Mar 1, 2026');
  assert.equal(relativeTime('2026-09-01T00:00:00Z', null), null, 'no clock on the server → caller shows a date');
  const now = Date.parse('2026-09-09T12:00:00Z');
  assert.equal(relativeTime('2026-09-09T11:30:00Z', now), '30m ago');
  assert.equal(relativeTime('2026-09-07T12:00:00Z', now), '2d ago');
  assert.equal(relativeTime('2026-05-09T12:00:00Z', now), '4mo ago');
});

test('the age ramp has exactly one colour per band and reads teal → oxblood', () => {
  assert.deepEqual(Object.keys(BAND_COLOR).sort(), AR_BANDS.map((b) => b.key).sort());
  assert.equal(BAND_COLOR['0_30'], '#1C8B82');
  assert.equal(BAND_COLOR['2yr_plus'], '#7F2C29');
  assert.equal(bandLabel('31_60'), '31–60d');
  assert.equal(bandLabel(null), '—');
});

test('PatientMask: masked by default (fixed mask + opaque id), name only when revealed', () => {
  const masked = renderToStaticMarkup(<PatientMask revealed={null} cmdPatientId="80000001" />);
  assert.ok(masked.includes('••••••'));
  assert.ok(masked.includes('#80000001'));
  const shown = renderToStaticMarkup(<PatientMask revealed={{ name: 'TESTLAST, ALEX', member: 'ZZZ111' }} cmdPatientId="80000001" />);
  assert.ok(shown.includes('TESTLAST, ALEX'));
  assert.ok(shown.includes('ZZZ111'));
  assert.equal(shown.includes('••••••'), false);
});

test('chips: status / band / work / denial carry their labels and titles', () => {
  const at = renderToStaticMarkup(<ArStatusChip statusRaw="CLAIM AT CIGNA - SECONDARY" statusCategory="AT_PAYER" statusPayer="CIGNA" cmdStatusText={null} />);
  assert.ok(at.includes('At payer'));
  assert.ok(at.includes('CIGNA'));
  assert.ok(at.includes('title="CLAIM AT CIGNA - SECONDARY"'));
  const custom = renderToStaticMarkup(<ArStatusChip statusRaw="NEEDS RENEGOTIATING" statusCategory="NEEDS_RENEGOTIATING" statusPayer={null} cmdStatusText="NEEDS RENEGOTIATING" />);
  assert.ok(custom.includes('Needs renegotiating'));
  const other = renderToStaticMarkup(<ArStatusChip statusRaw="BALANCE DUE OTHER" statusCategory="OTHER" statusPayer={null} cmdStatusText={null} />);
  assert.ok(other.includes('BALANCE DUE OTHER'));
  const pill = renderToStaticMarkup(<BandPill band="1_2yr" ageDays={400} />);
  assert.ok(pill.includes('1.1y'));
  assert.ok(pill.includes('1–2yr'));
  assert.ok(pill.includes('#BE4238'));
  assert.ok(renderToStaticMarkup(<BandPill band={null} ageDays={null} />).includes('—'));
  assert.ok(renderToStaticMarkup(<WorkChip status="waiting_payer" />).includes('Waiting on payer'));
  assert.ok(renderToStaticMarkup(<WorkChip status="open" />).includes('Open'));
  const denial = renderToStaticMarkup(<DenialPills items={[{ g: 'CO', c: '197', amt: '3900.00', n: 2 }, { g: 'CO', c: '45', amt: '400.00', n: 1 }, { g: 'PI', c: '242', amt: '10.00', n: 1 }]} />);
  assert.ok(denial.includes('197'));
  assert.ok(denial.includes('+1'));
  assert.ok(denial.includes('$3,900.00 across 2 lines'));
  assert.ok(renderToStaticMarkup(<DenialPills items={[]} />).includes('—'));
  assert.equal(clp02Label('4'), 'Denied');
  assert.equal(clp02Label('22'), 'Reversal of prior payment');
  assert.equal(clp02Label('99'), null);
});

test('WorkChip: a CMD-derived state is visibly weaker than a person\'s ruling, and says so in words', () => {
  // The queue shows an effective state that is usually CMD's inference (migration 0113), and it
  // must never carry the same authority as a colleague's decision — otherwise the Work column
  // reads as if the team had already triaged ~23,000 claims.
  const human = renderToStaticMarkup(<WorkChip status="in_progress" />);
  const derived = renderToStaticMarkup(<WorkChip status="in_progress" derived />);
  assert.notEqual(human, derived, 'the two must not render identically');

  // Same label and hue in both, so the state stays readable either way.
  assert.ok(human.includes('In progress') && derived.includes('In progress'));
  assert.ok(human.includes('#3A6B8A') && derived.includes('#3A6B8A'), 'the info hue survives');

  // Human = filled; derived = outlined and lighter weight.
  assert.ok(human.includes('background-color:#E7EEF4'), 'human chip is filled');
  assert.ok(derived.includes('background-color:transparent'), 'derived chip is not filled');
  assert.ok(derived.includes('inset 0 0 0 1px'), 'derived chip is outlined instead');
  assert.ok(human.includes('font-semibold') && derived.includes('font-medium'));

  // ⚠ COLOUR AND WEIGHT ARE NEVER THE SOLE CARRIER — the distinction is in the title text too, so
  // it survives greyscale, low vision and a screen reader.
  assert.ok(derived.includes('nobody has triaged this claim yet'));
  assert.ok(human.includes('set by a person'));
  assert.equal(derived.includes('set by a person'), false);
});

test('12px floor: no AR component sets meaning-bearing text below 12px', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'components', 'billing-audit', 'ar');
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => path.join(dir, f));
  files.push(path.resolve(import.meta.dirname, '..', 'components', 'ar-notifications-bell.tsx'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
      assert.ok(Number(m[1]) >= 12, `${path.basename(f)} uses ${m[0]} (below the 12px floor)`);
    }
  }
});
