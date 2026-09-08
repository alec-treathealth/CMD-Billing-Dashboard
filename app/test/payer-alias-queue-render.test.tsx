/**
 * Payer-alias ruling queue — pure-leaf render invariants (renderToStaticMarkup, no jsdom).
 * Locks:
 *  1. alias_norm NEVER reaches an href — it can hold an employer name, which stays in the PhiKey
 *     union and must not enter a URL;
 *  2. confidence renders as a VALUE, not a bar, and a null score says so in words;
 *  3. a row with no proposal says so explicitly rather than rendering an empty cell;
 *  4. the 029 review note is IN FLOW — not a title= tooltip, not CSS-hidden;
 *  5. Artifact 2 is READ-ONLY: no form, no button, no confirm control anywhere in the markup;
 *  6. a11y: tabs carry aria-current, both nav landmarks are labelled, and screen-reader text
 *     names the bare numerics (confidence / similarity) that read as noise otherwise;
 *  7. VOB names behind a payer id render in the three measured shapes (1 inline · 2–12 all · 13–24
 *     capped with an overflow line), say so in one line when the list cannot help, and are IN the
 *     markup whether or not the <details> is open — collapse is presentation, not containment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConfidenceValue,
  NeighbourList,
  Pager,
  ProposalCell,
  QueueList,
  ReviewNote,
  RulingFormFields,
  VOB_NAMES_UNHELPFUL_FROM,
  VobNameList,
  VocabularyTabs,
  pageHref,
  vocabTabHref,
  type RulingFormState,
} from '../components/admin/payer-alias-leaves';
import {
  VOB_NAMES_PER_ID,
  type PayerAliasNeighbourRow,
  type PayerAliasQueueRow,
  type PayerAliasSiblingRow,
  type PayerAliasVobNameRow,
} from '../../src/collections/payerAliasQueue';

/** An employer-shaped alias — the exact case that makes alias_norm URL-hostile. */
const EMPLOYER_ALIAS = 'ACME MANUFACTURING EMPLOYEE HEALTH PLAN';

const row = (over: Partial<PayerAliasQueueRow> = {}): PayerAliasQueueRow => ({
  vocabulary: 'vob_insurance_co',
  alias_norm: 'ANTHEM BCBS GA',
  relationship: 'same_payer',
  provenance: 'idf_cosine',
  confidence: '0.833',
  review_note: null,
  created_at: '2026-08-05',
  canonical_payer_id: 'pi_anthem_georgia',
  display_name: 'Anthem Blue Cross and Blue Shield of Georgia',
  payer_family: 'ANTHEM',
  entity_kind: 'insurer',
  is_active: true,
  administers_for: null,
  administers_for_name: null,
  ...over,
});

const sibling = (over: Partial<PayerAliasSiblingRow> = {}): PayerAliasSiblingRow => ({
  alias_norm: 'ANTHEM BCBS GA',
  vocabulary: 'claims_primary_payer',
  relationship: 'same_payer',
  canonical_payer_id: 'pi_anthem_georgia',
  needs_review: false,
  display_name: 'Anthem Blue Cross and Blue Shield of Georgia',
  ...over,
});

const neighbour = (over: Partial<PayerAliasNeighbourRow> = {}): PayerAliasNeighbourRow => ({
  seed: 'ANTHEM BCBS GA',
  alias_norm: 'ANTHEM BCBS OF GA',
  vocabulary: 'claims_primary_payer',
  relationship: 'same_payer',
  canonical_payer_id: 'pi_anthem_georgia',
  display_name: 'Anthem Blue Cross and Blue Shield of Georgia',
  similarity: '0.833333',
  ...over,
});

const COUNTS = { vob_insurance_co: 646, claims_primary_payer: 145, vob_payer_id: 199 };

/** One VOB name under payer id 62308. */
const vname = (
  name: string,
  members: number,
  total_names: number,
  total_members: number,
  payer_id = '62308',
): PayerAliasVobNameRow => ({ payer_id, name, members, total_names, total_members });

/** N distinct names under one id, heaviest first, capped at 12 exactly the way the SQL caps them. */
const vnames = (totalNames: number, totalMembers = totalNames * 10): PayerAliasVobNameRow[] =>
  Array.from({ length: Math.min(totalNames, VOB_NAMES_PER_ID) }, (_, i) =>
    vname(`PAYER NAME ${String(i + 1).padStart(3, '0')}`, 100 - i, totalNames, totalMembers),
  );

/* ── 1. alias_norm never reaches a URL ─────────────────────────────────────────────────────────── */

test('route builders never carry alias_norm — only the vocabulary enum and an integer page', () => {
  assert.equal(vocabTabHref('vob_payer_id'), '/admin/payer-aliases?v=vob_payer_id');
  assert.equal(pageHref('vob_insurance_co', 1), '/admin/payer-aliases?v=vob_insurance_co');
  assert.equal(pageHref('vob_insurance_co', 3), '/admin/payer-aliases?v=vob_insurance_co&p=3');
  // A float or negative page cannot produce a malformed href.
  assert.equal(pageHref('vob_payer_id', 0), '/admin/payer-aliases?v=vob_payer_id');
  assert.equal(pageHref('vob_payer_id', 2.7), '/admin/payer-aliases?v=vob_payer_id&p=2');
});

test('an employer-shaped alias_norm renders but appears in NO href', () => {
  const html = renderToStaticMarkup(
    <QueueList
      rows={[row({ alias_norm: EMPLOYER_ALIAS, canonical_payer_id: null, display_name: null })]}
      siblings={{}}
      neighbours={{}}
    />,
  );
  // It is displayed — ruled non-PHI for an authenticated principal (2026-08-14) …
  assert.ok(html.includes(EMPLOYER_ALIAS));
  // … but every href on the surface must be free of it, in raw AND encoded form.
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const href = m[1] ?? '';
    assert.equal(href.includes('ACME'), false, `alias_norm leaked into href: ${href}`);
    assert.equal(href.includes(encodeURIComponent(EMPLOYER_ALIAS)), false, href);
  }
});

test('the Pager builds hrefs from vocabulary and page alone', () => {
  const html = renderToStaticMarkup(
    <Pager vocabulary="vob_insurance_co" page={2} pageSize={25} total={646} hasMore />,
  );
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));
  assert.ok(hrefs.length > 0, 'the pager rendered no links to check');
  for (const href of hrefs) {
    assert.match(href, /^\/admin\/payer-aliases\?v=[a-z_]+(&p=\d+)?$/);
  }
});

/* ── 2. confidence is a value, not a bar ───────────────────────────────────────────────────────── */

test('confidence renders the exact numeric string, unparsed', () => {
  const html = renderToStaticMarkup(<ConfidenceValue value="0.510" />);
  assert.ok(html.includes('0.510'), html); // not 0.51 — a float round-trip would drop the zero
  assert.ok(html.includes('tabular-nums'), html);
  // A bar would be an element with a width style; there is none.
  assert.equal(/style="[^"]*width/.test(html), false, html);
});

test('a null confidence says "no score" in words, and names itself to a screen reader', () => {
  const html = renderToStaticMarkup(<ConfidenceValue value={null} />);
  assert.ok(html.includes('no score'), html);
  assert.ok(html.includes('no confidence value'), html);
});

test('the 199 vob_payer_id rows render without a score rather than a zero', () => {
  const html = renderToStaticMarkup(
    <QueueList
      rows={[row({ vocabulary: 'vob_payer_id', confidence: null, provenance: 'vob_payer_id' })]}
      siblings={{}}
      neighbours={{}}
    />,
  );
  assert.ok(html.includes('no score'), html);
  assert.equal(html.includes('>0<'), false, 'a null score must never render as 0');
});

/* ── 3. no proposal is stated, not blank ───────────────────────────────────────────────────────── */

test('a row with no canonical proposal says so explicitly', () => {
  const html = renderToStaticMarkup(
    <ProposalCell row={row({ canonical_payer_id: null, display_name: null, payer_family: null, entity_kind: null, is_active: null })} />,
  );
  assert.ok(html.includes('No proposal'), html);
  assert.ok(html.includes('needs research'), html);
});

test('a TPA proposal renders the administers-for chain, not a bare name', () => {
  const html = renderToStaticMarkup(
    <ProposalCell
      row={row({
        canonical_payer_id: 'pi_optum',
        display_name: 'Optum',
        entity_kind: 'tpa',
        administers_for: 'pi_uhc',
        administers_for_name: 'UnitedHealthcare',
      })}
    />,
  );
  assert.ok(html.includes('administers for UnitedHealthcare'), html);
});

test('an inactive proposed identity is flagged — it must not be accepted silently', () => {
  const html = renderToStaticMarkup(<ProposalCell row={row({ is_active: false })} />);
  assert.ok(html.includes('identity inactive'), html);
});

/* ── 4. the review note is in flow ─────────────────────────────────────────────────────────────── */

test('the 029 review note renders IN FLOW — never a title tooltip, never CSS-hidden', () => {
  const note = 'STRUCTURALLY AMBIGUOUS — bare UHC, no product evidence';
  const html = renderToStaticMarkup(<ReviewNote note={note} />);
  assert.ok(html.includes(note), html);
  assert.equal(html.includes('title='), false, 'the note must not be a tooltip');
  assert.equal(/hidden|display:\s*none|sr-only/.test(html), false, 'the note must not be hidden');
});

test('an absent review note renders nothing at all', () => {
  assert.equal(renderToStaticMarkup(<ReviewNote note={null} />), '');
  assert.equal(renderToStaticMarkup(<ReviewNote note="   " />), '');
});

/* ── 5. read-only ──────────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ TIGHTENED, NOT RELAXED, WHEN THE RULING FORM LANDED (2026-09-06).
 *
 * Before: "the queue markup contains no form/button/input/select". Once a form existed the naive
 * move would be to delete this test, or to loosen it to "the page may contain controls" — either
 * way every DISPLAY leaf loses its guard forever, and a stray button in NeighbourList or Pager
 * becomes invisible.
 *
 * After: the exemption is scoped to ONE component. Every read-only leaf is still asserted to emit
 * zero controls, INCLUDING QueueList rendered without a renderForm prop — which is how the guard
 * survives the arrival of the form. RulingFormFields is the single permitted emitter, and it gets
 * its own assertions below rather than a free pass.
 */
const CONTROL_TAGS = ['<form', '<button', '<input', '<select', '<textarea'];

test('every DISPLAY leaf still emits zero controls — the exemption is one component, not the file', () => {
  const displays: Array<[string, string]> = [
    [
      'QueueList (no renderForm)',
      renderToStaticMarkup(
        <QueueList
          rows={[row(), row({ alias_norm: 'UHC', canonical_payer_id: null, display_name: null, review_note: 'STRUCTURALLY AMBIGUOUS —' })]}
          siblings={{ 'ANTHEM BCBS GA': [sibling()] }}
          neighbours={{ 'ANTHEM BCBS GA': [neighbour()] }}
        />,
      ),
    ],
    ['NeighbourList', renderToStaticMarkup(<NeighbourList neighbours={[neighbour()]} />)],
    ['VobNameList (collapsed)', renderToStaticMarkup(<VobNameList names={vnames(7)} />)],
    ['VobNameList (inline)', renderToStaticMarkup(<VobNameList names={vnames(1)} />)],
    ['VobNameList (unhelpful)', renderToStaticMarkup(<VobNameList names={vnames(369)} />)],
    ['ProposalCell', renderToStaticMarkup(<ProposalCell row={row()} />)],
    ['ReviewNote', renderToStaticMarkup(<ReviewNote note="a note" />)],
    ['ConfidenceValue', renderToStaticMarkup(<ConfidenceValue value="0.5" />)],
    ['VocabularyTabs', renderToStaticMarkup(<VocabularyTabs active="vob_payer_id" counts={COUNTS} />)],
    [
      'Pager',
      renderToStaticMarkup(
        <Pager vocabulary="vob_payer_id" page={1} pageSize={25} total={199} hasMore />,
      ),
    ],
  ];
  for (const [name, html] of displays) {
    for (const tag of CONTROL_TAGS) {
      assert.equal(html.includes(tag), false, `${name} emitted ${tag}`);
    }
  }
});

test('a card only grows controls when a form is explicitly injected', () => {
  const withoutForm = renderToStaticMarkup(
    <QueueList rows={[row()]} siblings={{}} neighbours={{}} />,
  );
  const withForm = renderToStaticMarkup(
    <QueueList rows={[row()]} siblings={{}} neighbours={{}} renderForm={() => <button>x</button>} />,
  );
  assert.equal(withoutForm.includes('<button'), false);
  assert.ok(withForm.includes('<button'), 'renderForm must actually reach the card');
});

/* ── 6. context and a11y ───────────────────────────────────────────────────────────────────────── */

test('a confirmed look-alike shows its similarity and the ruling it already received', () => {
  const html = renderToStaticMarkup(<NeighbourList neighbours={[neighbour()]} />);
  assert.ok(html.includes('ANTHEM BCBS OF GA'), html);
  assert.ok(html.includes('0.833333'), html);
  assert.ok(html.includes('Anthem Blue Cross and Blue Shield of Georgia'), html);
  assert.ok(html.includes('similarity'), 'the bare number must be named for a screen reader');
});

test('no confirmed look-alike is stated as an absence of precedent, not left blank', () => {
  const html = renderToStaticMarkup(<NeighbourList neighbours={[]} />);
  assert.ok(html.includes('No confirmed look-alikes'), html);
});

test('a cross-vocabulary sibling is labelled confirmed or also-unruled', () => {
  const confirmed = renderToStaticMarkup(
    <QueueList rows={[row()]} siblings={{ 'ANTHEM BCBS GA': [sibling()] }} neighbours={{}} />,
  );
  assert.ok(confirmed.includes('confirmed'), confirmed);
  const unruled = renderToStaticMarkup(
    <QueueList
      rows={[row()]}
      siblings={{ 'ANTHEM BCBS GA': [sibling({ needs_review: true })] }}
      neighbours={{}}
    />,
  );
  assert.ok(unruled.includes('also unruled'), unruled);
});

test('tabs mark the active vocabulary with aria-current and carry live counts', () => {
  const html = renderToStaticMarkup(<VocabularyTabs active="claims_primary_payer" counts={COUNTS} />);
  assert.ok(html.includes('aria-current="page"'), html);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1, 'exactly one active tab');
  assert.ok(html.includes('aria-label="Alias vocabulary"'), html);
  for (const n of ['646', '145', '199']) assert.ok(html.includes(n), `count ${n} missing`);
});

test('both nav landmarks are labelled, so they are distinguishable to a screen reader', () => {
  const tabs = renderToStaticMarkup(<VocabularyTabs active="vob_payer_id" counts={COUNTS} />);
  const pager = renderToStaticMarkup(
    <Pager vocabulary="vob_payer_id" page={1} pageSize={25} total={199} hasMore />,
  );
  assert.ok(tabs.includes('aria-label="Alias vocabulary"'));
  assert.ok(pager.includes('aria-label="Queue pages"'));
});

test('pager: dead ends are inert spans marked aria-disabled, never dangling links', () => {
  const firstPage = renderToStaticMarkup(
    <Pager vocabulary="vob_insurance_co" page={1} pageSize={25} total={646} hasMore />,
  );
  assert.ok(firstPage.includes('aria-disabled="true"'), firstPage);
  assert.equal((firstPage.match(/<a /g) ?? []).length, 1, 'only Next is a link on page 1');

  const lastPage = renderToStaticMarkup(
    <Pager vocabulary="vob_insurance_co" page={26} pageSize={25} total={646} hasMore={false} />,
  );
  assert.equal((lastPage.match(/<a /g) ?? []).length, 1, 'only Previous is a link on the last page');
});

test('pager range arithmetic is honest at both ends and when empty', () => {
  const mid = renderToStaticMarkup(
    <Pager vocabulary="vob_insurance_co" page={2} pageSize={25} total={646} hasMore />,
  );
  assert.ok(mid.includes('Showing 26–50 of 646 unruled'), mid);

  const tail = renderToStaticMarkup(
    <Pager vocabulary="claims_primary_payer" page={6} pageSize={25} total={145} hasMore={false} />,
  );
  assert.ok(tail.includes('Showing 126–145 of 145 unruled'), tail);

  const empty = renderToStaticMarkup(
    <Pager vocabulary="vob_payer_id" page={1} pageSize={25} total={0} hasMore={false} />,
  );
  assert.ok(empty.includes('No unruled rows'), empty);
});

/**
 * M2 REGRESSION (2026-09-06). `clampPage` bounds a route value to [1, MAX_PAGE=200] because it
 * cannot know the row count, so `?p=200` against 990 rows rendered "Showing 4976–990 of 990" — an
 * inverted range. The loader now clamps to the real last page, but this leaf is exported and
 * independently renderable, so it re-clamps rather than trusting its caller.
 *
 * The original pager test covered page 2, the tail page and empty — never PAST the end, which is
 * exactly why this shipped green.
 */
test('M2: a past-the-end page never renders an inverted range', () => {
  const html = renderToStaticMarkup(
    <Pager vocabulary="vob_insurance_co" page={200} pageSize={25} total={990} hasMore={false} />,
  );
  assert.equal(html.includes('4976'), false, 'the pre-fix offset must not appear');
  assert.ok(html.includes('Showing 976–990 of 990 unruled'), html);
});

test('M2: the rendered range is never inverted at any page, for any total', () => {
  for (const total of [0, 1, 24, 25, 26, 145, 990]) {
    for (const page of [1, 2, 6, 40, 200, 1000]) {
      const html = renderToStaticMarkup(
        <Pager vocabulary="vob_payer_id" page={page} pageSize={25} total={total} hasMore={false} />,
      );
      const m = html.match(/Showing (\d+)–(\d+) of (\d+)/);
      if (m) {
        const [first, last, shown] = [Number(m[1]), Number(m[2]), Number(m[3])];
        assert.ok(first <= last, `inverted at total=${total} page=${page}: ${first}–${last}`);
        assert.ok(last <= shown, `last exceeds total at total=${total} page=${page}`);
        assert.ok(first >= 1, `first below 1 at total=${total} page=${page}`);
      } else {
        assert.ok(html.includes('No unruled rows'), `total=${total} page=${page} rendered neither`);
      }
    }
  }
});

test('M2: Next is inert past the end even if a caller passes hasMore=true', () => {
  // Defensive: the loader would never do this, but the leaf must not emit a link to page 201.
  const html = renderToStaticMarkup(
    <Pager vocabulary="vob_insurance_co" page={200} pageSize={25} total={990} hasMore />,
  );
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((x) => (x[1] ?? '').replaceAll('&amp;', '&'));
  for (const h of hrefs) {
    assert.equal(h.includes('p=201'), false, `emitted a link past the end: ${h}`);
  }
});

test('an empty page states it rather than rendering a bare list', () => {
  const html = renderToStaticMarkup(<QueueList rows={[]} siblings={{}} neighbours={{}} />);
  assert.ok(html.includes('Nothing unruled on this page'), html);
});

/* ── 7. VOB names behind a payer id ────────────────────────────────────────────────────────────── */

/** A vob_payer_id row — an IDENTIFIER, no score, the seed provenance. */
const idRow = (over: Partial<PayerAliasQueueRow> = {}): PayerAliasQueueRow =>
  row({ vocabulary: 'vob_payer_id', alias_norm: '62308', confidence: null, provenance: 'vob_payer_id', ...over });

const renderId = (names: readonly PayerAliasVobNameRow[]) =>
  renderToStaticMarkup(
    <QueueList rows={[idRow()]} siblings={{}} neighbours={{}} vobNames={{ '62308': [...names] }} />,
  );

const NAME_RE = /PAYER NAME \d{3}/g;

test('1 name renders INLINE — no <details>, because a one-item disclosure implies an ambiguity that does not exist', () => {
  // 48% of cards. The card is saying "this id means one name"; a collapsed "1 name" would say the
  // opposite.
  const html = renderId([vname('AETNA', 41, 1, 41)]);
  assert.ok(html.includes('AETNA'), html);
  assert.ok(html.includes('41 members'), html);
  assert.equal(html.includes('<details'), false, 'a single name must not be behind a disclosure');
  assert.equal(html.includes('showing'), false);
});

test('2–12 names render in ONE <details>, every name present, no overflow line', () => {
  for (const total of [2, 7, VOB_NAMES_PER_ID]) {
    const html = renderId(vnames(total));
    assert.equal((html.match(/<details/g) ?? []).length, 1, `total=${total}: exactly one disclosure`);
    assert.equal((html.match(NAME_RE) ?? []).length, total, `total=${total}: every name rendered`);
    assert.equal(html.includes('showing'), false, `total=${total}: nothing is omitted, so no overflow line`);
    assert.ok(html.includes(`${total} VOB names`), html);
  }
});

test('13–24 names: the 12 heaviest, plus an overflow line naming what is not shown', () => {
  const html = renderId(vnames(19, 1204));
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.equal((html.match(NAME_RE) ?? []).length, VOB_NAMES_PER_ID, 'capped at 12');
  assert.ok(html.includes('PAYER NAME 012'), 'the 12th heaviest is shown');
  assert.equal(html.includes('PAYER NAME 013'), false, 'the 13th is not');
  // The exact ruled wording, with a thousands separator on the member count.
  assert.ok(html.includes('showing 12 of 19 · 1,204 members'), html);
});

test('at the threshold and beyond, ONE line says the list cannot help — and no list is rendered', () => {
  // 2 × cap + 1: from here the omitted names outnumber the shown ones. Pinned so a change to the
  // threshold is a deliberate edit to the constant, with its docblock, not a drift.
  assert.equal(VOB_NAMES_UNHELPFUL_FROM, 25);
  for (const total of [VOB_NAMES_UNHELPFUL_FROM, 100, 369]) {
    const html = renderId(vnames(total, 4812));
    assert.equal(html.includes('<details'), false, `total=${total}: no disclosure`);
    assert.equal((html.match(NAME_RE) ?? []).length, 0, `total=${total}: no names — 12 of ${total} is not progress`);
    assert.ok(html.includes(`${total} VOB names`), html);
    assert.ok(html.includes('4,812 members'), html);
    assert.ok(html.includes('too many for a name list to help'), html);
  }
  // The boundary: one below the threshold still gets the capped list.
  const below = renderId(vnames(VOB_NAMES_UNHELPFUL_FROM - 1));
  assert.ok(below.includes('<details'), 'total=24 is still a disclosure');
  assert.ok(below.includes('showing 12 of 24'), below);
});

/**
 * ⚠️ PINNED ON PURPOSE — COLLAPSE IS PRESENTATION, NOT CONTAINMENT. A closed <details> serialises
 * its children, so every name is in the HTML whether or not the reader opened it. That is CORRECT
 * for payer names (non-PHI by construction) and this test exists so nobody later reads the
 * <details> as a boundary and puts a value behind it that needed one. If that ever looks tempting,
 * the answer is server-side omission (the dollar-gating rule), never a closed disclosure.
 */
test('a closed <details> is NOT a boundary — every name is in the markup whether opened or not', () => {
  const names = vnames(7);
  const html = renderId(names);
  assert.equal(/<details[^>]*\sopen/.test(html), false, 'rendered closed');
  for (const n of names) assert.ok(html.includes(n.name), `${n.name} must be in the serialised markup`);
});

test('VOB names never reach an href', () => {
  const html = renderId(vnames(19));
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    assert.equal(/PAYER NAME/.test(m[1] ?? ''), false, `a VOB name leaked into href: ${m[1]}`);
  }
});

test('no VOB row behind the id: the absence is stated, not left blank', () => {
  const html = renderToStaticMarkup(<QueueList rows={[idRow()]} siblings={{}} neighbours={{}} />);
  assert.ok(html.includes('No VOB row carries this payer id verbatim'), html);
  assert.equal(html.includes('<details'), false);
});

test('VOB names never render on a NAME-vocabulary card, even when handed some', () => {
  // The join is meaningless for vob_insurance_co / claims_primary_payer; the loader sends nothing,
  // and the leaf must not render it even if a caller does.
  for (const v of ['vob_insurance_co', 'claims_primary_payer'] as const) {
    const html = renderToStaticMarkup(
      <QueueList
        rows={[row({ vocabulary: v })]}
        siblings={{}}
        neighbours={{}}
        vobNames={{ 'ANTHEM BCBS GA': vnames(3) }}
      />,
    );
    assert.equal(html.includes('VOB name'), false, `${v} rendered VOB names`);
    assert.equal(html.includes('<details'), false, v);
    assert.equal(html.includes('No VOB row'), false, `${v} must not even state an absence`);
  }
});

test('member counts are named for a screen reader, not left as bare numerals', () => {
  const html = renderId(vnames(3));
  assert.ok(html.includes('members'), html);
  assert.ok(html.includes('sr-only'), 'the per-name count needs a spoken label');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULING FORM — the one component permitted to emit controls, and what it owes in exchange.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

const IDENTITIES = [
  { canonical_payer_id: 'pi_cigna', display_name: 'Cigna', entity_kind: 'insurer' },
  { canonical_payer_id: 'pi_optum', display_name: 'Optum', entity_kind: 'tpa' },
];

const formState = (over: Partial<RulingFormState> = {}): RulingFormState => ({
  action: 'confirm',
  relationship: 'same_payer',
  canonicalPayerId: 'pi_cigna',
  reviewNote: '',
  ...over,
});

const renderForm = (over: Partial<RulingFormState> = {}, extra: Partial<{ error: string | null; errorField: string | null; pending: boolean; alias: string }> = {}) =>
  renderToStaticMarkup(
    <RulingFormFields
      alias={extra.alias ?? 'ANTHEM BCBS GA'}
      state={formState(over)}
      identities={IDENTITIES}
      pending={extra.pending ?? false}
      error={extra.error ?? null}
      errorField={extra.errorField ?? null}
      onChange={() => {}}
      idPrefix="t1"
    />,
  );

test('all SIX relationships are offered — tpa and employer_self_funded are not hidden', () => {
  const html = renderForm();
  for (const r of ['same_payer', 'carve_out', 'tpa', 'employer_self_funded', 'program_label', 'unmapped']) {
    assert.ok(html.includes(`value="${r}"`), `relationship ${r} is not offered`);
  }
});

test('the canonical picker is OMITTED, not disabled, when the relationship forbids one', () => {
  // payer_alias_map_relationship_canonical rejects a canonical on unmapped/program_label, so a
  // greyed-out control still holding pi_cigna is a submission waiting to fail.
  for (const r of ['unmapped', 'program_label'] as const) {
    const html = renderForm({ relationship: r });
    assert.equal(html.includes('name="canonicalPayerId"'), false, `${r} still rendered the picker`);
    assert.equal(html.includes('pi_cigna'), false, `${r} left a stale canonical in the DOM`);
  }
  for (const r of ['same_payer', 'carve_out', 'tpa', 'employer_self_funded'] as const) {
    assert.ok(renderForm({ relationship: r }).includes('name="canonicalPayerId"'), `${r} needs the picker`);
  }
});

test('a defer hides the relationship and canonical controls and requires the note', () => {
  const html = renderForm({ action: 'defer' });
  assert.equal(html.includes('name="relationship"'), false);
  assert.equal(html.includes('name="canonicalPayerId"'), false);
  assert.ok(html.includes('required'), 'the note must be required on a defer');
  assert.ok(html.includes('(required)'), 'the label must say so visually too');
});

test('every control is labelled — no placeholder-only or aria-less input', () => {
  const html = renderForm();
  for (const name of ['action', 'relationship', 'canonicalPayerId', 'reviewNote']) {
    // Attribute ORDER is React's, not ours — match the tag then pull id and name out of it
    // independently. An order-sensitive regex here was a false failure, not a real finding.
    const tag = html.match(new RegExp(`<(?:select|textarea|input)\\b[^>]*name="${name}"[^>]*>`));
    assert.ok(tag, `${name} control is missing`);
    const id = tag[0].match(/id="([^"]+)"/);
    assert.ok(id, `${name} has no id to label`);
    assert.ok(html.includes(`for="${id[1]}"`), `${name} has no <label for>`);
  }
  assert.ok(html.includes('<legend'), 'the control group needs a legend');
});

test('a rejection is announced, not merely coloured', () => {
  const html = renderForm({}, { error: 'That canonical payer is retired — pick a live one.', errorField: 'canonicalPayerId' });
  assert.ok(html.includes('role="alert"'), 'the error must be announced');
  assert.ok(html.includes('retired'), html);
  // Colour alone fails WCAG 1.4.1; the field name is carried in text for a screen reader.
  assert.ok(html.includes('canonicalPayerId'), 'the blamed field is not named to AT');
});

test('the form carries NO bulk affordance — one alias, one submit', () => {
  const html = renderForm();
  assert.equal((html.match(/type="submit"/g) ?? []).length, 1, 'exactly one submit control');
  assert.equal(html.includes('type="checkbox"'), false, 'no multi-select checkbox');
  assert.equal(html.includes('multiple'), false, 'no multi-select control');
  // Exactly ONE hidden alias field — a form carrying two would be batching by another name.
  assert.equal((html.match(/name="aliasNorm"/g) ?? []).length, 1, 'more than one alias in one form');
  // ⚠️ Match AFFORDANCE wording, not the substring "bulk" — the form deliberately CONTAINS the words
  // "no bulk confirm" as user-facing reassurance, so a bare /bulk/i test contradicts itself. That was
  // this test's first draft and it failed on its own copy.
  assert.equal(/select all|confirm all|rule all|apply to all/i.test(html), false, 'a bulk affordance appeared');
  assert.ok(html.includes('no bulk confirm'), 'the single-row guarantee should be stated to the user');
});

test('the alias travels in a hidden field, never in an href or a fragment id', () => {
  const html = renderForm({}, { alias: EMPLOYER_ALIAS });
  assert.ok(html.includes(`value="${EMPLOYER_ALIAS}"`), 'the exact stored PK must be submitted');
  assert.equal(html.includes('href'), false, 'the form emits no links at all');
  // Every generated id comes from the caller's prefix — never from the alias itself.
  for (const m of html.matchAll(/id="([^"]+)"/g)) {
    assert.equal((m[1] ?? '').includes('ACME'), false, `alias leaked into a DOM id: ${m[1]}`);
  }
});

test('pending disables the controls rather than hiding them', () => {
  const html = renderForm({}, { pending: true });
  assert.ok(html.includes('disabled'), 'controls must be disabled while a ruling is in flight');
  assert.ok(html.includes('Saving'), 'the submit control should say what is happening');
});
