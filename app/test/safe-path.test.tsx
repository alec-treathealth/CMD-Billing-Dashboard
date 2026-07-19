/**
 * safeInternalPath bounds the invite "set up on mobile/web" destination that is threaded through
 * /auth/confirm → /set-password: only app-relative paths pass, never an absolute or protocol-relative
 * URL (which would let the post-auth redirect leave our origin). Pure leaf — no runtime chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeInternalPath } from '../lib/auth/safe-path';

test('safeInternalPath: an app-relative path passes through', () => {
  assert.equal(safeInternalPath('/qualify/m'), '/qualify/m');
  assert.equal(safeInternalPath('/qualify'), '/qualify');
});

test('safeInternalPath: query + hash are preserved', () => {
  assert.equal(safeInternalPath('/qualify/m?welcome=1'), '/qualify/m?welcome=1');
  assert.equal(safeInternalPath('/dashboard#top'), '/dashboard#top');
});

test('safeInternalPath: protocol-relative ("//host") is rejected', () => {
  assert.equal(safeInternalPath('//evil.example.com'), null);
  assert.equal(safeInternalPath('//evil.example.com/qualify/m'), null);
});

test('safeInternalPath: absolute URLs are rejected', () => {
  assert.equal(safeInternalPath('https://evil.example.com/qualify/m'), null);
  assert.equal(safeInternalPath('http://cmd-billing-dashboard.vercel.app/qualify/m'), null);
});

test('safeInternalPath: empty / relative / non-string values are rejected', () => {
  assert.equal(safeInternalPath(''), null);
  assert.equal(safeInternalPath('qualify/m'), null);
  assert.equal(safeInternalPath(null), null);
  assert.equal(safeInternalPath(undefined), null);
  assert.equal(safeInternalPath(42), null);
  // A FormData File-like value (never a string) must not be treated as a path.
  assert.equal(safeInternalPath({ name: 'x' }), null);
});
