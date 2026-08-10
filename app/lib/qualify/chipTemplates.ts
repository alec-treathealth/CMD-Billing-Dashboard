/**
 * SLOT-CHIP GRAMMAR (Smoke Phase 2, 2026-08-10) — chips stop being fixed sentences and become
 * sentence TEMPLATES whose only editable parts are enum SLOTS.
 *
 * THE POINT IS THE FIREWALL, not the interaction. `docs/mockups/qualify-smoke-NOTES.md` §2 states
 * the contract the mock's composer footer prints out loud: *"slots only — free text never reaches
 * the model · template id + slot enums are all the server sees."* A free-text box on a PHI surface
 * is a standing exfiltration risk — a rep pastes a member ID into it and the identifier is in a
 * model prompt, a transcript and an audit row before anyone notices. This grammar makes that
 * structurally impossible rather than filtered: there is no field on the wire that can carry prose.
 *
 * HOW A SLOT VALUE IS CONSTRAINED, which is the whole design:
 *
 *   1. A STATIC ENUM (metric, horizon, care setting) — a closed set defined here and re-declared in
 *      the zod schema, so an unknown member is rejected at the server boundary.
 *   2. AN INDEX into an array the validated payload ALREADY carries (`facilities[]`).
 *
 * (2) is what makes facility and payer slots safe. The mock shows a rep picking "Hillside Horizon"
 * from a dropdown, and the naive reading is that the chosen NAME travels. It must not: a name on the
 * wire is a string field, and a string field is a place prose can live. So the client sends
 * `facility: 2` and the server resolves index 2 against the facilities array it already validated.
 * The name never crosses — it was already on the server side of the boundary. No new data reaches
 * the model, and the widest thing a compromised client can say is "the third one".
 *
 * PURE + client-safe (no React, no server imports, relative imports only) for the same reason
 * aiPayload.ts is: it must be importable from the hermetic render tests. See qualifyAi.ts for the
 * zod half — this module may only ever narrow what that schema already permits.
 */
import type { QualifySnapshot } from './contract';
import type { QualifyAiChipId } from './aiChips';

/** The five slots any template may expose. A key absent from a template is absent from its wire. */
export const QUALIFY_SLOT_KEYS = ['facility', 'comparator', 'metric', 'horizonDays', 'careSetting'] as const;
export type QualifySlotKey = (typeof QUALIFY_SLOT_KEYS)[number];

/** Static slot vocabularies. Mirrored EXACTLY by the zod enums in src/collections/qualifyAi.ts —
 *  the test asserts the two lists are identical, because a value accepted here and rejected there
 *  is a chip that silently fails to run, and the reverse is a hole in the firewall. */
export const SLOT_METRICS = ['allowed', 'paidOfAllowed', 'paidOfBilled', 'speed', 'rating'] as const;
export const SLOT_HORIZONS = [30, 90, 180, 365] as const;
export const SLOT_CARE_SETTINGS = ['IP', 'OP', 'BOTH', 'ANY'] as const;

export type SlotMetric = (typeof SLOT_METRICS)[number];
export type SlotHorizon = (typeof SLOT_HORIZONS)[number];
export type SlotCareSetting = (typeof SLOT_CARE_SETTINGS)[number];

/** What the client may send. Facility slots are INDICES (see the header); the rest are enums. */
export interface QualifyChipSlots {
  facility: number | null;
  comparator: number | null;
  metric: SlotMetric | null;
  horizonDays: SlotHorizon | null;
  careSetting: SlotCareSetting | null;
}

export const EMPTY_SLOTS: QualifyChipSlots = {
  facility: null,
  comparator: null,
  metric: null,
  horizonDays: null,
  careSetting: null,
};

/** A template is a sentence in pieces: literal text, and slots the rep can change. */
export type QualifyTemplateSegment =
  | { kind: 'text'; text: string }
  /** `locked` renders the value but refuses the dropdown — the mock's `.slot--locked`. It is the
   *  guardrail made visible: the lane's subject is not editable from inside the lane. */
  | { kind: 'slot'; slot: QualifySlotKey; locked: boolean };

export interface QualifyChipTemplate {
  id: QualifyAiChipId;
  segments: QualifyTemplateSegment[];
}

const text = (t: string): QualifyTemplateSegment => ({ kind: 'text', text: t });
const slot = (s: QualifySlotKey, locked = false): QualifyTemplateSegment => ({ kind: 'slot', slot: s, locked });

/**
 * Templates for the chips a slot genuinely improves. A chip WITHOUT an entry here keeps its fixed
 * label from aiChips.ts and is still a valid template — a template with zero slots. That is
 * deliberate: 'thin' ("is there enough history to trust this?") has no parameter a rep would want to
 * vary, and inventing one to make the table look uniform would add a control that only creates ways
 * to ask a worse question.
 */
export const QUALIFY_CHIP_TEMPLATES: Partial<Record<QualifyAiChipId, QualifyChipTemplate>> = {
  ranks: {
    id: 'ranks',
    segments: [text('Which of our'), slot('careSetting'), text('facilities does this policy pay best on'), slot('metric'), text('?')],
  },
  placement: {
    id: 'placement',
    segments: [text('Should I place this client at'), slot('facility'), text('?')],
  },
  explain: {
    id: 'explain',
    segments: [text('Why does'), slot('facility', true), text('score what it does on'), slot('metric'), text('?')],
  },
  speed: {
    id: 'speed',
    segments: [text('How long until'), slot('facility'), text('sees the money, over the last'), slot('horizonDays'), text('?')],
  },
  improve: {
    id: 'improve',
    segments: [text('What would move'), slot('facility'), text("'s rating over the next"), slot('horizonDays'), text('?')],
  },
};

/** One selectable option in a slot's dropdown. `value` is what travels; `label` never does. */
export interface QualifySlotChoice {
  value: string | number;
  label: string;
}

const METRIC_LABELS: Record<SlotMetric, string> = {
  allowed: '% allowed of billed',
  paidOfAllowed: '% paid of allowed',
  paidOfBilled: '% paid of billed',
  speed: 'days to payment',
  rating: 'overall rating',
};

const CARE_SETTING_LABELS: Record<SlotCareSetting, string> = {
  IP: 'residential',
  OP: 'outpatient',
  BOTH: 'combined-setting',
  ANY: '',
};

/**
 * The options a slot offers FOR THIS SNAPSHOT. Facility choices are the ranked set, in the order the
 * payload carries it — so the index a rep picks is the index the server resolves, with no separate
 * mapping to drift. A facility list shorter than two makes comparator slots meaningless; callers
 * check `length` rather than this module suppressing the chip, because which chips show is
 * aiChips.ts's decision, not this module's.
 */
export function slotChoices(snapshot: QualifySnapshot, key: QualifySlotKey): QualifySlotChoice[] {
  switch (key) {
    case 'facility':
    case 'comparator':
      return snapshot.facilities.slice(0, 10).map((f, i) => ({ value: i, label: f.name }));
    case 'metric':
      return SLOT_METRICS.map((m) => ({ value: m, label: METRIC_LABELS[m] }));
    case 'horizonDays':
      return SLOT_HORIZONS.map((d) => ({ value: d, label: `${d} days` }));
    case 'careSetting':
      return SLOT_CARE_SETTINGS.map((c) => ({ value: c, label: CARE_SETTING_LABELS[c] || 'any' }));
  }
}

/**
 * The slot values a chip STARTS with, so a chip is answerable the instant it is clicked — the rep on
 * the phone should never have to fill a form before asking. Facility defaults to rank 1, which since
 * 2026-08-08 means the best facility that can ADMIT TODAY rather than the best-paying one (the
 * bed-availability tier in core.ts); that is the right default for a chip pressed mid-call.
 */
export function defaultSlots(snapshot: QualifySnapshot, template: QualifyChipTemplate): QualifyChipSlots {
  const used = new Set(template.segments.filter((s) => s.kind === 'slot').map((s) => s.slot));
  const hasFacilities = snapshot.facilities.length > 0;
  return {
    facility: used.has('facility') && hasFacilities ? 0 : null,
    comparator: used.has('comparator') && snapshot.facilities.length > 1 ? 1 : null,
    metric: used.has('metric') ? 'allowed' : null,
    horizonDays: used.has('horizonDays') ? 90 : null,
    careSetting: used.has('careSetting') ? 'ANY' : null,
  };
}

/**
 * Drop any slot the template does not declare. The wire must carry exactly the template's own slots
 * and nothing else — a stale value left over from a previously-clicked chip would otherwise ride
 * along and reach the prompt as a parameter of a question that never had it.
 */
export function narrowSlotsToTemplate(slots: QualifyChipSlots, template: QualifyChipTemplate): QualifyChipSlots {
  const used = new Set(template.segments.filter((s) => s.kind === 'slot').map((s) => s.slot));
  return {
    facility: used.has('facility') ? slots.facility : null,
    comparator: used.has('comparator') ? slots.comparator : null,
    metric: used.has('metric') ? slots.metric : null,
    horizonDays: used.has('horizonDays') ? slots.horizonDays : null,
    careSetting: used.has('careSetting') ? slots.careSetting : null,
  };
}
