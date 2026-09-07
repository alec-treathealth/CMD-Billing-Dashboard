/**
 * Speed Insights egress scrubbing. The vitals beacon carries the FULL HREF
 * (BeforeSendEvent.url is required; route is optional), and this app's URLs carry
 * ?facility=/?payer= (ruled a re-identification vector by lib/qualify/urlState.ts's P0-4
 * header) and ?actor=<staff email>. These assert the query string cannot ride along.
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
  assert.equal(
    scrubVitalsUrl('https://billing-rcm.treathealth.ai/admin/user-logs?actor=someone%40treathealth.ai'),
    'https://billing-rcm.treathealth.ai/admin/user-logs',
  );
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
