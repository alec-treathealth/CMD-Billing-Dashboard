/**
 * Facility Resolution — pure-leaf render invariants (renderToStaticMarkup, no jsdom).
 * Locks:
 *  1. PHI: a raw member_id_bidx NEVER reaches the markup — only the short display token;
 *  2. the unresolved tile is present and carries its dollars (the page's whole job);
 *  3. dollars render in the mono/tabular stack (design-system.md), at charge grain;
 *  4. a11y: every row checkbox is labelled, sortable headers carry aria-sort + a Sort-by
 *     button, and the select-all control is labelled;
 *  5. unmatched search chips render inert — no Remove button, and marked for screen readers;
 *  6. the assignment fields carry a real <label for> on the note and a required-note hint.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AssignDialogFields,
  ChipRow,
  QueueTable,
  ResolutionOverviewTiles,
  formatUsd,
} from '../components/collections/facility-resolution-leaves';
import type {
  ResolutionMethod,
  ResolutionOverviewRow,
  ResolutionRow,
} from '../../src/collections/facilityResolutionQuery';

const BIDX = 'deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0123';

const row = (over: Partial<ResolutionRow> = {}): ResolutionRow => ({
  id: 1,
  business_entity_id: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088',
  member_id_bidx: BIDX,
  charge_date: '2024-07-15',
  payment_received: '2024-08-01',
  cpt_code: 'H0018',
  revenue_code: '1002',
  cpt_key: 'H0018',
  revenue_key: '1002',
  charge_amount: '2500.00',
  insurance_payments: '900.00',
  primary_payer: 'AETNA',
  source_era: 'seed',
  method: 'unresolved',
  facility_code: null,
  facility_label: null,
  facility_alias: null,
  unresolved_reason: 'no_evidence',
  assignment_id: null,
  ...over,
});

const overviewRow = (over: Partial<ResolutionOverviewRow> = {}): ResolutionOverviewRow => ({
  method: 'unresolved',
  charges: 6463,
  members: 265,
  charge_dollars: '17953848.22',
  paid_dollars: '4615577.80',
  facilities: 0,
  ...over,
});

test('PHI: the raw member blind index never reaches the markup — only the display token', () => {
  const html = renderToStaticMarkup(
    <QueueTable rows={[row()]} sort={{ column: 'charge_date', direction: 'desc' }} />,
  );
  assert.ok(!html.includes(BIDX), 'the full bidx must never be rendered');
  assert.ok(html.includes('M-deadbeefca'), 'the short display token is what renders');
  // and nothing longer than the documented prefix leaks
  assert.ok(!html.includes('deadbeefcafe0'), 'no more than the token prefix may appear');
});

test('the unresolved tile renders with its dollars and is visually distinguished', () => {
  const html = renderToStaticMarkup(
    <ResolutionOverviewTiles
      overview={[
        overviewRow(),
        overviewRow({ method: 'member_inference', charges: 3102, charge_dollars: '7472871.90', facilities: 10 }),
      ]}
    />,
  );
  assert.ok(html.includes('Unresolved'));
  assert.ok(html.includes('$17,953,848.22'), 'unresolved dollars render at charge grain');
  assert.ok(html.includes('coral600'), 'unresolved is accented, not just another tile');
  assert.ok(html.includes('Member inference'));
});

test('the attributed percentage is computed from the tiles it shows', () => {
  const html = renderToStaticMarkup(
    <ResolutionOverviewTiles
      overview={[
        overviewRow({ charge_dollars: '750.00' }),
        overviewRow({ method: 'vob', charge_dollars: '250.00' }),
      ]}
    />,
  );
  assert.ok(html.includes('25.0%'), '250 of 1000 attributed');
});

test('dollars render in the mono/tabular stack', () => {
  const html = renderToStaticMarkup(
    <QueueTable rows={[row()]} sort={{ column: 'charge_date', direction: 'desc' }} />,
  );
  assert.match(html, /font-mono[^"]*tabular-nums[^"]*">\$2,500\.00/);
});

test('formatUsd renders an em dash for a null amount rather than $0 or NaN', () => {
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd('not-a-number'), '—');
  assert.equal(formatUsd('1234.5'), '$1,234.50');
});

test('a11y: sortable headers carry aria-sort and a labelled Sort-by button', () => {
  const html = renderToStaticMarkup(
    <QueueTable rows={[row()]} sort={{ column: 'charge_amount', direction: 'asc' }} />,
  );
  assert.ok(html.includes('aria-sort="ascending"'), 'the active column announces its direction');
  assert.ok(html.includes('aria-label="Sort by Charged"'));
  assert.ok(html.includes('aria-label="Sort by Charge date"'));
});

test('a11y: every selection checkbox is individually labelled, including select-all', () => {
  const html = renderToStaticMarkup(
    <QueueTable
      rows={[row()]}
      sort={{ column: 'charge_date', direction: 'desc' }}
      selection={{ selected: new Set<number>(), onToggle: () => {}, onToggleAll: () => {} }}
    />,
  );
  assert.ok(html.includes('aria-label="Select all charges on this page"'));
  assert.ok(
    html.includes('aria-label="Select charge of $2,500.00 on 2024-07-15 for member M-deadbeefca"'),
    'the row checkbox label identifies the charge without exposing an identifier',
  );
});

test('an empty queue says so instead of rendering a bare table', () => {
  const html = renderToStaticMarkup(
    <QueueTable rows={[]} sort={{ column: 'charge_date', direction: 'desc' }} />,
  );
  assert.ok(html.includes('No charges match the current filters.'));
});

test('a resolved row shows its facility and method; an unresolved row shows its reason', () => {
  const resolved = renderToStaticMarkup(
    <QueueTable
      rows={[row({ method: 'vob', facility_alias: 'CAMH', unresolved_reason: null })]}
      sort={{ column: 'charge_date', direction: 'desc' }}
    />,
  );
  assert.ok(resolved.includes('CAMH'));
  assert.ok(resolved.includes('VOB evidence'));

  const unresolved = renderToStaticMarkup(
    <QueueTable rows={[row()]} sort={{ column: 'charge_date', direction: 'desc' }} />,
  );
  assert.ok(unresolved.includes('unresolved · no evidence'));
});

// ── #294: THE STATUS CELL SPLITS EXACT FROM INFERRED ──────────────────────────────────────────
// ⚠ THE TEST ABOVE USES A `vob` FIXTURE — an INFERRED method — and asserts only the alias and the
// label. It passed identically before and after the split, proving none of it. That is why this
// block exists rather than an extra assertion up there: a fixture that cannot fail is not coverage.
const queue = (method: ResolutionMethod, alias: string): string =>
  renderToStaticMarkup(
    <QueueTable
      rows={[row({ method, facility_alias: alias, unresolved_reason: null })]}
      sort={{ column: 'charge_date', direction: 'desc' }}
    />,
  );

test('#294: an EXACT method renders the solid teal pill and never says "inferred"', () => {
  for (const method of ['manual', 'named'] as const) {
    const html = queue(method, 'TREAT_WA');
    assert.match(html, /data-resolution="exact"/, `${method} is exact evidence`);
    assert.match(html, /bg-teal50/, `${method} keeps the solid teal pill`);
    assert.doesNotMatch(html, /inferred/, `${method} must never be labelled inferred`);
  }
});

test('#294: an INFERRED method is distinguished on all THREE channels, not colour alone', () => {
  // WCAG 1.4.1 — the split must survive greyscale and forced-colours, so assert each channel.
  for (const method of ['member_inference', 'vob', 'tie_break'] as const) {
    const html = queue(method, 'CAMH');
    assert.match(html, /data-resolution="inferred"/, `${method} is a derived conclusion`);
    assert.match(html, /border-dashed/, `${method}: border STYLE channel`);
    assert.match(html, /text-ink600/, `${method}: COLOUR channel`);
    assert.match(html, /inferred/, `${method}: the literal WORD channel`);
    assert.doesNotMatch(html, /bg-teal50/, `${method} must not borrow the exact-evidence pill`);
  }
});

test('#294: exact and inferred markup actually DIFFER — the whole point of the port', () => {
  assert.notEqual(queue('manual', 'TREAT_WA'), queue('member_inference', 'TREAT_WA'));
});

test('unmatched chips render inert: no Remove button, and flagged for screen readers', () => {
  const html = renderToStaticMarkup(
    <ChipRow
      chips={[
        { kind: 'method', method: 'unresolved', label: 'method: unresolved' },
        { kind: 'unmatched', raw: '???', label: '???' },
      ]}
      onRemove={() => {}}
    />,
  );
  assert.ok(html.includes('aria-label="Remove filter method: unresolved"'), 'applied chips are removable');
  assert.ok(!html.includes('aria-label="Remove filter ???"'), 'an unmatched chip has no remove control');
  assert.ok(html.includes('(not understood; not applied)'));
});

test('the chip list is a labelled list', () => {
  const html = renderToStaticMarkup(
    <ChipRow chips={[{ kind: 'era', era: 'seed', label: 'era: seed' }]} />,
  );
  assert.ok(html.includes('aria-label="Active search filters"'));
});

test('the assignment fields label the note, mark it required, and warn against PHI', () => {
  const html = renderToStaticMarkup(
    <AssignDialogFields
      chargeCount={12}
      memberCount={3}
      facilityListboxId="fx"
      noteId="note-1"
      scopeName="scope-1"
      scope="charges"
      note=""
    />,
  );
  assert.ok(html.includes('for="note-1"'), 'the note has a real label association');
  assert.ok(html.includes('id="note-1"'));
  assert.ok(html.includes('aria-describedby="note-1-hint"'));
  assert.ok(html.includes('do not include PHI'));
  assert.ok(html.includes('required'));
  assert.ok(html.includes('Only the 12 selected charges'));
  assert.ok(html.includes('Every unresolved charge for the 3 selected members'));
});

test('the facility combobox usage hint is rendered for screen readers', () => {
  const html = renderToStaticMarkup(
    <AssignDialogFields
      chargeCount={1}
      memberCount={1}
      facilityListboxId="fx"
      noteId="n"
      scopeName="s"
      scope="members"
      note=""
    />,
  );
  assert.ok(html.includes('id="fx-usage"'));
  assert.ok(html.includes('Escape to close the list'));
});
