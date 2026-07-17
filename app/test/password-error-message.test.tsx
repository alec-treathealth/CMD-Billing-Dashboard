/**
 * setPassword surfaces WHY an updateUser({ password }) call was rejected instead of a dead-end
 * generic error. GoTrue returns 422 / code 'weak_password' with reasons ("length"|"characters"|
 * "pwned"); this project has leaked-password protection on, so 'pwned' is the common case.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passwordUpdateErrorMessage } from '../lib/auth/password';

test('pwned password → breach-specific guidance', () => {
  const msg = passwordUpdateErrorMessage({ code: 'weak_password', status: 422, reasons: ['pwned'] });
  assert.match(msg, /known data breach/i);
  assert.match(msg, /unique/i);
});

test('length/characters reasons → requirements guidance, not the breach copy', () => {
  const msg = passwordUpdateErrorMessage({ code: 'weak_password', status: 422, reasons: ['length'] });
  assert.match(msg, /at least 8 characters/i);
  assert.doesNotMatch(msg, /data breach/i);
});

test('weak_password with no reasons → generic weak-password guidance', () => {
  const msg = passwordUpdateErrorMessage({ code: 'weak_password', status: 422 });
  assert.match(msg, /too common or appear in a known data breach/i);
});

test('a bare 422 (no code/reasons) is still treated as a weak password', () => {
  assert.match(passwordUpdateErrorMessage({ status: 422 }), /can’t be used/i);
});

test('a non-password failure falls back to the neutral retry message', () => {
  const msg = passwordUpdateErrorMessage({ code: 'session_not_found', status: 401 });
  assert.equal(msg, 'Could not set your password. Please try again.');
});
