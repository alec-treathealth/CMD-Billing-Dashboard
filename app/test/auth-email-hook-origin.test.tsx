/**
 * Regression test for the invite/recovery link bug: the Send Email hook must build confirm links on
 * the APP's origin, never on GoTrue's email_data.site_url (which arrives as the API host,
 * https://<ref>.supabase.co/auth/v1, and produced the "No API key found" landing). appOrigin derives
 * the base from email_data.redirect_to and, as defense-in-depth, refuses any *.supabase.co origin,
 * falling back to VERCEL_PROJECT_PRODUCTION_URL.
 *
 * appOrigin is a pure function (reads only its arg + process.env), so it's testable as a leaf without
 * loading the 'use server' / next-runtime chain — matching the repo convention.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appOrigin, canonicalAppOrigin } from '../lib/auth/email-link';

const PROD = 'cmd-billing-dashboard.vercel.app';

function withProdEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (value === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  else process.env.VERCEL_PROJECT_PRODUCTION_URL = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = prev;
  }
}

test('appOrigin: returns the origin of an app redirect_to, stripping path + query', () => {
  assert.equal(
    appOrigin('https://cmd-billing-dashboard.vercel.app/auth/confirm?next=/set-password'),
    'https://cmd-billing-dashboard.vercel.app',
  );
});

test('appOrigin: a bare app origin passes through unchanged', () => {
  assert.equal(appOrigin('https://cmd-billing-dashboard.vercel.app'), 'https://cmd-billing-dashboard.vercel.app');
});

test('appOrigin: NEVER returns a *.supabase.co origin — falls back to the prod domain', () => {
  withProdEnv(PROD, () => {
    // This is the exact value GoTrue put in site_url and the bug we are guarding against.
    assert.equal(appOrigin('https://dbpabchpvipipkzkogta.supabase.co/auth/v1'), `https://${PROD}`);
  });
});

test('appOrigin: missing/invalid redirect_to falls back to VERCEL_PROJECT_PRODUCTION_URL', () => {
  withProdEnv(PROD, () => {
    assert.equal(appOrigin(undefined), `https://${PROD}`);
    assert.equal(appOrigin('not-a-url'), `https://${PROD}`);
  });
  // A prod env that already carries a scheme is not double-prefixed.
  withProdEnv('https://cmd-billing-dashboard.vercel.app', () => {
    assert.equal(appOrigin(undefined), 'https://cmd-billing-dashboard.vercel.app');
  });
});

test('appOrigin: throws when it cannot resolve an origin at all (no redirect_to, no prod env)', () => {
  withProdEnv(undefined, () => {
    assert.throws(() => appOrigin(undefined), /cannot resolve app origin/);
  });
});

function withCanonicalEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.APP_CANONICAL_ORIGIN;
  if (value === undefined) delete process.env.APP_CANONICAL_ORIGIN;
  else process.env.APP_CANONICAL_ORIGIN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.APP_CANONICAL_ORIGIN;
    else process.env.APP_CANONICAL_ORIGIN = prev;
  }
}

test('canonicalAppOrigin: defaults to the ratified prod alias when unset', () => {
  withCanonicalEnv(undefined, () => {
    assert.equal(canonicalAppOrigin(), `https://${PROD}`);
  });
});

test('canonicalAppOrigin: env override accepts a bare host, forces https, trims trailing slash', () => {
  withCanonicalEnv('app.treathealth.ai', () => {
    assert.equal(canonicalAppOrigin(), 'https://app.treathealth.ai');
  });
  withCanonicalEnv('http://app.treathealth.ai/', () => {
    assert.equal(canonicalAppOrigin(), 'https://app.treathealth.ai');
  });
  withCanonicalEnv('https://app.treathealth.ai', () => {
    assert.equal(canonicalAppOrigin(), 'https://app.treathealth.ai');
  });
});
