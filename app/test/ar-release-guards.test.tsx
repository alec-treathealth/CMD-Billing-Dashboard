/**
 * Release-gate guards for AR Management, added 2026-09-10 after the pre-release review.
 *
 * Three of these are SOURCE-SCAN tests rather than behavioural ones, and that is deliberate: they
 * pin async-ordering and mount-gating properties that a string render cannot execute (Server Actions
 * are un-abortable and there is no request context here). Each names the failure it prevents, so a
 * later edit that removes the guard fails with the reason rather than a diff.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgingStrip } from '../components/billing-audit/ar/aging-strip';

const appRoot = path.join(__dirname, '..');
const read = (p: string): string => readFileSync(path.join(appRoot, p), 'utf8');
/** Strip comments so a scan cannot be satisfied by prose describing the guard. */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const EMPTY_KPI = { claims: 0, balance: '0', denied: 0, denied_balance: '0', worked: 0, followup_overdue: 0, never_noted: 0, aged_31_plus: 0, aged_31_plus_balance: '0' };
const BANDS = [
  { band: '31_60' as const, claims: 10, balance: '1000.00' },
  { band: '61_90' as const, claims: 5, balance: '3000.00' },
];

// ── B1 ────────────────────────────────────────────────────────────────────────────────────────────
test('the AR bell is gated on the ROLLOUT FLAG, not only on the role', () => {
  // The bell is the one piece of AR Management mounted in the LAYOUT, so /billing-audit's own
  // maintenance gate does not cover it. Ungated, 12 of 14 super-admins get a live unread badge whose
  // every click lands on "AR Management is being rebuilt".
  const layout = strip(read('app/layout.tsx'));
  assert.match(layout, /claimsAuditMaintenanceBlocks/, 'layout consults the rollout gate');
  const mount = layout.match(/\{role === 'super_admin'[^}]*<ArNotificationsBell \/>[^}]*\}/);
  assert.ok(mount, 'the bell mount expression is still recognisable');
  assert.match(mount[0], /!claimsAuditMaintenanceBlocks\(email\)/, 'a blocked viewer gets no bell');
  // The flag is a RENDER gate only — it must never become an authorization control.
  const actions = strip(read('lib/ar/actions.ts'));
  assert.ok(!/maintenance/i.test(actions), 'the maintenance flag must not enter the Server Action gate path');
});

// ── B4 ────────────────────────────────────────────────────────────────────────────────────────────
test('every post-await state write in the claim drawer is guarded by the current target', () => {
  const src = strip(read('components/billing-audit/ar/claim-drawer.tsx'));
  assert.match(src, /const targetRef = useRef<string \| null>\(null\)/, 'the drawer tracks its live target in a ref');
  assert.match(src, /targetRef\.current = claimId/, 'and keeps it in step with the prop');
  // The three mutating paths each re-check after their await. Un-guarded, a save on claim A that
  // resolves after the operator opened claim B repointed the drawer at A while targeted at B — and
  // the next Save wrote A's status, assignee, due date and resolution onto B.
  const guards = src.match(/targetRef\.current !== (?:id|claimId)/g) ?? [];
  assert.ok(guards.length >= 3, `reveal, submitNote and submitWork must all re-check the target (found ${guards.length})`);
  // `work` must be cleared on a claim change, or the form holds the previous claim's disposition
  // until a load replaces it — and a Save in that window writes it to the new claim.
  assert.match(src, /setWork\(\{ status: 'open', assignee: '', due: '', resolution: '' \}\)/, 'the work form resets when the claim changes');
  // The decrypted identity is keyed to its patient and rendered only on a match, so a late reveal
  // can never paint one patient's name, DOB and member id onto another patient's claim.
  assert.match(src, /setRevealed\(\{ patientId, patient: res\.patient \}\)/, 'reveal state carries the patient it belongs to');
  assert.match(src, /revealed\.patientId === c\.cmd_patient_id/, 'and is only shown when it matches the claim on screen');
});

// ── B5 ────────────────────────────────────────────────────────────────────────────────────────────
test('a failed summary load renders an ALERT and dashes, never a confident $0 or stale totals', () => {
  const html = renderToStaticMarkup(
    <AgingStrip bands={BANDS} kpi={EMPTY_KPI} selected={[]} onToggle={() => {}} loading={false} error="Something failed." />,
  );
  assert.match(html, /role="alert"/, 'the failure is announced, not silent');
  assert.match(html, /Totals unavailable/);
  assert.ok(!/Open AR ·/.test(html), 'no confident "0 claims" headline');
  assert.ok(!/\$0/.test(html), 'nothing on the strip presents a zero as a real figure');
  assert.match(html, /—/, 'the figures read as unknown');
  // The band tiles are part of the same ArSummary payload, so they are exactly as stale as the hero.
  assert.ok(!/\$1\.0K|\$3\.0K/.test(html), 'the tiles do not keep showing the previous filter\'s money');
});

test('with no error the strip shows real totals, and band shares do not depend on the band filter', () => {
  const kpi = { ...EMPTY_KPI, claims: 15, balance: '4000.00' };
  const html = renderToStaticMarkup(
    <AgingStrip bands={BANDS} kpi={kpi} selected={[]} onToggle={() => {}} loading={false} error={null} />,
  );
  assert.ok(!/role="alert"/.test(html), 'no alert on the happy path');
  assert.match(html, /15/);
  // The denominator is the sum of the BANDS, not kpi.balance. kpi.balance here is deliberately equal
  // to the band sum; the property under test is that selecting a tile (which narrows kpi.balance to
  // that band and would make it 100%) cannot move the shares.
  const narrowed = { ...EMPTY_KPI, claims: 5, balance: '3000.00' };
  const selectedHtml = renderToStaticMarkup(
    <AgingStrip bands={BANDS} kpi={narrowed} selected={['61_90']} onToggle={() => {}} loading={false} error={null} />,
  );
  const share = (s: string): string[] => (s.match(/width:\s?[\d.]+%/g) ?? []).sort();
  assert.deepEqual(share(selectedHtml), share(html), 'band shares are computed from a band-independent total');
});
