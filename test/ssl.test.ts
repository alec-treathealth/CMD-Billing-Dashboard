/**
 * Hermetic tests for src/ssl.ts `sanitizeConnectionString` — the guard against the
 * node-postgres footgun where a `sslmode` query param in the connection string
 * overrides the explicit `ssl: verifyFullSsl()` object and silently drops the `ca`
 * (causing `self-signed certificate in certificate chain`). No DB, no network.
 *
 * The regression test constructs a pg Client (which does NOT connect) and inspects
 * its resolved ssl config, locking in the exact bug that broke the cmd-explorer cron.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { sanitizeConnectionString } from '../src/ssl.js';

test('strips sslmode, preserves base and other query params', () => {
  const out = sanitizeConnectionString(
    'postgresql://u:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&application_name=x',
  );
  assert.equal(out, 'postgresql://u:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres?application_name=x');
});

test('strips both sslmode and ssl params', () => {
  const out = sanitizeConnectionString('postgresql://u:pw@h:6543/db?ssl=true&sslmode=require');
  assert.equal(out, 'postgresql://u:pw@h:6543/db');
});

test('strips sslrootcert/sslcert/sslkey (these also make pg build an overriding ssl object)', () => {
  assert.equal(
    sanitizeConnectionString('postgresql://u:pw@h:6543/db?sslrootcert=/etc/x.crt'),
    'postgresql://u:pw@h:6543/db',
  );
  assert.equal(
    sanitizeConnectionString('postgresql://u:pw@h:6543/db?sslcert=/c.crt&sslkey=/k.key&application_name=z'),
    'postgresql://u:pw@h:6543/db?application_name=z',
  );
});

test('does NOT mangle a password with URL-special characters', () => {
  // base (userinfo/host/path) must come back byte-for-byte — no re-encoding.
  const base = 'postgresql://cmd_rollup_writer_login.ref:Cmd%40RW_2026!xK9@aws-1-us-west-1.pooler.supabase.com:6543/postgres';
  assert.equal(sanitizeConnectionString(`${base}?sslmode=verify-full`), base);
});

test('no-op when there is no query string', () => {
  const url = 'postgresql://u:pw@h:6543/postgres';
  assert.equal(sanitizeConnectionString(url), url);
});

test('no-op when query has no sslmode/ssl', () => {
  const url = 'postgresql://u:pw@h:6543/postgres?application_name=claims-query';
  assert.equal(sanitizeConnectionString(url), url);
});

test('regression: pg keeps the explicit ca when the connection string is sanitized', () => {
  const FAKE_CA = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----';
  const raw = 'postgresql://u:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres?sslmode=verify-full';

  // `connectionParameters` is pg-internal (not in the public types) — read it via a cast.
  const sslOf = (c: pg.Client): { ca?: string } | boolean =>
    (c as unknown as { connectionParameters: { ssl: { ca?: string } | boolean } }).connectionParameters.ssl;

  // Control: WITHOUT sanitizing, pg parses sslmode and overrides our ssl -> ca dropped.
  const dropped = new pg.Client({ connectionString: raw, ssl: { rejectUnauthorized: true, ca: FAKE_CA } });
  const droppedSsl = sslOf(dropped);
  assert.equal(typeof droppedSsl === 'object' && !!droppedSsl.ca, false, 'control: ca should be dropped without sanitize');

  // Sanitized: our explicit ssl (with ca) survives — and verify-full stays on.
  const kept = new pg.Client({ connectionString: sanitizeConnectionString(raw), ssl: { rejectUnauthorized: true, ca: FAKE_CA } });
  const keptSsl = sslOf(kept) as { ca?: string; rejectUnauthorized?: boolean };
  assert.equal(typeof keptSsl === 'object' && keptSsl.ca, FAKE_CA, 'sanitized: ca must survive');
  assert.equal(typeof keptSsl === 'object' && keptSsl.rejectUnauthorized, true, 'sanitized: verify-full (rejectUnauthorized) must stay on');
});
