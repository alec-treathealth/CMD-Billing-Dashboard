/**
 * Source-level guards for the Collections AI stream's REQUEST, LOG and WIRE shape (app/lib/server.ts,
 * app/lib/actions.ts).
 *
 * server.ts is the composition root — importing it stands up the reader pool and reads secrets — so
 * these pin the lines that matter at the SOURCE (the same constraint cmd-recency-default.test.tsx
 * records). The PURE half — splitAiStream, the cap, the prompt budget, the mid-section-cut case — is
 * unit-tested hermetically in the ROOT suite (test/aiAnalysis.test.ts). What these lock in:
 *   · max_tokens is the shared AI_MAX_TOKENS constant — a literal here would drift from the root pin
 *   · the truncation mark is enqueued on `max_tokens`, AFTER finalMessage() and BEFORE close — the
 *     one-code-point wire convention that makes a clipped answer say so
 *   · stop_reason rides the cost-governance line — a clip or a refusal is visible in ops (the
 *     2026-09-04 production clip was found in exactly this line: output_tokens == 1024, no error)
 *   · no sampling params (400 on Opus 4.7+), no thinking override, and NO output_config — effort:'low'
 *     was measured and deliberately deferred (aiAnalysis.ts module docblock)
 *   · the convention is documented where the stream TYPE is declared, on both sides of the action
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, '../lib/server.ts'), 'utf8');
const actionsSrc = readFileSync(join(here, '../lib/actions.ts'), 'utf8');
const slice = (() => {
  const from = serverSrc.indexOf('export async function streamCollectionsAiAnalysis(');
  const to = serverSrc.indexOf('async function loadCohortCurveData(', from);
  assert.ok(from > 0 && to > from, 'streamCollectionsAiAnalysis slice located');
  return serverSrc.slice(from, to);
})();
const code = slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the request carries the shared token ceiling and no sampling / thinking / effort overrides', () => {
  const req = code.match(/sdk\.messages\.stream\(\{([\s\S]*?)\}\);/);
  assert.ok(req, 'the stream request is located');
  assert.match(req[1], /max_tokens: AI_MAX_TOKENS,/, 'max_tokens is the shared constant, not a literal');
  assert.doesNotMatch(req[1], /max_tokens: \d/, 'never a literal token cap here');
  assert.doesNotMatch(req[1], /temperature|top_p|top_k/, 'sampling params return 400 on Opus 4.7+');
  assert.doesNotMatch(req[1], /thinking/, 'thinking is left to the model default (disabling it leaks on Opus 5)');
  assert.doesNotMatch(req[1], /output_config|effort/, "effort:'low' was measured and DEFERRED — not in this request");
});

test('a clip is marked in-band: AI_TRUNCATED_MARK after finalMessage(), before close', () => {
  const final = code.indexOf('const final = await ms.finalMessage();');
  const mark = code.indexOf("if (final.stop_reason === 'max_tokens') controller.enqueue(AI_TRUNCATED_MARK);");
  const close = code.indexOf('controller.close();', final);
  assert.ok(final > 0 && mark > final && close > mark, 'finalMessage → mark → close, in that order');
  assert.match(serverSrc, /^\s*AI_TRUNCATED_MARK,\s*$/m, 'the mark is imported from the shared module, not redeclared');
  // The mark is the ONLY non-text thing ever enqueued.
  const enqueues = code.match(/controller\.enqueue\(([^)]*)\)/g) ?? [];
  assert.deepEqual(enqueues, ['controller.enqueue(event.delta.text)', 'controller.enqueue(AI_TRUNCATED_MARK)']);
});

test('the cost-governance line reports stop_reason so truncation is visible in ops', () => {
  const log = code.match(/kind: 'collections_ai_analysis',([\s\S]*?)\}\),/);
  assert.ok(log, 'the cost-governance log object is located');
  assert.match(log[1], /stop_reason: final\.stop_reason,/, 'stop_reason logged');
  assert.match(log[1], /output_tokens: final\.usage\?\.output_tokens,/, 'token counts still logged');
  // Still PHI-free: mode, tenant ids, model, counts, stop reason — never the prompt or the answer.
  assert.doesNotMatch(log[1], /system|user|text|input\.top_|acc\b/, 'no prompt or answer content in the log');
});

test('the wire convention is documented where the stream type is declared — both sides', () => {
  const serverType = serverSrc.slice(serverSrc.lastIndexOf('/**', serverSrc.indexOf('export type CollectionsAiStreamResult')), serverSrc.indexOf('export type CollectionsAiStreamResult'));
  assert.match(serverType, /NOT PURE TEXT/, 'server type docblock warns the reader');
  assert.match(serverType, /AI_TRUNCATED_MARK/, 'and names the mark');
  const actionType = actionsSrc.slice(actionsSrc.lastIndexOf('/**', actionsSrc.indexOf('export type CollectionsAiAnalysisResult')), actionsSrc.indexOf('export type CollectionsAiAnalysisResult'));
  assert.match(actionType, /AI_TRUNCATED_MARK/, 'client-facing type points at the convention');
  assert.match(actionType, /splitAiStream/, 'and at the one function that strips it');
});
