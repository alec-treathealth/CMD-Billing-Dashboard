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
 *     names the bare numerics (confidence / similarity) that read as noise otherwise.
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
  VocabularyTabs,
  pageHref,
  vocabTabHref,
} from '../components/admin/payer-alias-leaves';
import type {
  PayerAliasNeighbourRow,
  PayerAliasQueueRow,
  PayerAliasSiblingRow,
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

test('ARTIFACT 2 IS READ-ONLY — the queue markup contains no form, button, input or select', () => {
  const html = renderToStaticMarkup(
    <QueueList
      rows={[row(), row({ alias_norm: 'UHC', canonical_payer_id: null, display_name: null, review_note: 'STRUCTURALLY AMBIGUOUS —' })]}
      siblings={{ 'ANTHEM BCBS GA': [sibling()] }}
      neighbours={{ 'ANTHEM BCBS GA': [neighbour()] }}
    />,
  );
  for (const tag of ['<form', '<button', '<input', '<select', '<textarea']) {
    assert.equal(html.includes(tag), false, `read-only surface emitted ${tag}`);
  }
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
