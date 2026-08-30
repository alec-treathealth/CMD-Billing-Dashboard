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
import {
  CODE_LEGEND,
  codeOrReason,
  codeTitle,
  meaningFor,
} from '../components/billing-audit/billable-days/legend';
import { BillableDaysGrid } from '../components/billing-audit/billable-days/grid';
import { CA_CLAIM_CODES, claimCodeFor } from '../../src/kipu/claimCodes.js';
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

/* ── the agreement runs BOTH WAYS, deliberately ──────────────────────────────────────────────
 * The first version of this walked `CODE_LEGEND` only. That is the same shape as the
 * forward-only context-map guard CLAUDE.md records: a check that iterates one set cannot report
 * anything about entries missing from it. A code seeded in `claimCodes.ts` and absent from the
 * legend would have passed silently, while this file claimed the two modules agreed.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

test('FORWARD — every code the LEGEND prints is one the CA seed actually resolves', () => {
  for (const m of CODE_LEGEND) {
    const seeded = claimCodeFor('CA', m.code);
    if (m.cpt !== null) {
      // The strong direction, and the one the original defect violated: the display may not
      // print a claim code the policy does not resolve — whatever the reason it does not.
      assert.equal(seeded.resolved, true, `${m.code} shows a CPT the CA seed does not resolve`);
      assert.equal(m.cpt, seeded.code, `${m.code}: the legend and the CA seed disagree`);
    } else if (seeded.resolved) {
      assert.fail(`${m.code} resolves in the CA seed but the legend shows no code`);
    }
  }
});

test('REVERSE — every code the CA SEED knows is described by the legend, and agrees', () => {
  // The direction Qodo found missing. Without it, a seed-only entry is invisible here.
  for (const e of CA_CLAIM_CODES) {
    const m = meaningFor(e.dayCode);
    assert.ok(m, `${e.dayCode} is in the CA seed but has no legend entry to render it`);
    assert.equal(
      m!.cpt,
      e.code,
      `${e.dayCode}: seed says ${e.code ?? 'no code'}, legend says ${m!.cpt ?? 'no code'}`,
    );
    if (e.code === null) {
      assert.ok(m!.unresolved, `${e.dayCode} is unresolved in the seed but the legend gives no reason`);
    }
  }
});

test('the ONLY legitimate asymmetry is legend-only, non-service entries', () => {
  // N/B is a display marker, not a service, so the seed has no line for it and `claimCodeFor`
  // returns `claim-code-unknown`. Pin that this is the whole of the asymmetry — if a second
  // legend-only code ever appears, someone has to decide whether it is a service.
  const legendOnly = CODE_LEGEND.filter((m) => !CA_CLAIM_CODES.some((e) => e.dayCode === m.code));
  assert.deepEqual(legendOnly.map((m) => m.code), ['N/B']);
  for (const m of legendOnly) {
    const seeded = claimCodeFor('CA', m.code);
    assert.equal(seeded.resolved, false);
    assert.equal(seeded.resolved ? null : seeded.flag, 'claim-code-unknown');
    assert.equal(m.cpt, null, 'a code the seed has never heard of must not print a CPT');
  }
  // And nothing may be seed-only: every seeded code needs somewhere to render.
  const seedOnly = CA_CLAIM_CODES.filter((e) => !CODE_LEGEND.some((m) => m.code === e.dayCode));
  assert.deepEqual(seedOnly.map((e) => e.dayCode), []);
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
