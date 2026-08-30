import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ALLOWLIST_BASELINE_SHA256,
  ALLOWLIST_CREATED,
  ALLOWLIST_INITIAL_SIZE,
  REPO_ROOT,
  UNREGISTERED_DOC_ALLOWLIST,
  allowlistBaselineDigest,
  checkAllowlistIntegrity,
  checkContextMap,
  checkUnregisteredDocs,
  listTrackedDocs,
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

/* ══════════════════════════════════════════════════════════════════════════════════════
 * Assertion 4 — every tracked doc is in the table (the reverse direction).
 *
 * Added 2026-08-30. The guard was forward-only until then: it proved every LISTED path
 * resolves and never that every tracked doc is LISTED, so `npm test` stayed green with an
 * unregistered doc in the tree. A forward-only check cannot report that gap — the set it
 * iterates is the set it is meant to be auditing.
 * ══════════════════════════════════════════════════════════════════════════════════════ */

const trackedDocs = listTrackedDocs();

// ---- live repo ----

test('assertion 4 reports zero failures against the live repo', () => {
  assert.deepEqual(checkUnregisteredDocs(map, trackedDocs), []);
});

test('the frozen baseline is byte-identical to what was grandfathered', () => {
  // A LENGTH ratchet was the first version of this and it was a real hole: dropping one entry
  // and adding a different tracked-and-unregistered path kept the count at 52 and passed every
  // check, so the exemption set could be REPLACED rather than shrunk. Cardinality is not
  // subset. The digest catches an addition, a removal AND a swap.
  assert.equal(
    allowlistBaselineDigest(),
    ALLOWLIST_BASELINE_SHA256,
    'ALLOWLIST_BASELINE_2026_08_30 was edited. It is frozen — register the doc or delete it; ' +
      'to retire a baseline entry, add its path to RESOLVED_SINCE_BASELINE.',
  );
});

test('the live allowlist may only shrink — it is a subset of the frozen baseline', () => {
  assert.deepEqual(checkAllowlistIntegrity(), []);
  assert.ok(
    UNREGISTERED_DOC_ALLOWLIST.length <= ALLOWLIST_INITIAL_SIZE,
    `the exemption set grew past its ${ALLOWLIST_CREATED} size of ${ALLOWLIST_INITIAL_SIZE}`,
  );
});

test('every allowlist entry is a real, still-unregistered tracked doc', () => {
  // Keeps the array from rotting into a fiction of the backlog's size. checkUnregisteredDocs
  // enforces this too; asserted separately so the failure names the mechanism.
  const registered = new Set([...map.canonical.map((e) => e.path), ...map.superseded]);
  for (const p of UNREGISTERED_DOC_ALLOWLIST) {
    assert.ok(trackedDocs.includes(p), `allowlisted but no longer a tracked in-scope doc: ${p}`);
    assert.ok(!registered.has(p), `allowlisted but now registered — remove the entry: ${p}`);
  }
});

test('the allowlist is sorted and free of duplicates', () => {
  assert.deepEqual(
    [...UNREGISTERED_DOC_ALLOWLIST],
    [...new Set(UNREGISTERED_DOC_ALLOWLIST)].sort(),
    'keep UNREGISTERED_DOC_ALLOWLIST sorted and unique so a diff to it is legible',
  );
});

// ---- scope: what listTrackedDocs does and does not return ----

test('scope is .md only — a tracked .yaml in the table is not swept in', () => {
  // pr_compliance_checklist.yaml is read-order 4, so the table is NOT .md-only. The relation
  // asserted is one-way: every tracked .md is in the table, not that every row is .md.
  assert.ok(map.canonical.some((e) => e.path === 'pr_compliance_checklist.yaml'));
  assert.ok(!trackedDocs.includes('pr_compliance_checklist.yaml'));
  for (const p of trackedDocs) assert.ok(p.endsWith('.md'), `not a .md: ${p}`);
});

test('.claude/rules/ is out of scope — CLAUDE.md says they are deliberately not listed', () => {
  // "Path-scoped rules in `.claude/rules/` load automatically and are not listed here."
  // Structural exclusion, not backlog: they will never be triaged INTO the table, so they
  // must never occupy an allowlist that is meant to reach zero.
  assert.equal(trackedDocs.filter((p) => p.startsWith('.claude/rules/')).length, 0);
  assert.equal(UNREGISTERED_DOC_ALLOWLIST.filter((p) => p.startsWith('.claude/rules/')).length, 0);
});

test('a tracked doc whose name has spaces and an em dash survives enumeration', () => {
  // The -z split exists for this row; newline-splitting `git ls-files` would corrupt it.
  assert.ok(trackedDocs.includes('CMD AR Automation — Build Doc v2.md'));
});

// ---- synthetic: the four behaviours, no git and no disk ----

const SYNTH_MAP = {
  canonical: [{ role: 'Rules', path: 'CLAUDE.md', readOrder: 1 }],
  notInRepo: [],
  superseded: ['docs/frozen.md'],
};

test('a NEW unregistered doc fails on day one', () => {
  const failures = checkUnregisteredDocs(SYNTH_MAP, ['CLAUDE.md', 'docs/brand-new.md'], []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.path, 'docs/brand-new.md');
  assert.match(failures[0]!.kind, /not in the Canonical Context Set/);
});

test('the failure tells you to register or delete — never to grow the allowlist', () => {
  // Pinned as text: the remedy is the whole point of the message. If someone softens this
  // into "add it to the allowlist", the guard stops meaning anything.
  const [f] = checkUnregisteredDocs(SYNTH_MAP, ['docs/brand-new.md'], []);
  assert.match(f!.detail, /Do NOT add it to UNREGISTERED_DOC_ALLOWLIST/);
});

test('canonical and superseded both count as registered', () => {
  assert.deepEqual(checkUnregisteredDocs(SYNTH_MAP, ['CLAUDE.md', 'docs/frozen.md'], []), []);
});

test('an allowlisted doc passes while it stays unregistered', () => {
  assert.deepEqual(
    checkUnregisteredDocs(SYNTH_MAP, ['CLAUDE.md', 'docs/legacy.md'], ['docs/legacy.md']),
    [],
  );
});

test('an allowlist entry that got registered fails until the entry is removed', () => {
  const failures = checkUnregisteredDocs(SYNTH_MAP, ['CLAUDE.md'], ['CLAUDE.md']);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.kind, /stale allowlist entry/);
  assert.match(failures[0]!.detail, /now registered/);
});

test('an allowlist entry for a deleted doc fails until the entry is removed', () => {
  const failures = checkUnregisteredDocs(SYNTH_MAP, ['CLAUDE.md'], ['docs/deleted.md']);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.kind, /stale allowlist entry/);
  assert.match(failures[0]!.detail, /no longer a tracked in-scope doc/);
});

test('a same-size REPLACEMENT of a baseline entry is caught, not just growth', () => {
  // THE EXACT BUG THE LENGTH RATCHET MISSED. Swap one grandfathered path for a different
  // tracked, unregistered one: the count is unchanged, every per-entry check in
  // checkUnregisteredDocs is satisfied (it honours whatever allowlist it is handed), and the
  // old `length <= 52` assertion passed. Cardinality is not subset — so the assertion has to
  // live on the allowlist's own PROVENANCE, which is what the digest pins.
  const baseline = ['docs/a.md', 'docs/b.md'];
  const digest = createHash('sha256').update(baseline.join('\n')).digest('hex');
  const swapped = ['docs/a.md', 'docs/sneaked-in.md'];
  assert.equal(swapped.length, baseline.length, 'same size, by construction');

  // Unchanged baseline + a swapped LIVE set: caught as an exemption outside the baseline.
  const widened = checkAllowlistIntegrity(baseline, swapped, [], digest);
  assert.equal(widened.length, 1);
  assert.equal(widened[0]!.path, 'docs/sneaked-in.md');
  assert.match(widened[0]!.kind, /outside the frozen baseline/);

  // Swapping the BASELINE itself instead: caught by the digest.
  const edited = checkAllowlistIntegrity(swapped, swapped, [], digest);
  assert.equal(edited.length, 1);
  assert.match(edited[0]!.kind, /frozen allowlist baseline was edited/);
});

test('a RESOLVED entry that was never in the baseline exempts nothing', () => {
  // Guards the obvious workaround: "resolve" a path that was never grandfathered, hoping the
  // derivation lets it through. The live set is baseline MINUS resolved, so subtracting an
  // unrelated path removes nothing — and the bogus entry is reported rather than ignored.
  const baseline = ['docs/a.md'];
  const digest = createHash('sha256').update(baseline.join('\n')).digest('hex');
  const failures = checkAllowlistIntegrity(baseline, baseline, ['docs/never-here.md'], digest);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.path, 'docs/never-here.md');
  assert.match(failures[0]!.kind, /stale RESOLVED_SINCE_BASELINE entry/);
});

test('editing the frozen baseline changes the digest', () => {
  // Proves the pin is load-bearing rather than a constant that happens to match today.
  const tampered = [...UNREGISTERED_DOC_ALLOWLIST.slice(1), 'docs/sneaked-in.md'].join('\n');
  assert.notEqual(createHash('sha256').update(tampered).digest('hex'), ALLOWLIST_BASELINE_SHA256);
});
