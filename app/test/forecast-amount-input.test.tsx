/**
 * THE MONEY BOX, EXECUTED — what an operator types vs. what gets filed.
 *
 * This is a BEHAVIOUR file, so it uses the sanctioned jsdom harness (see `helpers/dom.tsx` for
 * the full boundary). It has to: the contract under test is "typing `$50,000` results in the
 * string `50000.00` reaching the Server Action", and a `renderToStaticMarkup` string can show
 * that a `pattern` attribute EXISTS but never that a submit handler normalized anything. The
 * sibling markup assertions live in `era-upcoming-render.test.tsx` and stay there.
 *
 * The regression being pinned: the Amount field's `pattern` used to mirror the numeric(12,2)
 * bind shape (`\d{1,10}(\.\d{1,2})?`), so the browser rejected `50,000` outright — while the
 * hourly Google-Sheets sync next to it had been reading `$35,000.00` happily since it shipped.
 * The operator was being asked to hand-key a SQL bind value.
 *
 * ⚠️ Must be .tsx and must sit directly in `app/test/` — the runner glob is `test/*.test.tsx`,
 * single-level. A `.ts` file, or a subdirectory, "passes" by never running.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as React from 'react';
import { installDom } from './helpers/dom';
import type { ForecastEditIntent } from '../lib/forecast/edit-feedback';

installDom();

/**
 * ⚠️ `react-dom/client` IS LOADED DYNAMICALLY, AND THAT IS LOAD-BEARING — do not "tidy" it into a
 * static import at the top of the file.
 *
 * react-dom decides ONCE, at module-evaluation time, whether the browser supports the `input`
 * event: `canUseDOM && isEventSupported('input')`. Static imports are hoisted ABOVE the
 * `installDom()` call above, so react-dom evaluates while `window` is still undefined, concludes
 * `canUseDOM === false`, and permanently arms its INTERNET EXPLORER value-change polyfill. That
 * polyfill then calls `activeElement.detachEvent(...)` on the first focus event, which jsdom does
 * not implement — the TypeError is thrown INSIDE React's event dispatch and aborts the plugin
 * chain before any `onBlur` handler runs. The blur assertion below fails with the box unchanged
 * and nothing whatsoever explaining why.
 *
 * `helpers/dom.tsx` already says "call installDom() at the TOP, THEN `await import(...)`". This is
 * that instruction, and this comment is the receipt for what ignoring it costs. Top-level await
 * is not available (tsx compiles these tests to CJS), hence the lazy loader.
 */
let dom: { createRoot: typeof import('react-dom/client').createRoot } | null = null;
let ui: { AddForecastForm: typeof import('../components/dashboard/era-upcoming').AddForecastForm } | null =
  null;
async function deps() {
  dom ??= await import('react-dom/client');
  ui ??= await import('../components/dashboard/era-upcoming');
  return { createRoot: dom.createRoot, AddForecastForm: ui.AddForecastForm };
}

const FACILITIES = [{ code: 'CAMH', label: 'CAMH — Casa Muñeca' }];

/** Mount the add form and hand back the pieces a test drives, plus every intent it emitted.
 *  Teardown hangs off the TEST CONTEXT so it runs on the failing path too. */
async function mountForm(t: TestContext) {
  const { createRoot, AddForecastForm } = await deps();
  const intents: ForecastEditIntent[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  });
  await React.act(async () => {
    root.render(
      <AddForecastForm
        facilityOptions={FACILITIES}
        payerSuggestions={[]}
        busy={false}
        onEdit={(i) => intents.push(i)}
      />,
    );
  });
  const form = container.querySelector('form');
  assert.ok(form instanceof window.HTMLFormElement, 'the form mounted');
  const field = (name: string): HTMLInputElement | HTMLSelectElement => {
    const el = form.elements.namedItem(name);
    assert.ok(
      el instanceof window.HTMLInputElement || el instanceof window.HTMLSelectElement,
      `field ${name} exists`,
    );
    return el;
  };
  return { intents, form, field };
}

/** Fill everything EXCEPT amount, so each test varies exactly one thing. */
function fillNonAmount(field: (n: string) => HTMLInputElement | HTMLSelectElement): void {
  field('facilityCode').value = 'CAMH';
  field('payerLabel').value = 'BCBS';
  field('expectedDate').value = '2026-09-30';
  field('methodLabel').value = 'Check';
}

/** Submit the way the button does. Dispatched on the form so React's own handler runs; jsdom's
 *  constraint validation is deliberately NOT relied on here — the `pattern` gate is a markup
 *  claim, asserted as markup in the sibling file. This exercises OUR normalization. */
async function submit(form: HTMLFormElement): Promise<void> {
  await React.act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

test('an operator types $50,000 and the canonical 50000.00 is what gets filed', async (t) => {
  const { intents, form, field } = await mountForm(t);
  fillNonAmount(field);
  field('amount').value = '$50,000';
  await submit(form);

  assert.equal(intents.length, 1, 'the submit was not swallowed by a silent return');
  const intent = intents[0]!;
  assert.equal(intent.op, 'add');
  assert.ok(intent.op === 'add' && intent.amount === '50000.00', 'normalized to the bind shape');
});

test('every money form an operator plausibly types lands on the same canonical string', async (t) => {
  for (const typed of ['50,000', '$50,000', '$ 50,000.00', '50000', '50000.00']) {
    const { intents, form, field } = await mountForm(t);
    fillNonAmount(field);
    field('amount').value = typed;
    await submit(form);
    const intent = intents[0];
    assert.ok(intent !== undefined && intent.op === 'add', `"${typed}" submitted`);
    assert.equal(intent.amount, '50000.00', `"${typed}" normalizes to 50000.00`);
  }
});

test('cents are padded, never truncated — 4200.5 is four thousand two hundred dollars fifty', async (t) => {
  const { intents, form, field } = await mountForm(t);
  fillNonAmount(field);
  field('amount').value = '4200.5';
  await submit(form);
  const intent = intents[0];
  assert.ok(intent !== undefined && intent.op === 'add');
  assert.equal(intent.amount, '4200.50');
});

test('a value the parser rejects emits NOTHING — normalization did not widen the gate', async (t) => {
  // Zero and negatives are what 024's `amount > 0` CHECK refuses; `1,23.00` is malformed
  // grouping. Accepting `$` and commas must not have quietly let any of these through.
  for (const junk of ['0', '$0.00', '-10', '1,23.00', 'abc', '']) {
    const { intents, form, field } = await mountForm(t);
    fillNonAmount(field);
    field('amount').value = junk;
    await submit(form);
    assert.equal(intents.length, 0, `"${junk}" filed nothing`);
  }
});

test('leaving the box settles it to the exact string that will be saved', async (t) => {
  // WHY THIS IS NOT COSMETIC: now that what you type and what is stored can differ, the
  // operator has to see the resolved figure BEFORE clicking Save, not infer it from the tile
  // afterwards. This is the only place that confirmation happens.
  const { field } = await mountForm(t);
  const amount = field('amount') as HTMLInputElement;
  amount.value = '$50,000';
  await React.act(async () => {
    amount.focus();
    amount.blur();
  });
  assert.equal(amount.value, '50000.00');
});

test('unparseable text is left EXACTLY as typed on blur, so the field message still fits', async (t) => {
  // Rewriting junk would move the operator's own text out from under the browser's
  // "please match the requested format" bubble, which points at what they wrote.
  const { field } = await mountForm(t);
  const amount = field('amount') as HTMLInputElement;
  amount.value = 'fifty grand';
  await React.act(async () => {
    amount.focus();
    amount.blur();
  });
  assert.equal(amount.value, 'fifty grand');
});
