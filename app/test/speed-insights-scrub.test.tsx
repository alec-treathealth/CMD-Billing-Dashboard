/**
 * Speed Insights egress scrubbing. The vitals beacon carries the FULL HREF
 * (BeforeSendEvent.url is required; route is optional), and this app's URLs carry
 * ?actor=<staff email> (admin/user-logs — staff PII) and ?facility=/?payer= (Qualify — classed
 * NON-PHI compose selections by lib/qualify/urlState.ts's P0-4 header, which keeps EMPLOYER out
 * of the URL precisely because the employer+facility+payer triple is the re-identification
 * vector). These assert the query string cannot ride along in either case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubVitalsUrl } from '../components/speed-insights';

test('strips the query string from a vitals href', () => {
  assert.equal(
    scrubVitalsUrl('https://billing-rcm.treathealth.ai/qualify?facility=Some%20Rehab&payer=Aetna'),
    'https://billing-rcm.treathealth.ai/qualify',
  );
});

test('strips a staff email actor param', () => {
  const out = scrubVitalsUrl('https://billing-rcm.treathealth.ai/admin/user-logs?actor=someone%40treathealth.ai');
  assert.equal(out, 'https://billing-rcm.treathealth.ai/admin/user-logs');
  // Absence asserted on the VALUE under test, not on a placeholder: no fragment of the address may
  // survive in any encoding, and neither may the key that named it. The hostname legitimately
  // contains "treathealth.ai", so that is deliberately NOT in this list.
  for (const leak of ['someone', '@', '%40', 'actor', '?']) {
    assert.ok(!out!.includes(leak), `leaked: ${leak}`);
  }
});

test('strips the real /admin/user-logs filter shape — actor, action, from, to, page', () => {
  // This is the exact query pageHref() builds (app/admin/user-logs/page.tsx:29-33): five params,
  // the staff email first. A single-param case proves the mechanism; this proves the production
  // shape, including that no OTHER key survives when the email is stripped.
  const out = scrubVitalsUrl(
    'https://billing-rcm.treathealth.ai/admin/user-logs' +
      '?actor=someone%40treathealth.ai&action=payer_alias_ruling&from=2026-09-01&to=2026-09-08&page=2',
  );
  assert.equal(out, 'https://billing-rcm.treathealth.ai/admin/user-logs');
  for (const leak of ['someone', '@', '%40', 'actor', 'action=', 'from=', 'to=', 'page=', '?', '&']) {
    assert.ok(!out!.includes(leak), `leaked: ${leak}`);
  }
});

test('strips the fragment as well as the query', () => {
  assert.equal(
    scrubVitalsUrl('https://x.treathealth.ai/dashboard?view=bxr#member-123'),
    'https://x.treathealth.ai/dashboard',
  );
});

test('preserves the pathname, which is what the metric is keyed on', () => {
  assert.equal(
    scrubVitalsUrl('https://x.treathealth.ai/dashboard/collections/explorer?a=1&b=2'),
    'https://x.treathealth.ai/dashboard/collections/explorer',
  );
});

test('a clean href is unchanged', () => {
  assert.equal(scrubVitalsUrl('https://x.treathealth.ai/login'), 'https://x.treathealth.ai/login');
});

test('an unparseable href is dropped rather than forwarded', () => {
  assert.equal(scrubVitalsUrl('not-a-url?facility=Some%20Rehab'), null);
});
