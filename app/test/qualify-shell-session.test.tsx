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

// ── 2. The lane's lock state after "Start over" ─────────────────────────────────────────────────
test('laneIsOpen is the SESSION, not the server action leftover', () => {
  assert.equal(laneIsOpen(false, false), false, 'nothing resolved yet');
  assert.equal(laneIsOpen(true, false), true, 'a live lane');
  // THE DEFECT: `went_back` cannot clear `state.resolution`, so the first argument stays true.
  assert.equal(laneIsOpen(true, true), false, 'reset closes the lane despite a stale resolution');
  assert.equal(laneIsOpen(false, true), false);
});

test('the rail says "No lane yet" right after a reset, with the resolution still present', () => {
  const beforeReset = renderToStaticMarkup(
    <LaneRail
      echo="GGS"
      readAs="read as a 3-character member-ID prefix"
      hasResolution={laneIsOpen(true, false)}
      onReset={() => {}}
      composer={null}
    >
      <p>flow</p>
    </LaneRail>,
  );
  assert.match(beforeReset, /Locked to/);
  assert.match(beforeReset, /GGS/);

  // The shell gates echo and readAs on the same derivation, so nothing about the abandoned lane is
  // even handed to the rail.
  const open = laneIsOpen(true, true);
  const afterReset = renderToStaticMarkup(
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
  assert.match(afterReset, /No lane yet/);
  assert.doesNotMatch(afterReset, /Locked to/, 'the strip must not name the abandoned lane');
  assert.doesNotMatch(afterReset, /GGS/, 'nor echo it');
  // The reset control goes inert again — aria-disabled, never `disabled` (the focus-drop rule).
  assert.match(afterReset, /aria-disabled="true"/);
  assert.doesNotMatch(afterReset, / disabled=""/);
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
