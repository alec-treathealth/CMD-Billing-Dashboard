/**
 * THE AUDIT TABLES MUST BE REBUILT ON A TENANT SWITCH; THE BILLABLE DAYS PANEL MUST NOT BE.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT (found in pre-push review, 2026-08-31) ────────────────
 * Landing `TenantTabs` on /billing-audit made an in-place `?view=` switch reachable for the
 * first time. That is a SOFT navigation: the page re-renders with a new `view` prop and React
 * keeps client components mounted. `AuditWorkTable` seeds `rows` / `cursors` / `hasNext` from
 * `initialPage` in `useState` INITIALISERS, which run once at mount and ignore every later prop,
 * and its page-0 refetch effect deps are `[filterKey, sort.column, sort.direction, scope]` —
 * `view` is absent, behind an `eslint-disable react-hooks/exhaustive-deps`.
 *
 * So without a `key`, switching BXR → Indigo left the PREVIOUS tenant's patient rows on screen
 * under the new tenant's tabs and brand theme — including any decrypted names cached in the
 * `revealed` Map — while `PivotStrip` (whose deps DO include `view`) reloaded to the new
 * tenant's aggregates. Two tenants' data on one screen, presented as one coherent view, until
 * some unrelated filter or sort change happened to force a reload. That is the cross-tenant
 * PHI attribution `.claude/rules/billing-audit.md` forbids outright: *"never a cross-tenant
 * leak."*
 *
 * ⚠ IT IS ALSO THIS REPO'S RECORDED `exhaustive-deps` LESSON REPEATING. An existing disable
 * silences the rule for state added LATER, so `view` was never flagged — the same shape as the
 * cmd-explorer name-search defect where the notice updated and the grid never reloaded. A
 * disable is not a local decision; it is a standing waiver over every future dep.
 *
 * ── WHY `key`, NOT A DEP OR A prevView RESET ───────────────────────────────────────────────
 * The server ALREADY refetched for the new tenant — the page is a Server Component that re-runs
 * on the soft nav, so a correctly-scoped `initialPage` is in hand. `key={view}` makes the client
 * USE it. Adding `view` to the effect deps would instead fire a SECOND, client-side fetch, and
 * it would fetch with the client's CURRENT filter while the server seeded the DEFAULT (YTD)
 * window — reintroducing precisely the mismatch `billing-audit.md` says to preserve against:
 * *"the client starts on the same window the seeded page was fetched with — no first-render
 * refetch or mismatch."* Keying upholds that invariant; a dep would violate it.
 *
 * ── WHY THE TWO PANELS ARE TREATED DIFFERENTLY ─────────────────────────────────────────────
 * The asymmetry is the point, so it is asserted in BOTH directions. The audit tables hold a
 * server-seeded snapshot of one tenant's PHI, which must be re-derived. The Billable Days panel
 * holds a corpus the USER uploaded, whose overrides are keyed by (entity, week) and therefore
 * isolated by construction — keying it would destroy a biller's parsed export and unsaved edits
 * on a BXR → Indigo → BXR glance, forcing a four-CSV re-upload to recover work that was never
 * at risk. See `billableDaysEntityScope.test.tsx` for that isolation.
 *
 * SOURCE-LEVEL by necessity: a `key` prop's effect is React reconciliation, which no string
 * render can observe, and mounting the real workbench needs a live router plus Server Actions.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(APP, rel), 'utf8');

const WORKBENCH = 'components/billing-audit/workbench.tsx';

/** The `<ScopePanel …/>` JSX blocks, one per scope, as source text. */
function scopePanelBlocks(src: string): string[] {
  return src.split('<ScopePanel').slice(1).map((b) => b.slice(0, b.indexOf('/>')));
}

test('both ScopePanels are keyed by `view`, so a tenant switch rebuilds them', () => {
  const blocks = scopePanelBlocks(read(WORKBENCH));
  assert.equal(blocks.length, 2, 'expected exactly two ScopePanel renders (IP and OP)');
  for (const [i, block] of blocks.entries()) {
    assert.match(
      block,
      /key=\{view\}/,
      `ScopePanel #${i + 1} is not keyed by view — a tenant switch would leave the previous ` +
        `tenant's patient rows on screen (see this file's header)`,
    );
  }
});

test('the Billable Days panel is NOT keyed by `view` — the asymmetry is deliberate', () => {
  // Asserted so a later "consistency" cleanup cannot key everything and silently trade the PHI
  // bug for destroying a biller's unsaved work. The negative direction of the same claim.
  const src = read(WORKBENCH);
  const block = src.slice(src.indexOf('<BillableDaysPanel'));
  const render = block.slice(0, block.indexOf('/>'));
  assert.equal(
    /key=/.test(render),
    false,
    'BillableDaysPanel is now keyed; its overrides are (entity, week)-scoped and must survive a ' +
      'tenant round trip — re-read this file’s header before changing this',
  );
});

test('the work table still seeds from `initialPage` via useState initialisers', () => {
  // The reason keying is REQUIRED rather than merely tidy. If this ever became a prop-synced
  // effect, the key would be belt-and-braces instead of the only thing standing between a
  // tenant switch and stale PHI — and this file's rationale would need rewriting.
  const src = read('components/billing-audit/work-table.tsx');
  assert.match(src, /useState<AuditGridRow\[\]>\(initialPage\?\.rows \?\? \[\]\)/);
});

test('the work table refetch effect still omits `view` — documented, not accidental', () => {
  // Pinned so the omission stays a KNOWN quantity. If someone adds `view` here, the double-fetch
  // and the seeded-window mismatch described in the header become live, and keying the panel
  // makes the effect unreachable anyway.
  const src = read('components/billing-audit/work-table.tsx');
  const deps = src.match(/\}, \[filterKey, sort\.column, sort\.direction, scope\]\);/);
  assert.ok(deps, 'the page-0 refetch effect deps changed — re-derive whether keying still suffices');
});
