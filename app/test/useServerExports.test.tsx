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
import { fileURLToPath } from 'node:url';

/**
 * Directory of the module one level above `url`, as a real filesystem path.
 *
 * `URL.pathname` is NOT a filesystem path — it is percent-encoded and, on Windows, carries a
 * leading slash before the drive letter. A checkout under a path containing a space yields
 * '/repo/a%20b/' and `readdirSync` then throws ENOENT before the scan runs, which would turn this
 * guard off silently in exactly the environments least like a developer laptop. `fileURLToPath`
 * is the supported conversion. It keeps the trailing slash, so the `file.slice(APP_ROOT.length)`
 * relative-path trick below is unchanged.
 */
function moduleDirFromUrl(url: string): string {
  return fileURLToPath(new URL('..', url));
}

const APP_ROOT = moduleDirFromUrl(import.meta.url);
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

/**
 * ⚠ THIS IS AN AST SCAN, NOT A REGEX SCAN, AND THAT IS THE WHOLE POINT.
 *
 * It was line-based, first as a denylist of "known bad" patterns and then as an allowlist. An
 * adversarial sweep broke BOTH, because a line is not a statement:
 *
 *   export async function ok() {} export const BAD = {};   // legal head, object smuggled after it
 *   } export const V3_INITIAL_STATE = {};                  // line does not start with `export`
 *   @log export class Registry {}                          // decorator first
 *
 * and it rejected code that is perfectly safe:
 *
 *   export const submitForm = async () => {};   // Next's own rule accepts this
 *   export declare const FLAG: boolean;         // ambient — emits zero bytes
 *   export {}; // with a trailing comment       // exports nothing
 *
 * Every one of those is an artefact of pretending lines are statements. Patching them individually
 * is the same mistake one level up. `typescript` is already a devDependency, so we parse: statements
 * are statements, `declare` is visible as a modifier, and "is this export erased or a runtime value"
 * becomes a property of the tree instead of a guess.
 */
import ts from 'typescript';

function parse(src: string, fileName = 'module.ts'): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/**
 * Provably a function at runtime from syntax alone. An arrow or function expression qualifies; a
 * call expression (`withAuth(async () => {})`) does not — it may return anything, and this guard
 * refuses to guess. Restructure to a declaration if you hit that.
 */
function isProvablyFunction(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e);
}

/** True when the module's first statement is the 'use server' directive. */
function isUseServerModule(src: string, fileName?: string): boolean {
  if (!/['"]use server['"]/.test(src)) return false; // cheap reject before paying for a parse
  const first = parse(src, fileName).statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

/**
 * Every illegal export in a source file, as `{ line, what }` (1-indexed).
 *
 * Exported so the rule set is unit-testable against synthetic sources — the filesystem scan below
 * and the unit tests exercise the SAME function, so neither can drift from the other.
 */
export function findIllegalExports(src: string, fileName?: string): Array<{ line: number; what: string }> {
  const sf = parse(src, fileName);
  const out: Array<{ line: number; what: string }> = [];
  const push = (n: ts.Node, what: string): void => {
    out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
  };

  for (const st of sf.statements) {
    // `export default <expr>` and the TS-only `export = <expr>`.
    if (ts.isExportAssignment(st)) {
      if (st.isExportEquals) push(st, 'a TS `export =` assignment');
      else if (!isProvablyFunction(st.expression)) {
        push(st, 'a default export that is not provably a function (object, identifier or literal)');
      }
      continue;
    }

    // `export { ... }`, `export * from`, `export type { ... }`.
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue; // erased
      const clause = st.exportClause;
      if (!clause) {
        push(st, 'a star re-export');
      } else if (ts.isNamespaceExport(clause)) {
        push(st, 'a namespace re-export');
      } else if (clause.elements.length === 0) {
        continue; // `export {}` / `export {} from '...'` — binds nothing at runtime
      } else if (clause.elements.every((e) => e.isTypeOnly)) {
        push(st, 'type-only specifiers in a value export — write `export type { T }` instead');
      } else {
        push(st, 'a value re-export (its async-ness is not verifiable here)');
      }
      continue;
    }

    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue; // ambient — emits nothing
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue; // erased

    if (ts.isFunctionDeclaration(st)) {
      if (!hasModifier(st, ts.SyntaxKind.AsyncKeyword)) push(st, 'a non-async function');
    } else if (ts.isClassDeclaration(st)) {
      push(st, 'a class');
    } else if (ts.isEnumDeclaration(st)) {
      push(st, 'an enum (a TS enum is a runtime object)');
    } else if (ts.isModuleDeclaration(st)) {
      push(st, 'a namespace (a runtime object)');
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!isProvablyFunction(d.initializer)) {
          push(d, 'a variable that is not provably a function (only async functions may be exported)');
        }
      }
    } else {
      // Fail CLOSED. An export form nobody anticipated is a failure here, not at 3am in production.
      push(st, 'an unrecognised export form (only async functions may be exported)');
    }
  }
  return out;
}

test("every 'use server' module exports only async functions", () => {
  const files = walk(APP_ROOT);
  const useServerFiles: string[] = [];
  const violations: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!isUseServerModule(src, file)) continue;
    const rel = file.slice(APP_ROOT.length);
    useServerFiles.push(rel);

    const lines = src.split('\n');
    for (const { line, what } of findIllegalExports(src, file)) {
      violations.push(`${rel}:${line} exports ${what} — ${lines[line - 1]!.trim().slice(0, 90)}`);
    }
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

// --- unit tests over the classifier -------------------------------------------------
// The filesystem scan above can only fail on defects that happen to be in the tree TODAY. These
// pin the RULE ITSELF against every export form, so a hole is caught the day it is opened rather
// than the day it ships. The corpus below came from an adversarial sweep that ran each candidate
// through tsc and the live classifier; every entry is a form that was actually mishandled.

/** Snippets are appended to a 'use server' directive and classified as a whole module. */
const MOD = "'use server';\n";
const flagged = (snippet: string): boolean => findIllegalExports(MOD + snippet).length > 0;

/** Forms that MUST be rejected — each ships a runtime non-function out of a 'use server' module. */
const ILLEGAL: ReadonlyArray<[string, string]> = [
  ['export const X = {};', 'the exact defect that took down /qualify'],
  ['export let x = 1;', 'mutable binding'],
  ['export var x = 1;', 'var binding'],
  ['export function f() {}', 'non-async function'],
  ['export class C {}', 'class'],
  ['export { x };', 'value re-export'],
  ['export { x } from "./y";', 'value re-export from'],
  ['export * from "./y";', 'star re-export'],
  ['export default {};', 'default object literal — the "found object" class'],
  ['export default { a: 1 };', 'default object with members'],
  ['export default class Foo {}', 'default class'],
  ['export default someIdentifier;', 'default identifier'],
  ['export default 42;', 'default literal'],
  ['export default function f() {}', 'default non-async function'],
  ['export enum E { A }', 'enum — a runtime object in TS'],
  ['export namespace N { export const a = 1; }', 'namespace — a runtime object'],
  ['export { type T, value };', 'MIXED type + value: the value still ships'],
  ['export { value, type T };', 'mixed, value first'],
  // MULTI-STATEMENT LINES. A line-based scanner matches the legal head and never sees the tail.
  // Every one of these was verified to compile and to smuggle a runtime object past the guard.
  ['export async function ok() {} export const BAD = {};', 'legal head hides an object on the same line'],
  ['export default async function f() {} export const CACHE = {};', 'same, via the default form'],
  ['export type T = string; export const X = {};', 'erased head hides a value'],
  ['export interface State { a: number } export const INITIAL: State = { a: 0 };', 'interface needs no semicolon'],
  // A LEADING TOKEN means the line does not start with `export` at all.
  ['export async function g() {} } export const V3 = {};', 'closing brace before the export'],
  ['/** @deprecated */ export const V3_INITIAL_STATE = {};', 'doc comment before the export'],
  ['@log export class Registry { name = "r"; }', 'decorator before the export'],
  // Not statically provable to be a function. Documented policy: restructure to a declaration.
  ['export const submitVob = withAuth(async (f) => f);', 'a call expression is not provably a function'],
];

/** Forms that MUST be permitted — erased at compile time, or provably a function. */
const LEGAL: ReadonlyArray<[string, string]> = [
  ['export async function f() {}', 'the canonical action form'],
  ['export default async function f() {}', 'default async action'],
  ['export async function* stream() {}', 'async generator is still a function'],
  ['export type Foo = string;', 'erased at compile time'],
  ['export interface Bar { a: string }', 'erased'],
  ['export type { Foo };', 'type-only re-export is erased'],
  ['export type{Foo};', 'the space before the brace is optional in TS'],
  ['export {};', 'exports nothing at runtime'],
  ['export {}; // keep this file a module', 'a trailing comment changes nothing'],
  ['export {} from "./side";', 'empty specifier list re-exports no bindings'],
  // Ambient declarations emit ZERO bytes, so they can never reach the flight loader.
  ['export declare const FEATURE_FLAG: boolean;', 'ambient const is erased'],
  ['export declare function legacyHelper(x: string): void;', 'ambient function is erased'],
  ['export declare enum AmbientEnum { A }', 'ambient enum is erased, unlike a real one'],
  ['export declare namespace Cfg { const a: number; }', 'ambient namespace is erased'],
  // Provably functions at runtime — Next\'s own server-boundary rule accepts these.
  ['export const submitForm = async () => {};', 'async arrow is a first-class action form'],
  ['export const act = async function (x: string) { return x; };', 'async function expression'],
  ['export default async () => {};', 'anonymous default async arrow'],
  ['export default (async function () {});', 'parenthesized async function expression'],
  // Wrapped across lines — a statement is not a line.
  ['export\nasync function f() {}', 'wrap after `export`'],
  ['export async\n  function f() {}', 'wrap before the name'],
  ['export async /* keep the name here */ function f() {}', 'inline comment inside the signature'],
  ['const x = 1;', 'not an export at all'],
  ['// export const X = 1;', 'a comment, not an export'],
];

test('classifier rejects every illegal export form', () => {
  const missed = ILLEGAL.filter(([s]) => !flagged(s)).map(([s, why]) => `${s}   (${why})`);
  assert.deepEqual(missed, [], `these illegal forms were NOT caught:\n  ${missed.join('\n  ')}`);
});

test('classifier permits every legal export form', () => {
  const wrong = LEGAL.filter(([s]) => flagged(s)).map(([s, why]) => `${s}   (${why})`);
  assert.deepEqual(wrong, [], `these LEGAL forms were wrongly flagged:\n  ${wrong.join('\n  ')}`);
});

test('findIllegalExports reports 1-indexed line numbers', () => {
  const src = ["'use server';", '', 'export async function ok() {}', 'export const bad = {};'].join('\n');
  assert.deepEqual(findIllegalExports(src).map((v) => v.line), [4]);
});

test('APP_ROOT resolution decodes percent-encoding rather than using URL.pathname', () => {
  // A URL pathname is percent-encoded: a repo checked out under a path with a space yields
  // '/tmp/a%20b/', and readdirSync then throws ENOENT before the scan ever runs.
  assert.equal(moduleDirFromUrl('file:///tmp/a%20b/test/x.ts'), '/tmp/a b/');
});
