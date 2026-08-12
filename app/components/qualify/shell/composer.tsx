'use client';

/**
 * THE COMPOSER — the rail-foot "ask anything" bar that structurally cannot carry prose
 * (mock: `.composer`, whose own footer states the contract this file implements:
 * "slots only — free text never reaches the model · template id + slot enums are all the server sees").
 *
 * It is a TEMPLATE PICKER over the same grammar the panel's chips use (chipTemplates.ts), rendering
 * the chosen template through the SAME <SlotChip> component — one implementation of the slot UI,
 * not two that drift. There is no text input here and none may be added; the `slots` field on
 * QualifyAiInputSchema is the wire this rides, and the server re-validates regardless.
 *
 * DISABLED before the answer stage, honestly: a template needs a snapshot to offer facility slots
 * and the AI panel to stream into, so pre-answer the composer shows WHY it is quiet rather than
 * pretending to work. The Ask itself is delegated UP (onAsk) — the owner threads it to the panel
 * as `externalAsk`, because panel and composer live in different panes.
 */
import { useEffect, useMemo, useState } from 'react';
import type { QualifySnapshot } from '../../../lib/qualify/contract';
import {
  QUALIFY_CHIP_TEMPLATES,
  defaultSlots,
  narrowSlotsToTemplate,
  slotChoices,
  type QualifyChipSlots,
} from '../../../lib/qualify/chipTemplates';
import type { QualifyAiChipId } from '../../../lib/qualify/aiChips';
import { SlotChip } from '../slot-chip';

/** The composer's template menu: id → the short label the <select> shows. Only slotted templates —
 *  the zero-slot chips already live on the panel and a composer entry would duplicate them. */
const COMPOSER_LABELS: Partial<Record<QualifyAiChipId, string>> = {
  placement: 'Should I place this client at …',
  ranks: 'Which facilities pay best on …',
  explain: 'Why does the top facility score …',
  speed: 'How long until the money, at …',
  improve: 'What would move the rating at …',
};

export function QualifyComposer({
  snapshot,
  onAsk,
}: {
  /** Null before the answer stage — renders the quiet state. */
  snapshot: QualifySnapshot | null;
  onAsk: (question: QualifyAiChipId, slots: QualifyChipSlots | null) => void;
}) {
  const [templateId, setTemplateId] = useState<QualifyAiChipId>('placement');
  const [slots, setSlots] = useState<QualifyChipSlots | null>(null);

  /**
   * ⚠ SLOT VALUES DIE WITH THE SNAPSHOT — a correctness requirement, not tidiness, and the exact
   * rule qualify-ai-panel.tsx already states for its own per-chip slot state. A facility slot is an
   * INDEX into THIS snapshot's ranking; carrying `facility: 2` across a re-scope (a window chip, a
   * billed-under press, a new search) silently asks about whatever facility is third in the NEW
   * list, while the sentence on screen still shows the old name. The composer lives in the other
   * pane from the panel, so it needs its own reset — it does not ride the panel's.
   */
  useEffect(() => {
    setSlots(null);
  }, [snapshot]);

  const template = QUALIFY_CHIP_TEMPLATES[templateId] ?? null;
  // A template is offerable only when every slot it declares has choices on THIS snapshot —
  // the same usability rule the panel applies (an empty <select> is a control that lies).
  const offerable = useMemo(() => {
    if (snapshot === null) return [];
    return (Object.keys(COMPOSER_LABELS) as QualifyAiChipId[]).filter((id) => {
      const t = QUALIFY_CHIP_TEMPLATES[id];
      if (!t) return false;
      const keys = t.segments.flatMap((s) => (s.kind === 'slot' ? [s.slot] : []));
      return keys.length > 0 && keys.every((k) => slotChoices(snapshot, k).length > 0);
    });
  }, [snapshot]);

  if (snapshot === null || offerable.length === 0 || template === null) {
    return (
      // `shrink-0`: flex items default to `flex-shrink: 1`, so under the rail's 2026-08-12
      // max-height this pane — which carries the ratified compliance line — would compress instead
      // of pinning.
      <div className="shrink-0 border-t border-line px-4 py-3" data-testid="qualify-composer-quiet">
        {/* 26 words of explanation for a visibly-inert control, until 2026-08-12. The control's own
            disabled treatment already says it is not ready; the sentence only had to say why. */}
        <p className="text-[11.5px] leading-relaxed text-ink400">Resolve a search to ask about it.</p>
        <ComposerFoot />
      </div>
    );
  }

  const active = offerable.includes(templateId) ? templateId : offerable[0]!;
  const activeTemplate = QUALIFY_CHIP_TEMPLATES[active]!;
  const current = slots ?? defaultSlots(snapshot, activeTemplate);

  return (
    // `shrink-0` for the same reason as the quiet state above — the rail now has a max-height.
    <div className="shrink-0 border-t border-line px-4 py-3" data-testid="qualify-composer">
      <div className="mb-2 flex items-center gap-2">
        <label htmlFor="qualify-composer-template" className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink400">
          Ask
        </label>
        <select
          id="qualify-composer-template"
          value={active}
          onChange={(e) => {
            setTemplateId(e.target.value as QualifyAiChipId);
            setSlots(null); // a new sentence starts from its own defaults, not the last one's picks
          }}
          className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface px-2 py-1 text-[12px] font-semibold text-ink900"
        >
          {offerable.map((id) => (
            <option key={id} value={id}>
              {COMPOSER_LABELS[id]}
            </option>
          ))}
        </select>
      </div>
      <SlotChip
        template={activeTemplate}
        snapshot={snapshot}
        slots={current}
        active={false}
        suggested={false}
        onChange={setSlots}
        onAsk={() => onAsk(active, narrowSlotsToTemplate(current, activeTemplate))}
      />
      <ComposerFoot />
    </div>
  );
}

/** The compliance line, verbatim from the mock — it is the contract, not decoration. */
function ComposerFoot() {
  return (
    <p className="mt-2 font-mono text-[9.5px] leading-relaxed text-ink400">
      slots only — free text never reaches the model · template id + slot values are all the server sees
    </p>
  );
}
