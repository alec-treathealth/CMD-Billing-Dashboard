/**
 * Hermetic tests for the census-cron env preflight. Pure leaf — no pg, no libsodium, no PHI.
 * The helper only inspects process.env, so we mutate it inside each test and restore in a finally.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRequiredEnvVars } from '../lib/env-preflight';

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('assertRequiredEnvVars: passes silently when every var is set', () => {
  withEnv(
    {
      PREFLIGHT_TEST_A: 'a-value',
      PREFLIGHT_TEST_B: 'b-value',
    },
    () => {
      assert.doesNotThrow(() =>
        assertRequiredEnvVars('cmd-census', ['PREFLIGHT_TEST_A', 'PREFLIGHT_TEST_B']),
      );
    },
  );
});

test('assertRequiredEnvVars: passes on an empty required list', () => {
  assert.doesNotThrow(() => assertRequiredEnvVars('cmd-census', []));
});

test('assertRequiredEnvVars: throws when a required var is undefined', () => {
  withEnv({ PREFLIGHT_TEST_A: undefined }, () => {
    assert.throws(
      () => assertRequiredEnvVars('cmd-census', ['PREFLIGHT_TEST_A']),
      /cmd-census cron missing required env: PREFLIGHT_TEST_A/,
    );
  });
});

test('assertRequiredEnvVars: treats empty and whitespace-only as missing', () => {
  withEnv({ PREFLIGHT_TEST_A: '', PREFLIGHT_TEST_B: '   \t\n' }, () => {
    assert.throws(
      () => assertRequiredEnvVars('cmd-census', ['PREFLIGHT_TEST_A', 'PREFLIGHT_TEST_B']),
      /PREFLIGHT_TEST_A, PREFLIGHT_TEST_B/,
    );
  });
});

test('assertRequiredEnvVars: names EVERY missing var in one error, not just the first', () => {
  withEnv(
    { PREFLIGHT_TEST_A: undefined, PREFLIGHT_TEST_B: 'set', PREFLIGHT_TEST_C: undefined },
    () => {
      try {
        assertRequiredEnvVars('indigo-census', [
          'PREFLIGHT_TEST_A',
          'PREFLIGHT_TEST_B',
          'PREFLIGHT_TEST_C',
        ]);
        assert.fail('expected throw');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Must list both missing names AND the tenant label; must NOT list the set one.
        assert.match(msg, /indigo-census/);
        assert.match(msg, /PREFLIGHT_TEST_A/);
        assert.match(msg, /PREFLIGHT_TEST_C/);
        assert.doesNotMatch(msg, /PREFLIGHT_TEST_B/);
      }
    },
  );
});

test('assertRequiredEnvVars: error message never contains env VALUES (PHI/log posture)', () => {
  const secret = 'super-secret-value-that-should-never-log';
  withEnv({ PREFLIGHT_TEST_A: secret, PREFLIGHT_TEST_B: undefined }, () => {
    try {
      assertRequiredEnvVars('cmd-census', ['PREFLIGHT_TEST_A', 'PREFLIGHT_TEST_B']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.doesNotMatch(msg, new RegExp(secret));
    }
  });
});
