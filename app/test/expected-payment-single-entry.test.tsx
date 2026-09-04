/**
 * ONE WAY TO RECORD AN EXPECTED PAYMENT, AND IT NEVER TOUCHES THE MONEY LEDGER.
 *
 * Ruling (Alec, 2026-09-04): *"There is nobody manually entering payments through this platform.
 * The payments land in CollaborateMD already. This feature is for them to track incoming payments
 * from a past collection or a future collection, like a paper check that came in late. The data
 * should not actually touch the database. The user should only see the one option."*
 *
 * Overview's "Add an expected payment" panel used to host TWO create forms:
 *   · one that wrote collections.daily_collections (source_tag='manual', 0096) and therefore moved
 *     MTD, the All Facilities table and the Master chart — REMOVED;
 *   · one that writes staging.expected_payment_manual (024) and moves none of them — KEPT.
 *
 * The production record behind the removal: 2 manual deposits ever created, BOTH later removed
 * (a 100% undo rate), $0 live in MTD at removal, against 33 forecast edits over the same period.
 * The undo rate was structural — CMD posts the payment eventually, so every manual deposit was
 * temporary by construction and only a human noticing the double-count warning kept MTD honest.
 *
 * WHY SOURCE PINS. These components transitively import @/lib/actions → @/lib/access, which calls
 * the RSC `cache()` and crashes under node:test (the constraint collections-grid-scrollport.test.tsx
 * documents). The load-bearing claim here is an ABSENCE — that a write path does not exist — which
 * is exactly what source assertions can prove and a render test cannot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const read = (p: string) => readFileSync(join(appRoot, p), 'utf8');
const actionsSrc = read('lib/actions.ts');
const serverSrc = read('lib/server.ts');
const kpisSrc = read('components/dashboard/overview-kpis.tsx');
const eraSrc = read('components/dashboard/era-upcoming.tsx');
/** Comment-stripped: every docblock above NAMES what it removed, so absence checks must read code. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actionsCode = strip(actionsSrc);
const kpisCode = strip(kpisSrc);

test('the MTD-writing Server Actions are GONE — not merely unmounted', () => {
  /*
   * ⚠ THE ENDPOINT IS THE CAPABILITY. A Server Action compiles to a POST endpoint, so an exported
   * `addManualDeposit` that no button calls is still fully reachable by anyone able to craft the
   * request. "Nobody should have the ability" is a claim about the endpoint; deleting the form
   * would have satisfied the screenshot and not the ruling.
   */
  for (const action of ['addManualDeposit', 'removeManualDeposit', 'loadManualDeposits']) {
    assert.doesNotMatch(
      actionsCode,
      new RegExp(`export async function ${action}\\b`),
      `${action} must not exist as a Server Action — the endpoint IS the capability`,
    );
  }
  // The data layer they called goes too, or the next caller re-exposes it in one line.
  for (const fn of ['addManualDepositRow', 'removeManualDepositRow', 'getManualDeposits']) {
    assert.doesNotMatch(strip(serverSrc), new RegExp(`export async function ${fn}\\b`), `${fn} must be gone`);
  }
  assert.doesNotMatch(strip(serverSrc), /export interface ManualDepositRow\b/, 'its row type too');
});

test('no USER-FACING path can write the money ledger — the credential proves it', () => {
  /*
   * ⚠ THIS TEST ASSERTED SOMETHING OVER-BROAD AND AN INDEPENDENT AUDIT CAUGHT IT (2026-09-04).
   * It claimed "nothing under app/ writes collections.daily_collections". That is FALSE, and
   * always was: app/app/api/cron/cmd-explorer/route.ts reaches server.ts's composition root, which
   * hands `writeDb: rollupWriterDb()` to cmdExplorerCron, and that DELETEs and INSERTs the ledger
   * via src/collections/db.ts. That is the production-critical CMD ingest — the legitimate writer,
   * and the reason the table has any rows at all. The old assertion passed only because it grepped
   * for SQL literals, which live in src/; it could never have failed for the right reason.
   *
   * The boundary that matters is not app/ vs src/. It is WHICH CREDENTIAL, reachable from WHICH
   * AUTH PATH:
   *   · `readerExecutor()` — claims_reader, cannot write the ledger. This is what every Server
   *     Action and every session-authenticated page uses.
   *   · `rollupWriterDb()` — cmd_rollup_writer, CAN write it. Confined to the composition root and
   *     handed only to cron handlers behind `Authorization: Bearer <CRON_SECRET>` (GET-only, no
   *     user session — a machine endpoint, deliberately).
   * A user cannot write the ledger because no user-reachable module holds a credential that could.
   * That is least privilege doing the work, rather than a grep hoping to spot every spelling.
   */
  const actionsFull = readFileSync(join(appRoot, 'lib/actions.ts'), 'utf8');
  // 1. THE SERVER ACTION SURFACE NEVER HOLDS THE WRITER. actions.ts is the 'use server' module —
  //    every Server Action in the app is exported from it, and each one is a POST endpoint.
  assert.match(actionsFull, /^'use server';/m, 'actions.ts is the Server Action surface');
  assert.doesNotMatch(strip(actionsFull), /rollupWriterDb/, 'no Server Action may hold the ledger writer');

  // 2. THE WRITER CREDENTIAL IS CONFINED TO THE COMPOSITION ROOT. Spreading it is how a
  //    user-facing module quietly acquires write access to money.
  const holders: string[] = [];
  const walk = (dir: string, sink: string[], test: (code: string, f: string) => void) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'test') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, sink, test);
      else if (/\.(ts|tsx)$/.test(entry)) test(strip(readFileSync(full, 'utf8')), full);
    }
  };
  for (const d of ['app', 'lib', 'components']) {
    walk(join(appRoot, d), holders, (code, f) => {
      if (/rollupWriterDb/.test(code)) holders.push(relative(appRoot, f));
    });
  }
  assert.deepEqual(
    holders.sort(),
    ['lib/server.ts'],
    `only the composition root may hold the ledger writer, found: ${holders.join(', ')}`,
  );

  // 3. NO DIRECT LEDGER WRITE AND NO 0096 DEFINER CALL ANYWHERE UNDER app/. The removed feature was
  //    both — raw SQL through a definer running as postgres. Swept over the whole tree, because a
  //    future writer is likeliest to appear somewhere other than the files this change edited.
  const offenders: string[] = [];
  for (const d of ['app', 'lib', 'components']) {
    walk(join(appRoot, d), offenders, (code, f) => {
      for (const re of [
        /(insert\s+into|update|delete\s+from)\s+collections\.daily_collections/i,
        /collections\.(add|remove)_manual_deposit\s*\(/i,
      ]) {
        if (re.test(code)) offenders.push(`${relative(appRoot, f)} :: ${re.source}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `no app module may write the ledger directly:\n  ${offenders.join('\n  ')}`);
});

test('the surviving path writes the ANNOTATION table, which cannot reach MTD', () => {
  // staging.expected_payment_manual (024) is not referenced by daily_collections_resolved, so a
  // forecast row is excluded from MTD BY CONSTRUCTION rather than by a filter we must maintain.
  assert.match(strip(serverSrc), /staging\.upsert_expected_payment_manual/, 'the forecast writer survives');
  assert.match(actionsCode, /export async function saveUpcomingManual\b/, 'and its Server Action does');
  // It stays super-admin gated and audited — removing its sibling must not have loosened it.
  const save = actionsCode.slice(
    actionsCode.indexOf('export async function saveUpcomingManual'),
    actionsCode.indexOf('export async function deleteUpcomingManual'),
  );
  assert.match(save, /role !== 'super_admin'/, 'still super-admin only');
  assert.match(save, /recordAccess\(/, 'still writes an audit row before the mutation');
});

test('the panel offers exactly ONE create form, with no nested twin', () => {
  const panel = kpisCode.slice(kpisCode.indexOf('function AddForecastPanel'), kpisCode.indexOf('function EraUpcomingPanel'));
  assert.ok(panel.length > 0, 'panel located');
  assert.equal((panel.match(/<AddForecastForm/g) ?? []).length, 1, 'one forecast form');
  assert.doesNotMatch(panel, /<ManualDepositSection/, 'the second create form must not return');
  // ⚠ AND THE FORM MUST NOT RE-GROW ITS OWN DISCLOSURE. It used to wrap itself in a <details>
  // labelled "Add an expected payment" — the same words as the panel heading it now sits under,
  // so reaching the only form meant opening an identically-named twin. That was the second
  // duplicate entry point, and it is the one the screenshot showed most clearly.
  const form = strip(eraSrc).slice(
    strip(eraSrc).indexOf('export function AddForecastForm'),
    strip(eraSrc).indexOf('export function AddForecastForm') + 4000,
  );
  assert.doesNotMatch(form, /<details/, 'the form carries no disclosure of its own');
  assert.doesNotMatch(form, /<summary/, 'and no summary label to duplicate the panel heading');
});

test('the copy states the contract it actually honours — no "future", no dangling "Or"', () => {
  const panel = kpisSrc.slice(kpisSrc.indexOf('function AddForecastPanel'), kpisSrc.indexOf('function EraUpcomingPanel'));
  /*
   * The old line read "Or schedule a FUTURE expected payment". Both halves were wrong:
   *   · "Or" — nothing precedes it any more;
   *   · "future" — verified false against the code it described. validateManualInput checks only
   *     the ISO shape, 024 has no CHECK on expected_date, and the date input carries no `min`, so
   *     past dates have ALWAYS been accepted and land in the tile's overdue partition. That is the
   *     actual use case ("a paper check that came in late"), and the copy denied it.
   */
  assert.doesNotMatch(panel, /Or schedule a/, 'nothing precedes this form any more');
  assert.doesNotMatch(panel, /<span className="font-medium">future<\/span> expected payment/, 'past dates are valid');
  assert.match(panel, /past or future/, 'the copy says both directions work');
  assert.match(panel, /not<\/span> count toward MTD/, 'and that it never counts toward MTD');
});

test('the orphaned deposit-error helper and its suite are gone, not left dangling', () => {
  // Its only consumer was the removed form. Left behind, it is dead code whose test still passes —
  // the shape that makes a reader think the feature is still wired.
  assert.equal(existsSync(join(appRoot, 'lib/forecast/deposit-feedback.ts')), false, 'helper deleted');
  assert.equal(existsSync(join(appRoot, 'test/deposit-error-text.test.tsx')), false, 'its suite deleted');
  assert.doesNotMatch(kpisCode, /depositErrorText/, 'and nothing imports it');
});
