/**
 * The Billable Days display legend must never present an UNRESOLVED mapping as a code.
 *
 * `I` shipped as `cpt: 'S9480 / H0015'` and rendered into a tooltip that `legend.ts`'s own
 * header says billers read "to decide what to submit", in a field whose every other value is a
 * single submittable code. That is a mapping claim, and there is none to make.
 *
 * ── WHY THIS FILE HOLDS TWO MODULES IN AGREEMENT ────────────────────────────────────────────
 * `legend.ts` deliberately does NOT import `src/kipu/claimCodes.ts`: the seed is scoped to
 * CALIFORNIA and refuses every other state, while the legend renders for every location, so a
 * runtime import would apply CA policy to a Texas row. A shared ASSERTION gives the agreement
 * without the coupling — if the biller resolves `I`, this test fails until both are updated.
 *
 * Assertions name the wrong VALUE. "the tooltip contains a reason" would pass just as well
 * while `S9480` sat next to it.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CODE_LEGEND, codeOrReason, codeTitle } from '../components/billing-audit/billable-days/legend';
import { BillableDaysGrid } from '../components/billing-audit/billable-days/grid';
import { claimCodeFor } from '../../src/kipu/claimCodes.js';
import { WEEK_A, makeRow } from './helpers/billableDays';

/** Every code the CA seed refuses to resolve, and the alternates it refuses to pick from. */
const NEVER_SHOWN_AS_A_CODE = ['S9480', 'H0015', 'H2013', 'H2019', 'H2020'] as const;

test('the I tooltip shows NO claim code — not one of the alternates, not the printed pair', () => {
  const title = codeTitle('I');
  for (const code of NEVER_SHOWN_AS_A_CODE) {
    assert.equal(title.includes(code), false, `the I tooltip still offers ${code}`);
  }
  assert.equal(title.includes('/'), false, 'the tooltip still renders a slash-joined pair');
});

test('the I tooltip says WHY instead of going blank, and keeps its other detail', () => {
  // A fix that merely deleted the field would pass the test above and tell the biller nothing.
  const title = codeTitle('I');
  assert.ok(title.includes('payer-dependent'), 'the tooltip does not say why there is no code');
  assert.ok(title.includes('Intensive outpatient'), 'the label was lost');
  assert.ok(title.includes('3 hours'), 'the expected duration was lost');
});

test('the resolved codes still render exactly as before — the fix must not blank them', () => {
  assert.ok(codeTitle('G').includes('90853'));
  assert.ok(codeTitle('T').includes('90837'));
  assert.ok(codeTitle('BPS').includes('90791'));
});

test('CM and N/B state different reasons — a blank made them indistinguishable', () => {
  const cm = codeTitle('CM');
  const nb = codeTitle('N/B');
  assert.ok(cm.includes('no code in the legend'), 'CM does not say the legend gave no code');
  assert.ok(nb.includes('not a billable service'), 'N/B does not say it is not a service');
  assert.notEqual(cm, nb);
});

test('every entry carries a code XOR a reason — never both, never neither', () => {
  for (const m of CODE_LEGEND) {
    const hasCode = m.cpt !== null;
    const hasReason = m.unresolved !== null;
    assert.notEqual(hasCode, hasReason, `${m.code} has both a code and a reason, or neither`);
    assert.notEqual(codeOrReason(m), '', `${m.code} renders an empty field where a code belongs`);
  }
});

test('the legend AGREES with the CA seed: same codes resolved, same ones refused', () => {
  for (const m of CODE_LEGEND) {
    const seeded = claimCodeFor('CA', m.code);
    if (seeded.resolved) {
      assert.equal(m.cpt, seeded.code, `${m.code}: the legend and the CA seed disagree`);
    } else if (seeded.flag === 'claim-code-ambiguous' || seeded.flag === 'claim-code-absent') {
      // The seed knows this code and refuses it — the display must refuse it too.
      assert.equal(m.cpt, null, `${m.code} is unresolved in the CA seed but shows a code in the UI`);
    }
    // `claim-code-unknown` (N/B) is not in the seed's legend at all; the display may still
    // describe it, because "not a billable service" is a display fact, not a claim mapping.
  }
});

test('RENDERED: no alternate reaches the grid’s markup for an I day', () => {
  // codeTitle is the tooltip; this is the DOM the biller actually gets, chips and title attrs.
  const row = makeRow({ loc: 'MH IOP 1 Adult' });
  const html = renderToStaticMarkup(
    <BillableDaysGrid
      rows={[row]}
      weekStart={WEEK_A}
      phiIncluded={false}
      revealed={false}
      cellOv={new Map()}
      statusOv={new Map()}
      onSetCell={() => {}}
      onSetStatus={() => {}}
      onOpen={() => {}}
    />,
  );
  assert.ok(html.includes('>I<'), 'the fixture must actually render an I chip');
  for (const code of NEVER_SHOWN_AS_A_CODE) {
    assert.equal(html.includes(code), false, `${code} reached the grid markup`);
  }
  assert.ok(html.includes('payer-dependent'), 'the I chip title lost its reason');
});
