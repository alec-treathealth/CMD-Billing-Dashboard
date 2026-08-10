/**
 * SLOT-CHIPS — the pure grammar, plus the RENDERED chip.
 *
 * The firewall's schema half is asserted in test/qualifyAiSlots.test.ts (root suite). This file
 * covers the two things that live only on the app side:
 *
 *   1. ENUM PARITY, BOTH DIRECTIONS. chipTemplates.ts declares the slot vocabularies for the UI and
 *      qualifyAi.ts re-declares them for the wire. They are two hand-written lists that must agree
 *      exactly, and until Task 3 only the forward direction (§1a: every UI value is schema-accepted)
 *      was checked — a value ADDED to the schema and never offered by the UI passed silently, which
 *      is a real hole (the rep can never select it) that the header's "must agree exactly" claim
 *      denied existed. §1b closes the reverse direction: every value the SCHEMA accepts must also be
 *      offered by the UI. Rather than hand-copy a THIRD list that could independently drift from
 *      both existing ones, §1b's schema-side lists are DERIVED from `QualifyAiInputSchema` itself via
 *      zod's own public introspection (`.unwrap()` / `.options` / `.value`) — see `schemaValuesOf`.
 *   2. NO FREE-TEXT CONTROL reaches the DOM. The chip's whole purpose is that a rep cannot type on
 *      this surface; an <input> or <textarea> appearing here later would be the regression, and it
 *      would look like a feature in review.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
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

// ── 1a. Enum parity, forward direction: every UI value is schema-accepted ──────────────────────
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

// ── 1b. Enum parity, REVERSE direction: every schema value is UI-offered ───────────────────────
//
// `app/` and the root package are two separate npm installs (`app/node_modules/zod` and the root's
// are different files on disk, same version) — the `z` imported HERE is a different module instance
// from the one `src/collections/qualifyAi.ts` built `QualifyAiInputSchema` with, so `instanceof
// z.ZodEnum` etc. is always false across that boundary even though the runtime shape is identical.
// Reading `_def.typeName` (a plain string, not a class identity) is what actually works across two
// zod copies, so unwrapping goes through that instead of `instanceof` — still "derived from the
// schema itself", just via the property that survives the module-instance split.
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s: z.ZodTypeAny = schema;
  while (s._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional || s._def.typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
    s = (s as unknown as { unwrap(): z.ZodTypeAny }).unwrap();
  }
  return s;
}

/** The schema's OWN permitted values for a `z.enum([...])` or a `z.union([z.literal(...), ...])`
 *  field, read off the schema rather than hand-copied — the whole point of §1b (see file header). */
function schemaValuesOf(schema: z.ZodTypeAny): unknown[] {
  const s = unwrapZod(schema);
  const typeName = s._def.typeName;
  if (typeName === z.ZodFirstPartyTypeKind.ZodEnum) {
    return [...(s as unknown as { options: unknown[] }).options];
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodUnion) {
    const options = (s as unknown as { options: z.ZodTypeAny[] }).options;
    return options.map((option) => {
      const lit = unwrapZod(option);
      if (lit._def.typeName !== z.ZodFirstPartyTypeKind.ZodLiteral) {
        throw new Error('schemaValuesOf: expected a union of z.literal(...) members');
      }
      return (lit as unknown as { value: unknown }).value;
    });
  }
  throw new Error(`schemaValuesOf: unsupported zod node "${typeName}"`);
}

const slotsSchema = unwrapZod(QualifyAiInputSchema.shape.slots);
if (slotsSchema._def.typeName !== z.ZodFirstPartyTypeKind.ZodObject) {
  throw new Error('QualifyAiInputSchema.shape.slots did not unwrap to an object schema');
}
const slotsShape = (slotsSchema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
const SCHEMA_METRICS = schemaValuesOf(slotsShape.metric!);
const SCHEMA_HORIZONS = schemaValuesOf(slotsShape.horizonDays!);
const SCHEMA_CARE_SETTINGS = schemaValuesOf(slotsShape.careSetting!);

/** Is `schemaValue` one of the values the UI's own vocabulary array offers? */
function uiOffers<T>(uiValues: readonly T[], schemaValue: unknown): boolean {
  return uiValues.some((v) => (v as unknown) === schemaValue);
}

test('every metric value the SCHEMA accepts is offered by the UI', () => {
  for (const value of SCHEMA_METRICS) {
    assert.ok(uiOffers(SLOT_METRICS, value), `schema accepts metric "${String(value)}" the UI never offers`);
  }
  // Equal cardinality closes the gap containment alone would miss: every schema value happening to
  // collide with a UI value already checked would pass containment even if the schema grew by one.
  assert.equal(SCHEMA_METRICS.length, SLOT_METRICS.length, 'metric list length mismatch — one side has a value the other lacks');
});

test('every horizon value the SCHEMA accepts is offered by the UI', () => {
  for (const value of SCHEMA_HORIZONS) {
    assert.ok(uiOffers(SLOT_HORIZONS, value), `schema accepts horizon ${String(value)} the UI never offers`);
  }
  assert.equal(SCHEMA_HORIZONS.length, SLOT_HORIZONS.length, 'horizon list length mismatch');
});

test('every care-setting value the SCHEMA accepts is offered by the UI', () => {
  for (const value of SCHEMA_CARE_SETTINGS) {
    assert.ok(uiOffers(SLOT_CARE_SETTINGS, value), `schema accepts care setting "${String(value)}" the UI never offers`);
  }
  assert.equal(SCHEMA_CARE_SETTINGS.length, SLOT_CARE_SETTINGS.length, 'care-setting list length mismatch');
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
