/**
 * THE MAINTENANCE BYPASS ALLOWLIST and the two gates that read it (Alec, 2026-08-18: put a
 * maintenance page on Payer Intel and Claims Desk for everyone except alec + ryan).
 *
 * This is a gate whose failure mode is SILENT IN BOTH DIRECTIONS — a typo'd address locks the owner
 * out with no error, and a missed edit leaves a surface open with no error. Neither shows up
 * anywhere except by someone loading the page. So it gets tested as data, not as a rendering.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would "pass"
 * by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bypassesMaintenance, MAINTENANCE_BYPASS_LIST } from '../lib/maintenance-bypass';
import { payerIntelMaintenanceBlocks } from '../lib/payer-intel/maintenance';
import { claimsAuditMaintenanceBlocks } from '../lib/billing-audit/maintenance';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

// -- 1. Who is on the list --------------------------------------------------------------------

test('exactly the two intended addresses bypass, and nobody else', () => {
  assert.deepEqual([...MAINTENANCE_BYPASS_LIST].sort(), ['alec@treathealth.ai', 'ryan@treathealth.ai']);
  assert.equal(bypassesMaintenance('alec@treathealth.ai'), true);
  assert.equal(bypassesMaintenance('ryan@treathealth.ai'), true);
  assert.equal(bypassesMaintenance('someone.else@treathealth.ai'), false);
});

test('THE TYPO DOES NOT BYPASS — treatheath is not treathealth', () => {
  // ⚠ The request that created this list spelled it `alec@treatheath.ai`, missing the `l`. Encoding
  // that would have locked the owner out of both surfaces he was granting himself, and the failure
  // is SILENT: a wrong address just quietly does not match. One character, no feedback loop.
  assert.equal(bypassesMaintenance('alec@treatheath.ai'), false);
  assert.ok(!MAINTENANCE_BYPASS_LIST.includes('alec@treatheath.ai'));
});

test('matching is case- and whitespace-insensitive, because identity providers are not tidy', () => {
  assert.equal(bypassesMaintenance('  Alec@TreatHealth.AI '), true);
  assert.equal(bypassesMaintenance('RYAN@TREATHEALTH.AI'), true);
});

test('an absent email is blocked, not bypassed — fail closed', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(bypassesMaintenance(v), false, `"${String(v)}" must not bypass`);
  }
});

// -- 2. Both gates read the same list ---------------------------------------------------------

test('Payer Intel and Claims Desk block and allow the SAME people', () => {
  // The point of sharing the list: someone added for one surface cannot silently be missing from
  // the other. Asserting agreement is what makes that guarantee real rather than aspirational.
  delete process.env.PAYER_INTEL_MAINTENANCE;
  delete process.env.CLAIMS_AUDIT_MAINTENANCE;
  for (const email of ['alec@treathealth.ai', 'ryan@treathealth.ai', 'nobody@treathealth.ai', null]) {
    assert.equal(
      payerIntelMaintenanceBlocks(email),
      claimsAuditMaintenanceBlocks(email),
      `the two gates disagree about ${String(email)}`,
    );
  }
});

test('both gates are ON by default and the kill switch turns them off', () => {
  delete process.env.PAYER_INTEL_MAINTENANCE;
  assert.equal(payerIntelMaintenanceBlocks('nobody@treathealth.ai'), true, 'on by default');
  for (const off of ['0', 'false', 'off', 'OFF', ' Off ']) {
    process.env.PAYER_INTEL_MAINTENANCE = off;
    assert.equal(payerIntelMaintenanceBlocks('nobody@treathealth.ai'), false, `"${off}" must disable`);
  }
  // Anything else means ON — the switch must not be disabled by a typo'd value.
  process.env.PAYER_INTEL_MAINTENANCE = 'no';
  assert.equal(payerIntelMaintenanceBlocks('nobody@treathealth.ai'), true, 'only the three words disable it');
  delete process.env.PAYER_INTEL_MAINTENANCE;
});

// -- 3. Where the gates are wired -------------------------------------------------------------

test('the Payer Intel gate runs AFTER the role gate, never before', () => {
  // Order is an information-disclosure decision. Checking maintenance first would render the notice
  // for an entity admin/user who is not entitled to the surface at all — telling them a tab exists
  // that they may never see, instead of redirecting them as they are redirected today.
  const src = read('../app/payer-intel/page.tsx');
  const roleGate = src.indexOf("if (!principal.ok) redirect('/dashboard');");
  const maint = src.indexOf('payerIntelMaintenanceBlocks(');
  assert.ok(roleGate > 0 && maint > roleGate, 'the role gate must come first');
  // And before the board fetch, so a blocked viewer never triggers those queries.
  assert.ok(maint < src.indexOf('getPayerIntelBoardCore('), 'blocked viewers must not hit the data path');
});

test('BOTH Claims Desk routes are gated, not just the index', () => {
  // ⚠ /billing-audit/facility-resolution was ungated until 2026-08-18, so a viewer held out of the
  // tab could still reach that workbench by typing its URL. A maintenance notice is a per-TAB
  // decision; gating one of a tab's two routes leaves the tab half open.
  for (const p of ['../app/billing-audit/page.tsx', '../app/billing-audit/facility-resolution/page.tsx']) {
    assert.match(read(p), /claimsAuditMaintenanceBlocks\(/, `${p} must be gated`);
  }
});

test('the notice omits its links for the persona that has nowhere to go', () => {
  // admissions_seat's ONLY nav link is /payer-intel (navLinksFor), so "Go to Overview" would send
  // them through a redirect straight back — a broken app rather than a paused tab.
  const page = read('../app/payer-intel/page.tsx');
  assert.match(page, /hasFullDashboard=\{access\.access\.role !== 'admissions_seat'\}/);
  const notice = read('../components/payer-intel/maintenance-notice.tsx');
  assert.match(notice, /\{hasFullDashboard && \(/, 'the links are conditional, not unconditional');
});

test('Qualify keeps its own list — this must not silently widen it', () => {
  // Folding Qualify in would grant it to whoever is added for Claims Desk or Payer Intel, which is
  // a different decision with a different history. Pinned so the "tidy-up" is a deliberate act.
  assert.doesNotMatch(read('../lib/qualify/maintenance.ts'), /maintenance-bypass/);
});
