/**
 * A `'use server'` module may export ONLY async functions. Everything else — an object, an array, a
 * string, a class, a plain (non-async) function — is registered by Next's flight loader as a Server
 * Action and then throws at RUNTIME on first require of the page's action entry:
 *
 *     ⨯ Error: A "use server" file can only export async functions, found object.
 *
 * WHY THIS TEST EXISTS RATHER THAN TRUSTING THE BUILD. `V3_INITIAL_STATE` (a plain object) shipped
 * from `app/lib/qualify/v3-actions.ts` to production. `next build` PASSED, `tsc` passed, both test
 * suites passed — the entire five-command gate was green. The check is deferred to runtime, and the
 * generated action entry is SHARED per page: the built `server-reference-manifest` placed
 * `getQualifyOverview` and `V3_INITIAL_STATE` in the same worker/moduleId for `app/qualify/page`, so
 * requiring it threw and ALL 19 Qualify Server Actions 500'd. The page GET kept rendering (rendering
 * never requires the action entry), so the surface looked alive while every data call died — "Couldn't
 * load the book overview", no Heating-Up ticker, blank KPI tiles, and no server log naming the cause.
 *
 * So: the build cannot catch this class, and the symptom does not point at it. This test does.
 *
 * Deliberately a STATIC scan, not an import: importing a `'use server'` module outside a Next build
 * pulls the whole server graph (pg pools, env reads) into the hermetic suite. Regex over source is
 * the right tool — it is also why the patterns below are conservative and explained individually.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', '.next', 'test', 'dist', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** True when the file's FIRST non-comment, non-blank statement is the 'use server' directive. */
function isUseServerModule(src: string): boolean {
  const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const raw of withoutBlockComments.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    return /^['"]use server['"];?$/.test(line);
  }
  return false;
}

/**
 * Export statements that are ILLEGAL in a 'use server' module. Each pattern targets a runtime value;
 * `export type`, `export interface` and `export type { ... }` are all erased at compile time and so
 * are explicitly permitted.
 */
const ILLEGAL_EXPORT_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
  // `export const X = ...` / `export let` / `export var` — the exact defect that shipped.
  { re: /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/, what: 'a variable (only async functions may be exported)' },
  // `export function X` WITHOUT async.
  { re: /^export\s+function\s+([A-Za-z_$][\w$]*)/, what: 'a non-async function' },
  { re: /^export\s+default\s+function\s+(?!.*async)/, what: 'a non-async default function' },
  { re: /^export\s+class\s+([A-Za-z_$][\w$]*)/, what: 'a class' },
  // `export { X }` re-exports a binding whose async-ness this file cannot vouch for. `export type { X }`
  // is excluded by the negative lookahead.
  { re: /^export\s+\{(?![^}]*\btype\b)/, what: 'a value re-export (its async-ness is not verifiable here)' },
  { re: /^export\s+\*\s+from/, what: 'a star re-export' },
];

test("every 'use server' module exports only async functions", () => {
  const files = walk(APP_ROOT);
  const useServerFiles: string[] = [];
  const violations: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!isUseServerModule(src)) continue;
    const rel = file.slice(APP_ROOT.length);
    useServerFiles.push(rel);

    src.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line.startsWith('export')) return;
      // Erased at compile time — always legal.
      if (/^export\s+(type|interface)\s/.test(line)) return;
      if (/^export\s+async\s+function\s/.test(line)) return;
      if (/^export\s+default\s+async\s+function/.test(line)) return;

      for (const { re, what } of ILLEGAL_EXPORT_PATTERNS) {
        if (re.test(line)) {
          violations.push(`${rel}:${i + 1} exports ${what} — ${line.slice(0, 90)}`);
          return;
        }
      }
    });
  }

  // Guard the guard: if the walk stops finding 'use server' modules, this test has silently stopped
  // testing anything. The app has many; assert a floor rather than trusting the scan.
  assert.ok(
    useServerFiles.length >= 5,
    `expected to find several 'use server' modules, found ${useServerFiles.length} — the scan is broken, not the code`,
  );

  assert.deepEqual(
    violations,
    [],
    `A 'use server' file may export ONLY async functions. These throw at RUNTIME (next build does NOT catch them) ` +
      `and take down EVERY Server Action on any page that reaches the module:\n  ${violations.join('\n  ')}\n` +
      `Fix: move the value into a plain (non-'use server') module and import it from there.`,
  );
});
