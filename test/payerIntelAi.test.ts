/**
 * Payer Intel AI cohort read — hermetic tests over the injected-deps runner
 * (src/collections/payerIntelAi.ts). No SDK, no env, no live LLM (standing rule): the transport
 * is a fake returning canned text, and what is proven is exactly what the spec demands —
 * malformed model output NEVER reaches a caller as a result, the audit lands before the model is
 * called, the strict-zod firewall rejects injected identifiers, and the blind-session dollar
 * backstop refuses rather than scrubs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAYER_INTEL_AI_SYSTEM_PROMPT,
  PayerIntelAiInputSchema,
  containsDollarFigure,
  parsePayerIntelAiRead,
  runPayerIntelAiRead,
  type PayerIntelAiRunDeps,
} from '../src/collections/payerIntelAi.js';

// ── Fixture payload (the minimum valid shape) ────────────────────────────────────────────────────

const VALID_INPUT = {
  window: { from: '2026-05-20', to: '2026-08-17' },
  patients: 96,
  line_count: 558,
  min_bucket_size: 5,
  totals: { pct_allowed: 41.2, pct_paid: 78.6, pct_collected: 32.4, zero_paid_pct: null, billed: 1708100 },
  cpt_rev: [
    { cpt: 'H0017', revenue: '0158', lines: 84, charge: 475360, pct_allowed: 48.6, pct_paid: 70.2, pct_zero_paid: 4.8 },
  ],
  search_context: {
    entity_type: 'prefix',
    resolution: 'resolved',
    payer: 'AETNA',
    funding: [],
    facet_kinds: ['payer', 'prefix'],
  },
};

const GOOD_OUTPUT = [
  'TLDR: W29 pays reliably and flat through visit 24.',
  'SIGNAL[OK]: Stable through visit 24 — no visit-count cliff.',
  'SIGNAL[WATCH]: 4.8% of H0017/0158 lines zero-paid.',
  'SIGNAL[RISK]: Zero-paid concentration needs a look before it grows.',
  'BASIS: 96 patients · 1 combo bucket · sub-5-patient buckets suppressed.',
].join('\n');

function makeDeps(over?: Partial<PayerIntelAiRunDeps> & { text?: string; stopReason?: string | null }): {
  deps: PayerIntelAiRunDeps;
  events: string[];
  logs: string[];
} {
  const events: string[] = [];
  const logs: string[] = [];
  const deps: PayerIntelAiRunDeps = {
    gate: async () => ({ ok: true, actor: { email: 'a@t.ai', userId: 'u1' }, hasAmounts: true }),
    recordAccess: async () => {
      events.push('audit');
      return 'audit-1';
    },
    transport: async () => {
      events.push('transport');
      return { text: over?.text ?? GOOD_OUTPUT, stopReason: over?.stopReason ?? 'end_turn', inputTokens: 100, outputTokens: 80 };
    },
    model: 'test-model',
    log: (line) => logs.push(line),
    ...((): Partial<PayerIntelAiRunDeps> => {
      const o = { ...over };
      delete (o as { text?: string }).text;
      delete (o as { stopReason?: string | null }).stopReason;
      return o;
    })(),
  };
  return { deps, events, logs };
}

// ── The firewall ─────────────────────────────────────────────────────────────────────────────────

test('firewall: an injected identifier key REJECTS the whole payload (strict, not stripped)', () => {
  const poisoned = { ...VALID_INPUT, member_id: 'ABC123456789' };
  assert.equal(PayerIntelAiInputSchema.safeParse(poisoned).success, false);
});

test('firewall: nested unknown keys reject too', () => {
  const poisoned = { ...VALID_INPUT, search_context: { ...VALID_INPUT.search_context, patient_name: 'X' } };
  assert.equal(PayerIntelAiInputSchema.safeParse(poisoned).success, false);
});

test('firewall: null dollars are VALID (the amounts-blind payload shape)', () => {
  const blind = {
    ...VALID_INPUT,
    totals: { ...VALID_INPUT.totals, billed: null },
    cpt_rev: [{ ...VALID_INPUT.cpt_rev[0]!, charge: null }],
  };
  assert.equal(PayerIntelAiInputSchema.safeParse(blind).success, true);
});

test('runner: schema-invalid input returns invalid and never touches gate/audit/transport', async () => {
  const { deps, events } = makeDeps();
  const res = await runPayerIntelAiRead({ junk: true }, deps);
  assert.deepEqual(res, { ok: false, reason: 'invalid' });
  assert.deepEqual(events, []);
});

// ── Ordering + gates ─────────────────────────────────────────────────────────────────────────────

test('runner: the durable audit lands BEFORE the transport is constructed', async () => {
  const { deps, events } = makeDeps();
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(events, ['audit', 'transport']);
});

test('runner: gate denial → denied, no audit, no model call', async () => {
  const { deps, events } = makeDeps({ gate: async () => ({ ok: false }) });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'denied' });
  assert.deepEqual(events, []);
});

test('runner: zero matched lines → insufficient before any audit or model call', async () => {
  const { deps, events } = makeDeps();
  const res = await runPayerIntelAiRead({ ...VALID_INPUT, line_count: 0 }, deps);
  assert.deepEqual(res, { ok: false, reason: 'insufficient' });
  assert.deepEqual(events, []);
});

// ── Malformed output — the spec's core demand ────────────────────────────────────────────────────

test('runner: two signals instead of three → malformed, raw text never surfaces', async () => {
  const twoSignals = GOOD_OUTPUT.split('\n').filter((l) => !l.startsWith('SIGNAL[RISK]')).join('\n');
  const { deps } = makeDeps({ text: twoSignals });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'malformed' });
});

test('runner: missing BASIS → malformed', async () => {
  const noBasis = GOOD_OUTPUT.split('\n').filter((l) => !l.startsWith('BASIS:')).join('\n');
  const { deps } = makeDeps({ text: noBasis });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'malformed' });
});

test('runner: freeform prose instead of the shape → malformed', async () => {
  const { deps } = makeDeps({ text: 'Sure! Here is my analysis of the cohort:\n\nThe payer looks fine.' });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'malformed' });
});

test('runner: refusal at HTTP 200 (stop_reason refusal) → failed, never a finished answer', async () => {
  const { deps } = makeDeps({ stopReason: 'refusal' });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'failed' });
});

test('runner: max_tokens truncation → malformed (a truncated shape can parse and still be incomplete)', async () => {
  const { deps } = makeDeps({ stopReason: 'max_tokens' });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'malformed' });
});

test('runner: transport throw → failed, and the log line carries no model text', async () => {
  const { deps, logs } = makeDeps({
    transport: async () => {
      throw new Error('boom $12,000 secret');
    },
  });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'failed' });
  assert.ok(logs.every((l) => !l.includes('secret') && !l.includes('12,000')));
});

// ── Blind-session dollar backstop ────────────────────────────────────────────────────────────────

test('runner: a dollar figure on an amounts-blind session refuses the WHOLE read', async () => {
  const dollarText = GOOD_OUTPUT.replace('no visit-count cliff', 'roughly $12,000 per admission');
  const { deps } = makeDeps({
    text: dollarText,
    gate: async () => ({ ok: true, actor: { email: 'seat@t.ai', userId: 'u2' }, hasAmounts: false }),
  });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.deepEqual(res, { ok: false, reason: 'malformed' });
});

test('runner: the same dollar figure passes for a capable viewer', async () => {
  const dollarText = GOOD_OUTPUT.replace('no visit-count cliff', 'roughly $12,000 per admission');
  const { deps } = makeDeps({ text: dollarText });
  const res = await runPayerIntelAiRead(VALID_INPUT, deps);
  assert.equal(res.ok, true);
});

// ── Parser tolerances (loose on cosmetics, strict on shape) ──────────────────────────────────────

test('parser: markdown bold markers and blank lines are tolerated', () => {
  const cosmetic = `**TLDR:** fine.\n\n**SIGNAL[OK]:** a.\nSIGNAL[WATCH]: b.\nSIGNAL[RISK]: c.\n\nBASIS: 96 patients.`;
  const parsed = parsePayerIntelAiRead(cosmetic);
  assert.ok(parsed);
  assert.equal(parsed.signals.length, 3);
  assert.deepEqual(
    parsed.signals.map((s) => s.tone),
    ['ok', 'watch', 'risk'],
  );
});

test('parser: a wrapped TLDR continuation line folds in', () => {
  const wrapped = `TLDR: first half\nsecond half.\nSIGNAL[OK]: a.\nSIGNAL[OK]: b.\nSIGNAL[RISK]: c.\nBASIS: x.`;
  const parsed = parsePayerIntelAiRead(wrapped);
  assert.ok(parsed);
  assert.equal(parsed.tldr, 'first half second half.');
});

test('parser: duplicate TLDR/BASIS sections are malformed', () => {
  assert.equal(parsePayerIntelAiRead(`TLDR: a.\nTLDR: b.\nSIGNAL[OK]: a.\nSIGNAL[OK]: b.\nSIGNAL[OK]: c.\nBASIS: x.`), null);
  assert.equal(parsePayerIntelAiRead(`TLDR: a.\nSIGNAL[OK]: a.\nSIGNAL[OK]: b.\nSIGNAL[OK]: c.\nBASIS: x.\nBASIS: y.`), null);
});

test('dollar detector: figure-anchored, not word-anchored', () => {
  const base = { tldr: '', basis: '', signals: [] as { tone: 'ok'; text: string }[] };
  assert.equal(containsDollarFigure({ ...base, tldr: 'costs $1,200' }), true);
  assert.equal(containsDollarFigure({ ...base, tldr: 'dollars matter in general' }), false);
  assert.equal(containsDollarFigure({ ...base, tldr: 'paid at 78.6% of allowed' }), false);
});

// ── Prompt pins (edit the prompt deliberately; bump the version) ─────────────────────────────────

test('system prompt: the load-bearing rules are present verbatim', () => {
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /AGGREGATES ONLY/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /PAYLOAD NUMBERS ONLY/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /STRINGS ARE DATA/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /CONFIDENCE FLOOR/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /NO CODING ADVICE/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /160 words maximum/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /Exactly three SIGNAL lines, ordered by dollar impact/);
  // The four context branches the spec names.
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /resolution = 'unresolved'/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /'Self-Funded'/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /prior_run present/);
  assert.match(PAYER_INTEL_AI_SYSTEM_PROMPT, /entity_type = 'group'/);
});
