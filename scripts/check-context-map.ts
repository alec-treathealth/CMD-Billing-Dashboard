/**
 * Guard for the "## Canonical Context Set" section of root CLAUDE.md.
 *
 * Why this exists: CC prompts kept hardcoding doc paths that drifted
 * (00-GUIDE.md moved into `docs/Fable Build Doc E2E/`, docs/CLAUDE.md became
 * root CLAUDE.md, `docs/CMD AR Automation — Build Doc v2.md` was cited for
 * weeks while never existing). CLAUDE.md is now the single map, and this script
 * makes a `git mv` fail a gate instead of silently rotting that map.
 *
 * Four assertions. 1-3 run FORWARD (table -> disk); 4 runs BACKWARD (disk -> table):
 *   1. every canonical-table path resolves on disk
 *   2. every NOT-IN-REPO path does NOT resolve (if one lands, the map is lying)
 *   3. every SUPERSEDED path still resolves (they are real, just frozen)
 *   4. every tracked documentation file appears in the table (or on the allowlist)
 *
 * WHY 4 EXISTS, AND WHY ITS ABSENCE WAS INVISIBLE. Until 2026-08-30 this guard was
 * FORWARD-ONLY: it proved every LISTED path resolves, and never that every tracked doc
 * is LISTED. So `npm test` stayed green while an unregistered doc sat in the tree, in
 * violation of CLAUDE.md's "A doc is either in the table above or it is deleted —
 * 'untracked' is not a third state". Nothing reported the gap, because a forward-only
 * check cannot: the set it iterates is the set it is supposed to be auditing.
 *
 * Parsing is structural: locate the level-2 section by heading text, find the
 * table inside it whose header cells are Role/Path/Read-order, split body rows
 * on pipes, and read the path out of the cell's inline-code span. No matching
 * on filenames or extensions — renaming a doc must be detected, not tolerated.
 *
 * ASYMMETRY, ON PURPOSE. Assertions 1-3 read the WORKING TREE; assertion 4 reads the
 * GIT INDEX. That is not an oversight:
 *   - Forward, the working tree is the right question — a listed path must be readable
 *     by the session reading CLAUDE.md right now.
 *   - Backward, tracked-ness is the ONLY defensible question. A filesystem walk would
 *     fail the gate on a teammate's local scratch note, making the result depend on an
 *     uncommitted working tree and disagree machine-to-machine. A gate that fires on
 *     files no one else can see is a gate people learn to ignore.
 * The forward half's own gap therefore stands unchanged: a path that exists locally but
 * is uncommitted still passes 1-3 and would 404 on a fresh clone.
 *
 * ⚠ THIS HEADER CLAIMED `child_process` WAS "rejected by the repo security hook" AND
 * THAT WAS FALSE — it was the stated reason assertion 4 was never built. The repo's only
 * hook is `.claude/hooks/session-start.sh`, which pins the git author identity and
 * inspects no tool call; `src/auth.ts:11` has imported `node:child_process` in
 * production source the whole time. A blocker recorded in a comment and never re-tested
 * outlives the thing it described. `execFileSync` is used below with an ARGUMENT ARRAY
 * and no shell, so no path or pathspec is ever interpolated into a command line.
 *
 * Run standalone:  npx tsx scripts/check-context-map.ts
 * Runs in root `npm test` via test/contextMap.test.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

const SECTION_HEADING = 'Canonical Context Set';
const NOT_IN_REPO_HEADING = 'NOT IN REPO';
const SUPERSEDED_HEADING = 'Superseded in repo';
const TABLE_HEADER = ['role', 'path', 'read-order'];

export type CanonicalEntry = {
  /** The Role cell, verbatim. */
  role: string;
  /** Repo-relative path, unwrapped from its inline-code span. */
  path: string;
  /** The Read-order cell parsed as an integer. */
  readOrder: number;
};

export type ContextMap = {
  canonical: CanonicalEntry[];
  notInRepo: string[];
  superseded: string[];
};

export type Failure = { kind: string; path: string; detail: string };

/** A markdown ATX heading, or null. Returns the level and the trimmed text. */
function parseHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1]!.length, text: m[2]!.trim() };
}

/** Split one markdown table row into trimmed cells, dropping the edge pipes. */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

/** True for a `|---|:--:|` style delimiter row. */
function isDelimiterRow(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/**
 * Pull the single inline-code span out of a markdown cell or list item.
 * This is a regex over markdown syntax (backticks), NOT over path shape — the
 * guard must not care whether a path looks like a filename.
 */
function codeSpan(text: string, context: string): string {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  if (spans.length !== 1) {
    throw new Error(
      `${context}: expected exactly one \`inline-code\` path, found ${spans.length} in ${JSON.stringify(text)}`,
    );
  }
  return spans[0]!;
}

/** Lines of the level-2 section with the given heading text, exclusive of the heading. */
function sectionLines(lines: string[], heading: string): string[] {
  const startIdx = lines.findIndex((l) => {
    const h = parseHeading(l);
    return h?.level === 2 && h.text === heading;
  });
  if (startIdx === -1) {
    throw new Error(`CLAUDE.md: no "## ${heading}" section found`);
  }
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => {
    const h = parseHeading(l);
    return h !== null && h.level <= 2;
  });
  return endIdx === -1 ? rest : rest.slice(0, endIdx);
}

/** Contiguous runs of pipe-leading lines — one run per markdown table. */
function tableRuns(lines: string[]): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      current.push(line);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * A list item's path is the inline-code span in *leading* position, so the
 * trailing prose stays free to cite other paths (`.claude/rules/` etc.).
 */
function leadingCodeSpan(line: string, context: string): string {
  const m = /^\s*[-*]\s+`([^`]+)`/.exec(line);
  if (!m) {
    throw new Error(
      `${context}: item must start with a \`inline-code\` path, got ${JSON.stringify(line.trim())}`,
    );
  }
  return m[1]!.trim();
}

/** Bullet items under the level-3 sub-heading whose text starts with `prefix`. */
function subListItems(lines: string[], prefix: string): string[] {
  const startIdx = lines.findIndex((l) => {
    const h = parseHeading(l);
    return h?.level === 3 && h.text.startsWith(prefix);
  });
  if (startIdx === -1) {
    throw new Error(`CLAUDE.md: no "### ${prefix}…" sub-heading under ## ${SECTION_HEADING}`);
  }
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => parseHeading(l) !== null);
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return body
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l, i) => leadingCodeSpan(l, `### ${prefix} item ${i + 1}`));
}

export function parseContextMap(markdown: string): ContextMap {
  const lines = markdown.split('\n');
  const section = sectionLines(lines, SECTION_HEADING);

  const table = tableRuns(section).find((run) => {
    if (run.length < 3 || !isDelimiterRow(run[1]!)) return false;
    const header = tableCells(run[0]!).map((c) => c.toLowerCase());
    return header.length === TABLE_HEADER.length && TABLE_HEADER.every((h, i) => header[i] === h);
  });
  if (!table) {
    throw new Error(`## ${SECTION_HEADING}: no table with header ${TABLE_HEADER.join(' | ')}`);
  }

  const canonical = table.slice(2).map((row, i) => {
    const cells = tableCells(row);
    if (cells.length !== TABLE_HEADER.length) {
      throw new Error(
        `## ${SECTION_HEADING} row ${i + 1}: expected ${TABLE_HEADER.length} cells, got ${cells.length}`,
      );
    }
    const readOrder = Number(cells[2]);
    if (!Number.isInteger(readOrder)) {
      throw new Error(
        `## ${SECTION_HEADING} row ${i + 1}: Read-order ${JSON.stringify(cells[2])} is not an integer`,
      );
    }
    return {
      role: cells[0]!,
      path: codeSpan(cells[1]!, `## ${SECTION_HEADING} row ${i + 1}`),
      readOrder,
    };
  });

  return {
    canonical,
    notInRepo: subListItems(section, NOT_IN_REPO_HEADING),
    superseded: subListItems(section, SUPERSEDED_HEADING),
  };
}

export function checkContextMap(map: ContextMap, repoRoot: string = REPO_ROOT): Failure[] {
  const failures: Failure[] = [];

  for (const entry of map.canonical) {
    if (!existsSync(join(repoRoot, entry.path))) {
      failures.push({
        kind: 'canonical path missing on disk',
        path: entry.path,
        detail: `listed as read-order ${entry.readOrder} ("${entry.role}") but does not resolve`,
      });
    }
  }

  const order = map.canonical.map((e) => e.readOrder);
  const expected = order.map((_, i) => i + 1);
  if (order.join(',') !== expected.join(',')) {
    failures.push({
      kind: 'read-order not 1..N',
      path: 'CLAUDE.md',
      detail: `read-order column is [${order.join(', ')}], expected [${expected.join(', ')}]`,
    });
  }

  for (const p of map.notInRepo) {
    if (existsSync(join(repoRoot, p))) {
      failures.push({
        kind: 'NOT-IN-REPO path resolves',
        path: p,
        detail: 'declared project-knowledge-only but now exists — the map is lying',
      });
    }
  }

  for (const p of map.superseded) {
    if (!existsSync(join(repoRoot, p))) {
      failures.push({
        kind: 'superseded path missing on disk',
        path: p,
        detail: 'listed as a frozen in-repo snapshot but does not resolve',
      });
    }
  }

  return failures;
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * Assertion 4 — the reverse direction: every tracked doc must be in the table.
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * WHICH TRACKED FILES COUNT AS "documentation", and why it is `.md` alone.
 *
 * Read from how the repo actually scopes the word rather than assumed. Three inputs:
 *
 *   - The table MAY list a non-`.md` file, and does: `pr_compliance_checklist.yaml` sits at
 *     read-order 4. So table membership is not `.md`-only, and this check deliberately does
 *     NOT assert the converse — a row may point at any path. The relation asserted here is
 *     one-way: every tracked `.md` is in the table. Not: everything in the table is `.md`.
 *   - That yaml is listed for its CONTENT ("PR compliance rules — the real Qodo content"),
 *     not because `.yaml` is a documentation format. Generalising from it would sweep in
 *     `.github/workflows/*.yml` and `requirements-brain{1,2,3}.txt` — CI config and pip
 *     manifests. Those are configuration. Calling them docs would force either registering
 *     config in a prose table or padding the allowlist with files nobody will ever triage,
 *     and both make the table mean less.
 *   - Nothing is lost by the narrower scope: every tracked file in this repo that reads as
 *     prose documentation is already `.md`. The only non-`.md` candidates are the three
 *     `requirements-brain*.txt` pip manifests, three `.github/workflows/*.yml`, and the one
 *     `.yaml` already in the table — none of them prose.
 *
 * So: `.md` is the scope, stated rather than inferred. If a genuine `.rst`/`.adoc`/`.txt`
 * doc ever lands, widen this array in the same change that adds it — do not let the first
 * one in on the grounds that the guard did not happen to cover its extension.
 */
const DOC_EXTENSIONS: readonly string[] = ['.md'];

/**
 * Structurally out of scope — NOT backlog, and NOT allowlist material.
 *
 * CLAUDE.md says so itself, in the paragraph directly under the canonical table:
 * "Path-scoped rules in `.claude/rules/` load automatically and are not listed here".
 * They are a different artifact kind — auto-loaded, path-triggered rules, not cold-start
 * reading — so they will never be triaged INTO the table and must never age out of an
 * allowlist that is meant to reach zero.
 */
const OUT_OF_SCOPE_PREFIXES: readonly string[] = ['.claude/rules/'];

/**
 * ⚠ DATED BACKLOG ALLOWLIST — CREATED 2026-08-30. IT MAY ONLY EVER SHRINK.
 *
 * WHAT THIS IS: the exact set of tracked docs that were already unregistered on the day
 * assertion 4 was switched on. They are a violation of CLAUDE.md's "a doc is either in the
 * table above or it is deleted" — every one of them. They are listed here, individually and
 * by hand, so the assertion could go live for anything NEW without silently ratifying the
 * backlog. A NEW unregistered doc fails the gate on day one; these 52 stay visible instead
 * of being laundered into "passing".
 *
 * ⚠ ADDING A PATH HERE IS A RULE VIOLATION, NOT A NORMAL EDIT. It is not the way to make a
 * failing gate go green. If this check fails on a doc you touched, you have exactly two
 * legitimate moves, both named by CLAUDE.md: REGISTER it in the Canonical Context Set, or
 * DELETE it. Growing this array is the third state the rule exists to forbid — it converts
 * a one-time, dated, shrinking debt into an open-ended exemption, at which point the guard
 * asserts nothing. A reviewer seeing a `+` line in this array should treat it as the finding.
 *
 * HOW IT SHRINKS: `checkUnregisteredDocs` reports any entry that is no longer a tracked,
 * unregistered doc. Register one of these and the stale entry FAILS the gate until it is
 * removed from this array, so the list cannot rot into a fiction of the backlog's size.
 * `test/contextMap.test.ts` additionally pins the length as a ratchet.
 *
 * NOT triaged here on purpose: which of the 52 are live, which are frozen snapshots, and
 * which should be deleted is 52 separate judgements that belong to Alec, not to the change
 * that installs the guard.
 */
/** Exact membership baseline captured when the allowlist was created. Entries may only be removed. */
export const ALLOWLIST_INITIAL_PATHS: readonly string[] = [
  'INT-INGEST-DIAGNOSIS-ROUND2.md',
  'MARKET_VALIDATION.md',
  'NO-FACILITY-ATTRIBUTION-FEASIBILITY.md',
  'NO-FACILITY-CUSTOMER-ID-LEVER.md',
  'QUALIFY-AUDIT-2026-08-12.md',
  'app/README.md',
  'docs/BH-Payer-Policy-Report-All-Payers-2026-08-09.md',
  'docs/DATABASE-SCHEMA-HANDOFF.md',
  'docs/PERF-PROMPT-2026-08-03.md',
  'docs/Qualify v2 — design prototype prompt.md',
  'docs/UHC-93-code-exposure-2026-08-10.md',
  'docs/archive/billing-audit-consolidated-reports.md',
  'docs/archive/code-intel-AUDIT.md',
  'docs/archive/fable-build-doc-e2e/02-session-tenancy-foundation.md',
  'docs/archive/fable-build-doc-e2e/03-session-etl-reference-data.md',
  'docs/archive/fable-build-doc-e2e/04-session-python-ml-runtime.md',
  'docs/archive/fable-build-doc-e2e/05-session-auth.md',
  'docs/archive/fable-build-doc-e2e/06-session-cmd-ingest-indigo.md',
  'docs/archive/fable-build-doc-e2e/07-session-production-readiness-gate.md',
  'docs/archive/fable-build-doc-e2e/08-session-era-835-ingestion.md',
  'docs/archive/fable-build-doc-e2e/09-session-agent-validation.md',
  'docs/archive/fable-build-doc-e2e/10-session-veris-ui.md',
  'docs/archive/fable-build-doc-e2e/11-session-mcp-servers.md',
  'docs/archive/fable-build-doc-e2e/12-session-evals-observability.md',
  'docs/archive/fable-build-doc-e2e/13-session-gtm-instrumentation.md',
  'docs/archive/veris-runbook.md',
  'docs/cc-prompts-design-unification.md',
  'docs/mockups/qualify-smoke-NOTES.md',
  'docs/monday-census-board-architecture.md',
  'docs/payer-intel-HANDOFF-2026-08-03.md',
  'docs/qualify-current-status.md',
  'docs/qualify-redesign-HANDOFF.md',
  'docs/qualify-redesign-cc-prompt.md',
  'docs/qualify-v2-build-plan.md',
  'docs/qualify-v2-morning-runbook.md',
  'docs/qualify-v3-followups-handoff.md',
  'docs/qualify-v3-search-pattern.md',
  'docs/qualify-watchers-handoff.md',
  'docs/upcoming-payments-HANDOFF.md',
  'etl/vob/HANDOFF.md',
  'etl/vob/docs/vob_extraction_recon_and_build.md',
  'etl/vob/docs/vob_supabase_load_plan.md',
  'qualify-prompts/00-INDEX.md',
  'qualify-prompts/OON-1-reimbursement-and-denial-recovery.md',
  'qualify-prompts/WAVE-1-correctness-and-exposure.md',
  'qualify-prompts/WAVE-2-operational.md',
  'qualify-prompts/WAVE-3-accessibility.md',
  'qualify-prompts/WAVE-4-ux-restructure.md',
  'qualify-prompts/WAVE-5-followups-and-backlog.md',
  'qualify-v3-search-rearchitecture-PROMPT.md',
  'scripts/payer-ml/README.md',
  'test/fixtures/kipu-billing-report/README.md',
] as const;

/** The current exemption set is a copy so it can shrink, but never replace baseline paths. */
export const UNREGISTERED_DOC_ALLOWLIST: readonly string[] = [...ALLOWLIST_INITIAL_PATHS];

/** The size of the allowlist on the day it was created. It may go DOWN; never up. */
export const ALLOWLIST_CREATED = '2026-08-30';
export const ALLOWLIST_INITIAL_SIZE = 52;

function isDoc(path: string): boolean {
  return DOC_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function inScope(path: string): boolean {
  return isDoc(path) && !OUT_OF_SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Tracked documentation files, repo-relative, from the git index.
 *
 * `-z` because two tracked docs carry spaces and an em dash in their names
 * ("CMD AR Automation — Build Doc v2.md"); newline-splitting corrupts those. The argument
 * array means no shell, so the pathspec is never string-interpolated.
 *
 * THROWS if git is unavailable or this is not a checkout. That is deliberate — the failure
 * mode being avoided is the one that made assertion 4 necessary in the first place: a check
 * that cannot see its input must not report success. Fail loud, never fail open.
 */
export function listTrackedDocs(repoRoot: string = REPO_ROOT): string[] {
  const pathspecs = DOC_EXTENSIONS.map((ext) => `*${ext}`);
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `context-map: cannot list tracked docs via git (${(err as Error).message}). ` +
        'Assertion 4 needs the git index; it will not report success without it.',
    );
  }
  return out.split('\0').filter(Boolean).filter(inScope).sort();
}

/**
 * Assertion 4. Pure over its inputs — `trackedDocs` is injected so the unit tests can
 * exercise it against synthetic lists with no git and no disk.
 */
export function checkUnregisteredDocs(
  map: ContextMap,
  trackedDocs: readonly string[],
  allowlist: readonly string[] = UNREGISTERED_DOC_ALLOWLIST,
): Failure[] {
  const failures: Failure[] = [];
  const registered = new Set([...map.canonical.map((e) => e.path), ...map.superseded]);
  const allowed = new Set(allowlist);
  const tracked = new Set(trackedDocs);

  for (const path of trackedDocs) {
    if (registered.has(path) || allowed.has(path)) continue;
    failures.push({
      kind: 'tracked doc not in the Canonical Context Set',
      path,
      detail:
        'CLAUDE.md: a doc is either in the table or it is deleted. Register it (add a row ' +
        'and renumber read-order) or delete it. Do NOT add it to UNREGISTERED_DOC_ALLOWLIST.',
    });
  }

  // The shrink ratchet: an allowlist entry that is no longer a tracked, unregistered doc has
  // been resolved, so the exemption must go with it. Without this the array would keep
  // claiming a backlog that no longer exists.
  for (const path of allowlist) {
    if (!tracked.has(path)) {
      failures.push({
        kind: 'stale allowlist entry',
        path,
        detail: `no longer a tracked in-scope doc — remove it from UNREGISTERED_DOC_ALLOWLIST (created ${ALLOWLIST_CREATED})`,
      });
    } else if (registered.has(path)) {
      failures.push({
        kind: 'stale allowlist entry',
        path,
        detail: `now registered in the Canonical Context Set — remove it from UNREGISTERED_DOC_ALLOWLIST (created ${ALLOWLIST_CREATED})`,
      });
    }
  }

  return failures;
}

export function loadContextMap(repoRoot: string = REPO_ROOT): ContextMap {
  return parseContextMap(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8'));
}

export function loadAndCheck(repoRoot: string = REPO_ROOT): Failure[] {
  const map = loadContextMap(repoRoot);
  return [
    ...checkContextMap(map, repoRoot),
    ...checkUnregisteredDocs(map, listTrackedDocs(repoRoot)),
  ];
}

function main(): void {
  let map: ContextMap;
  let tracked: string[];
  let failures: Failure[];
  try {
    map = loadContextMap();
    tracked = listTrackedDocs();
    failures = [...checkContextMap(map), ...checkUnregisteredDocs(map, tracked)];
  } catch (err) {
    console.error(`context-map: ${(err as Error).message}`);
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`context-map: ${failures.length} failure(s) in CLAUDE.md § ${SECTION_HEADING}`);
    for (const f of failures) {
      console.error(`  ✗ ${f.path}\n      ${f.kind} — ${f.detail}`);
    }
    console.error(
      '\nForward failures (1-3): fix the path in CLAUDE.md, or move the file back — do not' +
        '\ndelete the row. Reverse failures (4): register the doc in the Canonical Context Set' +
        '\nor delete it. Adding it to UNREGISTERED_DOC_ALLOWLIST is a rule violation.',
    );
    process.exit(1);
  }
  const registered = new Set([...map.canonical.map((e) => e.path), ...map.superseded]);
  const backlog = tracked.filter((p) => !registered.has(p)).length;
  console.log(
    `context-map: OK — ${map.canonical.length} canonical, ` +
      `${map.superseded.length} superseded, ${map.notInRepo.length} not-in-repo, ` +
      `${tracked.length} tracked docs (${backlog} on the dated allowlist, target 0)`,
  );
}

// Run the CLI only when invoked directly, not when imported by the test suite.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
