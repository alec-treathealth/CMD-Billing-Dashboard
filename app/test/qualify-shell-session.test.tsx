/**
 * THE SMOKE SHELL'S SESSION RULES — the four state-correctness defects, pinned.
 *
 * The shell that wires these (`components/qualify/v3/resolution-flow-client.tsx`) needs
 * `useActionState` and cannot be mounted hermetically, so each rule was extracted into
 * `components/qualify/shell/shell-session.ts` as a total function and is CALLED here. That is the
 * deliberate alternative to a source scan: `makeRetryHandler`'s header records how an `indexOf`-based
 * scan of this same shell survived the deletion of the guard it was meant to protect.
 *
 * What must hold:
 *   1. TWO DIFFERENT MEMBERS ARE TWO HISTORY ROWS even when they share a predicateId — and a
 *      re-scope of one member is still exactly one row.
 *   2. THE RAIL SAYS "No lane yet" IMMEDIATELY AFTER A RESET, though `state.resolution` is still
 *      non-null (the server action owns it and the shell cannot clear it).
 *   3. THE REVEAL SCOPE follows the pane the answer actually renders in.
 *   4. A REFUSED WATCHER SAVE IS SPOKEN — a distinct sentence per reason, inside a live region that
 *      exists before it has anything to say.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a `.ts` file here would
 * "pass" by never running (forecast-edit-feedback.test.tsx's header).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  laneIsOpen,
  recentSearchKeyOf,
  revealScopeFor,
  watcherSaveNotice,
  type QualifyWatcherSaveFailure,
} from '../components/qualify/shell/shell-session';
import { LaneRail } from '../components/qualify/shell/lane-rail';
import { WatchersPanel } from '../components/qualify/shell/watchers-panel';
import { ResolutionStages, type ResolutionStagesProps } from '../components/qualify/v3/resolution-flow';
import type { QualifyResolution } from '../lib/qualify/resolution';

/** The shell's source, for the CALL-SITE pins below. */
const SHELL_SRC = readFileSync(
  fileURLToPath(new URL('../components/qualify/v3/resolution-flow-client.tsx', import.meta.url)),
  'utf8',
);

/**
 * `indexOf` RETURNS -1 FOR AN ABSENT NEEDLE, which is how a `a.indexOf(x) < b.indexOf(y)` ordering
 * assertion became `-1 < positive` — TRUE — the moment the thing it guarded was deleted
 * (`makeRetryHandler`'s header, MUT-25). Every position this file takes goes through here, so an
 * absent needle FAILS instead of quietly satisfying a comparison.
 */
function indexOfOrFail(hay: string, needle: string, from = 0): number {
  const at = hay.indexOf(needle, from);
  assert.notEqual(at, -1, `missing from the shell: ${needle}`);
  return at;
}

// ── 1. The recent-search dedupe key ─────────────────────────────────────────────────────────────
//
// `predicateIdFor` (resolutionService.ts:415) hashes {kind, canonicalPayerId, employerLabel,
// funding, planType, from, to} — NO identifier. Two members on the same plan shape in the same
// window are the same hash, which is the exact input this test holds fixed.
const SHARED_PREDICATE = 'pred-aetna-acme-selffunded-ppo-2025';

test('two different members sharing a predicateId are two different history keys', () => {
  // The shell bumps its search counter on every identify dispatch; the hash is identical.
  const memberA = recentSearchKeyOf(1, SHARED_PREDICATE);
  const memberB = recentSearchKeyOf(2, SHARED_PREDICATE);
  assert.notEqual(memberA, memberB, 'a colliding predicateId must not collapse two searches');
});

test('the dedupe records the second member and still swallows a re-scope of the first', () => {
  // The shell's own loop, replayed: a Set of keys, one `has`/`add` per resolved snapshot.
  const recorded = new Set<string>();
  const record = (seq: number, pid: string): boolean => {
    const key = recentSearchKeyOf(seq, pid);
    if (recorded.has(key)) return false;
    recorded.add(key);
    return true;
  };

  // Member A resolves, then the operator presses a window chip and a billed-under chip: three
  // snapshots, ONE search — the counter does not move, because no identify was dispatched.
  assert.equal(record(1, SHARED_PREDICATE), true, 'the first resolve is logged');
  assert.equal(record(1, SHARED_PREDICATE), false, 'a re-scope must not re-log');
  assert.equal(record(1, SHARED_PREDICATE), false, 'nor a refresh');

  // Member B is typed in. Same plan shape, same hash, new search.
  assert.equal(record(2, SHARED_PREDICATE), true, 'the SECOND member must be logged — the defect');

  // A plan pick inside member B's search re-resolves to a concrete plan class: a real new row.
  assert.equal(record(2, 'pred-aetna-acme-selffunded-hmo-2025'), true);
  assert.equal(recorded.size, 3);
});

test('the dedupe key carries no identifier — only the counter and the hash', () => {
  const key = recentSearchKeyOf(7, SHARED_PREDICATE);
  assert.equal(key, `7:${SHARED_PREDICATE}`);
  // The raw term is the one thing that would trivially work and must never be used: a Set of terms
  // in a ref is PHI at rest for the life of the mount.
  assert.doesNotMatch(key, /W12345678|GGS0001/, 'no member identifier may reach the key');
});

/**
 * ⚠ THE CALL SITE, NOT ONLY THE FUNCTION. Everything above passes with `searchSeqRef.current += 1`
 * DELETED and with `recordedRef` still keyed on the bare `pid` — the two tests above call
 * `recentSearchKeyOf` directly and re-implement the shell's `has`/`add` loop rather than exercising
 * it. Extracting the rule moved the untestable part; it did not shrink it. The shell needs
 * `useActionState` and cannot be mounted here, so the wiring is pinned by reading the source — with
 * every position taken through `indexOfOrFail`, never a bare `indexOf` comparison.
 */
test('the shell WIRES the key: the counter is bumped inside identifyAction and the Set is keyed on it', () => {
  // (a) THE INCREMENT — present, and inside `identifyAction`, before the dispatch that starts the
  // search. A bump anywhere else (an effect, a later handler) would race the recording effect.
  const identifyAt = indexOfOrFail(SHELL_SRC, 'const identifyAction = useCallback(');
  const bumpAt = indexOfOrFail(SHELL_SRC, 'searchSeqRef.current += 1;', identifyAt);
  const closeAt = indexOfOrFail(SHELL_SRC, '[formAction],', identifyAt);
  assert.ok(bumpAt < closeAt, 'the counter must be bumped INSIDE identifyAction');
  const dispatchAt = indexOfOrFail(SHELL_SRC, "dispatch({ type: 'search_submitted' })", identifyAt);
  assert.ok(bumpAt < dispatchAt, 'and before the search it identifies is dispatched');
  // Exactly one writer — a second `+= 1` anywhere would double-count and split one search in two.
  assert.equal(SHELL_SRC.split('searchSeqRef.current += 1').length - 1, 1, 'one writer, no more');

  // (b) THE SET IS KEYED ON IT. Both the read and the write, and the old keying is gone.
  assert.match(
    SHELL_SRC,
    /const key = recentSearchKeyOf\(searchSeqRef\.current, pid\);/,
    'the dedupe key must be derived by recentSearchKeyOf',
  );
  assert.match(SHELL_SRC, /recordedRef\.current\.has\(key\)/, 'the read uses the derived key');
  assert.match(SHELL_SRC, /recordedRef\.current\.add\(key\)/, 'and so does the write');
  assert.doesNotMatch(
    SHELL_SRC,
    /recordedRef\.current\.(has|add)\(pid\)/,
    'the predicateId-only keying is the defect — it must not come back',
  );
});

// ── 2. The lane's lock state after "Start over" AND after the receipt's Change ──────────────────
const LIVE_LANE = { resolutionPresent: true, sessionCleared: false, stageIsIdentify: false };

test('laneIsOpen is the SESSION, not the server action leftover', () => {
  assert.equal(laneIsOpen({ ...LIVE_LANE, resolutionPresent: false, stageIsIdentify: true }), false, 'nothing resolved yet');
  assert.equal(laneIsOpen(LIVE_LANE), true, 'a live lane');
  // DEFECT 1: `went_back` cannot clear `state.resolution`, so `resolutionPresent` stays true.
  assert.equal(laneIsOpen({ ...LIVE_LANE, sessionCleared: true, stageIsIdentify: true }), false, 'reset closes the lane');
  // DEFECT 2 (the review's find): the receipt's Change dispatches the same `went_back` through a
  // handler that arms NOTHING, so `sessionCleared` is false and only the stage says the lane is gone.
  assert.equal(
    laneIsOpen({ ...LIVE_LANE, stageIsIdentify: true }),
    false,
    'a receipt Change back to Search closes the lane too — the board already says "Nothing resolved yet"',
  );
  // ...and the pending window after a NEW submit is deliberately NOT closed: the stage is 'payer'
  // there, so the rail keeps agreeing with the stage beside it (see the field's own docblock).
  assert.equal(laneIsOpen({ ...LIVE_LANE, sessionCleared: false }), true);
});

test('the rail says "No lane yet" after a reset AND after a receipt Change, resolution still present', () => {
  const railFor = (input: Parameters<typeof laneIsOpen>[0]) => {
    const open = laneIsOpen(input);
    return renderToStaticMarkup(
      <LaneRail
        echo={open ? 'GGS' : ''}
        readAs={open ? 'read as a 3-character member-ID prefix' : null}
        hasResolution={open}
        onReset={() => {}}
        composer={null}
      >
        <p>flow</p>
      </LaneRail>,
    );
  };

  const live = railFor(LIVE_LANE);
  assert.match(live, /Locked to/, 'positive control: a live lane really does say so');
  assert.match(live, /GGS/);

  // BOTH routes back to the identify question, asserted separately — one arms the session bit, the
  // other only moves the stage, and until the fix only the first was covered.
  for (const [what, input] of [
    ['Start over', { ...LIVE_LANE, sessionCleared: true, stageIsIdentify: true }],
    ['receipt Change → Search', { ...LIVE_LANE, stageIsIdentify: true }],
  ] as const) {
    const html = railFor(input);
    assert.match(html, /No lane yet/, `${what}: the strip must say the lane is gone`);
    assert.doesNotMatch(html, /Locked to/, `${what}: it must not name the abandoned lane`);
    assert.doesNotMatch(html, /GGS/, `${what}: nor echo it`);
    // The reset control goes inert — aria-disabled, never `disabled` (the focus-drop rule).
    assert.match(html, /aria-disabled="true"/);
    assert.doesNotMatch(html, / disabled=""/);
  }
});

// ── 2b. The rail must not contradict the search box inside it ───────────────────────────────────
//
// `echo` is StageIdentify's `defaultValue` and the resolution's `readAs` is the "We read as …"
// sentence. A reset drops the held term, so both are claims about a search that no longer exists —
// and before this they sat 12px under a strip already saying "No lane yet".
const IDENTIFY_RESOLUTION = {
  handle: { readAs: 'read as a 3-character member-ID prefix', echo: 'GGS', kind: 'alpha_prefix' },
  candidates: { total: 4 },
  group: { claimsPayerLabels: [] },
} as unknown as QualifyResolution;

function identifyStage(over: Partial<ResolutionStagesProps> = {}): string {
  return renderToStaticMarkup(
    <ResolutionStages
      stage="identify"
      resolution={IDENTIFY_RESOLUTION}
      reason={null}
      echo="GGS"
      denied={null}
      pending={false}
      payerPick={null}
      planFilter=""
      identifyAction={() => {}}
      planAction={() => {}}
      onPickPayer={() => {}}
      onPlanFilter={() => {}}
      onAskAi={() => {}}
      onChange={() => {}}
      onSkip={() => {}}
      ticker={null}
      payerGroups={[]}
      answer={null}
      {...over}
    />,
  );
}

test('a cleared lane empties the search box and drops the "We read as" sentence', () => {
  // POSITIVE CONTROL — and the single-column v3 path, where `laneCleared` is never passed at all.
  // A receipt Change lands here with the term still HELD, so the pre-fill is correct and must stay.
  const changed = identifyStage();
  assert.match(changed, /defaultValue|value="GGS"/, 'sanity: the input renders its value attribute');
  assert.ok(changed.includes('value="GGS"'), 'a Change pre-fills the prefix it is editing');
  assert.match(changed, /We read as a 3-character member-ID prefix/);

  // A RESET dropped the term — neither claim may survive.
  const cleared = identifyStage({ laneCleared: true });
  assert.ok(!cleared.includes('value="GGS"'), 'the box must not pre-fill an abandoned prefix');
  assert.doesNotMatch(cleared, /We read as/, 'nor describe how it was read');
  // ...and the generic help sentence takes over rather than the field going silent.
  assert.match(cleared, /Three characters is read as a prefix/);
});

test('the identify stage gates BOTH halves on laneCleared, and the shell passes the reset bit', () => {
  // Pinned at the call site for the reason item 1's wiring is: the prop defaulting false is what
  // makes single-column inert, and a caller that stops passing it fails nothing else.
  assert.match(SHELL_SRC, /laneCleared=\{sessionCleared\}/, 'the shell must pass the reset bit');
  assert.doesNotMatch(
    SHELL_SRC,
    /laneCleared=\{!laneOpen\}/,
    'NOT !laneOpen — a receipt Change closes the lane but keeps the term, and the box should pre-fill',
  );
});

// ── 3. Where the tile/facet reveal looks ────────────────────────────────────────────────────────
test('the reveal scope follows the pane the answer renders in', () => {
  const root = { id: 'root' };
  const stageEl = { id: 'stage' };
  // Single-column: the answer is inside [data-v3-stage].
  assert.equal(revealScopeFor(false, root, stageEl), stageEl);
  // Shell: `answerInline` is false and StageAnswer mounts in the BOARD, outside [data-v3-stage] —
  // scoping to the stage found no answer content at all, which is why neither reveal ran.
  assert.equal(revealScopeFor(true, root, stageEl), root);
});

// ── 4. A refused or failed watcher save is spoken ───────────────────────────────────────────────
const REASONS: QualifyWatcherSaveFailure[] = ['denied', 'invalid', 'failed'];

test('each save-failure reason gets its own sentence, and all of them say nothing was stored', () => {
  const seen = new Set<string>();
  for (const r of REASONS) {
    const s = watcherSaveNotice(r);
    assert.ok(s.length > 0);
    assert.match(s, /not saved/);
    assert.match(s, /Nothing is stored/);
    seen.add(s);
  }
  assert.equal(seen.size, REASONS.length, 'three reasons, three distinct sentences');
});

test('the watchers panel announces a failed save and keeps its live region mounted when quiet', () => {
  const quiet = renderToStaticMarkup(
    <WatchersPanel available={false} trend={[]} patient={[]} onDelete={() => {}} />,
  );
  // The region must EXIST before it has anything to say — a live region that appears together with
  // its text is unreliably announced.
  assert.match(quiet, /role="status" aria-live="polite"/);
  assert.doesNotMatch(quiet, /not saved/);

  for (const r of REASONS) {
    const failed = renderToStaticMarkup(
      <WatchersPanel available={false} saveFailed={r} trend={[]} patient={[]} onDelete={() => {}} />,
    );
    assert.match(failed, /role="status" aria-live="polite"/);
    assert.ok(failed.includes(watcherSaveNotice(r)), `the ${r} sentence must render`);
    // A failed SAVE is not a failed READ — the panel must not offer the read banner's explanation.
    assert.doesNotMatch(failed, /saved watchers could not be read/);
  }
});
