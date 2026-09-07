/**
 * Payer-alias ruling — the ACTION CHAIN end to end (hermetic; fake db, fake recordAccess, no net).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT TESTING ruling-actions.ts DIRECTLY ───────────────────
 * `ruling-actions.ts` is a `'use server'` module importing `@/lib/access`, which calls React
 * `cache()`. Importing it outside a Next request throws `TypeError: (0, import_react.cache) is not a
 * function` — verified 2026-09-07. So the chain was moved to `./rule.ts` (no Next, no React,
 * dependencies injected) and the action reduced to gate → delegate → revalidate. `executeRuling` is
 * everything the action does after the gate, so exercising it here IS exercising the action's
 * behaviour, not a validator in isolation.
 *
 * Covers Qodo #335 findings 1 and 4.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeRuling, type RulingDeps, type RulingFormInput } from '../lib/payer-alias/rule';
import { defaultRulingRelationship } from '../../src/collections/payerAliasQueue';

const PRINCIPAL = { email: 'alec@treathealth.ai', userId: 'usr_1' };

interface Call { sql: string; params: readonly unknown[] }

/**
 * A fake reader routed by SQL shape. `containment` is what the pre-check returns; `ruling` is what
 * the definer call returns, or an Error to throw (a driver error carries `.code`).
 */
function deps(opts: {
  containment?: { rowNeedsReview: boolean | null; canonicalActive: boolean | null };
  ruling?: { ruling_id: string } | Error;
  recordAccess?: () => Promise<string>;
} = {}): { deps: RulingDeps; calls: Call[]; audits: Array<Record<string, unknown>> } {
  const calls: Call[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const containment = opts.containment ?? { rowNeedsReview: true, canonicalActive: true };
  const ruling = opts.ruling ?? { ruling_id: '42' };
  return {
    calls,
    audits,
    deps: {
      db: {
        async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
          calls.push({ sql, params });
          if (sql.includes('rule_payer_alias')) {
            if (ruling instanceof Error) throw ruling;
            return { rows: [ruling] as T[] };
          }
          return { rows: [containment] as T[] };
        },
      },
      recordAccess:
        opts.recordAccess ??
        (async (entry) => {
          audits.push(entry as unknown as Record<string, unknown>);
          return 'audit_1';
        }),
    },
  };
}

const input = (over: Partial<RulingFormInput> = {}): RulingFormInput => ({
  vocabulary: 'claims_primary_payer',
  aliasNorm: 'ANTHEM BCBS GA',
  action: 'confirm',
  relationship: 'same_payer',
  canonicalPayerId: 'pi_anthem_georgia',
  reviewNote: null,
  ...over,
});

const definerCalled = (calls: Call[]) => calls.some((c) => c.sql.includes('rule_payer_alias'));

/* ── Baseline: the happy path actually reaches the definer and the audit ─────────────────────────── */

test('a well-formed confirm calls the definer once and returns its ruling id', async () => {
  const { deps: d, calls, audits } = deps();
  const r = await executeRuling(d, PRINCIPAL, input());
  assert.deepEqual(r, { ok: true, rulingId: '42' });
  assert.equal(calls.filter((c) => c.sql.includes('rule_payer_alias')).length, 1, 'exactly one write');
  assert.equal(audits.length, 1);
});

/* ── F1 (Qodo #335 finding 1) — a mismatched override is rejected THROUGH THE ACTION ─────────────── */

test('F1: relationship=unmapped WITH a canonical is rejected by the action, and never reaches the definer', async () => {
  const { deps: d, calls } = deps();
  const r = await executeRuling(d, PRINCIPAL, input({ relationship: 'unmapped', canonicalPayerId: 'pi_cigna' }));

  assert.equal(r.ok, false);
  assert.equal(r.field, 'canonicalPayerId');
  assert.match(r.error, /must not carry a canonical payer/i);
  // The TS containment catches it FIRST — the definer's own 22023 is the backstop, not the mechanism.
  // Asserting the write never happened is what proves containment is doing the work.
  assert.equal(definerCalled(calls), false, 'a mis-paired ruling must not reach the database');
});

test('F1: same_payer WITHOUT a canonical is rejected the same way, and never reaches the definer', async () => {
  const { deps: d, calls } = deps();
  const r = await executeRuling(d, PRINCIPAL, input({ relationship: 'same_payer', canonicalPayerId: null }));
  assert.equal(r.ok, false);
  assert.equal(r.field, 'canonicalPayerId');
  assert.equal(definerCalled(calls), false);
});

test("F1: if containment were bypassed, the definer's raise still surfaces as {ok:false}", async () => {
  // Belt and braces: the database is the authority even though TS should never let this through.
  // A 22023 from ref.rule_payer_alias must become a clean {ok:false}, never an unhandled throw.
  const err = Object.assign(new Error('rule_payer_alias: unmapped must not carry a canonical payer'), {
    code: '22023',
  });
  const { deps: d } = deps({ ruling: err });
  const r = await executeRuling(d, PRINCIPAL, input());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The ruling could not be saved right now.');
  // The raw driver message must not reach the client — it can echo bound parameters.
  assert.equal(r.error.includes('rule_payer_alias'), false);
});

test('F1: the form default is the ROW’s relationship, not a hard-coded same_payer', () => {
  // The regression this guards: the page passed only the canonical, the form substituted same_payer,
  // and a carve_out proposal confirmed as same_payer. 36 confirmed rows carry carve_out today.
  for (const r of ['same_payer', 'carve_out', 'tpa', 'employer_self_funded', 'program_label', 'unmapped']) {
    assert.equal(defaultRulingRelationship(r), r, `${r} must survive as the default`);
  }
  // Only a value outside the union falls back — the CHECK should make that unreachable.
  assert.equal(defaultRulingRelationship('nonsense'), 'same_payer');
  assert.equal(defaultRulingRelationship(null), 'same_payer');
  assert.equal(defaultRulingRelationship(undefined), 'same_payer');
});

test('F1: a carve_out proposal survives the whole chain to the definer parameters', async () => {
  const { deps: d, calls } = deps();
  const r = await executeRuling(d, PRINCIPAL, input({ relationship: 'carve_out', canonicalPayerId: 'pi_optum' }));
  assert.equal(r.ok, true);
  const write = calls.find((c) => c.sql.includes('rule_payer_alias'));
  assert.ok(write);
  // params: [vocabulary, aliasNorm, action, relationship, canonical, note, ruledBy]
  assert.equal(write.params[3], 'carve_out', 'the relationship reached the database unaltered');
  assert.equal(write.params[4], 'pi_optum');
});

/* ── F4 (Qodo #335 finding 4) — a committed ruling is never reported as a failure ─────────────────── */

test('F4: recordAccess rejecting does NOT turn a committed ruling into a failure', async () => {
  const { deps: d, calls } = deps({
    recordAccess: async () => {
      throw new Error('claims.log_access returned no id');
    },
  });
  const r = await executeRuling(d, PRINCIPAL, input());

  // The ruling COMMITTED — ref.rule_payer_alias returned and its domain audit row is the durable
  // record. Reporting {ok:false} here would leave the client un-refreshed and send the reviewer into
  // a retry that hits "already ruled".
  assert.deepEqual(r, { ok: true, rulingId: '42' });
  assert.equal(calls.filter((c) => c.sql.includes('rule_payer_alias')).length, 1);
});

test('F4: the access-audit failure is LOGGED, not silently swallowed', async () => {
  const seen: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void seen.push(args);
  try {
    const { deps: d } = deps({
      recordAccess: async () => {
        throw new Error('boom');
      },
    });
    await executeRuling(d, PRINCIPAL, input());
  } finally {
    console.error = original;
  }
  const flat = seen.map((a) => JSON.stringify(a)).join(' ');
  assert.match(flat, /access audit failed/i, 'an operator must be able to see the hole in the trail');
});

test('F4: a DEFINER failure is still a failure — best-effort applies only to the access line', async () => {
  const err = Object.assign(new Error('nope'), { code: '25000' });
  const { deps: d, audits } = deps({ ruling: err });
  const r = await executeRuling(d, PRINCIPAL, input());
  assert.equal(r.ok, false);
  assert.equal(audits.length, 0, 'no access line for a ruling that never landed');
});

test('F4: a P0002 race is reported as a race, not as a generic failure', async () => {
  const err = Object.assign(new Error('no unruled row'), { code: 'P0002' });
  const { deps: d } = deps({ ruling: err });
  const r = await executeRuling(d, PRINCIPAL, input());
  assert.equal(r.ok, false);
  assert.equal(r.field, 'alias');
  assert.match(r.error, /already ruled|a moment ago/i);
});

/* ── The audit detail must never carry alias_norm ─────────────────────────────────────────────────── */

test('the access-audit detail carries no alias_norm, in any field', async () => {
  const EMPLOYER = 'ACME MANUFACTURING EMPLOYEE HEALTH PLAN';
  const { deps: d, audits } = deps();
  await executeRuling(d, PRINCIPAL, input({ aliasNorm: EMPLOYER }));
  assert.equal(audits.length, 1);
  const blob = JSON.stringify(audits[0]);
  assert.equal(blob.includes('ACME'), false, `alias_norm leaked into the access audit: ${blob}`);
  assert.ok(blob.includes('ruling_audit_id'), 'the join key to the domain record must be present');
});

/* ── Containment still short-circuits before the write ────────────────────────────────────────────── */

test('an already-ruled row is refused before the definer is called', async () => {
  const { deps: d, calls } = deps({ containment: { rowNeedsReview: false, canonicalActive: true } });
  const r = await executeRuling(d, PRINCIPAL, input());
  assert.equal(r.ok, false);
  assert.equal(r.field, 'alias');
  assert.equal(definerCalled(calls), false);
});

test('a retired canonical is refused before the definer is called', async () => {
  const { deps: d, calls } = deps({ containment: { rowNeedsReview: true, canonicalActive: false } });
  const r = await executeRuling(d, PRINCIPAL, input());
  assert.equal(r.ok, false);
  assert.equal(r.field, 'canonicalPayerId');
  assert.equal(definerCalled(calls), false);
});

test('unknown keys are rejected by .strict() — a forged ruledBy cannot ride along', async () => {
  const { deps: d, calls } = deps();
  const r = await executeRuling(d, PRINCIPAL, {
    ...input(),
    ruledBy: 'someone.else@example.com',
  } as unknown as RulingFormInput);
  assert.equal(r.ok, false);
  assert.equal(definerCalled(calls), false);
});

test('attribution comes from the principal, never from the payload', async () => {
  const { deps: d, calls, audits } = deps();
  await executeRuling(d, PRINCIPAL, input());
  const write = calls.find((c) => c.sql.includes('rule_payer_alias'));
  assert.equal(write?.params[6], PRINCIPAL.email, 'ruledBy must be the session principal');
  assert.equal(audits[0]?.actorEmail, PRINCIPAL.email);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * F1 WIRING — the half no runtime test can reach.
 *
 * The mutation battery found a hole: reverting the form to `relationship: 'same_payer'` passed all
 * fifteen tests AND both typechecks. The page→form prop is guarded by tsc (it is required), and the
 * default LOGIC is guarded by initialRulingState's unit tests — but the form simply IGNORING the
 * prop was invisible, and that is precisely the bug Qodo reported.
 *
 * It cannot be caught by rendering: PayerAliasRulingForm calls `useRouter`, which throws outside a
 * Next router context, so renderToStaticMarkup cannot mount it and this repo has no module-mocking
 * harness. So the wiring is pinned at the source level. That is deliberate and narrow — it asserts
 * one call site, not formatting.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

test('F1 wiring: the form computes its opening state via initialRulingState, never inline', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../components/admin/payer-alias-ruling-form.tsx', import.meta.url),
    'utf8',
  );
  // The state initializer must delegate, and must be handed BOTH halves of the row's proposal.
  assert.match(
    src,
    /useState<RulingFormState>\(\s*initialRulingState\(proposedRelationship,\s*proposedCanonicalId\),?\s*\)/,
    'the form must initialise through initialRulingState(proposedRelationship, proposedCanonicalId)',
  );
  // And must not resurrect a hard-coded relationship in that initializer.
  assert.equal(
    /relationship:\s*['"]/.test(src),
    false,
    'a quoted relationship literal reappeared in the form — that is the Qodo #335 finding 1 regression',
  );
});

test('F1 wiring: initialRulingState carries BOTH halves of the proposal through', async () => {
  const { initialRulingState } = await import('../components/admin/payer-alias-leaves');
  assert.deepEqual(initialRulingState('carve_out', 'pi_optum'), {
    action: 'confirm',
    relationship: 'carve_out',
    canonicalPayerId: 'pi_optum',
    reviewNote: '',
  });
  assert.deepEqual(initialRulingState('unmapped', null), {
    action: 'confirm',
    relationship: 'unmapped',
    canonicalPayerId: '',
    reviewNote: '',
  });
  // A drifted value falls back rather than crashing the form.
  assert.equal(initialRulingState('nonsense', null).relationship, 'same_payer');
});
