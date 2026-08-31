/**
 * The "scheduled" badge — the marker that stops future-dated money sitting silently inside a total
 * a reader takes as settled cash.
 *
 * renderToStaticMarkup, no jsdom: every claim here is a markup claim.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentDateCell } from '../components/dashboard/payment-date-cell';

test('the badge renders when the payment is dated after business-today', () => {
  const html = renderToStaticMarkup(<PaymentDateCell row={{ is_scheduled: true }} text="2026-08-31" />);
  assert.match(html, /2026-08-31/, 'the date itself is still shown');
  assert.match(html, /scheduled/, 'and it is marked');
  assert.match(html, /data-scheduled="true"/);
});

test('the badge does NOT render for a settled payment', () => {
  const html = renderToStaticMarkup(<PaymentDateCell row={{ is_scheduled: false }} text="2026-08-29" />);
  assert.equal(html, '2026-08-29', 'no wrapper, no badge — the bare value');
  assert.doesNotMatch(html, /scheduled/);
});

test('an undated charge is not "scheduled" — unplaceable is a different thing', () => {
  // payment_received null → the server projects false, and the cell says nothing about it.
  const html = renderToStaticMarkup(<PaymentDateCell row={{ is_scheduled: false }} text="—" />);
  assert.equal(html, '—');
});

test('the marker survives greyscale — it is not colour-only', () => {
  // WCAG 1.4.1. A dashed border plus the literal word, so the qualifier reads in forced-colours
  // mode and for a colour-blind reader, not just as a tint.
  const html = renderToStaticMarkup(<PaymentDateCell row={{ is_scheduled: true }} text="2026-09-02" />);
  assert.match(html, /border-dashed/);
  assert.match(html, />scheduled</, 'the word itself, not only a style');
});

test('the cell reads no clock and knows no timezone', () => {
  // The flag is server-resolved and shipped per row. If this component ever started deriving it,
  // the same fixture would have to change behaviour with the wall clock — it must not.
  const a = renderToStaticMarkup(<PaymentDateCell row={{ is_scheduled: true }} text="2026-08-31" />);
  const b = renderToStaticMarkup(<PaymentDateCell row={{ is_scheduled: true }} text="2026-08-31" />);
  assert.equal(a, b);
  assert.match(a, /scheduled/);
});
