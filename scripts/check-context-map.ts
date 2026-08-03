/**
 * Guard for the "## Canonical Context Set" section of root CLAUDE.md.
 *
 * Why this exists: CC prompts kept hardcoding doc paths that drifted
 * (00-GUIDE.md moved into `docs/Fable Build Doc E2E/`, docs/CLAUDE.md became
 * root CLAUDE.md, `docs/CMD AR Automation — Build Doc v2.md` was cited for
 * weeks while never existing). CLAUDE.md is now the single map, and this script
 * makes a `git mv` fail a gate instead of silently rotting that map.
 *
 * Three assertions:
 *   1. every canonical-table path resolves on disk
 *   2. every NOT-IN-REPO path does NOT resolve (if one lands, the map is lying)
 *   3. every SUPERSEDED path still resolves (they are real, just frozen)
 *
 * Parsing is structural: locate the level-2 section by heading text, find the
 * table inside it whose header cells are Role/Path/Read-order, split body rows
 * on pipes, and read the path out of the cell's inline-code span. No matching
 * on filenames or extensions — renaming a doc must be detected, not tolerated.
 *
 * Known gap: this checks the working tree, not `git ls-tree HEAD`. A path that
 * exists locally but is uncommitted passes here and would 404 on a fresh clone.
 * Untracked docs therefore belong under "### Uncommitted — not guarded", not in
 * the table. (A HEAD check needs child_process, which the repo security hook
 * rejects; revisit if a vetted exec helper lands.)
 *
 * Run standalone:  npx tsx scripts/check-context-map.ts
 * Runs in root `npm test` via test/contextMap.test.ts
 */

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

export function loadContextMap(repoRoot: string = REPO_ROOT): ContextMap {
  return parseContextMap(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8'));
}

export function loadAndCheck(repoRoot: string = REPO_ROOT): Failure[] {
  return checkContextMap(loadContextMap(repoRoot), repoRoot);
}

function main(): void {
  let map: ContextMap;
  let failures: Failure[];
  try {
    map = loadContextMap();
    failures = checkContextMap(map);
  } catch (err) {
    console.error(`context-map: ${(err as Error).message}`);
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`context-map: ${failures.length} failure(s) in CLAUDE.md § ${SECTION_HEADING}`);
    for (const f of failures) {
      console.error(`  ✗ ${f.path}\n      ${f.kind} — ${f.detail}`);
    }
    console.error('\nFix the path in CLAUDE.md, or move the file back. Do not delete the row.');
    process.exit(1);
  }
  console.log(
    `context-map: OK — ${map.canonical.length} canonical, ` +
      `${map.superseded.length} superseded, ${map.notInRepo.length} not-in-repo`,
  );
}

// Run the CLI only when invoked directly, not when imported by the test suite.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
