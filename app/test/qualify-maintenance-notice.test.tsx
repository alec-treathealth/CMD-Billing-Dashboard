/**
 * Qualify MAINTENANCE NOTICE — the exits are role-dependent (audit 2026-08-12, P0-7).
 *
 * THE DEFECT THIS PINS: the notice rendered "Go to Overview" / "Go to Collections" unconditionally,
 * and for a qualify-only role BOTH targets redirect straight back to /qualify (isQualifyOnlyRole →
 * redirect(QUALIFY_HOME) in the dashboard pages). Qualify is that persona's only surface, so the
 * interstitial was a closed loop with two buttons that look like ways out and are not — and the
 * component's own docblock admitted it. Zero seats are provisioned today, which makes it a trap
 * waiting for the first one rather than a live outage.
 *
 * ⚠️ .tsx on purpose: app/package.json collects `test/*.test.tsx` ONLY — a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QualifyMaintenanceNotice } from '../components/qualify/qualify-maintenance-notice';

test('a qualify-only viewer is offered NO exits — every link would bounce back here', () => {
  const html = renderToStaticMarkup(<QualifyMaintenanceNotice qualifyOnlyViewer />);
  assert.ok(!html.includes('href="/dashboard"'), 'the Overview link redirects this role back to /qualify');
  assert.ok(!html.includes('href="/dashboard/collections"'), 'so does Collections');
  assert.ok(!/<a\s/.test(html), 'no anchor at all: a dead button is worse than no button');
  // It still has to say something actionable rather than leaving a bare status.
  assert.ok(html.includes('only surface on your account'), 'names WHY there is nowhere to go');
  assert.ok(html.includes('contact your administrator'), 'and what to do instead');
});

test('a viewer WITH dashboard access keeps both working exits', () => {
  const html = renderToStaticMarkup(<QualifyMaintenanceNotice qualifyOnlyViewer={false} />);
  assert.ok(html.includes('href="/dashboard"'), 'Overview is reachable for this role');
  assert.ok(html.includes('href="/dashboard/collections"'), 'and so is Collections');
  assert.ok(!html.includes('only surface on your account'), 'no qualify-only copy for a viewer with exits');
});

test('the prop DEFAULTS to showing links — an un-updated caller must not silently lose navigation', () => {
  // Fail-open on NAVIGATION is the safe default here (unlike an authorization gate, where the safe
  // default is closed): hiding an admin's exits over a missing prop is a worse failure than showing
  // a qualify-only viewer links, which is exactly the state that shipped for months.
  const html = renderToStaticMarkup(<QualifyMaintenanceNotice />);
  assert.ok(html.includes('href="/dashboard"'));
});

test('every viewer still gets the same honest status — the rebuild message is not role-dependent', () => {
  for (const only of [true, false]) {
    const html = renderToStaticMarkup(<QualifyMaintenanceNotice qualifyOnlyViewer={only} />);
    assert.ok(html.includes('Qualify is being rebuilt'), 'the heading is the status, for everyone');
    assert.ok(html.includes('being refactored into an AI system'));
  }
});
