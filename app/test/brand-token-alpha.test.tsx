/**
 * THE TWO WAYS A BRAND COLOUR SILENTLY BECOMES TRANSPARENT, banned repo-wide.
 *
 * ── 1. `/<alpha>` ON AN ARBITRARY `var()` COLOUR ────────────────────────────────────────────────
 * `bg-[var(--brand-accent)]/10` and every class of that shape emit NO RULE AT ALL. Tailwind's
 * alpha modifier has to rewrite the colour into a channel form to insert the alpha, which it can
 * only do for a value it can parse; an opaque `var()` is not one. It does not warn, `tsc` is happy,
 * `next build` is happy, and the element just has no such style.
 *
 * ⚠ 17 CLASSES IN THIS REPO WERE WRITTEN THAT WAY AND NONE OF THEM HAD EVER PAINTED (found and
 * fixed 2026-09-04, across cmd-explorer.tsx, tenant-tabs.tsx, multi-select-tag-picker.tsx and both
 * billable-days files). They were hover tints, focus halos, active-state fills — and twice a DATA
 * BAR, `<span class="absolute inset-y-0 left-0 bg-[var(--brand-accent)]/10" style={width:pct}>`,
 * i.e. a bar chart whose bars were invisible. Measured from the shipped stylesheet before the fix:
 * 31 `brand-accent` rules, ZERO carrying an alpha modifier; the class computed to `rgba(0,0,0,0)`
 * under every tenant theme. Nothing in the five-command gate can see this, which is why it lives
 * here.
 *
 * ── 2. A `var()` REFERENCE TO A TOKEN THAT IS NOT DECLARED ──────────────────────────────────────
 * `bg-[var(--brand-accent-a15)]` DOES emit a rule — one referencing a variable nothing defines, so
 * it also computes to transparent. Same symptom, same invisibility, and it is the obvious next
 * mistake now that the alpha steps are named by percentage: reach for a step that does not exist.
 * So every `--brand-*` token any class references must be declared in globals.css.
 *
 * The fix for both is the alpha-step scale in app/globals.css (`--brand-accent-a10`, …), built on
 * `color-mix`. Verified theme-aware, not assumed: with `data-view` on <html> — the same element
 * :root declares the steps on, which is what makes the substitution follow the tenant — one class
 * computes teal / BXR gold / Indigo violet across the three palettes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const globalsCss = readFileSync(join(appRoot, 'app/globals.css'), 'utf8');

/** Every source file that can carry a className, minus the test suite itself. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}
const files = ['app', 'components', 'lib'].flatMap((d) => sources(join(appRoot, d)));

/**
 * Comment-stripped, because the ban has to be checked against CODE. The docblocks that fixed this
 * bug legitimately quote the broken form to stop it coming back — the same trap, and the same
 * solution, as the `explorerCode` copy in collections-grid-scrollport.test.tsx. A prose match would
 * fail for the wrong reason, and the obvious way to make it pass again is to delete the warning.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no class applies an /alpha modifier to an arbitrary var() colour — it emits nothing', () => {
  const alphaOnVar = /-\[var\((--[a-z0-9-]+)\)\]\/\d+/g;
  const offenders: string[] = [];
  for (const f of files) {
    const code = strip(readFileSync(f, 'utf8'));
    for (const line of code.split('\n')) {
      for (const m of line.matchAll(alphaOnVar)) offenders.push(`${relative(appRoot, f)}  ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these emit NO CSS — use an alpha step from globals.css (e.g. var(--brand-accent-a10)):\n  ${offenders.join('\n  ')}`,
  );
});

test('every --brand-* token a class references is actually declared', () => {
  // An undeclared var still emits a rule, so it is transparent rather than absent — invisible in
  // exactly the same way, and not catchable by the assertion above.
  const declared = new Set([...globalsCss.matchAll(/^\s*(--brand-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
  assert.ok(declared.size >= 13, `expected the brand tokens + alpha steps to be declared, found ${declared.size}`);
  const missing: string[] = [];
  for (const f of files) {
    const code = strip(readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/var\((--brand-[a-z0-9-]+)\)/g)) {
      if (!declared.has(m[1]!)) missing.push(`${relative(appRoot, f)}  var(${m[1]}) is not declared in globals.css`);
    }
  }
  assert.deepEqual(missing, [], `undeclared brand tokens compute to transparent:\n  ${missing.join('\n  ')}`);
});

test('the alpha-step scale is built with color-mix and lives on :root', () => {
  // color-mix is the working equivalent, and was already the house pattern (--m3-rail-indicator).
  const steps = [...globalsCss.matchAll(/(--brand-(?:accent|soft)-a\d+):\s*([^;]+);/g)];
  assert.ok(steps.length >= 9, `expected >=9 alpha steps, found ${steps.length}`);
  for (const [, name, value] of steps) {
    assert.match(value!, /^color-mix\(in srgb, var\(--brand-(?:accent|soft)\) \d+%, transparent\)$/, `${name} must be a color-mix of its base token`);
    // The percentage in the NAME must be the percentage in the VALUE, or a reader picking `a25`
    // silently gets some other tint.
    const pct = name!.match(/-a(\d+)$/)![1];
    assert.match(value!, new RegExp(`\\) ${pct}%,`), `${name} must mix at ${pct}%`);
  }
  // ⚠ ON :root, NOT ON A [data-view] BLOCK. A custom property containing var() is substituted at
  // computed-value time on the element that DECLARES it, so a step declared on :root === <html>
  // picks up whatever --brand-accent the active [data-view] rule set on that same element. Declared
  // one level down instead, it would freeze to the default teal for every tenant.
  const rootBlock = globalsCss.slice(globalsCss.indexOf(':root {'), globalsCss.indexOf('[data-view='));
  for (const [, name] of steps) assert.ok(rootBlock.includes(`${name}:`), `${name} must be declared in the :root block`);
});
