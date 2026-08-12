import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Source-level guard on the pipeline tick's composition root.
 *
 * WHY A SOURCE ASSERTION rather than an integration test: handlePipelineTick builds a live
 * cmd_rollup_writer pool at call time, so exercising it would need a database. The one thing worth
 * pinning is a wiring detail that typechecks perfectly and fails silently at runtime.
 */
const SERVER = readFileSync(new URL('../lib/server.ts', import.meta.url), 'utf8');

test('the tick attributes a manual run by comparing the holder LITERAL, not a prefix', () => {
  // Regression guard. `holder` inside handlePipelineTick is the HANDLER's clamped value — the
  // literal 'manual' or 'cron' (pipelineTickHandler.ts). runPipelineTick derives its own unique
  // lease token ('manual:<ts>:<uuid>') internally and never returns it, so a `startsWith('manual:')`
  // test here can NEVER be true and every hand-run tick would be recorded as 'tick'. That shipped
  // briefly via review #216, which correctly fixed the src-side lease collision and then applied a
  // matching prefix check on this side, where the prefix does not exist.
  const block = SERVER.slice(
    SERVER.indexOf('export function handlePipelineTick'),
    SERVER.indexOf('function dispatchStage'),
  );
  assert.ok(block.length > 0, 'handlePipelineTick block not found');
  assert.match(block, /triggeredBy:\s*holder === 'manual' \? 'tick-manual' : 'tick'/);
  assert.doesNotMatch(
    block,
    /holder\.startsWith\(/,
    "the handler's holder is a bare literal — a prefix match silently never fires",
  );
});

test('every pipeline stage name has a wired handler in dispatchStage', () => {
  // A stage present in etlStages.ts but missing here throws at runtime inside the tick. Cheap to
  // assert statically, and the failure mode otherwise is a stage that silently never runs.
  const stages = readFileSync(new URL('../../src/collections/etlStages.ts', import.meta.url), 'utf8');
  const declared = [...stages.matchAll(/\{\s*stage: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(declared.length >= 5, `expected the five CMD stages, found ${declared.length}`);

  const dispatch = SERVER.slice(
    SERVER.indexOf('function dispatchStage'),
    SERVER.indexOf('function envFlagEnabled'),
  );
  for (const stage of declared) {
    assert.ok(dispatch.includes(`case '${stage}':`), `dispatchStage has no case for '${stage}'`);
  }
});
