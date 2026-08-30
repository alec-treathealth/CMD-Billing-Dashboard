/**
 * BillableDaysDrawer — RENDERED-HTML proof that the provider gate degrades cleanly.
 *
 * The payload test (`kipuImportPayload.test.tsx`) proves the VALUE never leaves the server for
 * an ungated viewer. This proves the other half: that the component the value used to feed
 * still renders correctly once it arrives as `null`. Gating a field server-side and leaving a
 * component that assumed a string is how a PHI fix turns into a crash for exactly the users it
 * was meant to protect.
 *
 * Static markup only — `useDialog`'s effect is SSR-inert, which is enough here because every
 * claim below is about what bytes are in the HTML, not about focus or layout.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only; a .ts file here would
 * "pass" by never running.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillableDaysDrawer } from '../components/billing-audit/billable-days/drawer';
import type { KipuRowDTO, KipuSessionDTO } from '../lib/billing-audit/kipu-import';

const PROVIDER = 'Synthetic Clinician 42';
const TOPIC = 'Synthetic Group Topic';

function session(over: Partial<KipuSessionDTO> = {}): KipuSessionDTO {
  return {
    date: '2026-08-11',
    kind: 'group',
    start: '09:00',
    end: '12:00',
    hrs: 3,
    provider: PROVIDER,
    status: 'Complete',
    billable: true,
    topic: TOPIC,
    label: 'MH IOP 1 Adult',
    ...over,
  };
}

function row(s: KipuSessionDTO): KipuRowDTO {
  return {
    id: 'client-1',
    name: null,
    loc: 'MH IOP 1 Adult',
    payer: 'SYNTHETIC PAYER',
    labels: ['MH IOP 1 Adult'],
    facilityCodes: ['TREAT_TX'],
    billableDays: 1,
    capDays: 1,
    iopDays: 1,
    totalHours: 3,
    flag: false,
    maxPast: 0,
    multiLoc: false,
    hasAuth: false,
    days: [
      { i: 0, date: '2026-08-11', codes: ['I'], hrs: 3, oow: false, past: 0, dc: false, sessions: [s] },
    ],
    auths: [],
    warn: [],
  };
}

function html(s: KipuSessionDTO, phiIncluded: boolean): string {
  const r = row(s);
  return renderToStaticMarkup(
    <BillableDaysDrawer
      target={{ row: r, dayIndex: 0 }}
      billableDays={r.billableDays}
      approximate={false}
      phiIncluded={phiIncluded}
      revealed={phiIncluded}
      onClose={() => {}}
    />,
  );
}

test('a withheld provider leaves no empty-element artifact in the metadata strip', () => {
  // The load-bearing leak proof lives in kipuImportPayload.test.tsx, where the value actually
  // exists to leak. Asserting PROVIDER is absent HERE is only defence-in-depth — with
  // `provider: null` the string was never in the input, so on its own it proves little. What
  // this test genuinely pins is the render contract: `{s.provider && …}` must drop the element
  // entirely rather than emitting an empty span, which would show as a stray gap between the
  // status and label chips for every ungated viewer.
  const out = html(session({ provider: null, topic: null }), false);
  assert.equal(out.includes(PROVIDER), false, 'the provider name reached the DOM');
  assert.equal(out.includes(TOPIC), false, 'the topic reached the DOM');
  assert.equal(/<span[^>]*><\/span>/.test(out), false, 'withheld provider left an empty span');
});

test('the ungated drawer still renders its non-PHI detail — the gate must not blank the panel', () => {
  // A drawer that threw or rendered empty would "pass" a leak assertion perfectly. Pin the
  // detail that must survive, so the leak test above cannot go green by rendering nothing.
  const out = html(session({ provider: null, topic: null }), false);
  assert.ok(out.includes('Complete'), 'status must still render');
  assert.ok(out.includes('MH IOP 1 Adult'), 'container label must still render');
  assert.ok(out.includes('3 h'), 'hours must still render');
});

test('a gated drawer renders the provider verbatim — existing behaviour is unchanged', () => {
  const out = html(session(), true);
  assert.ok(out.includes(PROVIDER), 'a privileged viewer must still see the provider');
  assert.ok(out.includes(TOPIC), 'a privileged viewer must still see the topic');
});

test('a blank Kipu Provider column and a WITHHELD provider render identically', () => {
  // '' means "Kipu had no Provider"; null means "withheld". Both drop out of the metadata
  // strip, which is why the drawer does NOT show a mask glyph there — a glyph would claim
  // data was withheld on rows where none ever existed. Documented in drawer.tsx's header.
  const withheld = html(session({ provider: null, topic: null }), false);
  const blank = html(session({ provider: '', topic: null }), false);
  assert.equal(withheld, blank);
});
