/**
 * THE FOCUS CONTRACT, EXECUTED — the first tests in this repo that press a key.
 *
 * These run against `vob-modal.tsx`, which the 2026-08-12 accessibility audit singles out as the
 * one dialog on the Qualify surface that ALREADY implements the pattern correctly
 * (`role="dialog"` + `aria-modal` + `useDialog`'s trap). That choice is deliberate and is the point
 * of this file landing BEFORE the a11y fixes rather than alongside them: a harness proven against
 * known-good code gives a trustworthy baseline. If the harness and a brand-new fix arrived in the
 * same PR, a red test would leave you unable to say whether the fix was wrong or the harness was.
 *
 * What is asserted here is exactly what a string render cannot see — that the EFFECT ran and did
 * the right thing. See `helpers/dom.tsx` for the full "what jsdom does and does not buy" note; the
 * short version is that focus and keyboard are in scope, and layout, contrast, target size and real
 * screen-reader behaviour are NOT.
 *
 * ⚠️ Must be .tsx and must sit directly in `app/test/` — the runner glob is `test/*.test.tsx`,
 * single-level. A `.ts` file, or a subdirectory, "passes" by never running.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, pressKey } from './helpers/dom';
import { VobModal } from '../components/qualify/vob-modal';

// INSTALLED AT MODULE SCOPE, BEFORE ANY TEST RUNS — but AFTER the imports above, which is safe here
// and worth stating because it looks fragile: neither `react-dom/client` nor anything in the
// vob-modal chain (`react`, `lucide-react`, `useDialog`) touches `document` at import time. They
// read it lazily, inside render and inside effects, both of which happen in `mount()` below. If a
// future component under test DOES reach for `document` at module scope, this file will fail loudly
// at import rather than silently — and the fix is a dynamic import, not a global setup file.
//
// (Top-level `await import(...)` would be the more obviously-correct ordering, but tsx compiles
// these tests to CJS, where top-level await is a syntax error.)
installDom();

/**
 * Mount into a fresh container, and register teardown on the TEST CONTEXT rather than returning an
 * `unmount()` for the caller to remember.
 *
 * Teardown hangs off the TEST CONTEXT so it runs on the failing path too, not just the passing one.
 *
 * ⚠ KNOWN LIMITATION, MEASURED — THIS DID NOT FULLY FIX THE HANG, and saying so is the point.
 * Mutation-testing this file (deleting `node.focus()` from `useDialog`) makes the run die as
 * `signal: 'SIGKILL'` after ~32s instead of printing the assertion diff. Moving teardown to
 * `t.after()` did NOT change that, so the leak is not the React root. What IS established:
 *   - the suite passes 4/4 against correct code;
 *   - the assertions are NOT vacuous — mutate `useDialog` and it goes red, revert and it goes green;
 *   - a plain `assert.equal(1, 2)` inside a jsdom file reports cleanly in <1ms, so jsdom and the
 *     runner are fine in general; the hang is specific to this component-under-mutation path.
 * So a genuine regression here still FAILS the gate — it just reports as a timeout rather than a
 * message, and whoever hits it should re-run the single test to get a readable diff. Root-causing
 * that is a follow-up, deliberately not folded into this PR.
 */
async function mount(t: TestContext, ui: React.ReactElement) {
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
    root.render(ui);
  });
  return {
    container,
    async rerender(next: React.ReactElement) {
      await React.act(async () => {
        root.render(next);
      });
    },
  };
}

/** A realistic opener: the control a user would have been on when the dialog opened. Removed on
 *  teardown for the same always-runs reason as the root above. */
function makeOpener(t: TestContext): HTMLButtonElement {
  const opener = document.createElement('button');
  opener.textContent = 'open the modal';
  document.body.appendChild(opener);
  opener.focus();
  t.after(() => opener.remove());
  return opener;
}

test('opening a dialog MOVES focus into it — the claim a markup test cannot make', async (t) => {
  const opener = makeOpener(t);
  assert.equal(document.activeElement, opener, 'precondition: the opener holds focus');

  await mount(t, <VobModal open query="AETNA" onClose={() => {}} />);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, 'the dialog rendered');
  assert.equal(
    document.activeElement,
    dialog,
    'focus is INSIDE the dialog. renderToStaticMarkup proves role="dialog" exists; only this proves ' +
      'a screen-reader user is actually taken there',
  );

});

test('Escape closes, and closing RESTORES focus to the opener (SC 2.4.3)', async (t) => {
  const opener = makeOpener(t);
  let closed = 0;
  const view = await mount(t, <VobModal open query="AETNA" onClose={() => { closed += 1; }} />);

  pressKey('Escape');
  assert.equal(closed, 1, 'Escape reached the dialog handler and requested close');

  // The consumer owns `open`; simulate it honouring the request, which is what triggers restore.
  await view.rerender(<VobModal open={false} query="AETNA" onClose={() => {}} />);
  assert.equal(
    document.activeElement,
    opener,
    'focus returned to the control that opened the dialog — the failure useDialog.ts:60 exists to ' +
      'prevent, and the exact defect the audit files as M9 against ticker-explainer',
  );

});

test('Tab CYCLES inside the modal instead of escaping to the page behind it (SC 2.1.1)', async (t) => {
  // A control outside the dialog. In a real browser Tab from the last dialog element would land
  // here if the trap were broken; jsdom does not traverse natively, so what we assert is that the
  // trap's own handler fires and redirects focus to the first element. That IS our code, and our
  // code is what the audit says is missing on the three mobile sheets.
  const outside = document.createElement('button');
  outside.textContent = 'behind the modal';
  document.body.appendChild(outside);

  await mount(t, <VobModal open query="AETNA" onClose={() => {}} />);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  );
  assert.ok(focusable.length >= 2, 'this dialog has enough controls for the cycle to be observable');

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;

  last.focus();
  pressKey('Tab');
  assert.equal(document.activeElement, first, 'Tab from the LAST control wraps to the first, not out of the dialog');

  first.focus();
  pressKey('Tab', { shiftKey: true });
  assert.equal(document.activeElement, last, 'Shift+Tab from the FIRST control wraps to the last');

  assert.notEqual(document.activeElement, outside, 'focus never reached the control behind the modal');

  outside.remove();
});

test('Shift+Tab from the JUST-OPENED dialog stays inside — the container-focus path (PR #311)', async (t) => {
  // The hook focuses the tabIndex={-1} CONTAINER on open, and that container is excluded from the
  // FOCUSABLE list — so before this fix the boundary checks never matched it and the very first
  // Shift+Tab walked out of the modal into the page behind it. The prior test above starts by
  // manually focusing `first`, which is exactly why it could not catch this.
  makeOpener(t);
  await mount(t, <VobModal open query="AETNA" onClose={() => {}} />);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  assert.equal(document.activeElement, dialog, 'precondition: the container itself holds focus on open');

  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  );
  assert.ok(focusable.length >= 2, 'this dialog has controls for the routing to be observable');

  pressKey('Tab', { shiftKey: true });
  assert.equal(
    document.activeElement,
    focusable[focusable.length - 1]!,
    'Shift+Tab from the container routes to the LAST control instead of escaping the dialog',
  );

  dialog.focus();
  pressKey('Tab');
  assert.equal(
    document.activeElement,
    focusable[0]!,
    'Tab from the container routes deterministically to the FIRST control',
  );
});

test('the harness itself is not vacuous — a dialog that never opens takes no focus', async (t) => {
  // The failure mode this guards: a harness where `act()` silently no-ops would make every
  // assertion above pass for the wrong reason. If focus moved here, the tests are measuring
  // something other than the effect.
  const opener = makeOpener(t);
  await mount(t, <VobModal open={false} query="AETNA" onClose={() => {}} />);
  assert.equal(document.querySelector('[role="dialog"]'), null, 'a closed dialog renders nothing');
  assert.equal(document.activeElement, opener, 'and steals no focus');
});
