import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CollectionsAiInputSchema,
  SELECTION_MIN_CHARGES,
  isSufficientForAi,
  buildAiMessages,
  parseAiSections,
  INSUFFICIENT_COPY,
  AI_SECTIONS,
  AI_MAX_TOKENS,
  AI_TRUNCATED_MARK,
  splitAiStream,
  type CollectionsAiInput,
} from '../src/collections/aiAnalysis.js';

const baseSelection: CollectionsAiInput = {
  mode: 'selection',
  yield_pct: { pct_allowed: 42.5, pct_paid: 70, pct_collected: 29.75 },
  scope: { charge_lines: 100, total_charge: 100000, total_allowed: 42500, total_paid: 29750, total_balance: 12000 },
  top_payers: [{ name: 'AETNA', count: 40, charge: 50000 }],
  top_facilities: [{ name: 'DALLAS MENTAL HEALTH LLC', count: 60, charge: 60000 }],
  top_cpt_rev: [{ cpt: '90837', revenue: '0900', lines: 30, pct_allowed: 45, pct_paid: 72 }],
};

const baseCohort: CollectionsAiInput = {
  mode: 'cohort',
  yield_pct: { pct_allowed: 33.11, pct_paid: 76.09, pct_collected: 25.19 },
  scope: { charge_lines: 800, total_charge: 500000, total_paid: 126000, total_balance: 60000, cohort_patients: 42 },
  top_payers: [{ name: 'BCBS', count: 300, charge: 250000 }],
  top_facilities: [{ name: 'HOUSTON BH', count: 500, charge: 300000 }],
  top_cpt_rev: [{ cpt: '90853', revenue: '0915', lines: 200, pct_allowed: 30, pct_paid: 74 }],
  series: {
    by_visit: [{ bucket: 1, patients: 42, charge_lines: 42, pct_allowed: 40, pct_paid: 80 }],
    by_days: [{ bucket: 0, patients: 42, charge_lines: 42, pct_allowed: 40, pct_paid: 80 }],
  },
};

test('PHI firewall: strict schema strips/rejects unknown keys (no member id / prefix / name can ride in)', () => {
  const withPhi = {
    ...baseSelection,
    member_id: 'PGE081', // attacker-injected PHI-adjacent fields
    alpha_prefix: 'PGE',
    patient_name: 'DOE, JANE',
  };
  const parsed = CollectionsAiInputSchema.safeParse(withPhi);
  // .strict() REJECTS unknown keys outright — the object never reaches the model.
  assert.equal(parsed.success, false);
});

test('PHI firewall: a clean aggregate parses and carries only allowlisted fields', () => {
  const parsed = CollectionsAiInputSchema.safeParse(baseCohort);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(Object.keys(parsed.data).sort(), [
      'mode',
      'scope',
      'series',
      'top_cpt_rev',
      'top_facilities',
      'top_payers',
      'yield_pct',
    ]);
  }
});

test('sufficiency gate — selection mode: needs >= SELECTION_MIN_CHARGES lines AND total_allowed > 0', () => {
  assert.equal(isSufficientForAi({ ...baseSelection, scope: { ...baseSelection.scope, charge_lines: SELECTION_MIN_CHARGES } }), true);
  // one under the line floor → insufficient
  assert.equal(
    isSufficientForAi({ ...baseSelection, scope: { ...baseSelection.scope, charge_lines: SELECTION_MIN_CHARGES - 1 } }),
    false,
  );
  // enough lines but zero-allowed scalar → insufficient (no %-allowed/%-paid story to tell)
  assert.equal(isSufficientForAi({ ...baseSelection, scope: { ...baseSelection.scope, total_allowed: 0 } }), false);
  // absent total_allowed (defensive) → insufficient
  const { total_allowed: _omit, ...scopeNoAllowed } = baseSelection.scope;
  assert.equal(isSufficientForAi({ ...baseSelection, scope: scopeNoAllowed }), false);
});

test('sufficiency gate — cohort mode: any resolved percentage means it cleared the min-patient floor', () => {
  assert.equal(isSufficientForAi(baseCohort), true);
  // A below-floor cohort would arrive with all-null yield (server returns totals=null) → insufficient.
  assert.equal(
    isSufficientForAi({ ...baseCohort, yield_pct: { pct_allowed: null, pct_paid: null, pct_collected: null } }),
    false,
  );
});

test('buildAiMessages: user turn = fixed prose + EXACTLY the validated aggregate JSON, nothing else', () => {
  const { system, user } = buildAiMessages(baseCohort);
  assert.match(system, /revenue-cycle analyst/i);
  assert.match(user, /Mode: COHORT/);
  assert.match(user, /42 patients/); // the aggregate count is fine (non-PHI)
  // The ONLY data the model sees is JSON.stringify(input) — so whatever the PHI firewall admitted
  // (allowlisted aggregate fields only) is the whole of the model input; no side channel adds more.
  assert.ok(user.includes(JSON.stringify(baseCohort)), 'user turn must embed exactly the validated aggregate');
  // A concrete PHI value never appears (it has no schema field to arrive in, and none is injected).
  assert.doesNotMatch(user, /PGE081|DOE, JANE/);
});

test('parseAiSections: splits the three sections, tolerant of a missing one', () => {
  const text = '## TL;DR\nAetna underpays.\n## Signals\n- 90837 low at 72%\n## Risks\n- thin buckets';
  const out = parseAiSections(text);
  assert.equal(out['TL;DR'], 'Aetna underpays.');
  assert.match(out.Signals, /90837 low at 72%/);
  assert.match(out.Risks, /thin buckets/);

  const partial = parseAiSections('## TL;DR\nJust the headline.');
  assert.equal(partial['TL;DR'], 'Just the headline.');
  assert.equal(partial.Signals, '');
  assert.equal(partial.Risks, '');
});

test('insufficient copy + section markers are the agreed constants', () => {
  assert.equal(INSUFFICIENT_COPY.cohort, 'Not enough data on this cohort to create a reliable summary.');
  assert.match(INSUFFICIENT_COPY.selection, /this selection/);
  assert.deepEqual([...AI_SECTIONS], ['TL;DR', 'Signals', 'Risks']);
});

// ── Token ceiling + prompt budget (measured 2026-09-04, see the module docblock) ────────────────────

test('AI_MAX_TOKENS is the MEASURED value, not a floor — change it only with a new measurement', () => {
  // With the per-section budget the observed max across real selection + cohort payloads was 792
  // output tokens (thinking included); 1536 is 1.9× that. The prompt as it was measured 1,101–1,578,
  // which is why 1024 clipped every production run (output_tokens == 1024 in the Vercel log).
  assert.equal(AI_MAX_TOKENS, 1536, 'the cap is a measurement; re-measure before moving it');
});

test('SYSTEM_PROMPT states the per-section budget the cap was sized to', () => {
  const { system } = buildAiMessages(baseSelection);
  assert.match(system, /40 words at most/, 'TL;DR budget');
  assert.equal((system.match(/25 words at most/g) ?? []).length, 2, 'Signals + Risks bullet budget');
  assert.match(system, /WHOLE answer stays under 220 words/, 'total budget');
  assert.match(system, /Output EXACTLY these three markdown sections/, 'the format contract is unchanged');
});

// ── Truncation: the one-code-point wire convention ─────────────────────────────────────────────────

test('AI_TRUNCATED_MARK is one private-use code unit — a chunk boundary cannot split it', () => {
  assert.equal(AI_TRUNCATED_MARK.length, 1);
  const cp = AI_TRUNCATED_MARK.codePointAt(0)!;
  assert.ok(cp >= 0xe000 && cp <= 0xf8ff, 'Unicode private-use area: no model output contains it');
});

test('splitAiStream: no mark → text unchanged, not truncated', () => {
  const acc = '## TL;DR\nfine.\n## Signals\n- a\n## Risks\n- b';
  assert.deepEqual(splitAiStream(acc), { text: acc, truncated: false });
});

test('splitAiStream: trailing mark → truncated, and the mark never reaches the text', () => {
  const body = '## TL;DR\nfine.\n## Signals\n- a\n## Risks\n- b';
  const out = splitAiStream(body + AI_TRUNCATED_MARK);
  assert.equal(out.truncated, true);
  assert.equal(out.text, body);
  assert.ok(!out.text.includes(AI_TRUNCATED_MARK));
});

test('splitAiStream: only a TERMINAL mark means truncated — a mark inside the text never does (Qodo #319)', () => {
  // The server replaces model-emitted U+E000 with U+FFFD before enqueueing, so a mid-text mark cannot
  // come from the server; the client strips it defensively but does NOT call the read cut short.
  assert.deepEqual(splitAiStream(`pay${AI_TRUNCATED_MARK}er`), { text: 'payer', truncated: false });
  assert.deepEqual(splitAiStream(`pay${AI_TRUNCATED_MARK}er${AI_TRUNCATED_MARK}`), { text: 'payer', truncated: true });
  // A normally completed answer that mentions U+FFFD (the server's substitution) is untouched.
  const withSub = '## TL;DR\nPAYER \uFFFD LLC pays 90%.\n## Signals\n- a\n## Risks\n- b';
  assert.deepEqual(splitAiStream(withSub), { text: withSub, truncated: false });
});

test('splitAiStream: detection is on the ACCUMULATED string — chunking cannot hide the mark', () => {
  // The client re-splits the whole accumulation on every chunk; wherever the transport puts the mark,
  // the result is the same, and a stray duplicate is stripped too.
  const chunks = ['## TL;DR\nfine.\n## Sig', 'nals\n- a\n## Risks\n- b', AI_TRUNCATED_MARK];
  let acc = '';
  const seen: boolean[] = [];
  for (const c of chunks) {
    acc += c;
    seen.push(splitAiStream(acc).truncated);
  }
  assert.deepEqual(seen, [false, false, true]);
  assert.equal(splitAiStream(`x${AI_TRUNCATED_MARK}y${AI_TRUNCATED_MARK}`).text, 'xy');
});

test('THE BUG THIS PR FIXES: a stream that ends mid-section is CUT SHORT, not a silently complete render', () => {
  // Reproduces the 2026-09-04 production shape: the ceiling landed inside Risks, after its first
  // bullet. Every section header is present and every body is NON-EMPTY, so a client-side
  // "missing or empty section" heuristic reports the answer complete — the exact silent partial the
  // server mark exists to make impossible.
  const clipped =
    '## TL;DR\nYield is healthy for OON.\n## Signals\n- S9480 allows 20.87%.\n- H0017 pays 89.56%.\n## Risks\n- Day-90 bucket exceeds 100% —';
  const out = splitAiStream(clipped + AI_TRUNCATED_MARK);
  const sections = parseAiSections(out.text);
  for (const s of AI_SECTIONS) assert.ok(sections[s].length > 0, `${s} is non-empty — the heuristic would pass it`);
  assert.equal(out.truncated, true, 'the mark is what says it was cut short');
  assert.match(sections.Risks, /exceeds 100% —$/, 'what arrived renders as it arrived');
  // And with NOTHING arriving before the ceiling (a probe at a 200-token cap did exactly this), the
  // flag still says cut short — the panel then shows the sentence alone, never "could not be generated".
  assert.deepEqual(splitAiStream(AI_TRUNCATED_MARK), { text: '', truncated: true });
});
