/**
 * SLOT-CHIPS — the pure grammar, plus the RENDERED chip.
 *
 * The firewall's schema half is asserted in test/qualifyAiSlots.test.ts (root suite). This file
 * covers the two things that live only on the app side:
 *
 *   1. ENUM PARITY. chipTemplates.ts declares the slot vocabularies for the UI and qualifyAi.ts
 *      re-declares them for the wire. They are two hand-written lists that must agree exactly: a
 *      value the UI offers but the schema rejects is a dropdown option that silently fails to run,
 *      and the reverse is a hole. Nothing but this test connects them.
 *   2. NO FREE-TEXT CONTROL reaches the DOM. The chip's whole purpose is that a rep cannot type on
 *      this surface; an <input> or <textarea> appearing here later would be the regression, and it
 *      would look like a feature in review.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlotChip } from '../components/qualify/slot-chip';
import {
  QUALIFY_CHIP_TEMPLATES,
  QUALIFY_SLOT_KEYS,
  SLOT_CARE_SETTINGS,
  SLOT_HORIZONS,
  SLOT_LABELS,
  SLOT_METRICS,
  defaultSlots,
  narrowSlotsToTemplate,
  slotChoices,
  templateSentence,
  EMPTY_SLOTS,
  type QualifyChipSlots,
} from '../lib/qualify/chipTemplates';
import { QualifyAiInputSchema } from '../../src/collections/qualifyAi';
import type { QualifySnapshot } from '../lib/qualify/contract';

function facility(name: string) {
  return {
    name,
    careSetting: 'IP' as const,
    ratingV2: 60,
    iqBand: '50' as const,
    pctAllowedOfBilled: 49,
    pctPaidOfAllowed: 82,
    pctPaidOfBilled: 40,
    distinctPatients: 12,
    lineCount: 300,
    medianDaysToPayment: 40,
    payerCount: 1,
    factors: [],
  };
}

/** Only the fields these pure helpers read. Cast at the seam so the test does not have to construct
 *  the entire QualifySnapshot contract to exercise five slot functions. */
const snapshot = {
  facilities: [facility('Nashville Mental Health'), facility('Lonestar Mental Health'), facility('Opus Health')],
} as unknown as QualifySnapshot;

// ── 1. Enum parity between the UI's vocabulary and the wire's ──────────────────────────────────
test('every slot value the UI offers is accepted by the wire schema', () => {
  const base = {
    question: 'placement' as const,
    payerName: null,
    payerScope: 'none' as const,
    policy: null,
    provenance: 'none' as const,
    windowDays: 90,
    windowSufficient: true,
    facilities: [],
    amountsBlind: false,
  };
  const accepts = (slots: QualifyChipSlots) =>
    QualifyAiInputSchema.safeParse({ ...base, slots }).success;

  for (const metric of SLOT_METRICS) {
    assert.ok(accepts({ ...EMPTY_SLOTS, metric }), `schema rejects metric "${metric}" that the UI offers`);
  }
  for (const horizonDays of SLOT_HORIZONS) {
    assert.ok(accepts({ ...EMPTY_SLOTS, horizonDays }), `schema rejects horizon ${horizonDays} that the UI offers`);
  }
  for (const careSetting of SLOT_CARE_SETTINGS) {
    assert.ok(accepts({ ...EMPTY_SLOTS, careSetting }), `schema rejects care setting "${careSetting}"`);
  }
});

// ── 2. Slot plumbing ───────────────────────────────────────────────────────────────────────────
test('facility choices are indices into the ranking, and the labels never travel', () => {
  const choices = slotChoices(snapshot, 'facility');
  assert.deepEqual(
    choices.map((c) => c.value),
    [0, 1, 2],
  );
  assert.equal(choices[0]!.label, 'Nashville Mental Health');
});

test('defaults make a chip answerable on first click', () => {
  const template = QUALIFY_CHIP_TEMPLATES.placement!;
  const slots = defaultSlots(snapshot, template);
  // rank 1 — which since the 2026-08-08 bed-availability tier means the best facility that can
  // ADMIT TODAY, the right default for a chip pressed mid-call.
  assert.equal(slots.facility, 0);
  // a slot the template does not declare stays null rather than defaulting to something plausible
  assert.equal(slots.metric, null);
});

test('slots the template does not declare are stripped before they can reach the wire', () => {
  const template = QUALIFY_CHIP_TEMPLATES.placement!; // declares `facility` only
  const stale: QualifyChipSlots = { facility: 1, comparator: 2, metric: 'speed', horizonDays: 365, careSetting: 'OP' };
  const narrowed = narrowSlotsToTemplate(stale, template);
  assert.equal(narrowed.facility, 1);
  assert.equal(narrowed.comparator, null);
  assert.equal(narrowed.metric, null);
  assert.equal(narrowed.horizonDays, null);
  assert.equal(narrowed.careSetting, null);
});

// ── 3. The rendered chip ───────────────────────────────────────────────────────────────────────
test('a slotted chip renders selects and NO free-text control', () => {
  const template = QUALIFY_CHIP_TEMPLATES.speed!;
  const html = renderToStaticMarkup(
    <SlotChip
      template={template}
      snapshot={snapshot}
      slots={defaultSlots(snapshot, template)}
      active={false}
      suggested={false}
      onChange={() => {}}
      onAsk={() => {}}
    />,
  );
  assert.match(html, /<select/);
  // THE assertion. A text input on this surface is the whole failure mode the grammar exists to
  // prevent — a rep pastes a member ID and it reaches a model prompt and an audit row.
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /contenteditable/i);
});

test('a locked slot renders its value as text, with no control to change it', () => {
  const template = QUALIFY_CHIP_TEMPLATES.explain!; // `facility` is locked here
  const html = renderToStaticMarkup(
    <SlotChip
      template={template}
      snapshot={snapshot}
      slots={defaultSlots(snapshot, template)}
      active={false}
      suggested={false}
      onChange={() => {}}
      onAsk={() => {}}
    />,
  );
  assert.match(html, /Nashville Mental Health/);
  // one editable slot (metric), and the locked facility is NOT one of them
  const selects = html.match(/<select/g) ?? [];
  assert.equal(selects.length, 1);
  assert.doesNotMatch(html, /aria-label="facility"/);
});

// ── 4. Accessible names — the confirmed review finding ────────────────────────────────────────────
test('every slot key has a non-empty, human label — never the bare camelCase key', () => {
  for (const key of QUALIFY_SLOT_KEYS) {
    const label = SLOT_LABELS[key];
    assert.ok(label && label.length > 0, `slot "${key}" has no accessible label`);
  }
  // the exact mapping the review asked for
  assert.equal(SLOT_LABELS.facility, 'facility');
  assert.equal(SLOT_LABELS.horizonDays, 'time window');
  assert.equal(SLOT_LABELS.careSetting, 'care setting');
  assert.equal(SLOT_LABELS.comparator, 'compare against');
  assert.equal(SLOT_LABELS.metric, 'measure');
});

test('a slotted chip\'s <select>s carry human aria-labels, not the raw camelCase slot key', () => {
  const template = QUALIFY_CHIP_TEMPLATES.speed!; // facility + horizonDays — two editable selects
  const html = renderToStaticMarkup(
    <SlotChip
      template={template}
      snapshot={snapshot}
      slots={defaultSlots(snapshot, template)}
      active={false}
      suggested={false}
      onChange={() => {}}
      onAsk={() => {}}
    />,
  );
  assert.match(html, /aria-label="facility"/);
  assert.match(html, /aria-label="time window"/);
  // the raw multi-word key must never leak through as-is
  assert.doesNotMatch(html, /aria-label="horizonDays"/);
});

test('the chip group announces the sentence it currently reads as, not an unnamed "group"', () => {
  const template = QUALIFY_CHIP_TEMPLATES.placement!;
  const slots = defaultSlots(snapshot, template);
  const sentence = templateSentence(template, snapshot, slots);
  assert.equal(sentence, 'Should I place this client at Nashville Mental Health ?');
  const html = renderToStaticMarkup(
    <SlotChip
      template={template}
      snapshot={snapshot}
      slots={slots}
      active={false}
      suggested={false}
      onChange={() => {}}
      onAsk={() => {}}
    />,
  );
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Should I place this client at Nashville Mental Health \?"/);
});

test('the Ask button names the template in its accessible name while the visible text stays "Ask"', () => {
  const template = QUALIFY_CHIP_TEMPLATES.placement!;
  const slots = defaultSlots(snapshot, template);
  const html = renderToStaticMarkup(
    <SlotChip
      template={template}
      snapshot={snapshot}
      slots={slots}
      active={false}
      suggested={false}
      onChange={() => {}}
      onAsk={() => {}}
    />,
  );
  assert.match(html, /aria-label="Ask: Should I place this client at Nashville Mental Health \?"/);
  // the visible label is unchanged — the accessible name is additive, not a replacement
  assert.match(html, />Ask</);
});

test('an option value is the index, never the facility name', () => {
  const template = QUALIFY_CHIP_TEMPLATES.placement!;
  const html = renderToStaticMarkup(
    <SlotChip
      template={template}
      snapshot={snapshot}
      slots={defaultSlots(snapshot, template)}
      active={false}
      suggested={false}
      onChange={() => {}}
      onAsk={() => {}}
    />,
  );
  assert.match(html, /<option value="0"/);
  assert.doesNotMatch(html, /value="Nashville Mental Health"/);
});
