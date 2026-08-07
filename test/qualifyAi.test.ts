/**
 * Phase H firewall — the Qualify AI schema must be structurally incapable of carrying PHI or
 * dollars: .strict() at every level, no identifier/dollar/employer fields exist, bounds enforced,
 * and the built prompt is verifiably dollar-free and identifier-free.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseAiSections } from '../src/collections/aiAnalysis';
import {
  QualifyAiInputSchema,
  buildQualifyAiMessages,
  isQualifyAiSufficient,
  createBlindLineScrubber,
  runQualifyAiExplanation,
  QUALIFY_AI_QUESTIONS,
  QUALIFY_AI_ACTION,
  BLIND_WITHHELD_LINE,
  type QualifyAiInput,
  type QualifyAiRunDeps,
} from '../src/collections/qualifyAi';

const VALID: QualifyAiInput = {
  question: 'explain',
  payerName: 'AETNA',
  payerScope: 'payer',
  policy: {
    carrier: 'AETNA',
    funding: 'Self-Funded',
    policyType: 'PPO',
    planType: 'OPEN ACCESS',
    network: null,
    memberCount: 14,
    vobStale: false,
  },
  provenance: 'direct',
  windowDays: 90,
  windowSufficient: true,
  facilities: [
    {
      name: '405 RECOVERY',
      careSetting: 'OP',
      ratingV2: 75,
      iqBand: '65',
      pctAllowedOfBilled: 62,
      distinctPatients: 22,
      lineCount: 120,
      payerCount: 1,
      medianDaysToPayment: 41,
      factors: [
        {
          key: 'claims',
          label: 'Claims reliability',
          weight: 25,
          score: 0.62,
          available: true,
          direction: 'neu',
          detail: '62% of billed allowed across 120 lines (110 confirmed-tier).',
        },
      ],
    },
  ],
  amountsBlind: false,
};

test('valid input parses; the whole shape round-trips', () => {
  const r = QualifyAiInputSchema.safeParse(VALID);
  assert.ok(r.success);
  assert.ok(isQualifyAiSufficient(r.data!));
});

test('unknown keys are REJECTED at every level — dollars and identifiers cannot ride', () => {
  for (const poisoned of [
    { ...VALID, totalBilled: 999999 }, // dollar at the top
    { ...VALID, memberId: 'AET12345678' }, // identifier at the top
    { ...VALID, policy: { ...VALID.policy!, employerName: 'ACME' } }, // employer on the policy
    { ...VALID, policy: { ...VALID.policy!, deductible: '$1,500' } }, // benefit string
    { ...VALID, facilities: [{ ...VALID.facilities[0]!, billedAmount: 123456 }] }, // dollar on a facility
    { ...VALID, facilities: [{ ...VALID.facilities[0]!, factors: [{ ...VALID.facilities[0]!.factors[0]!, dollars: 5 }] }] },
  ]) {
    assert.equal(QualifyAiInputSchema.safeParse(poisoned).success, false);
  }
});

test('bounds: facility cap 10, factor cap 6, detail length 300, window 1-366', () => {
  const many = { ...VALID, facilities: Array.from({ length: 11 }, () => VALID.facilities[0]!) };
  assert.equal(QualifyAiInputSchema.safeParse(many).success, false);
  const longDetail = {
    ...VALID,
    facilities: [{ ...VALID.facilities[0]!, factors: [{ ...VALID.facilities[0]!.factors[0]!, detail: 'x'.repeat(301) }] }],
  };
  assert.equal(QualifyAiInputSchema.safeParse(longDetail).success, false);
  assert.equal(QualifyAiInputSchema.safeParse({ ...VALID, windowDays: 0 }).success, false);
  assert.equal(QualifyAiInputSchema.safeParse({ ...VALID, windowDays: 400 }).success, false);
});

test('the built prompt carries no dollar sign and no identifier-shaped content', () => {
  const { system, user } = buildQualifyAiMessages(VALID);
  assert.ok(!user.includes('$'), 'user turn is dollar-free');
  assert.ok(!system.includes('$') || system.includes('dollar'), 'system mentions dollars only to forbid them');
  assert.match(user, /Aggregates \(JSON\)/);
  assert.match(user, /WHY does the top facility score/);
  // The framing changes with the question — each chip asks its own thing.
  const ranks = buildQualifyAiMessages({ ...VALID, question: 'ranks' });
  assert.match(ranks.user, /WHICH facility does this policy pay best/);
});

test('insufficient: no facilities AND no policy → the panel never calls the model', () => {
  assert.equal(isQualifyAiSufficient({ ...VALID, facilities: [], policy: null }), false);
  assert.equal(isQualifyAiSufficient({ ...VALID, facilities: [] }), true); // policy alone is explainable
});

// ── Chip enum + framing (2026-08-04 mockup-port additions) ──────────────────────────────────────

test('every chip id round-trips the firewall and carries its own dollar-free framing line', () => {
  const framings = new Set<string>();
  for (const question of QUALIFY_AI_QUESTIONS) {
    const parsed = QualifyAiInputSchema.safeParse({ ...VALID, question });
    assert.ok(parsed.success, `${question} parses`);
    const { user } = buildQualifyAiMessages({ ...VALID, question });
    assert.match(user, /^Question: /, `${question} is framed`);
    assert.ok(!user.includes('$'), `${question} user turn is dollar-free`);
    framings.add(user.split('\n')[0] ?? '');
  }
  // Ten distinct framings for ten chips — no chip silently reuses another's question.
  assert.equal(framings.size, QUALIFY_AI_QUESTIONS.length);
});

// ── Blind-role defensive scrubber ────────────────────────────────────────────────────────────────

test('blind scrubber: clean text passes byte-identical across arbitrary chunk seams', () => {
  let scrubs = 0;
  const s = createBlindLineScrubber(() => {
    scrubs += 1;
  });
  const parts = ['## TL;', 'DR\nAll clean here.\n## Sig', 'nals\n- 62% of billed allowed\n- 41 median days'];
  const out = parts.map((p) => s.push(p)).join('') + s.flush();
  assert.equal(out, parts.join(''));
  assert.equal(scrubs, 0);
});

test('blind scrubber: a dollar split across two deltas is caught at the line seam', () => {
  let scrubs = 0;
  const s = createBlindLineScrubber(() => {
    scrubs += 1;
  });
  const out = s.push('- roughly $') + s.push('4,200 per stay\n- clean line\n') + s.flush();
  // Withheld line replaced by a VISIBLE token (never emptied — see BLIND_WITHHELD_LINE), newline
  // kept, clean sibling intact.
  assert.equal(out, `${BLIND_WITHHELD_LINE}\n- clean line\n`);
  assert.equal(scrubs, 1);
});

test('blind scrubber: FIGURE-ADJACENT word forms trip it; the unterminated final line is scanned on flush', () => {
  const shapes: string[] = [];
  const s = createBlindLineScrubber((shape) => {
    shapes.push(shape);
  });
  assert.equal(s.push('about 5,000 dollars total\n'), `${BLIND_WITHHELD_LINE}\n`); // digit + dollars
  assert.equal(s.push('900 usd outstanding\n'), `${BLIND_WITHHELD_LINE}\n`); // digit + usd
  assert.equal(s.push('USD 900 outstanding'), ''); // held — no newline yet
  assert.equal(s.flush(), BLIND_WITHHELD_LINE); // scanned and withheld at flush
  assert.deepEqual(shapes, ['word', 'word', 'word']);
});

// The system prompt ORDERS the model to tell a blind viewer that no dollar amounts exist, so the
// bare word must NOT trip the scrub — else the compliant caveat is blanked on every blind read and
// the alert becomes noise that hides a real violation.
test('blind scrubber: the compliant "no dollar amounts" caveat survives — bare word is not a match', () => {
  let scrubs = 0;
  const s = createBlindLineScrubber(() => {
    scrubs += 1;
  });
  const compliant =
    '- No dollar amounts are available in this read, so treat it as a rate-quality signal only.\n' +
    '- Never quote dollars from this panel; verify benefits on the case.\n';
  assert.equal(s.push(compliant) + s.flush(), compliant);
  assert.equal(scrubs, 0);
});

test('blind scrubber: the sigil shape is reported distinctly from the word shape', () => {
  const shapes: string[] = [];
  const s = createBlindLineScrubber((shape) => {
    shapes.push(shape);
  });
  s.push('- about $4,200 per stay\n- and 5,000 dollars more\n');
  s.flush();
  assert.deepEqual(shapes, ['sigil', 'word']);
});

// Regression: withholding a section's ONLY body line must not corrupt the client's section split.
// Emptying it made parseAiSections' `##\s*Signals\s*\n` swallow the blank line and capture the NEXT
// header as TL;DR prose — the panel rendered the literal text "## Signals". Reproduced before the fix.
test('blind scrubber: a section whose only body line is withheld still parses into its own section', () => {
  const s = createBlindLineScrubber(() => {});
  const raw =
    '## TL;DR\nNASH is the strongest fit at 72; no $ amounts are visible to your role.\n' +
    '## Signals\n- NASH 72 (IQ 50+), 14 distinct patients.\n' +
    '## Risks\n- Thin sample.\n';
  const out = s.push(raw) + s.flush();
  const sections = parseAiSections(out);
  assert.ok(!sections['TL;DR'].includes('## Signals'), 'the next header is NOT captured as TL;DR prose');
  assert.equal(sections['TL;DR'], BLIND_WITHHELD_LINE);
  assert.equal(sections.Signals, '- NASH 72 (IQ 50+), 14 distinct patients.');
  assert.equal(sections.Risks, '- Thin sample.');
  assert.ok(!out.includes('$'));
});

// ── Orchestration core (fake deps — hermetic; no live gate/DB/Anthropic) ─────────────────────────

function makeDeps(
  chunks: string[],
  opts: { hasAmounts?: boolean; stopReason?: string | null; gateOk?: boolean; auditThrows?: boolean } = {},
) {
  const events: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const audits: Array<{
    actorEmail: string;
    actorUserId: string;
    action: string;
    detail: Record<string, unknown>;
  }> = [];
  const deps: QualifyAiRunDeps = {
    gate: async () =>
      opts.gateOk === false
        ? { ok: false }
        : { ok: true, actor: { email: 'rep@example.test', userId: 'u-1' }, hasAmounts: opts.hasAmounts ?? true },
    recordAccess: async (entry) => {
      events.push('audit');
      audits.push(entry);
      if (opts.auditThrows) throw new Error('audit unavailable');
    },
    transport: () => {
      events.push('transport');
      return {
        deltas: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
        final: async () => ({ inputTokens: 10, outputTokens: 20, stopReason: opts.stopReason ?? 'end_turn' }),
        abort: () => {
          events.push('abort');
        },
      };
    },
    model: 'test-model',
    log: (line) => logs.push(line),
  };
  return { deps, events, logs, audits };
}

async function collect(run: Awaited<ReturnType<typeof runQualifyAiExplanation>>): Promise<string> {
  if (!run.ok) throw new Error(`expected ok run, got ${JSON.stringify(run)}`);
  let out = '';
  for await (const chunk of run.deltas) out += chunk;
  return out;
}

test('core: the audit row lands BEFORE the model transport is touched — for EVERY chip id', async () => {
  for (const question of QUALIFY_AI_QUESTIONS) {
    const { deps, events, audits, logs } = makeDeps(['## TL;DR\nok\n']);
    const run = await runQualifyAiExplanation({ ...VALID, question }, deps);
    assert.ok(run.ok, `${question} runs`);
    // The action has returned; the transport has NOT been constructed yet — audit strictly first.
    assert.deepEqual(events, ['audit'], `${question}: audit precedes the stream`);
    await collect(run);
    assert.deepEqual(events, ['audit', 'transport'], `${question}: transport only on consumption`);
    assert.equal(audits[0]?.detail.question, question);
    assert.equal(audits[0]?.detail.model, 'test-model');
    const cost = logs.find((l) => l.evt === 'qualify_ai_explain_cost');
    assert.ok(cost, `${question}: cost line logged`);
    assert.equal(cost?.stop_reason, 'end_turn');
  }
});

const POISONED = [
  '## TL;DR\nStrong read at the top facility.\n',
  '## Signals\n- roughly $12,',
  '000 per admission historically\n- 62% of billed allowed on 40 patients\n',
  '## Risks\n- thin sample under 10 patients',
];

test('core: blind path — poisoned dollars scrubbed, alert line PHI-free, clean text still delivered', async () => {
  const { deps, logs } = makeDeps(POISONED, { hasAmounts: false });
  // amountsBlind:false from the client — the SERVER principal must force the blind path anyway.
  const run = await runQualifyAiExplanation({ ...VALID, amountsBlind: false }, deps);
  const out = await collect(run);
  assert.ok(!out.includes('$'), 'no dollar sign reaches the client');
  assert.ok(!/12,?000/.test(out), 'no dollar figure reaches the client');
  assert.ok(out.includes('- 62% of billed allowed on 40 patients'), 'clean sibling line survives');
  assert.ok(out.includes('## Risks'), 'section structure survives');
  assert.ok(out.includes('thin sample under 10 patients'), 'flush releases the unterminated final line');
  const alerts = logs.filter((l) => l.evt === 'qualify_ai_blind_scrub');
  assert.equal(alerts.length, 1, 'one alert per blanked line');
  assert.deepEqual(Object.keys(alerts[0] ?? {}).sort(), ['evt', 'facilities', 'question', 'shape']);
  assert.equal(alerts[0]?.facilities, 1);
  assert.equal(alerts[0]?.shape, 'sigil');
  assert.ok(!JSON.stringify(alerts[0]).includes('$'), 'the alert never echoes matched text');
  assert.ok(!/12,?000/.test(JSON.stringify(alerts[0])), 'the alert never echoes the figure');
  // The cost line keeps the ONE attribution that survives an audit failure — uuid, never the email.
  const cost = logs.find((l) => l.evt === 'qualify_ai_explain_cost');
  assert.equal(cost?.actor_user_id, 'u-1');
  assert.ok(!JSON.stringify(cost).includes('@'), 'no actor email in the ops log');
});

test('core: sighted path is byte-identical passthrough — the scrub never runs', async () => {
  const { deps, logs } = makeDeps(POISONED, { hasAmounts: true });
  const run = await runQualifyAiExplanation(VALID, deps);
  assert.equal(await collect(run), POISONED.join(''));
  assert.equal(logs.filter((l) => l.evt === 'qualify_ai_blind_scrub').length, 0);
});

test('core: an opus refusal (HTTP 200) rejects the stream instead of finishing it', async () => {
  const { deps } = makeDeps(['## TL;DR\nok\n'], { stopReason: 'refusal' });
  const run = await runQualifyAiExplanation(VALID, deps);
  await assert.rejects(() => collect(run), /qualify_ai_refusal/);
});

test('core: gate denial → unavailable; firewall reject → invalid; empty read → insufficient', async () => {
  assert.deepEqual(await runQualifyAiExplanation(VALID, makeDeps([], { gateOk: false }).deps), {
    ok: false,
    reason: 'unavailable',
  });
  assert.deepEqual(await runQualifyAiExplanation({ ...VALID, memberId: 'AET123' }, makeDeps([]).deps), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(
    await runQualifyAiExplanation({ ...VALID, facilities: [], policy: null }, makeDeps([]).deps),
    { ok: false, reason: 'insufficient' },
  );
});

test('core: the audit ROW itself is right — action key, actor, and the whole detail shape', async () => {
  const { deps, audits } = makeDeps(['## TL;DR\nok\n']);
  const run = await runQualifyAiExplanation({ ...VALID, question: 'takeit', windowDays: 180 }, deps);
  await collect(run);
  const row = audits[0];
  // The action string is the claims.access_audit QUERY KEY — renaming it silently orphans the audit
  // trail, so it is pinned to a literal here, not to the constant it comes from.
  assert.equal(row?.action, 'qualify_ai_explain');
  assert.equal(QUALIFY_AI_ACTION, 'qualify_ai_explain');
  // Attribution is the entire point of the row: it must be the SERVER principal, never a client value.
  assert.equal(row?.actorEmail, 'rep@example.test');
  assert.equal(row?.actorUserId, 'u-1');
  // Full shape — a dropped field is a silent loss of audit context, and no field may be PHI/dollars.
  assert.deepEqual(row?.detail, {
    question: 'takeit',
    provenance: 'direct',
    facilities: 1,
    window_days: 180,
    model: 'test-model',
  });
});

test('core: an early-breaking consumer aborts the upstream call (no tokens paid after abandon)', async () => {
  const { deps, events } = makeDeps(['## TL;DR\nfirst\n', '## Signals\nsecond\n']);
  const run = await runQualifyAiExplanation(VALID, deps);
  assert.ok(run.ok);
  if (!run.ok) return;
  for await (const _chunk of run.deltas) break; // client navigated away after the first delta
  assert.ok(events.includes('abort'), 'the transport was aborted, not merely abandoned');
});

test('core: an audit hiccup never blocks the non-PHI read (best-effort, preserved)', async () => {
  const { deps, events } = makeDeps(['## TL;DR\nok\n'], { auditThrows: true });
  const run = await runQualifyAiExplanation(VALID, deps);
  assert.equal(await collect(run), '## TL;DR\nok\n');
  assert.deepEqual(events, ['audit', 'transport']);
});

// ── IDENTIFIER-WIDE SCOPE reaches the model (2026-08-07) ─────────────────────────────────────────
// The explainer's whole posture is that it never narrates more confidence than the data carries. A
// null `payerName` used to mean exactly one thing ("no payer on this estimated read") and now means
// two, so the scope is stated as its own REQUIRED field rather than inferred from the null.

test('the AI payload REQUIRES an explicit payer scope — a null payerName no longer says which case it is', () => {
  const { payerScope: _drop, ...without } = VALID;
  assert.equal(QualifyAiInputSchema.safeParse(without).success, false, 'omitting the scope is rejected at the firewall');
  for (const scope of ['payer', 'all', 'none'] as const) {
    assert.equal(QualifyAiInputSchema.safeParse({ ...VALID, payerScope: scope }).success, true, scope);
  }
  assert.equal(QualifyAiInputSchema.safeParse({ ...VALID, payerScope: 'whatever' }).success, false, 'closed vocabulary');
  // The all-payers shape as the panel actually sends it: no single label, a per-card blend count.
  const allPayers = {
    ...VALID,
    payerName: null,
    payerScope: 'all' as const,
    facilities: VALID.facilities.map((f) => ({ ...f, payerCount: 4 })),
  };
  assert.equal(QualifyAiInputSchema.safeParse(allPayers).success, true);
  // payerCount is a COUNT of labels behind a card — never 0, because a card that exists has rows.
  assert.equal(
    QualifyAiInputSchema.safeParse({ ...VALID, facilities: VALID.facilities.map((f) => ({ ...f, payerCount: 0 })) }).success,
    false,
  );
});

test('the system prompt forbids narrating a blended percentage as one payer’s rate', () => {
  // ⚠ Simpson's paradox is the risk this instruction exists for: with payerScope "all" a facility's
  // allowed-of-billed is dollar-weighted across payerCount labels, so it can read strong overall and
  // weak under the one label that matters to the client on the phone. The model is told to say so,
  // and told where the un-blend control is.
  const { system, user } = buildQualifyAiMessages({
    ...VALID,
    payerName: null,
    payerScope: 'all',
    facilities: VALID.facilities.map((f) => ({ ...f, payerCount: 4 })),
  });
  assert.match(system, /payerScope "all"/);
  assert.match(system, /BLEND across payerCount labels/);
  assert.match(system, /never call a blended percentage a payer's rate/);
  assert.match(system, /BILLED UNDER chips/);
  // And the scope really rides in the JSON the model reads, not only in the instructions.
  assert.match(user, /"payerScope":"all"/);
  assert.match(user, /"payerCount":4/);
});
