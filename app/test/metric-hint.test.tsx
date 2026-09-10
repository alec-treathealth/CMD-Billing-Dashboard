/**
 * MetricHint — THE INTERACTION, EXECUTED (Qodo #350 finding 4).
 *
 * This component holds every caveat the KPI tiles gave up their height for, so "the panel opens and
 * can be read" is a correctness requirement on this surface, not polish. The first version failed in
 * both input modes at once and a string render could see neither failure:
 *   · the handlers sat on the BUTTON while the panel was an absolutely-positioned SIBLING, so
 *     `mouseleave` fired the instant the pointer travelled toward the panel — unreachable, so the
 *     text could not be read or selected;
 *   · `focus` opened and `click` TOGGLED one boolean, and a keyboard Enter/Space fires focus THEN
 *     click — so activating it opened and immediately closed it.
 *
 * jsdom is the sanctioned exception for exactly this (CLAUDE.md): `node:test` is still the runner,
 * and focus + keyboard are behaviour a `renderToStaticMarkup` assertion cannot reach. Scope stays
 * hard — no layout, no paint, no contrast, nothing reading getBoundingClientRect.
 *
 * ⚠️ THE POINTER HALF IS ASSERTED STRUCTURALLY, ON PURPOSE. React synthesises mouseenter/mouseleave
 * from mouseover/mouseout with relatedTarget bookkeeping, so hand-dispatching a faithful pointer
 * traversal tests the synthesiser more than the component. The load-bearing fact is that the panel is
 * a DESCENDANT of the element carrying the hover handlers — if it is, no `mouseleave` can fire
 * between the button and the panel, which is the whole fix. That is checked directly below.
 *
 * ⚠️ Must be .tsx and sit directly in `app/test/` — the runner glob is `test/*.test.tsx`.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as React from 'react';
import { installDom } from './helpers/dom';
import { MetricHint } from '../components/code-performance/metric-hint';

installDom();

let clientRenderer: typeof import('react-dom/client') | null = null;
async function reactDomClient() {
  clientRenderer ??= await import('react-dom/client');
  return clientRenderer;
}

const REASON = 'Not clamped. Over 100% is overpayment or clawback exposure.';

async function mount(t: TestContext) {
  const { createRoot } = await reactDomClient();
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
    root.render(<MetricHint label="paid of allowed">{REASON}</MetricHint>);
  });
  const button = container.querySelector('button');
  const panel = container.querySelector('[role="note"]');
  assert.ok(button && panel, 'the hint renders a button and a panel');
  return { container, button: button as HTMLButtonElement, panel: panel as HTMLElement };
}

const fire = (el: Element, type: string, init: EventInit = {}) =>
  React.act(async () => {
    el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }));
  });

const press = (el: Element, key: string) =>
  React.act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

const click = (el: Element) =>
  React.act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });

test('the panel is a DESCENDANT of the element carrying the hover handlers', async (t) => {
  // The structural half of the fix: a sibling panel is unreachable by pointer, because the button's
  // own mouseleave fires before the pointer arrives. Nesting is what makes it reachable.
  const { button, panel } = await mount(t);
  const wrapper = button.parentElement;
  assert.ok(wrapper, 'the button has a wrapper');
  assert.ok(wrapper.contains(panel), 'the panel must live INSIDE the hover target, not beside it');
  assert.notEqual(panel.parentElement, button, 'and not inside the button itself');
});

test('the caveat is in the DOM even while closed — a disclosure, never a containment boundary', async (t) => {
  const { panel } = await mount(t);
  assert.equal(panel.hidden, true, 'starts closed');
  assert.ok(panel.textContent?.includes('clawback'), 'the text ships regardless of open state');
});

test('focus OPENS it, and activating it does NOT close it — the Enter/Space bug', async (t) => {
  const { button, panel } = await mount(t);
  await React.act(async () => {
    button.focus();
  });
  assert.equal(panel.hidden, false, 'focus opens the panel');
  // A real keyboard activation fires focus THEN click. A toggle here closed what focus just opened.
  await click(button);
  assert.equal(panel.hidden, false, 'activating a focused hint must leave it open');
});

test('Escape closes it while focus is still on the button', async (t) => {
  const { button, panel } = await mount(t);
  await React.act(async () => {
    button.focus();
  });
  assert.equal(panel.hidden, false);
  await press(button, 'Escape');
  assert.equal(panel.hidden, true, 'Escape dismisses without moving focus (WCAG 1.4.13)');
});

test('blur closes it, and re-focusing re-arms after an Escape', async (t) => {
  const { button, panel } = await mount(t);
  await React.act(async () => {
    button.focus();
  });
  await press(button, 'Escape');
  assert.equal(panel.hidden, true);
  await React.act(async () => {
    button.blur();
  });
  assert.equal(panel.hidden, true, 'still closed after leaving');
  // Leaving resets the dismissal, so the next visit is not permanently muted.
  await React.act(async () => {
    button.focus();
  });
  assert.equal(panel.hidden, false, 'a dismissal must not persist past the next focus');
});

test('a mouseleave on the BUTTON alone cannot close it — the handler is on the wrapper', async (t) => {
  const { button, panel } = await mount(t);
  await React.act(async () => {
    button.focus();
  });
  assert.equal(panel.hidden, false);
  await fire(button, 'mouseout');
  assert.equal(panel.hidden, false, 'a pointer leaving the button for the panel must not close it');
});

test('the button names the metric and points at the panel it describes', async (t) => {
  const { button, panel } = await mount(t);
  assert.equal(button.getAttribute('aria-label'), 'About paid of allowed');
  assert.equal(button.getAttribute('aria-describedby'), panel.id, 'the description is wired, not just adjacent');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  await React.act(async () => {
    button.focus();
  });
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'state is announced, not only painted');
});
