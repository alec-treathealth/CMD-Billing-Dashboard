import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  REPO_ROOT,
  checkContextMap,
  loadContextMap,
  parseContextMap,
} from '../scripts/check-context-map.js';

// The live map. If any of these fail, CLAUDE.md § Canonical Context Set is
// lying about where a doc lives — fix the path there, do not delete the row.
const map = loadContextMap();

test('canonical table lists the docs a cold-start engineer cannot work without', () => {
  const paths = map.canonical.map((e) => e.path);
  // Paths updated 2026-08-05 after a bulk relocation moved the build guide and the design system
  // into docs/archive/. Both are still LIVE documents despite the directory name — the assertion is
  // "the map lists them", and it keeps naming them explicitly so a future move fails here loudly
  // instead of the row being quietly dropped from CLAUDE.md.
  for (const required of [
    'CLAUDE.md',
    'docs/archive/00-GUIDE.md',
    'veris-data-notes.md',
    'pr_compliance_checklist.yaml',
    'docs/archive/design-system.md',
  ]) {
    assert.ok(paths.includes(required), `canonical table is missing ${required}`);
  }
});

test('every canonical path resolves on disk', () => {
  for (const entry of map.canonical) {
    assert.ok(
      existsSync(join(REPO_ROOT, entry.path)),
      `canonical path does not resolve: ${entry.path} (read-order ${entry.readOrder})`,
    );
  }
});

test('read-order is 1..N, unique and contiguous', () => {
  assert.deepEqual(
    map.canonical.map((e) => e.readOrder),
    map.canonical.map((_, i) => i + 1),
  );
});

// The point of this one: these docs live only in Alec's Claude.ai project
// knowledge. If one gets committed, the map is lying in the other direction and
// the "ask me to paste it" instruction becomes wrong.
test('NOT-IN-REPO paths do NOT resolve on disk', () => {
  assert.ok(map.notInRepo.length > 0, 'NOT-IN-REPO list is empty — expected at least one entry');
  for (const p of map.notInRepo) {
    assert.ok(
      !existsSync(join(REPO_ROOT, p)),
      `${p} is declared project-knowledge-only but now exists in the repo — update CLAUDE.md`,
    );
  }
});

test('superseded in-repo snapshots still resolve', () => {
  assert.ok(map.superseded.length > 0, 'superseded list is empty — expected at least one entry');
  for (const p of map.superseded) {
    assert.ok(existsSync(join(REPO_ROOT, p)), `superseded path does not resolve: ${p}`);
  }
});

test('checkContextMap reports zero failures against the live repo', () => {
  assert.deepEqual(checkContextMap(map), []);
});

// ---- parser unit tests (synthetic markdown, no disk) ----

const FIXTURE = `# Title

## Repo layout

| Plane | Directory | Next number |
|---|---|---|
| Product | \`supabase/migrations\` | **0072** |

## Canonical Context Set

Preamble prose.

| Role | Path | Read-order |
|---|---|---|
| Rules | \`CLAUDE.md\` | 1 |
| Ledger | \`docs/veris-data-notes.md\` | 2 |

### NOT IN REPO — project-knowledge only

- \`Ghost-Doc.md\`

### Superseded in repo — do not treat as current

- \`docs/old.md\` — frozen snapshot.

### Uncommitted — not guarded

\`Untracked Thing.md\` is at the repo root.

## Standing rules
`;

test('parser picks the Role/Path/Read-order table, not the neighbouring one', () => {
  const parsed = parseContextMap(FIXTURE);
  assert.deepEqual(parsed.canonical, [
    { role: 'Rules', path: 'CLAUDE.md', readOrder: 1 },
    { role: 'Ledger', path: 'docs/veris-data-notes.md', readOrder: 2 },
  ]);
});

test('parser reads both sub-lists and ignores the unguarded prose section', () => {
  const parsed = parseContextMap(FIXTURE);
  assert.deepEqual(parsed.notInRepo, ['Ghost-Doc.md']);
  assert.deepEqual(parsed.superseded, ['docs/old.md']);
});

test('parser stops at the next level-2 heading', () => {
  // "Standing rules" follows the section; nothing from it may leak in.
  const parsed = parseContextMap(`${FIXTURE}\n| Leaked | \`nope.md\` | 3 |\n`);
  assert.equal(parsed.canonical.length, 2);
});

test('parser throws when the section is absent', () => {
  assert.throws(
    () => parseContextMap('# Title\n\n## Other\n\ntext\n'),
    /no "## Canonical Context Set" section/,
  );
});

test('list-item path comes from the leading code span; trailing prose may cite others', () => {
  const withProse = FIXTURE.replace(
    '- `docs/old.md` — frozen snapshot.',
    '- `docs/old.md` — superseded by this file plus `.claude/rules/`.',
  );
  assert.deepEqual(parseContextMap(withProse).superseded, ['docs/old.md']);
});

test('parser throws on a list item that does not start with a code span', () => {
  const bad = FIXTURE.replace('- `Ghost-Doc.md`', '- Ghost-Doc.md');
  assert.throws(() => parseContextMap(bad), /must start with a `inline-code` path/);
});

test('parser throws on a path cell without exactly one code span', () => {
  const bare = FIXTURE.replace('| Rules | `CLAUDE.md` | 1 |', '| Rules | CLAUDE.md | 1 |');
  assert.throws(() => parseContextMap(bare), /expected exactly one/);
});

test('parser throws on a non-integer read-order', () => {
  const bad = FIXTURE.replace('| Rules | `CLAUDE.md` | 1 |', '| Rules | `CLAUDE.md` | first |');
  assert.throws(() => parseContextMap(bad), /is not an integer/);
});

test('checkContextMap names a missing canonical path', () => {
  const failures = checkContextMap({
    canonical: [{ role: 'Ghost', path: 'docs/definitely-not-here.md', readOrder: 1 }],
    notInRepo: [],
    superseded: [],
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.path, 'docs/definitely-not-here.md');
  assert.match(failures[0]!.kind, /missing on disk/);
});

test('checkContextMap flags a NOT-IN-REPO path that resolves', () => {
  const failures = checkContextMap({
    canonical: [],
    notInRepo: ['CLAUDE.md'], // exists — must be reported
    superseded: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.kind, /NOT-IN-REPO path resolves/);
});
